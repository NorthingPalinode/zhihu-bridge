"""整轮回放（V6 §6.9）。只接受 provenance == "real_run" 的冻结文件；开发占位一律拒绝。"""
from __future__ import annotations

import hashlib
import json
import logging
from pathlib import Path
from typing import Optional

from pydantic import ValidationError

from ..contracts import QuestionDraft, RunSnapshot, TestResult
from .text import normalize_text

log = logging.getLogger("bridge.replay")


def run_key(
    text: str,
    audience_id: str,
    prompt_version: str,
    corpus_version: str,
    target_language: str = "en",
) -> str:
    parts = [normalize_text(text), audience_id, prompt_version, corpus_version]
    if target_language and target_language != "en":
        parts.append(target_language)
    raw = "\x1f".join(parts)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]


def test_key(run_k: str, level: str, key_point_ids: list[str]) -> str:
    return hashlib.sha256(f"{run_k}|{level}|{','.join(sorted(key_point_ids))}".encode()).hexdigest()[:32]


def draft_key(source_text: str) -> str:
    return hashlib.sha256(normalize_text(source_text).encode("utf-8")).hexdigest()[:32]


class ReplayStore:
    """文件格式：{"provenance":"real_run","frozenAt":..., "key":..., "snapshot":{...}, "tests":{testKey: {...}}, "drafts":{draftKey: {...}}}"""

    def __init__(self, directory: Path):
        self.directory = Path(directory)
        self.entries: dict[str, dict] = {}
        self.rejected: list[str] = []
        if not self.directory.exists():
            return
        for p in sorted(self.directory.glob("*.json")):
            try:
                data = json.loads(p.read_text(encoding="utf-8"))
                self._load(data)
            except (OSError, ValueError, ValidationError, KeyError, TypeError, AttributeError) as exc:
                self.rejected.append(f"{p.name}: 回放格式或来源无效（{exc.__class__.__name__}）")
                log.warning("rejected replay file %s", p.name)
                continue

    def _load(self, data: dict) -> None:
        if data.get("provenance") != "real_run" or not isinstance(data.get("frozenAt"), str) or not data["frozenAt"]:
            raise ValueError("missing real-run provenance or freeze timestamp")
        snap = RunSnapshot.model_validate(data["snapshot"])
        source = "".join(seg.text for seg in snap.sourceSegments)
        key = run_key(source, snap.audienceId, snap.promptVersion, snap.corpusVersion, snap.targetLanguage)
        if snap.provenance != "real_run" or snap.mode not in ("live", "replay") or data["key"] != key:
            raise ValueError("snapshot does not match replay key")
        tests = {}
        for stored_key, raw in (data.get("tests") or {}).items():
            result = TestResult.model_validate(raw)
            if (result.provenance != "real_run" or result.runId != snap.runId or result.revision != snap.revision
                    or stored_key != test_key(key, result.level, result.keyPointIds)):
                raise ValueError("test result does not match replay snapshot")
            tests[stored_key] = result.model_dump()
        drafts = {}
        for stored_key, raw in (data.get("drafts") or {}).items():
            draft = QuestionDraft.model_validate(raw)
            if draft.provenance != "real_run":
                raise ValueError("draft is not a real run")
            drafts[stored_key] = draft.model_dump()
        if key in self.entries:
            raise ValueError("duplicate replay key")
        self.entries[key] = {**data, "snapshot": snap.model_dump(), "tests": tests, "drafts": drafts}

    def __len__(self) -> int:
        return len(self.entries)

    def get(self, key: str) -> Optional[dict]:
        return self.entries.get(key)

    def find_test(self, run_k: str, test_k: str) -> Optional[dict]:
        return self.entries.get(run_k, {}).get("tests", {}).get(test_k)

    def find_draft(self, run_k: str, draft_k: str) -> Optional[dict]:
        return self.entries.get(run_k, {}).get("drafts", {}).get(draft_k)
