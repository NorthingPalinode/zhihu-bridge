"""加载 fixtures/：案例、证据库、人设、守门词表、开发占位与预缓存。"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

from .contracts import Decision, Evidence, KeyPoint, SourceSegment, Term
from .core.strategy import requested_levels
from .core.text import build_segments, find_terms, normalize_text


@dataclass
class Audience:
    id: str
    label: str
    recommendedLevel: str
    constraint: str
    personaSetId: Optional[str]


@dataclass
class Case:
    caseId: str
    label: str
    industry: str
    scene: str
    text: str
    defaultAudienceId: str
    levels: list[str]
    audiences: list[Audience]
    terms: list[Term]
    keyPoints: list[KeyPoint]
    decisions: list[Decision]
    raw: dict[str, Any]

    def audience(self, audience_id: str) -> Optional[Audience]:
        return next((a for a in self.audiences if a.id == audience_id), None)

    @property
    def source_segments(self) -> list[SourceSegment]:
        return build_segments(self.text, self.terms)

    def public(self, *, expanded: bool = False) -> dict:
        return {
            "caseId": self.caseId,
            "label": self.label,
            "industry": self.industry,
            "scene": self.scene,
            "text": self.text,
            "defaultAudienceId": self.defaultAudienceId,
            "levels": requested_levels(self.levels, expanded),
            "audiences": [a.__dict__ for a in self.audiences],
            "testEnabled": bool(self.raw.get("testEnabled")),
            "testDisabledReason": self.raw.get("testDisabledReason"),
        }


def _load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


class FixtureStore:
    def __init__(self, root: Path):
        self.root = root
        self.cases: dict[str, Case] = {}
        for p in sorted((root / "cases").glob("*.json")):
            raw = _load_json(p)
            spans = find_terms(raw["text"], raw["terms"])
            terms = [
                Term(id=t["id"], surface=t["surface"], start=s, end=e, keyPointIds=t.get("keyPointIds", []), kind=t.get("kind", "culture"))
                for t, (s, e) in zip(raw["terms"], spans)
            ]
            self.cases[raw["caseId"]] = Case(
                caseId=raw["caseId"],
                label=raw["label"],
                industry=raw.get("industry", ""),
                scene=raw.get("scene", ""),
                text=raw["text"],
                defaultAudienceId=raw["defaultAudienceId"],
                levels=raw["levels"],
                audiences=[Audience(**a) for a in raw["audiences"]],
                terms=terms,
                keyPoints=[KeyPoint(**k) for k in raw.get("keyPoints", [])],
                decisions=[Decision(**d) for d in raw.get("decisions", [])],
                raw=raw,
            )
        ev = _load_json(root / "evidence" / "evidence_seed.json")
        self.corpus_version: str = ev["corpusVersion"]
        self.evidence: list[dict] = ev["items"]
        self.personas: dict[str, list[dict]] = _load_json(root / "personas" / "personas.json")["sets"]
        self.lexicon: dict = _load_json(root / "guard" / "claims_lexicon.json")
        rules_path = root / "guard" / "compliance_rules.json"
        self.compliance_rules: list[dict] = _load_json(rules_path).get("rules", []) if rules_path.exists() else []
        stubs = root / "dev_stubs"
        self.gen_stub: dict = _load_json(stubs / "generation.json") if (stubs / "generation.json").exists() else {}
        self.retell_stub: dict = _load_json(stubs / "retellings.json") if (stubs / "retellings.json").exists() else {}
        self.precached: list[dict] = [_load_json(p) for p in sorted((root / "zhihu_cache").glob("*.json"))]

    def case_evidence(self, case_id: str) -> list[Evidence]:
        out = []
        for item in self.evidence:
            if item.get("caseId") != case_id:
                continue
            data = {k: v for k, v in item.items() if k not in {"caseId", "origin"}}
            out.append(Evidence(**data))
        return out

    def match_case(self, case_id: Optional[str], text: str) -> Optional[Case]:
        """只有 caseId 存在且原文未被编辑时才视为预置案例（V6 §5.1：编辑后按自定义输入处理）。"""
        if not case_id:
            return None
        case = self.cases.get(case_id)
        if case and normalize_text(case.text) == normalize_text(text):
            return case
        return None

    def precached_questions(self, query: str) -> Optional[dict]:
        q = normalize_text(query)
        for entry in self.precached:
            if entry.get("kind") == "question_recommendations" and normalize_text(entry["query"]) == q:
                return entry
        return None
