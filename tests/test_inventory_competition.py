"""库存竞争：床架分配不可重叠；并发双认领只成功一次。"""
import threading
import unittest

from hotel_beds.db import connect
from hotel_beds.errors import BusinessError
from tests.base import ServiceCase


class InventoryCompetitionTests(ServiceCase):
    def test_frame_no_overlap_sequential(self):
        # 种子有 6 个床架；合法派满 6 张后库存为 0
        svc = self.service()
        for room, qty in [("812", 2), ("820", 2), ("901", 2)]:
            rid = svc.submit_request(room_no=room, guests_to_add=qty, ends_on="2026-10-09")
            svc.assign_delivery(rid)
        in_use = {s["item_type"]: s["in_use"] for s in svc.inventory_summary()}
        self.assertEqual(in_use["frame"], 6)
        self.assertEqual(in_use["bedding"], 6)
        self.assertEqual(in_use["pillow"], 6)

        # 再派一单（802 豪华大床还能放 1 张）→ 床架库存不足
        rid = svc.submit_request(room_no="802", guests_to_add=1, ends_on="2026-10-09")
        with self.assertRaises(BusinessError) as cm:
            svc.assign_delivery(rid)
        self.assertEqual(cm.exception.code, "OUT_OF_STOCK")
        # 申请仍为 submitted，未生成配送单
        self.assertEqual(
            svc.conn.execute("SELECT status FROM requests WHERE id=?", (rid,)).fetchone()["status"],
            "submitted",
        )
        # 没有任何床架被重叠/半单占用
        dup = svc.conn.execute(
            """SELECT frame_sku FROM frame_allocations WHERE status='allocated'
               GROUP BY frame_sku HAVING COUNT(*) > 1"""
        ).fetchall()
        self.assertEqual(dup, [])

    def test_shortage_rolls_back_half_grab(self):
        # 手工把部分布草标损，使床架够、被褥不够：整单回滚，床架不被锁住
        svc = self.service()
        conn = svc.conn
        skus = [r["sku"] for r in conn.execute(
            "SELECT sku FROM inventory_items WHERE item_type='bedding' ORDER BY id LIMIT 3"
        ).fetchall()]
        for sku in skus:
            svc.mark_storage_damaged(sku, "演示用：布草污损隔离")
        # 可用被褥 5 条；812 要 2 床成功，820 要 2 床成功（共 4），901 再要 2 床 → 被褥不足
        for room in ("812", "820"):
            rid = svc.submit_request(room_no=room, guests_to_add=2, ends_on="2026-10-09")
            svc.assign_delivery(rid)
        rid = svc.submit_request(room_no="901", guests_to_add=2, ends_on="2026-10-09")
        with self.assertRaises(BusinessError) as cm:
            svc.assign_delivery(rid)
        self.assertEqual(cm.exception.code, "OUT_OF_STOCK")
        # 床架仍只占用 4 个（未被失败单锁住第五、第六个）
        in_use_frames = conn.execute(
            "SELECT COUNT(*) c FROM inventory_items WHERE item_type='frame' AND status='in_use'"
        ).fetchone()["c"]
        self.assertEqual(in_use_frames, 4)

    def test_concurrent_claim_only_one_wins(self):
        svc = self.service()
        rid = svc.submit_request(room_no="810", guests_to_add=1, ends_on="2026-10-09")
        did = svc.assign_delivery(rid)

        results = []
        barrier = threading.Barrier(3)

        def claim(name):
            conn = connect(self.db_path)
            local = __import__("hotel_beds.service", fromlist=["HotelService"]).HotelService(conn)
            barrier.wait()
            try:
                local.claim_delivery(did, name)
                results.append((name, "ok"))
            except BusinessError as e:
                results.append((name, e.code))
            finally:
                conn.close()

        threads = [threading.Thread(target=claim, args=(n,)) for n in ("小张", "小王", "小李")]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        oks = [r for r in results if r[1] == "ok"]
        self.assertEqual(len(oks), 1, f"应只有一人认领成功，实际：{results}")
        winner = oks[0][0]
        self.assertTrue(all(r[0] != winner or r[1] == "ok" for r in results))

        # 库内认领人唯一
        row = svc.conn.execute("SELECT claimed_by, status FROM deliveries WHERE id=?", (did,)).fetchone()
        self.assertEqual(row["status"], "claimed")
        self.assertEqual(row["claimed_by"], winner)

    def test_concurrent_assign_no_frame_overlap(self):
        # 两笔不同房间的单，各自在独立连接/线程派单，床架集合不得相交
        svc = self.service()
        r1 = svc.submit_request(room_no="810", guests_to_add=1, ends_on="2026-10-09")
        r2 = svc.submit_request(room_no="812", guests_to_add=1, ends_on="2026-10-09")

        out = {}

        def assign(rid, key):
            conn = connect(self.db_path)
            local = __import__("hotel_beds.service", fromlist=["HotelService"]).HotelService(conn)
            try:
                did = local.assign_delivery(rid)
                skus = [r["frame_sku"] for r in conn.execute(
                    "SELECT frame_sku FROM frame_allocations WHERE delivery_id=?", (did,)
                ).fetchall()]
                out[key] = skus
            except BusinessError as e:
                out[key] = e.code
            finally:
                conn.close()

        t1 = threading.Thread(target=assign, args=(r1, "a"))
        t2 = threading.Thread(target=assign, args=(r2, "b"))
        t1.start(); t2.start(); t1.join(); t2.join()
        self.assertTrue(out["a"] and out["b"])
        self.assertEqual(set(out["a"]) & set(out["b"]), set(), "床架被重叠分配")


if __name__ == "__main__":
    unittest.main()
