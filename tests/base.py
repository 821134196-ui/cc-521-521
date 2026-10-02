"""测试公共夹具。"""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from hotel_beds.db import connect, init_db
from hotel_beds.seed import seed
from hotel_beds.service import HotelService


class ServiceCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = str(Path(self.tmp.name) / "test.db")
        conn = connect(self.db_path)
        init_db(conn)
        seed(conn, include_overbook_demo=False)
        conn.close()

    def service(self):
        return HotelService(connect(self.db_path))

    def tearDown(self):
        self.tmp.cleanup()

    # -- 常用流程助手 ------------------------------------------------------

    def make_confirmed(self, room_no="810", qty=1, ends_on="2026-10-06",
                       delivered_on="2026-10-02", attendant="小张"):
        """提交→派单→认领→送达→确认，返回 (request_id, delivery_id)。"""
        svc = self.service()
        rid = svc.submit_request(room_no=room_no, guests_to_add=qty, ends_on=ends_on)
        did = svc.assign_delivery(rid)
        svc.claim_delivery(did, attendant)
        svc.mark_delivered(did, delivered_on=delivered_on)
        svc.guest_confirm(did)
        return rid, did

    def all_items_payload(self, svc, did, *, state="ok", note=""):
        det = svc.delivery_detail(did)
        items = []
        for f in det["frames"]:
            if f["status"] == "allocated":
                items.append({"kind": "frame", "id": f["id"], "state": state, "note": note})
        for l in det["linens"]:
            if not l["returned_at"]:
                items.append({"kind": l["item_type"], "id": l["id"],
                              "state": state, "note": note})
        return items
