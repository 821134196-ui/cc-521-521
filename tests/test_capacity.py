"""容量限制：消防核准人数与房间空间双重校验。"""
from hotel_beds.errors import BusinessError
from tests.base import ServiceCase


class CapacityTests(ServiceCase):
    def test_over_fire_capacity_rejected(self):
        # 801 标准间核准 2 人，已住 2 人 → 加 1 床触发入住人数超限
        svc = self.service()
        with self.assertRaises(BusinessError) as cm:
            svc.submit_request(room_no="801", guests_to_add=1, ends_on="2026-10-05")
        self.assertEqual(cm.exception.code, "OVER_OCCUPANCY")
        self.assertIn("入住人数超限", cm.exception.message)

    def test_fire_capacity_stacks_with_existing_extra_beds(self):
        # 812 家庭房：3/5 人、空间 2；先加 2 床（5 人满），再加 1 床 → 超消防
        svc = self.service()
        rid = svc.submit_request(room_no="812", guests_to_add=2, ends_on="2026-10-08")
        svc.assign_delivery(rid)
        with self.assertRaises(BusinessError) as cm:
            svc.submit_request(room_no="812", guests_to_add=1, ends_on="2026-10-08")
        self.assertEqual(cm.exception.code, "OVER_OCCUPANCY")

    def test_space_limit_before_fire(self):
        # 820：2/5 人、空间 2；加 2 床（4 人）合法，再申请 1 床人数 5 不超消防，
        # 但折叠床位 3 > 2 → 房间空间不足
        svc = self.service()
        rid = svc.submit_request(room_no="820", guests_to_add=2, ends_on="2026-10-08")
        svc.assign_delivery(rid)
        with self.assertRaises(BusinessError) as cm:
            svc.submit_request(room_no="820", guests_to_add=1, ends_on="2026-10-08")
        self.assertEqual(cm.exception.code, "NO_SPACE")
        self.assertIn("房间空间不足", cm.exception.message)

    def test_room_status_shows_extra_beds(self):
        svc = self.service()
        rid = svc.submit_request(room_no="810", guests_to_add=1, ends_on="2026-10-08")
        svc.assign_delivery(rid)
        rooms = {r["room_no"]: r for r in svc.list_rooms()}
        self.assertEqual(rooms["810"]["extra_beds"], 1)
        self.assertEqual(rooms["810"]["current_guests"], 5)
        self.assertFalse(rooms["810"]["over_fire"])

    def test_bad_inputs(self):
        svc = self.service()
        with self.assertRaises(BusinessError):
            svc.submit_request(room_no="810", guests_to_add=0, ends_on="2026-10-08")
        with self.assertRaises(BusinessError):
            svc.submit_request(room_no="810", guests_to_add=1, ends_on="2026/10/08")
