"""验收照片本地存储。"""
from __future__ import annotations

import time
import uuid
from pathlib import Path

ALLOWED_SUFFIX = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png"}


def save_photo(
    photos_dir: str | Path,
    delivery_id: int,
    stage: str,
    data: bytes,
    suffix: str = ".jpg",
) -> str:
    """写入 data/photos/，返回相对文件名（库存入数据库）。"""
    if stage not in ("delivery", "recovery"):
        raise ValueError("stage 必须是 delivery 或 recovery")
    suffix = suffix.lower()
    if suffix not in ALLOWED_SUFFIX:
        raise ValueError("仅支持 jpg/png 照片")
    if not data:
        raise ValueError("照片内容为空")
    folder = Path(photos_dir)
    folder.mkdir(parents=True, exist_ok=True)
    name = f"{stage}_delivery{delivery_id}_{int(time.time())}_{uuid.uuid4().hex[:8]}{suffix}"
    (folder / name).write_bytes(data)
    return name


def resolve(photos_dir: str | Path, rel_path: str) -> Path:
    # 防目录穿越
    p = (Path(photos_dir) / rel_path).resolve()
    root = Path(photos_dir).resolve()
    if root not in p.parents and p != root:
        raise ValueError("非法路径")
    return p
