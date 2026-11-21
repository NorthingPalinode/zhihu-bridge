"""日志规范（V6 §6.10）：只记步骤、耗时、来源 ID、错误码和模式；不记用户原文，只保留长度和哈希；不记凭证。"""
from __future__ import annotations

import json
import logging
import re

from .text import text_digest

log = logging.getLogger("bridge")

_SECRET_PATTERNS = [
    re.compile(r"(Bearer\s+)[A-Za-z0-9._\-]{6,}", re.IGNORECASE),
    re.compile(r"(sk-)[A-Za-z0-9_\-]{8,}"),
    re.compile(r"((?:api[_-]?key|secret|token|authorization)\"?\s*[:=]\s*\"?)[^\s\",}]{6,}", re.IGNORECASE),
]


def redact(text: str) -> str:
    out = text
    for p in _SECRET_PATTERNS:
        out = p.sub(lambda m: m.group(1) + "***", out)
    return out


def text_fingerprint(text: str) -> dict:
    return {"len": len(text), "sha256": text_digest(text)[:12]}


def event(step: str, **fields) -> None:
    safe = {k: v for k, v in fields.items() if k not in {"text", "apiKey", "secret"}}
    log.info(redact(json.dumps({"step": step, **safe}, ensure_ascii=False, default=str)))
