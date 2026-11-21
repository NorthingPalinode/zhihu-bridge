"""知乎回流闭环（V6 §4.3，P0-7）：误解句 / 用户粘贴 → 查知乎已有讨论 → 可编辑提问草稿 → 复制。系统不发布。"""
from __future__ import annotations

import uuid

from ..adapters.llm import DraftContext, LLMError
from ..adapters.zhihu import ZhihuError
from ..contracts import DraftBody, ExistingItem, QuestionDraft, QuestionDraftRequest
from ..core.logs import event as log_event
from ..core.logs import text_fingerprint
from ..core.replay import draft_key
from .deps import Deps

SOURCE_LABELS = {
    "reader_misreading": "模拟读者误解（非真实用户）",
    "manual": "用户粘贴",
    "example": "示例输入",
    "guard_gap": "守门待补材料",
}


class DraftError(ValueError):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def _fmt_time(iso: str | None) -> str:
    return (iso or "").replace("T", " ")[:16]


async def make_draft(req: QuestionDraftRequest, deps: Deps) -> QuestionDraft:
    src = req.source
    if src.kind == "guard_gap":
        raise DraftError(400, "“守门待补材料”来源属于 P1-2，本阶段未开放")
    if src.kind == "reader_misreading" and src.testId:
        test = deps.tests.get(src.testId)
        if not test or (req.runId and test.runId != req.runId):
            raise DraftError(404, "找不到该运行对应的模拟读者测试")
    label = SOURCE_LABELS[src.kind]
    case = deps.fx.cases.get(req.caseId) if req.caseId else None
    rec = deps.runs.get(req.runId) if req.runId else None
    if rec is not None and rec.snapshot.mode == "replay":
        frozen = deps.replays.find_draft(rec.key, draft_key(src.text))
        if not frozen or frozen["sourceLabel"] != label:
            raise DraftError(404, "该回放中没有对应的冻结提问草稿")
        return QuestionDraft(**{**frozen, "mode": "replay", "existingSource": "replay" if frozen["existing"] else frozen["existingSource"]})
    if deps.llm is None:
        raise DraftError(503, "提问草稿需要先配置转译模型")
    kps = rec.snapshot.keyPoints if rec else (case.keyPoints if case else [])
    terms = rec.snapshot.terms if rec else (case.terms if case else [])

    term = None
    if req.termIds:
        term = next((t for t in terms if t.id == req.termIds[0]), None)
    if term is None and src.keyPointId:
        term = next((t for t in terms if src.keyPointId in t.keyPointIds), None)
    kp = next((k for k in kps if k.id == src.keyPointId), None) if src.keyPointId else None

    seeds = (case.raw.get("flowbackQueries", {}) if case else {})
    preset_query = seeds.get(term.id) if term else None
    query = preset_query or (f"{term.surface} 外国人 怎么理解" if term else src.text[:20])
    if not preset_query:
        try:
            query = await deps.call_llm(deps.llm.refine_query, query, src.text)
        except LLMError:
            pass

    existing: list[dict] = []
    existing_source, note = "none", ""
    fake_zhihu_fail = deps.settings.is_fake and deps.settings.fake_failure == "zhihu"
    pre = None if fake_zhihu_fail else deps.fx.precached_questions(query)
    if fake_zhihu_fail:
        existing_source, note = "failed", "查询失败（FAKE_FAILURE=zhihu 本地故障演练）"
    elif deps.zhihu.enabled and not deps.zhihu_auth_failed:
        try:
            existing, s, fetched = await deps.zhihu.question_recommendations(query)
            existing_source = "zhihu_live" if s == "zhihu_live" else "cache"
            note = ("知乎实时" if s == "zhihu_live" else "缓存") + (
                f" · {_fmt_time(fetched)} UTC" if fetched else ""
            ) + f" · 查询词：{query}"
        except ZhihuError as exc:
            if exc.kind == "auth":
                deps.zhihu_auth_failed = True
            existing_source = "failed"
            note = ("项目共享问题发现额度已用完，可在首页导入个人 Access Secret。"
                    if exc.kind == "budget" else f"查询失败（{exc.kind}）")
    else:
        note = "知乎实时查询未启用"

    if pre and existing_source in ("none", "failed"):
        fallback_reason = note
        existing = pre["items"][:5]
        existing_source = "cache"
        note = f"缓存 · {_fmt_time(pre.get('fetchedAt'))} UTC 实测 · 查询词：{pre['query']}"
        if fallback_reason:
            note += f" · {fallback_reason}"

    dctx = DraftContext(
        case_id=case.caseId if case else None, source_kind=src.kind, source_text=src.text, source_label=label,
        term_surface=term.surface if term else None, key_point_text=kp.text if kp else None, query=query, existing=existing,
        target_language=rec.snapshot.targetLanguage if rec else "en",
    )
    try:
        body = await deps.call_llm(deps.llm.draft_question, dctx)
        draft = DraftBody(title=str(body["title"]), body=str(body["body"]))
    except (LLMError, KeyError, TypeError) as exc:
        raise DraftError(502, f"提问草稿生成失败（{exc.__class__.__name__}），请重试") from exc
    try:
        rec_out = await deps.call_llm(deps.llm.recommend, dctx)
    except LLMError:
        rec_out = {"recommendation": "new_question", "reason": "建议判断未完成，默认新提问"}

    out = QuestionDraft(
        draftId="q_" + uuid.uuid4().hex[:10], query=query,
        existing=[ExistingItem(**e) for e in existing], existingSource=existing_source, existingNote=note,
        recommendation=rec_out["recommendation"], recommendationReason=rec_out.get("reason", ""),
        draft=draft, sourceLabel=label, mode=deps.generation_mode, provenance=deps.llm.provenance,
    )
    log_event("draft.done", draftId=out.draftId, kind=src.kind, existingSource=existing_source, mode=out.mode, **text_fingerprint(src.text))
    return out
