"""跨夜费用：住客确认计费、跨夜续住按原报价、提前撤床退还未使用晚+上门费、改价留痕。"""
from hotel_beds.errors import BusinessError, PermissionDenied
from hotel_beds.pricing import EARLY_PICKUP_FEE_CENTS
from tests.base import ServiceCase


class NightlyBillingTests(ServiceCase):
    def test_confirm_charges_nights(self):
        # 家庭房挂牌价 18000/床/晚；10-02 送达，10-06 退房 = 4 晚
        svc = self.service()
        rid, did = self.make_confirmed(
            room_no="810", qty=1, ends_on="2026-10-06", delivered_on="2026-10-02"
        )
        bill = svc.room_billing("810")
        self.assertEqual(bill["balance_cents"], 18000 * 4)
        entry = bill["entries"][-1]
        self.assertEqual(entry["kind"], "nightly")
        self.assertEqual(entry["nights"], 4)
        self.assertTrue(entry["ref"].startswith("BILL-"))

    def test_multi_bed_nights(self):
        svc = self.service()
        _, did = self.make_confirmed(room_no="820", qty=2,
                                     ends_on="2026-10-05", delivered_on="2026-10-02")
        # 2 床 × 3 晚 × 18000 = 108000
        self.assertEqual(svc.room_billing("820")["balance_cents"], 108000)

    def test_confirm_requires_at_least_one_night(self):
        svc = self.service()
        rid = svc.submit_request(room_no="810", guests_to_add=1, ends_on="2026-10-02")
        did = svc.assign_delivery(rid)
        svc.claim_delivery(did, "小张")
        svc.mark_delivered(did, delivered_on="2026-10-02")
        with self.assertRaises(BusinessError) as cm:
            svc.guest_confirm(did)  # 退房日=送达日，0 晚
        self.assertEqual(cm.exception.code, "BAD_DATES")
        self.assertEqual(svc.room_billing("810")["balance_cents"], 0)

    def test_extend_stay_uses_locked_quote(self):
        svc = self.service()
        rid, did = self.make_confirmed(
            room_no="810", qty=1, ends_on="2026-10-06", delivered_on="2026-10-02"
        )  # 4 晚 × 18000 = 72000
        # 续住 2 晚 → 仍按确认时锁定价 18000
        res = svc.extend_stay(rid, "2026-10-08")
        self.assertEqual(res["extra_nights"], 2)
        self.assertEqual(res["amount_cents"], 36000)
        self.assertEqual(svc.room_billing("810")["balance_cents"], 108000)

        # 续住不能早于原退房日
        with self.assertRaises(BusinessError):
            svc.extend_stay(rid, "2026-10-07")

    def test_quote_adjust_keeps_original(self):
        svc = self.service()
        rid = svc.submit_request(room_no="810", guests_to_add=1, ends_on="2026-10-06")
        # 原挂牌 18000，前台优惠到 15000
        svc.adjust_quote(rid, 15000, role="front_desk", operator="前台小李")
        history = svc.quote_history(rid)
        self.assertEqual(history[0]["from_cents"], 18000)
        self.assertEqual(history[0]["to_cents"], 15000)

        did = svc.assign_delivery(rid)
        svc.claim_delivery(did, "小张")
        svc.mark_delivered(did, delivered_on="2026-10-02")
        svc.guest_confirm(did)
        # 按调整价 15000 × 4 晚
        self.assertEqual(svc.room_billing("810")["balance_cents"], 60000)

        # 房务员无权改价
        rid2 = svc.submit_request(room_no="812", guests_to_add=1, ends_on="2026-10-06")
        with self.assertRaises(PermissionDenied):
            svc.adjust_quote(rid2, 1000, role="attendant", operator="小王")

        # 已确认不可改价
        with self.assertRaises(BusinessError):
            svc.adjust_quote(rid, 9999, role="front_desk", operator="前台小李")

    def test_early_remove_refunds_unused_nights_plus_fee(self):
        svc = self.service()
        rid, did = self.make_confirmed(
            room_no="810", qty=1, ends_on="2026-10-06", delivered_on="2026-10-02"
        )  # 收费 4 晚 = 72000
        # 10-04 提前撤床：未使用 2 晚退还 36000，另收上门费
        res = svc.early_remove(did, removed_on="2026-10-04")
        self.assertEqual(res["refund_cents"], 36000)
        self.assertEqual(res["fee_cents"], EARLY_PICKUP_FEE_CENTS)
        self.assertEqual(
            svc.room_billing("810")["balance_cents"],
            72000 - 36000 + EARLY_PICKUP_FEE_CENTS,
        )
        # 物品全部回库可再用
        summary = {s["item_type"]: s for s in svc.inventory_summary()}
        self.assertEqual(summary["frame"]["in_use"], 0)
        self.assertEqual(summary["frame"]["ready"], 6)

        # 不能重复撤床
        with self.assertRaises(BusinessError):
            svc.early_remove(did, removed_on="2026-10-04")
