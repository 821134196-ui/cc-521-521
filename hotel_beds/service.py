"""核心业务服务。

所有写操作在单个 SQLite 连接上以 BEGIN IMMEDIATE 事务执行：
- 床架/布草分配：行级原子 UPDATE，资源占用不重叠；
- 配送单认领：UPDATE ... WHERE status='pending'，两人并发只成功一次；
- 计费与状态变更同事务，不会出现"已确认未入账"。
"""
from __future__ import annotations

import sqlite3
from datetime import date, datetime

from .billing import SimulatedBillingAdapter
from .errors import BusinessError, NotFound, PermissionDenied
from .pricing import (
    DAMAGE_FEES,
    EARLY_PICKUP_FEE_CENTS,
    REPLACEMENT_FEES,
    TYPE_NAME,
    nightly_total,
)

ACTIVE_REQUEST_STATES = ("assigned", "delivered", "confirmed")


class HotelService:
    def __init__(self, conn: sqlite3.Connection, billing: SimulatedBillingAdapter | None = None):
        self.conn = conn
        self.billing = billing or SimulatedBillingAdapter()

    # ------------------------------------------------------------------ 工具

    def _begin(self):
        self.conn.execute("BEGIN IMMEDIATE")

    def _commit(self):
        self.conn.execute("COMMIT")

    def _rollback(self):
        self.conn.execute("ROLLBACK")

    def _get(self, table: str, pk_col: str, pk):
        row = self.conn.execute(
            f"SELECT * FROM {table} WHERE {pk_col}=?", (pk,)
        ).fetchone()
        if row is None:
            raise NotFound(f"{table} {pk} 不存在")
        return row

    def _active_extra_beds(self, room_no: str) -> int:
        """房间当前已加且未撤的床数。"""
        placeholders = ",".join("?" for _ in ACTIVE_REQUEST_STATES)
        row = self.conn.execute(
            f"""
            SELECT COALESCE(SUM(guests_to_add),0) AS n
            FROM requests
            WHERE room_no=? AND status IN ({placeholders})
            """,
            (room_no, *ACTIVE_REQUEST_STATES),
        ).fetchone()
        return row["n"]

    # --------------------------------------------------------------- 房型/房态

    def list_rooms(self):
        rows = self.conn.execute(
            """
            SELECT r.*, rt.name AS type_name, rt.fire_capacity, rt.bed_space,
                   rt.price_cents AS rack_rate_cents
            FROM rooms r JOIN room_types rt ON rt.code = r.type_code
            ORDER BY r.room_no
            """
        ).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            d["extra_beds"] = self._active_extra_beds(r["room_no"])
            d["current_guests"] = r["base_guests"] + d["extra_beds"]
            d["over_fire"] = d["current_guests"] > r["fire_capacity"]
            result.append(d)
        return result

    # ------------------------------------------------------------- 申请与报价

    def submit_request(
        self,
        *,
        room_no: str,
        guests_to_add: int,
        ends_on: str,
        operator: str = "前台",
    ):
        """前台接受加床申请；逐项校验消防人数与房间空间。"""
        if guests_to_add <= 0:
            raise BusinessError("加床人数必须大于 0", "BAD_INPUT")
        try:
            datetime.strptime(ends_on, "%Y-%m-%d")
        except ValueError:
            raise BusinessError("退房日期格式应为 YYYY-MM-DD", "BAD_INPUT")

        self._begin()
        try:
            room = self._get("rooms", "room_no", room_no)
            rt = self._get("room_types", "code", room["type_code"])
            active = self._active_extra_beds(room_no)
            future_guests = room["base_guests"] + active + guests_to_add
            future_beds = active + guests_to_add

            if future_guests > rt["fire_capacity"]:
                raise BusinessError(
                    f"入住人数超限：核准 {rt['fire_capacity']} 人，"
                    f"叠加后将达 {future_guests} 人",
                    "OVER_OCCUPANCY",
                )
            if future_beds > rt["bed_space"]:
                raise BusinessError(
                    f"房间空间不足：最多放 {rt['bed_space']} 张折叠床，"
                    f"已有 {active} 张，申请 {guests_to_add} 张",
                    "NO_SPACE",
                )

            cur = self.conn.execute(
                """
                INSERT INTO requests
                    (room_no, guests_to_add, status, ends_on,
                     quoted_cents, list_price_cents)
                VALUES (?, ?, 'submitted', ?, ?, ?)
                """,
                (
                    room_no,
                    guests_to_add,
                    ends_on,
                    rt["price_cents"],
                    rt["price_cents"],
                ),
            )
            req_id = cur.lastrowid
            self._commit()
            return req_id
        except Exception:
            self._rollback()
            raise

    def reject_request(self, request_id: int, reason: str, *, operator: str = "前台"):
        self._begin()
        try:
            req = self._get("requests", "id", request_id)
            if req["status"] != "submitted":
                raise BusinessError("仅待处理申请可驳回", "BAD_STATE")
            self.conn.execute(
                """UPDATE requests
                   SET status='rejected', reject_reason=?, decided_at=datetime('now','localtime')
                   WHERE id=?""",
                (reason, request_id),
            )
            self._commit()
        except Exception:
            self._rollback()
            raise

    def adjust_quote(self, request_id: int, new_rate_cents: int, *, role: str, operator: str):
        """前台调整每床每晚价格；原报价写入 quote_adjustments 永久保留。"""
        if role != "front_desk":
            raise PermissionDenied("仅前台可调整价格")
        if new_rate_cents < 0:
            raise BusinessError("价格不能为负", "BAD_INPUT")
        self._begin()
        try:
            req = self._get("requests", "id", request_id)
            if req["status"] not in ("submitted", "assigned", "delivered"):
                raise BusinessError("申请已确认，价格不可再调整", "BAD_STATE")
            old = req["quoted_cents"]
            self.conn.execute(
                """INSERT INTO quote_adjustments
                       (request_id, from_cents, to_cents, changed_by)
                   VALUES (?, ?, ?, ?)""",
                (request_id, old, new_rate_cents, operator),
            )
            self.conn.execute(
                "UPDATE requests SET quoted_cents=? WHERE id=?",
                (new_rate_cents, request_id),
            )
            self._commit()
        except Exception:
            self._rollback()
            raise

    def quote_history(self, request_id: int):
        return [
            dict(r)
            for r in self.conn.execute(
                "SELECT * FROM quote_adjustments WHERE request_id=? ORDER BY id",
                (request_id,),
            ).fetchall()
        ]

    # ----------------------------------------------------------- 库存与配送单

    def _grab_items(self, item_type: str, qty: int) -> list[str]:
        """在已开启的事务内占用 qty 件可用库存，返回 sku 列表。

        仅取 status='available' AND condition='ok'；
        UPDATE 带状态条件并重查 rowcount，保证同一件不会被两单重叠占用。
        """
        skus = [
            r["sku"]
            for r in self.conn.execute(
                """SELECT sku FROM inventory_items
                   WHERE item_type=? AND status='available' AND condition='ok'
                   ORDER BY id""",
                (item_type,),
            ).fetchall()
        ]
        grabbed: list[str] = []
        for sku in skus:
            if len(grabbed) == qty:
                break
            cur = self.conn.execute(
                """UPDATE inventory_items SET status='in_use'
                   WHERE sku=? AND item_type=? AND status='available' AND condition='ok'""",
                (sku, item_type),
            )
            if cur.rowcount == 1:
                grabbed.append(sku)
        if len(grabbed) < qty:
            raise BusinessError(
                f"{TYPE_NAME[item_type]}库存不足：需要 {qty} 件，仅能分配 {len(grabbed)} 件",
                "OUT_OF_STOCK",
            )
        return grabbed

    def assign_delivery(self, request_id: int):
        """为申请锁定床架+布草并生成配送单。整套占用同一事务，缺一不成单。"""
        self._begin()
        try:
            req = self._get("requests", "id", request_id)
            if req["status"] != "submitted":
                raise BusinessError("仅待处理申请可派单", "BAD_STATE")
            n = req["guests_to_add"]

            frames = self._grab_items("frame", n)
            try:
                beddings = self._grab_items("bedding", n)
                pillows = self._grab_items("pillow", n)
            except BusinessError:
                # 布草不足时整体回滚，床架不会被半单占用
                raise

            cur = self.conn.execute(
                "INSERT INTO deliveries (request_id, status) VALUES (?, 'pending')",
                (request_id,),
            )
            delivery_id = cur.lastrowid
            for sku in frames:
                self.conn.execute(
                    "INSERT INTO frame_allocations (delivery_id, frame_sku) VALUES (?,?)",
                    (delivery_id, sku),
                )
            for sku in beddings:
                self.conn.execute(
                    "INSERT INTO linen_loans (delivery_id, item_type, item_sku) VALUES (?, 'bedding', ?)",
                    (delivery_id, sku),
                )
            for sku in pillows:
                self.conn.execute(
                    "INSERT INTO linen_loans (delivery_id, item_type, item_sku) VALUES (?, 'pillow', ?)",
                    (delivery_id, sku),
                )
            self.conn.execute(
                "UPDATE requests SET status='assigned' WHERE id=?", (request_id,)
            )
            self._commit()
            return delivery_id
        except Exception:
            self._rollback()
            raise

    def claim_delivery(self, delivery_id: int, attendant: str):
        """房务员认领配送单：并发双认领只成功一次。"""
        self._begin()
        try:
            cur = self.conn.execute(
                """UPDATE deliveries
                   SET status='claimed', claimed_by=?,
                       claimed_at=datetime('now','localtime')
                   WHERE id=? AND status='pending'""",
                (attendant, delivery_id),
            )
            if cur.rowcount == 0:
                row = self.conn.execute(
                    "SELECT status, claimed_by FROM deliveries WHERE id=?",
                    (delivery_id,),
                ).fetchone()
                if row is None:
                    raise NotFound("配送单不存在")
                raise BusinessError(
                    f"配送单已被房务员 {row['claimed_by']} 认领，不能重复认领",
                    "ALREADY_CLAIMED",
                )
            self._commit()
        except Exception:
            self._rollback()
            raise

    def mark_delivered(self, delivery_id: int, *, delivered_on: str | None = None):
        """房务员送达（床架、被褥、枕头已按单配齐）。"""
        delivered_on = delivered_on or date.today().isoformat()
        datetime.strptime(delivered_on, "%Y-%m-%d")
        self._begin()
        try:
            d = self._get("deliveries", "id", delivery_id)
            if d["status"] != "claimed":
                raise BusinessError("仅已认领配送单可登记送达", "BAD_STATE")
            self.conn.execute(
                """UPDATE deliveries
                   SET status='delivered', delivered_at=datetime('now','localtime')
                   WHERE id=?""",
                (delivery_id,),
            )
            self.conn.execute(
                "UPDATE requests SET status='delivered', delivered_on=? WHERE id=?",
                (delivered_on, d["request_id"]),
            )
            self._commit()
        except Exception:
            self._rollback()
            raise

    def add_photo(self, delivery_id: int, stage: str, rel_path: str, note: str | None):
        self.conn.execute(
            """INSERT INTO inspection_photos (delivery_id, stage, rel_path, note)
               VALUES (?, ?, ?, ?)""",
            (delivery_id, stage, rel_path, note),
        )

    # --------------------------------------------------------------- 住客确认

    def guest_confirm(self, delivery_id: int, *, ends_on: str | None = None):
        """住客确认加床到位 → 按实际送达日到退房日计跨夜费用并入房账。"""
        self._begin()
        try:
            d = self._get("deliveries", "id", delivery_id)
            req = self._get("requests", "id", d["request_id"])
            if d["status"] != "delivered" or req["status"] != "delivered":
                raise BusinessError("仅已送达的配送单可请住客确认", "BAD_STATE")
            if ends_on:
                datetime.strptime(ends_on, "%Y-%m-%d")
                self.conn.execute(
                    "UPDATE requests SET ends_on=? WHERE id=?", (ends_on, req["id"])
                )
            ends = date.fromisoformat(ends_on or req["ends_on"])
            delivered = date.fromisoformat(req["delivered_on"])
            n = (ends - delivered).days
            if n < 1:
                raise BusinessError("至少跨夜 1 晚方可确认计费", "BAD_DATES")

            amount = nightly_total(req["quoted_cents"], req["guests_to_add"], n)
            res = self.billing.post_charge(
                self.conn,
                room_no=req["room_no"],
                request_id=req["id"],
                kind="nightly",
                amount_cents=amount,
                nights_count=n,
                detail=(
                    f"加床 {req['guests_to_add']} 张 × {n} 晚 × "
                    f"每床每晚 ￥{req['quoted_cents']/100:.2f}（住客确认）"
                ),
            )
            self.conn.execute(
                "UPDATE requests SET status='confirmed' WHERE id=?", (req["id"],)
            )
            self._commit()
            return {"nights": n, "amount_cents": amount, "ref": res.ref}
        except Exception:
            self._rollback()
            raise

    def extend_stay(self, request_id: int, new_ends_on: str, *, operator: str = "前台"):
        """跨夜续住：延长退房日期，新增夜晚按锁定的原报价补收。"""
        self._begin()
        try:
            req = self._get("requests", "id", request_id)
            if req["status"] != "confirmed":
                raise BusinessError("仅已确认的加床可办理跨夜续住", "BAD_STATE")
            old_end = date.fromisoformat(req["ends_on"])
            new_end = date.fromisoformat(new_ends_on)
            if new_end <= old_end:
                raise BusinessError("续住日期必须晚于原退房日期", "BAD_DATES")
            extra_nights = (new_end - old_end).days
            amount = nightly_total(
                req["quoted_cents"], req["guests_to_add"], extra_nights
            )
            self.billing.post_charge(
                self.conn,
                room_no=req["room_no"],
                request_id=req["id"],
                kind="nightly",
                amount_cents=amount,
                nights_count=extra_nights,
                detail=(
                    f"跨夜续住 {extra_nights} 晚 × {req['guests_to_add']} 张 × "
                    f"原报价 ￥{req['quoted_cents']/100:.2f}"
                ),
            )
            self.conn.execute(
                "UPDATE requests SET ends_on=? WHERE id=?", (new_ends_on, request_id)
            )
            self._commit()
            return {"extra_nights": extra_nights, "amount_cents": amount}
        except Exception:
            self._rollback()
            raise

    # --------------------------------------------------------------- 撤床/回收

    def _return_item(self, *, table, id_col, row_id, state, note):
        """把单件借出物回收入库；返回 (sku, item_type)。"""
        row = self._get(table, id_col, row_id)
        if state not in ("ok", "damaged", "missing"):
            raise BusinessError("回收状态只能是 ok/damaged/missing", "BAD_INPUT")

        if table == "frame_allocations":
            sku = row["frame_sku"]
            item_type = "frame"
            self.conn.execute(
                """UPDATE frame_allocations
                   SET status='recovered',
                       recovered_at=CASE WHEN ?='missing' THEN NULL
                                         ELSE datetime('now','localtime') END,
                       return_state=?, note=?
                   WHERE id=?""",
                (state, state, note, row_id),
            )
        else:
            sku = row["item_sku"]
            item_type = row["item_type"]
            self.conn.execute(
                f"""UPDATE {table}
                    SET returned_at=CASE WHEN ?='missing' THEN NULL
                                         ELSE datetime('now','localtime') END,
                        return_state=?, note=?
                    WHERE {id_col}=?""",
                (state, state, note, row_id),
            )

        if state == "missing":
            # 灭失：资产报废，不再回库
            self.conn.execute(
                "UPDATE inventory_items SET status='retired' WHERE sku=?", (sku,)
            )
        elif state == "damaged":
            self.conn.execute(
                """UPDATE inventory_items
                   SET status='available', condition='damaged' WHERE sku=?""",
                (sku,),
            )
        else:
            self.conn.execute(
                """UPDATE inventory_items
                   SET status='available', condition='ok' WHERE sku=?""",
                (sku,),
            )
        return sku, item_type

    def early_remove(self, delivery_id: int, *, removed_on: str | None = None):
        """提前撤床：未使用夜晚按原报价退还，另收一次性上门费，物品全部完好回收。"""
        removed_on = removed_on or date.today().isoformat()
        self._begin()
        try:
            d = self._get("deliveries", "id", delivery_id)
            req = self._get("requests", "id", d["request_id"])
            if req["status"] != "confirmed":
                raise BusinessError("仅已确认在住的加床可提前撤床", "BAD_STATE")
            removed = date.fromisoformat(removed_on)
            end = date.fromisoformat(req["ends_on"])
            delivered = date.fromisoformat(req["delivered_on"])
            if not (delivered <= removed < end):
                raise BusinessError("提前撤床日期需在送达后、退房前", "BAD_DATES")

            unused_nights = (end - removed).days
            refund = nightly_total(
                req["quoted_cents"], req["guests_to_add"], unused_nights
            )
            if refund:
                self.billing.post_charge(
                    self.conn,
                    room_no=req["room_no"],
                    request_id=req["id"],
                    kind="adjustment",
                    amount_cents=-refund,
                    nights_count=unused_nights,
                    detail=f"提前撤床：退还未使用 {unused_nights} 晚（按原报价）",
                )
            self.billing.post_charge(
                self.conn,
                room_no=req["room_no"],
                request_id=req["id"],
                kind="early_pickup",
                amount_cents=EARLY_PICKUP_FEE_CENTS,
                detail="提前撤床上门服务费",
            )

            for row in self.conn.execute(
                "SELECT id FROM frame_allocations WHERE delivery_id=? AND status='allocated'",
                (delivery_id,),
            ).fetchall():
                self._return_item(
                    table="frame_allocations", id_col="id", row_id=row["id"],
                    state="ok", note="提前撤床回收",
                )
            for row in self.conn.execute(
                "SELECT id FROM linen_loans WHERE delivery_id=? AND returned_at IS NULL",
                (delivery_id,),
            ).fetchall():
                self._return_item(
                    table="linen_loans", id_col="id", row_id=row["id"],
                    state="ok", note="提前撤床回收",
                )

            self.conn.execute(
                "UPDATE deliveries SET status='recovered', recovered_at=datetime('now','localtime') WHERE id=?",
                (delivery_id,),
            )
            self.conn.execute(
                "UPDATE requests SET status='early_removed' WHERE id=?", (req["id"],)
            )
            self._commit()
            return {"refund_cents": refund, "fee_cents": EARLY_PICKUP_FEE_CENTS}
        except Exception:
            self._rollback()
            raise

    def recover_and_settle(self, delivery_id: int, items: list[dict], *, role: str):
        """退房逐件回收结算。

        items: [{"kind": "frame"|"bedding"|"pillow", "id": 行id,
                 "state": "ok"|"damaged"|"missing", "note": 缺件/损耗原因}]
        必须逐件核对（防止退房漏收布草）；损坏与缺件当场计入房账。
        """
        self._begin()
        try:
            d = self._get("deliveries", "id", delivery_id)
            req = self._get("requests", "id", d["request_id"])
            if req["status"] != "confirmed":
                raise BusinessError(
                    "住客尚未确认计费，不能办理退房结算；请先完成送达与住客确认",
                    "BAD_STATE",
                )

            frames = self.conn.execute(
                "SELECT id FROM frame_allocations WHERE delivery_id=? AND status='allocated'",
                (delivery_id,),
            ).fetchall()
            linens = self.conn.execute(
                "SELECT id, item_type FROM linen_loans WHERE delivery_id=? AND returned_at IS NULL",
                (delivery_id,),
            ).fetchall()

            expect = {("frame", r["id"]) for r in frames}
            expect |= {(r["item_type"], r["id"]) for r in linens}
            seen = set()
            for it in items:
                key = (it["kind"], int(it["id"]))
                if key not in expect:
                    raise BusinessError(f"不属于本配送单的物品：{it}", "BAD_INPUT")
                if key in seen:
                    raise BusinessError(f"同一物品重复提交：{it}", "BAD_INPUT")
                seen.add(key)
            missing_keys = expect - seen
            if missing_keys:
                raise BusinessError(
                    "存在未逐件核对的借出物品（防止漏收布草）："
                    + ", ".join(f"{k[0]}#{k[1]}" for k in sorted(missing_keys)),
                    "ITEMS_UNCHECKED",
                )

            charges = []
            for it in items:
                state, note = it["state"], it.get("note") or ""
                if it["kind"] == "frame":
                    sku, item_type = self._return_item(
                        table="frame_allocations", id_col="id",
                        row_id=int(it["id"]), state=state, note=note,
                    )
                else:
                    sku, item_type = self._return_item(
                        table="linen_loans", id_col="id",
                        row_id=int(it["id"]), state=state, note=note,
                    )

                if state == "damaged":
                    if not note.strip():
                        raise BusinessError(
                            f"{TYPE_NAME[item_type]} {sku} 损坏必须登记损耗说明", "NO_REASON"
                        )
                    fee = DAMAGE_FEES[item_type]
                    res = self.billing.post_charge(
                        self.conn,
                        room_no=req["room_no"],
                        request_id=req["id"],
                        kind="damage",
                        amount_cents=fee,
                        detail=f"{TYPE_NAME[item_type]}损坏赔偿（{sku}）：{note}",
                    )
                    charges.append({"sku": sku, "type": item_type, "state": state,
                                    "amount_cents": fee, "ref": res.ref})
                elif state == "missing":
                    if not note.strip():
                        raise BusinessError(
                            f"{TYPE_NAME[item_type]} {sku} 缺件必须填写缺件原因", "NO_REASON"
                        )
                    fee = REPLACEMENT_FEES[item_type]
                    res = self.billing.post_charge(
                        self.conn,
                        room_no=req["room_no"],
                        request_id=req["id"],
                        kind="missing",
                        amount_cents=fee,
                        detail=f"{TYPE_NAME[item_type]}缺件赔偿（{sku}）：{note}",
                    )
                    charges.append({"sku": sku, "type": item_type, "state": state,
                                    "amount_cents": fee, "ref": res.ref})
                else:
                    charges.append({"sku": sku, "type": item_type, "state": state,
                                    "amount_cents": 0})

            self.conn.execute(
                "UPDATE deliveries SET status='recovered', recovered_at=datetime('now','localtime') WHERE id=?",
                (delivery_id,),
            )
            self.conn.execute(
                "UPDATE requests SET status='checked_out' WHERE id=?", (req["id"],)
            )
            self._commit()
            return charges
        except Exception:
            self._rollback()
            raise

    def waive_charge(self, entry_id: int, *, role: str, operator: str, reason: str):
        """免除损坏/缺件费用：仅前台可批，房务员无权自行免除。"""
        if role != "front_desk":
            raise PermissionDenied("房务员无权免除损坏/缺件费用，须由前台审批")
        if not reason.strip():
            raise BusinessError("免除费用必须填写原因", "BAD_INPUT")
        self._begin()
        try:
            row = self._get("ledger_entries", "id", entry_id)
            if row["kind"] not in ("damage", "missing"):
                raise BusinessError("仅损坏/缺件赔偿可申请免除", "BAD_STATE")
            already = self.conn.execute(
                "SELECT COALESCE(SUM(amount_cents),0) AS s FROM ledger_entries WHERE kind='adjustment' AND detail LIKE ?",
                (f"免除#{entry_id}%",),
            ).fetchone()["s"]
            if already != 0:
                raise BusinessError("该笔费用已免除", "ALREADY_WAIVED")
            self.billing.post_charge(
                self.conn,
                room_no=row["room_no"],
                request_id=row["request_id"],
                kind="adjustment",
                amount_cents=-row["amount_cents"],
                detail=f"免除#{entry_id}：{row['detail']}；审批人 {operator}；原因：{reason}",
            )
            self._commit()
        except Exception:
            self._rollback()
            raise

    def mark_storage_damaged(self, sku: str, note: str):
        """床架在出库/配送前发现损坏：标记隔离，不允许再分配（不向客人收费）。"""
        self._begin()
        try:
            row = self._get("inventory_items", "sku", sku)
            if row["status"] != "available":
                raise BusinessError("仅在库物品可登记损坏隔离", "BAD_STATE")
            self.conn.execute(
                "UPDATE inventory_items SET condition='damaged' WHERE sku=?", (sku,)
            )
            self._commit()
        except Exception:
            self._rollback()
            raise

    def replace_damaged_item(self, delivery_id: int, bad_sku: str, note: str):
        """配送前发现已分配物品损坏：隔离坏件并从库存改配一件好件（不向客人收费）。"""
        self._begin()
        try:
            d = self._get("deliveries", "id", delivery_id)
            if d["status"] != "claimed":
                raise BusinessError("仅已认领、未送达的配送单可改配", "BAD_STATE")
            item = self._get("inventory_items", "sku", bad_sku)
            if item["item_type"] == "frame":
                own = self.conn.execute(
                    "SELECT id FROM frame_allocations WHERE delivery_id=? AND frame_sku=?",
                    (delivery_id, bad_sku),
                ).fetchone()
            else:
                own = self.conn.execute(
                    "SELECT id FROM linen_loans WHERE delivery_id=? AND item_sku=? AND returned_at IS NULL",
                    (delivery_id, bad_sku),
                ).fetchone()
            if own is None:
                raise BusinessError("该物品不属于此配送单", "BAD_INPUT")

            # 隔离坏件（释放占用、标记损坏）
            self.conn.execute(
                "UPDATE inventory_items SET status='available', condition='damaged' WHERE sku=?",
                (bad_sku,),
            )
            new_sku = self._grab_items(item["item_type"], 1)[0]
            if item["item_type"] == "frame":
                self.conn.execute(
                    "UPDATE frame_allocations SET frame_sku=? WHERE id=?",
                    (new_sku, own["id"]),
                )
            else:
                self.conn.execute(
                    "UPDATE linen_loans SET item_sku=? WHERE id=?",
                    (new_sku, own["id"]),
                )
            self._commit()
            return {"bad_sku": bad_sku, "replacement": new_sku, "note": note}
        except Exception:
            self._rollback()
            raise

    # ------------------------------------------------------------------- 查询

    def list_requests(self, status: str | None = None):
        sql = """
            SELECT q.*, r.type_code, ro.status AS room_status
            FROM requests q
            JOIN rooms ro ON ro.room_no = q.room_no
            JOIN room_types r ON r.code = ro.type_code
        """
        args = ()
        if status:
            sql += " WHERE q.status=?"
            args = (status,)
        sql += " ORDER BY q.id"
        return [dict(r) for r in self.conn.execute(sql, args).fetchall()]

    def list_deliveries(self, status: str | None = None):
        sql = """
            SELECT d.*, q.room_no, q.guests_to_add, q.status AS request_status
            FROM deliveries d JOIN requests q ON q.id = d.request_id
        """
        args = ()
        if status:
            sql += " WHERE d.status=?"
            args = (status,)
        sql += " ORDER BY d.id"
        return [dict(r) for r in self.conn.execute(sql, args).fetchall()]

    def delivery_detail(self, delivery_id: int):
        d = self._get("deliveries", "id", delivery_id)
        req = self._get("requests", "id", d["request_id"])
        room = self._get("rooms", "room_no", req["room_no"])
        rt = self._get("room_types", "code", room["type_code"])
        frames = [
            dict(r)
            for r in self.conn.execute(
                """SELECT a.*, i.condition
                   FROM frame_allocations a JOIN inventory_items i ON i.sku=a.frame_sku
                   WHERE a.delivery_id=? ORDER BY a.id""",
                (delivery_id,),
            ).fetchall()
        ]
        linens = [
            dict(r)
            for r in self.conn.execute(
                "SELECT * FROM linen_loans WHERE delivery_id=? ORDER BY id",
                (delivery_id,),
            ).fetchall()
        ]
        photos = [
            dict(r)
            for r in self.conn.execute(
                "SELECT * FROM inspection_photos WHERE delivery_id=? ORDER BY id",
                (delivery_id,),
            ).fetchall()
        ]
        return {
            "delivery": dict(d),
            "request": dict(req),
            "room": dict(room),
            "room_type": dict(rt),
            "frames": frames,
            "linens": linens,
            "photos": photos,
            "ledger": [dict(r) for r in self.billing.list_entries(self.conn, req["id"])],
            "quote_history": self.quote_history(req["id"]),
        }

    def room_billing(self, room_no: str):
        entries = [
            dict(r)
            for r in self.conn.execute(
                "SELECT * FROM ledger_entries WHERE room_no=? ORDER BY id", (room_no,)
            ).fetchall()
        ]
        return {"room_no": room_no, "entries": entries,
                "balance_cents": self.billing.balance_cents(self.conn, room_no)}

    def inventory_summary(self):
        rows = self.conn.execute(
            """SELECT item_type,
                      SUM(CASE WHEN status='available' AND condition='ok' THEN 1 ELSE 0 END) AS ready,
                      SUM(CASE WHEN status='in_use' THEN 1 ELSE 0 END) AS in_use,
                      SUM(CASE WHEN condition='damaged' THEN 1 ELSE 0 END) AS damaged,
                      SUM(CASE WHEN status='retired' THEN 1 ELSE 0 END) AS retired,
                      COUNT(*) AS total
               FROM inventory_items GROUP BY item_type ORDER BY item_type"""
        ).fetchall()
        return [dict(r) for r in rows]
