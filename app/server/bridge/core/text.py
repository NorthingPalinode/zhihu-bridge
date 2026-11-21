"""文本工具：规范化、术语定位、sourceSegments（前端只渲染分段，不自行按偏移切字符串）。"""
from __future__ import annotations

import hashlib
import re
import unicodedata
from typing import Iterable

_WS = re.compile(r"\s+")


def normalize_text(text: str) -> str:
    return _WS.sub(" ", unicodedata.normalize("NFKC", text or "")).strip()


def text_digest(text: str) -> str:
    return hashlib.sha256(normalize_text(text).encode("utf-8")).hexdigest()


def find_terms(text: str, terms: Iterable[dict]) -> list[tuple[int, int]]:
    """按码点偏移定位每个术语首次出现的位置；找不到时抛错（fixture 错误应在加载时暴露）。"""
    spans = []
    for t in terms:
        idx = text.find(t["surface"])
        if idx < 0:
            raise ValueError(f"术语 {t['surface']!r} 不在原文中")
        spans.append((idx, idx + len(t["surface"])))
    return spans


def build_segments(text: str, terms) -> list:
    from ..contracts import SourceSegment

    ordered = sorted(terms, key=lambda t: t.start)
    segs: list[SourceSegment] = []
    pos = 0
    for t in ordered:
        if t.start < pos:
            continue  # 重叠术语：保留先出现的
        if t.start > pos:
            segs.append(SourceSegment(text=text[pos:t.start], termId=None))
        segs.append(SourceSegment(text=text[t.start:t.end], termId=t.id))
        pos = t.end
    if pos < len(text):
        segs.append(SourceSegment(text=text[pos:], termId=None))
    return segs


def variant_text(segments) -> str:
    return "".join(s.text if hasattr(s, "text") else s["text"] for s in segments)
