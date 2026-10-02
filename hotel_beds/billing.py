"""房账适配器（模拟）。

真实环境这里会对接 PMS；当前用本地 SQLite ledger_entries 表模拟，
返回带凭证号的成功结果，便于业务层与界面引用。
"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass


@dataclass
class ChargeResult:
    ok: bool
    ref: str
    entry_id: int


class SimulatedBillingAdapter:
    """所有写入与业务事务使用同一连接，保证计费与状态同时成功或回滚。"""

    def post_charge(
        self,
        conn: sqlite3.Connection,
        *,
        room_no: str,
        kind: str,
        amount_cents: int,
        detail: str,
        request_id: int | None = None,
        nights_count: int | None = None,
    ) -> ChargeResult:
        cur = conn.execute(
            """
            INSERT INTO ledger_entries
                (room_no, request_id, kind, amount_cents, detail, nights, ref)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (room_no, request_id, kind, amount_cents, detail, nights_count, None),
        )
        entry_id = cur.lastrowid
        ref = f"BILL-{entry_id:06d}"
        conn.execute("UPDATE ledger_entries SET ref=? WHERE id=?", (ref, entry_id))
        return ChargeResult(ok=True, ref=ref, entry_id=entry_id)

    def balance_cents(self, conn: sqlite3.Connection, room_no: str) -> int:
        row = conn.execute(
            "SELECT COALESCE(SUM(amount_cents),0) AS s FROM ledger_entries WHERE room_no=?",
            (room_no,),
        ).fetchone()
        return row["s"]

    def list_entries(self, conn: sqlite3.Connection, request_id: int):
        return conn.execute(
            "SELECT * FROM ledger_entries WHERE request_id=? ORDER BY id",
            (request_id,),
        ).fetchall()
