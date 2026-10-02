"""计价规则。

金额一律以「分」存储，展示层再格式化。
"""
from __future__ import annotations

from datetime import date

# 损坏赔偿（每件，分）
DAMAGE_FEES = {
    "frame": 80000,    # 床架损坏 ￥800
    "bedding": 20000,  # 被褥损坏 ￥200
    "pillow": 8000,    # 枕头损坏 ￥80
}

# 缺件赔偿（按灭失重置价，每件，分）
REPLACEMENT_FEES = {
    "frame": 120000,
    "bedding": 30000,
    "pillow": 12000,
}

# 提前撤床收取一次性上门费（分），未使用夜晚按原报价退还
EARLY_PICKUP_FEE_CENTS = 5000

TYPE_NAME = {"frame": "床架", "bedding": "被褥", "pillow": "枕头"}


def nights(delivered_on: date, ends_on: date) -> int:
    """跨夜数：退房当天不计费。"""
    n = (ends_on - delivered_on).days
    if n < 0:
        raise ValueError("退房日期早于配送日期")
    return n


def nightly_total(price_per_bed_cents: int, beds: int, nights_count: int) -> int:
    return price_per_bed_cents * beds * nights_count


def format_yuan(cents: int) -> str:
    sign = "-" if cents < 0 else ""
    return f"{sign}￥{abs(cents) / 100:.2f}"
