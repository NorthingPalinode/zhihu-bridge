"""Editor-authored translation drafts for the three built-in examples."""
from __future__ import annotations

import re

from ..contracts import RunRequest
from ..fixtures import Audience, Case
from ..core.strategy import guidance_for, requested_levels
from ..core.languages import get_language

PRESET_CASES = {"case_a", "case_b", "case_c"}
TERM_SPAN = re.compile(r"\[(\d+):([^\]]+)\]")


def bridge_preset(req: RunRequest, case: Case | None, audience: Audience, language: str, text: str, presets: dict) -> dict | None:
    if not req.usePreset or req.mode != "auto" or case is None or case.caseId not in PRESET_CASES:
        return None
    preset = presets.get(case.caseId, {})
    if req.caseId != case.caseId or text != case.text.strip() or text != preset.get("text"):
        return None
    drafts = preset["languages"].get(language)
    if drafts is None:
        return None

    levels = ["literal", *requested_levels(case.levels, True)]
    variants = []
    decisions = []
    for level, draft in zip(levels, drafts, strict=True):
        segments = []
        words = TERM_SPAN.split(draft)
        if words[0]:
            segments.append({"text": words[0]})
        for i in range(1, len(words), 3):
            number, landing, remainder = words[i:i + 3]
            term = case.terms[int(number) - 1]
            segment = {"text": landing, "termIds": [term.id]}
            if level != "literal":
                decision_id = f"P-{level}-{term.id}"
                source = next((d for d in case.decisions if d.termId == term.id), None)
                decisions.append({
                    "id": decision_id,
                    "termId": term.id,
                    "title": term.surface,
                    "choice": landing,
                    "rationale": preset["rationales"][term.id],
                    "attribution": source.attribution if source else "editor",
                    "evidenceIds": source.evidenceIds if source else [],
                    "levels": [level],
                })
                segment["decisionId"] = decision_id
            segments.append(segment)
            if remainder:
                segments.append({"text": remainder})
        variants.append({"level": level, "segments": segments})

    reason = audience.constraint if audience.recommendedLevel == "single" else guidance_for(
        audience.recommendedLevel, get_language(language).label,
    )
    return {"variants": variants, "decisions": decisions, "recommendationReason": reason}
