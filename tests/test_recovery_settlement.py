"""退房回收结算：逐件核对、缺件/损坏赔偿、漏收拦截、免责权限、配送前坏件改配。"""
from hotel_beds.errors import BusinessError, PermissionDenied
from tests.base import ServiceCase


def item_map(svc, did):
    det = svc.delivery_detail(did)
    m = {}
    for f in det["frames"]:
        if f["status"] == "allocated":
            m[("frame", f["id"])] = f["frame_sku"]
    for l in det["linens"]:
        if not l["returned_at"]:
            m[(l["item_type"], l["id"])] = l["item_sku"]
    return m


class RecoverySettlementTests(ServiceCase):
    def _payload(self, svc, did, overrides=None, notes=None):
        overrides = overrides or {}
        notes = notes or {}
        items = []
        for (kind, row_id), sku in item_map(svc, did).items():
            state = overrides.get(sku, "ok")
            note = notes.get(sku, "回收验收")
            items.append({"kind": kind, "id": row_id, "state": state, "note": note})
        return items

    def test_all_ok_settlement(self):
        svc = self.service()
        _, did = self.make_confirmed(room_no="810", qty=1)
        charges = svc.recover_and_settle(
            did, self._payload(svc, did), role="front_desk"
        )
        self.assertTrue(all(c["state"] == "ok" and c["amount_cents"] == 0 for c in charges))
        # 库存全部回为可用
        self.assertEqual(
            svc.inventory_summary()[0]["ready"] + svc.inventory_summary()[1]["ready"] +
            svc.inventory_summary()[2]["ready"], 22
        )

    def test_missing_linen_charged_and_retired(self):
        svc = self.service()
        _, did = self.make_confirmed(room_no="810", qty=1)
        skus = {sku for (_k, _i), sku in item_map(svc, did).items()}
        bedding_sku = next(s for s in skus if s.startswith("BD"))
        items = self._payload(
            svc, did,
            overrides={bedding_sku: "missing"},
            notes={bedding_sku: "退房时被褥不见，客人承认带走后遗失"},
        )
        charges = svc.recover_and_settle(did, items, role="front_desk")
        miss = [c for c in charges if c["state"] == "missing"]
        self.assertEqual(len(miss), 1)
        self.assertEqual(miss[0]["amount_cents"], 30000)
        # 资产报废，不会再次入库
        row = svc.conn.execute(
            "SELECT status FROM inventory_items WHERE sku=?", (bedding_sku,)
        ).fetchone()
        self.assertEqual(row["status"], "retired")
        # 房账含跨夜费 + 缺件赔偿
        self.assertGreaterEqual(svc.room_billing("810")["balance_cents"], 30000)

    def test_damaged_frame_charged_and_quarantined(self):
        svc = self.service()
        _, did = self.make_confirmed(room_no="810", qty=1)
        frame_sku = next(s for s in item_map(svc, did).values() if s.startswith("FR"))
        items = self._payload(
            svc, did,
            overrides={frame_sku: "damaged"},
            notes={frame_sku: "床架横梁弯折无法展开"},
        )
        charges = svc.recover_and_settle(did, items, role="front_desk")
        dmg = [c for c in charges if c["state"] == "damaged"]
        self.assertEqual(dmg[0]["amount_cents"], 80000)
        row = svc.conn.execute(
            "SELECT status, condition FROM inventory_items WHERE sku=?", (frame_sku,)
        ).fetchone()
        self.assertEqual(row["condition"], "damaged")  # 回库但隔离，不再被分配

    def test_reason_required_for_damage_or_missing(self):
        svc = self.service()
        _, did = self.make_confirmed(room_no="810", qty=1)
        items = self._payload(svc, did)
        items[0]["state"] = "damaged"
        items[0]["note"] = ""
        with self.assertRaises(BusinessError) as cm:
            svc.recover_and_settle(did, items, role="front_desk")
        self.assertEqual(cm.exception.code, "NO_REASON")

    def test_missing_check_item_blocks_settlement(self):
        # 退房漏收布草：少核对一件，拒绝结算
        svc = self.service()
        _, did = self.make_confirmed(room_no="820", qty=2)
        items = self._payload(svc, did)
        items.pop()  # 故意漏掉最后一件
        with self.assertRaises(BusinessError) as cm:
            svc.recover_and_settle(did, items, role="front_desk")
        self.assertEqual(cm.exception.code, "ITEMS_UNCHECKED")
        # 单据仍处于未回收状态
        status = svc.conn.execute(
            "SELECT status FROM deliveries WHERE id=?", (did,)
        ).fetchone()["status"]
        self.assertNotEqual(status, "recovered")

    def test_attendant_cannot_waive_fee(self):
        svc = self.service()
        _, did = self.make_confirmed(room_no="810", qty=1)
        pillow = next(s for s in item_map(svc, did).values() if s.startswith("PL"))
        items = self._payload(
            svc, did, overrides={pillow: "missing"}, notes={pillow: "枕头缺失"}
        )
        svc.recover_and_settle(did, items, role="front_desk")
        entry = [e for e in svc.room_billing("810")["entries"] if e["kind"] == "missing"][0]

        # 房务员自己免除 → 403
        with self.assertRaises(PermissionDenied):
            svc.waive_charge(entry["id"], role="attendant", operator="小王", reason="算了")
        # 前台免除 → 冲账成功且留痕
        before = svc.room_billing("810")["balance_cents"]
        svc.waive_charge(entry["id"], role="front_desk", operator="前台经理",
                         reason="复查为前台漏配，非客人责任")
        after = svc.room_billing("810")["balance_cents"]
        self.assertEqual(after, before - entry["amount_cents"])
        # 不能重复免除
        with self.assertRaises(BusinessError):
            svc.waive_charge(entry["id"], role="front_desk", operator="前台经理", reason="x")

    def test_damaged_item_before_delivery_is_replaced_free(self):
        # 配送前床架损坏：隔离坏件、自动改配好件，不向客人收费
        svc = self.service()
        rid = svc.submit_request(room_no="810", guests_to_add=1, ends_on="2026-10-06")
        did = svc.assign_delivery(rid)
        svc.claim_delivery(did, "小张")
        bad = svc.delivery_detail(did)["frames"][0]["frame_sku"]
        res = svc.replace_damaged_item(did, bad, "出库时发现床架焊点开裂")
        self.assertNotEqual(res["replacement"], bad)
        # 坏件已隔离、好件在配送单上
        det = svc.delivery_detail(did)
        self.assertEqual(det["frames"][0]["frame_sku"], res["replacement"])
        self.assertEqual(
            svc.conn.execute("SELECT condition FROM inventory_items WHERE sku=?", (bad,))
            .fetchone()["condition"], "damaged"
        )
        # 后续确认没有任何损坏费用
        svc.mark_delivered(did, delivered_on="2026-10-02")
        svc.guest_confirm(did)
        kinds = {e["kind"] for e in svc.room_billing("810")["entries"]}
        self.assertNotIn("damage", kinds)
