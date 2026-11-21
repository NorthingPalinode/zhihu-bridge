"""确定性 fake 适配器：无凭据时让完整流程可操作。所有产出都是开发占位（provenance=dev_stub），不是模型输出、不是评测结果。"""
from __future__ import annotations

import asyncio
import re
from typing import Any

from ..core.languages import get_language
from .llm import DraftContext, GenerateContext, LLMError

PLACEHOLDER_EN = "[开发占位] 未接入真实模型，无法为自定义输入生成译稿。"


class FakeLLM:
    name = "fake"
    model_version = "fake-dev-stub-v1"
    provenance = "dev_stub"

    def __init__(self, fixtures, settings):
        self.fx = fixtures
        self.settings = settings

    async def _pause(self, factor: float = 1.0) -> None:
        ms = self.settings.fake_step_delay_ms * factor
        if ms > 0:
            await asyncio.sleep(ms / 1000)

    def _fail(self, step: str) -> None:
        if self.settings.fake_failure == step:
            raise LLMError("upstream", f"FAKE_FAILURE={step}：本地故障演练")

    async def extract_terms(self, text: str) -> dict:
        await self._pause(0.5)
        # fake 不做语义抽取：自定义输入不标术语，界面会如实显示“未识别术语（开发占位）”。
        return {"terms": [], "keyPoints": []}

    async def generate(self, ctx: GenerateContext) -> dict:
        await self._pause(1.5)
        self._fail("generate")
        lang = get_language(ctx.target_language)
        stub_case = self.fx.gen_stub.get(ctx.case_id or "", None) if lang.code == "en" else None
        if not stub_case:
            if lang.code != "en":
                message = f"[开发占位] {lang.label}（{lang.nativeName}）译稿需要启用真实模型。"
            else:
                message = "[开发占位] 此案例的译稿需要启用真实模型。" if ctx.case_id else PLACEHOLDER_EN
            seg = [{"text": message, "termIds": [], "evidenceIds": []}]
            return {
                "recommendationReason": message,
                "variants": [{"level": "literal", "segments": seg, "notes": []}]
                + [{"level": lv, "segments": seg, "notes": [], "placeholder": True} for lv in ctx.levels],
                "decisions": [],
            }
        variants = [{"level": "literal", **stub_case["literal"]}]
        for lv in ctx.levels:
            key = f"{lv}_candidate" if f"{lv}_candidate" in stub_case else lv
            variants.append({"level": lv, **stub_case[key]})
        return {
            "recommendationReason": stub_case["recommendationReason"].get(ctx.audience_id, ""),
            "variants": variants,
            "decisions": [d.model_dump() for d in ctx.planned_decisions],
        }

    async def semantic_check(self, ctx: GenerateContext, level: str, text: str) -> list[dict]:
        await self._pause(0.3)
        return []  # fake 不做语义判断，只依赖确定性规则

    async def rewrite(self, ctx: GenerateContext, level: str, text: str, problems: list[str]) -> dict:
        await self._pause(0.5)
        self._fail("rewrite")
        lang = get_language(ctx.target_language)
        if lang.code != "en":
            raise LLMError("unavailable", f"fake 适配器仅提供英语改写占位，{lang.label}改写需要启用真实模型")
        stub_case = self.fx.gen_stub.get(ctx.case_id or "", {})
        rw = stub_case.get(f"{level}_rewrite")
        if not rw:
            raise LLMError("unavailable", "fake 没有该档的改写占位")
        return rw

    async def retell(self, ctx: GenerateContext, persona: dict, version_level: str, text: str) -> str:
        await self._pause(0.6)
        if self.settings.fake_failure == "retell_partial" and persona["id"].endswith("_3"):
            raise LLMError("timeout", "FAKE_FAILURE=retell_partial：本地故障演练")
        lang = get_language(ctx.target_language)
        if lang.code != "en":
            raise LLMError("unavailable", f"fake 适配器仅提供英语复述占位，{lang.label}复述需要启用真实模型")
        table = self.fx.retell_stub.get(ctx.case_id or "", {}).get(persona["id"], {})
        if version_level not in table:
            raise LLMError("unavailable", "fake 没有该人设/版本的复述占位")
        return table[version_level]

    async def judge(self, ctx: GenerateContext, key_points: list[Any], retellings: list[str], rules: dict) -> list[list[dict]]:
        await self._pause(0.4)
        out = []
        for text in retellings:
            out.append([rule_judge(kp.id, text, rules.get(kp.id, {})) for kp in key_points])
        return out

    async def refine_query(self, seed_query: str, source_text: str) -> str:
        return seed_query

    async def draft_question(self, ctx: DraftContext) -> dict:
        await self._pause(0.5)
        term = ctx.term_surface or "这句话"
        title = f"海外读者对「{term}」的理解和原意不一致，该怎样向他们解释？"
        lines = [
            f"【海外读者原本的理解】{ctx.source_text}",
            f"【和原意的差异】原句要传达的是：{ctx.key_point_text}" if ctx.key_point_text else "【和原意的差异】待编辑补充",
            f"【希望答主解释】「{term}」在原文语境里是什么意思，以及怎样向没有相关背景的海外读者讲清楚。",
            f"【来源】{ctx.source_label}",
        ]
        return {"title": title, "body": "\n".join(lines)}

    async def recommend(self, ctx: DraftContext) -> dict:
        if not ctx.existing:
            return {"recommendation": "new_question", "reason": "没有查到已有讨论（规则判断）"}
        cues = ("翻译", "英文", "英译", "海外", "外国", "老外")
        related = [e for e in ctx.existing if any(c in e["title"] for c in cues)]
        if related:
            return {"recommendation": "answer_existing", "reason": "已有讨论涉及翻译或海外读者（规则判断）"}
        return {"recommendation": "new_question", "reason": "已有讨论没有涉及海外读者的理解（规则判断）"}


def rule_judge(kp_id: str, text: str, rule: dict) -> dict:
    low = text.lower()
    for w in rule.get("contradicted", []):
        if w in low:
            return {"keyPointId": kp_id, "verdict": "contradicted", "quote": _quote(text, w)}
    if "hitAll" in rule:
        ok = all(any(w in low for w in group) for group in rule["hitAll"])
        word = rule["hitAll"][0][0]
    else:
        hits = [w for w in rule.get("hit", []) if w in low]
        ok, word = bool(hits), (hits[0] if hits else "")
    if ok:
        return {"keyPointId": kp_id, "verdict": "hit", "quote": _quote(text, word)}
    return {"keyPointId": kp_id, "verdict": "missing", "quote": text}


def _quote(text: str, word: str) -> str:
    parts = re.split(r"(?<=[.;!?])\s+", text)
    for p in parts:
        if word and word in p.lower():
            return p
    return text
