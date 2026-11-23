"""运行管线（V6 §6.2）：校验 → terms → evidence → generate → check → ready。"""
from __future__ import annotations

import asyncio
import itertools
import re
import uuid
from dataclasses import replace
from datetime import datetime, timezone
from typing import AsyncIterator, Optional

from pydantic import ValidationError

from ..adapters.llm import GenerateContext, LLMError
from ..adapters.zhihu import ZhihuError, clean_title, public_zhihu_url
from ..contracts import Check, Decision, Evidence, KeyPoint, Note, RunRequest, RunSnapshot, Segment, Term, Variant
from ..core import guard
from ..core.ids import ReferenceError_, validate_references
from ..core.languages import get_language, script_check
from ..core.logs import event as log_event
from ..core.logs import text_fingerprint
from ..core.replay import run_key
from ..core.strategy import requested_levels
from ..core.text import build_segments, text_digest, variant_text
from ..fixtures import Audience
from .deps import Deps, RunRecord

MAX_CHARS = 400
EVIDENCE_SUMMARY_CHARS = 120
EVIDENCE_EXCERPT_CHARS = 600
HAN = re.compile(r"[\u3400-\u9fff]")


UNIVERSAL_PCT_RE = re.compile(r"\d+(?:[.,]\d+)?\s*%")

GENERAL_AUDIENCE = Audience(
    id="general_overseas",
    label="海外 · 通用目标受众",
    recommendedLevel="plain",
    constraint="面向目标市场的海外通用读者，用自然准确的目标语言传达核心信息，避免生硬直译和未经证实的宣传声称",
    personaSetId=None,
)


class InputError(ValueError):
    pass


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def validate_request(req: RunRequest, deps: Deps):
    text = req.text.strip()
    if not text:
        raise InputError("请输入原文")
    if len(text) > MAX_CHARS:
        raise InputError(f"原文超过 {MAX_CHARS} 字符（当前 {len(text)}）")
    try:
        lang = get_language(req.targetLanguage)
    except KeyError as exc:
        raise InputError("目标语言不支持") from exc
    case = deps.fx.match_case(req.caseId, text)
    audiences = case.audiences if case else [GENERAL_AUDIENCE, *[a for c in deps.fx.cases.values() for a in c.audiences]]
    aud = next((a for a in audiences if a.id == req.audienceId), None)
    if aud is None:
        raise InputError("受众不合法")
    return text, case, aud, lang


async def execute_run(req: RunRequest, deps: Deps) -> AsyncIterator[dict]:
    text, case, aud, lang = validate_request(req, deps)
    run_id = "r_" + uuid.uuid4().hex[:12]
    seq = itertools.count(1)

    def ev(type_: str, payload: dict) -> dict:
        return {"runId": run_id, "seq": next(seq), "type": type_, "payload": payload}

    s = deps.settings
    mode = deps.generation_mode
    key = run_key(text, aud.id, s.prompt_version, deps.fx.corpus_version, lang.code)
    log_event("run.started", runId=run_id, caseId=case.caseId if case else None, audienceId=aud.id, targetLanguage=lang.code, mode=mode, **text_fingerprint(text))
    yield ev("started", {"audienceId": aud.id, "audienceLabel": aud.label, "caseId": case.caseId if case else None,
                         "targetLanguage": lang.code, "mode": "replay" if req.mode == "replay" else mode})

    if req.mode == "replay":
        entry = deps.replays.get(key)
        if not entry:
            yield ev("error", {"step": "replay", "message": "没有与该输入匹配的真实运行回放", "mode": "degraded", "retryable": False})
            return
        async for e in _play_replay(entry, ev, deps, reason=None, run_id=run_id):
            yield e
        return

    # ---- terms ----
    notices: list[str] = []
    if case:
        terms, key_points = list(case.terms), list(case.keyPoints)
    else:
        terms, key_points = await _custom_terms(text, deps, notices)
    yield ev("terms", {
        "sourceSegments": [x.model_dump() for x in build_segments(text, terms)],
        "terms": [t.model_dump() for t in terms],
        "keyPoints": [k.model_dump() for k in key_points],
    })

    # ---- evidence ----
    curated = deps.fx.case_evidence(case.caseId) if case else []
    query = case.raw.get("searchQuery") if case else None
    aliases = case.raw.get("searchAliases", {}) if case else {}
    should_search = (not curated) or deps.zhihu.uses_personal_quota or deps.settings.zhihu_preset_live_search
    fetched, excerpts = (
        await _retrieve_evidence(text, terms, deps, notices, query=query, aliases=aliases)
        if should_search
        else ([], {})
    )
    extra_fetched: list[Evidence] = []
    if req.useGlobalSearch:
        g_ev, g_excerpts = await _retrieve_global_evidence(text, terms, deps, notices, query=query, aliases=aliases)
        extra_fetched.extend(g_ev)
        excerpts.update(g_excerpts)
    if req.knowledgeBaseIds:
        kb_ev, kb_excerpts = await _retrieve_knowledge_evidence(text, terms, req.knowledgeBaseIds, deps, notices, query=query)
        extra_fetched.extend(kb_ev)
        excerpts.update(kb_excerpts)
    curated_by_url = {e.url: e for e in curated}
    fetched_urls = {e.url for e in fetched}
    evidence = []
    evidence_excerpts: dict[str, str] = {}
    for e in fetched:
        merged = e if e.url not in curated_by_url else curated_by_url[e.url].model_copy(update={
            "sourceMode": e.sourceMode, "fetchedAt": e.fetchedAt, "author": e.author, "title": e.title,
        })
        evidence.append(merged)
        if e.id in excerpts:
            evidence_excerpts[merged.id] = excerpts[e.id]
    evidence.extend(e for e in curated if e.url not in fetched_urls)
    seen_all_urls = {e.url for e in evidence}
    for e in extra_fetched:
        if e.url and e.url in seen_all_urls:
            continue
        if e.url:
            seen_all_urls.add(e.url)
        evidence.append(e)
        if e.id in excerpts:
            evidence_excerpts[e.id] = excerpts[e.id]
    ev_source = _evidence_source(evidence)
    yield ev("evidence", {"evidence": [e.model_dump() for e in evidence], "evidenceSource": ev_source, "notices": notices})

    # ---- generate ----
    base_levels = case.levels if case else (["single"] if aud.recommendedLevel == "single" else ["plain", "genre"])
    levels = requested_levels(base_levels, mode == "live")
    ctx = GenerateContext(
        text=text, case_id=case.caseId if case else None, audience_id=aud.id, audience_label=aud.label,
        audience_constraint=aud.constraint, recommended_level=aud.recommendedLevel, levels=levels,
        terms=terms, key_points=key_points, evidence=evidence, evidence_excerpts=evidence_excerpts,
        planned_decisions=list(case.decisions) if case else [],
        fidelity_rules=case.raw.get("fidelityRules", {}) if (case and lang.code == "en") else {},
        prompt_version=s.prompt_version,
        target_language=lang.code,
    )
    try:
        if deps.llm is None:
            raise LLMError("not_configured")
        gen = await _generate_validated(ctx, deps)
    except (LLMError, ReferenceError_, ValidationError, KeyError, TypeError) as exc:
        reason = _failure_reason(exc)
        log_event("run.generate_failed", runId=run_id, reason=reason, errorType=exc.__class__.__name__, detail=_error_detail(exc))
        entry = deps.replays.get(key)
        if entry:
            async for e in _play_replay(entry, ev, deps, reason=reason, run_id=run_id):
                yield e
            return
        configured = deps.llm is not None
        message = (f"生成失败：{reason}。没有可匹配的真实回放，已保留原文与证据，可重试。"
                   if configured else "转译模型尚未配置。已保留原文与可用证据。")
        yield ev("error", {"step": "generate", "message": message, "mode": "degraded", "retryable": configured})
        return

    # ---- check ----
    variants = await _check_variants(ctx, gen["variants"], gen["decisions"], case, deps, notices)
    if not case:
        if not evidence:
            notices.append("知乎证据不足：输出为仅基于原文的保守稿")
        if mode == "dev_stub":
            notices.append("开发占位：fake 适配器不为自定义输入生成译稿，译稿不可复制")

    snapshot = RunSnapshot(
        runId=run_id, revision=1, caseId=case.caseId if case else None, audienceId=aud.id,
        targetLanguage=lang.code,
        mode=mode, provenance=deps.llm.provenance, degradedReason=None, evidenceSource=ev_source,
        sourceSegments=build_segments(text, terms), terms=terms, keyPoints=key_points, evidence=evidence,
        decisions=gen["decisions"], recommendedLevel=aud.recommendedLevel,
        recommendationReason=gen["reason"], variants=variants, modelVersion=deps.llm.model_version,
        promptVersion=s.prompt_version, corpusVersion=deps.fx.corpus_version, createdAt=now_iso(), notices=notices,
    )
    deps.runs.put(run_id, RunRecord(snapshot=snapshot, ctx=ctx, case=case, key=key))
    deps.store.index_run(run_id, snapshot.createdAt, snapshot.caseId, aud.id, mode, snapshot.provenance, len(text), text_digest(text)[:16])
    log_event("run.ready", runId=run_id, mode=mode, evidenceIds=[e.id for e in evidence])
    yield ev("ready", snapshot.model_dump())


_ATTRIBUTION_ALIAS = {
    "zhihu": "zhihu",
    "zhihu_curated": "zhihu",
    "zhihu_live": "zhihu",
    "zhihu_cached": "zhihu",
    "other": "other",
    "model": "model",
    "llm": "model",
    "ai": "model",
    "editor": "editor",
}


def _error_detail(exc: Exception) -> str:
    if isinstance(exc, ValidationError):
        parts = []
        for err in exc.errors()[:2]:
            loc = ".".join(str(p) for p in err.get("loc", ()))
            parts.append(f"{loc}: {err.get('msg', '')}" if loc else str(err.get("msg", "")))
        return "; ".join(parts)[:300]
    return str(exc)[:300]


def _failure_reason(exc: Exception) -> str:
    if isinstance(exc, LLMError):
        if exc.kind == "bad_output":
            if "截断" in str(exc):
                return "模型输出不符合契约（输出被截断）"
            return "模型输出不符合契约（JSON 格式错误）"
        return {"timeout": "模型超时", "rate_limit": "模型限流（429）", "budget": "模型日预算已触顶",
                "auth": "模型鉴权失败，请检查 API Key 和模型权限",
                "unavailable": "模型不可用"}.get(exc.kind, "模型上游错误")
    if isinstance(exc, ReferenceError_):
        return f"模型输出不符合契约（{exc}）"
    if isinstance(exc, ValidationError):
        first = exc.errors()[0] if exc.errors() else {}
        loc = ".".join(str(p) for p in first.get("loc", ()))
        return f"模型输出不符合契约（字段校验失败：{loc or 'schema'}）"
    if isinstance(exc, (KeyError, TypeError)):
        return f"模型输出不符合契约（结构或类型错误：{exc}）"
    return "模型输出不符合契约"


def _evidence_source(evidence: list[Evidence]) -> str:
    modes = {e.sourceMode for e in evidence}
    for mode in ("zhihu_live", "zhihu_cached", "zhihu_curated", "other"):
        if mode in modes:
            return mode
    return "none"


async def _custom_terms(text: str, deps: Deps, notices: list[str]):
    if deps.llm is None:
        return [], []
    try:
        raw = await deps.call_llm(deps.llm.extract_terms, text)
    except LLMError:
        notices.append("术语抽取失败，按无术语处理")
        return [], []
    terms, kps = [], []
    for i, k in enumerate(raw.get("keyPoints", [])[:5], 1):
        kps.append(KeyPoint(id=f"KP{i}", text=str(k.get("text", "")), short=str(k.get("text", ""))[:12]))
    kp_ids = {k.id for k in kps}
    taken: list[tuple[int, int]] = []
    for i, t in enumerate(raw.get("terms", [])[:5], 1):
        surf = str(t.get("surface", ""))
        idx = text.find(surf) if surf else -1
        if idx < 0 or any(a < idx + len(surf) and idx < b for a, b in taken):
            continue
        taken.append((idx, idx + len(surf)))
        terms.append(Term(id=f"T{i}", surface=surf, start=idx, end=idx + len(surf),
                          keyPointIds=[x for x in t.get("keyPointIds", []) if x in kp_ids]))
    if not terms and deps.llm.provenance == "dev_stub":
        notices.append("开发占位：fake 适配器不抽取自定义输入的术语")
    return terms, kps


async def _retrieve_evidence(text: str, terms: list[Term], deps: Deps, notices: list[str], *,
                             query: str | None, aliases: dict[str, list[str]]) -> tuple[list[Evidence], dict[str, str]]:
    if deps.zhihu_auth_failed or not deps.zhihu.enabled:
        notices.append("知乎实时检索不可用（未启用或鉴权失败）")
        return [], {}
    base = " ".join(t.surface for t in terms[:3]) or text[:20]
    query = query or f"{base} 为什么 解释"
    try:
        items, src = await deps.zhihu.search(query)
    except ZhihuError as exc:
        if exc.kind == "auth":
            deps.zhihu_auth_failed = True
        if exc.kind == "budget":
            notices.append("项目共享知乎检索额度已用完。可在首页导入个人 Access Secret 后重新转译。")
        elif exc.kind == "rate_limit" and deps.zhihu.uses_personal_quota:
            notices.append("个人知乎账号目前达到额度或频率限制，请在知乎开放平台查看用量。")
        elif exc.kind == "rate_limit":
            notices.append("项目共享知乎接口达到额度或频率限制。可在首页导入个人 Access Secret，或稍后重试。")
        elif exc.kind == "auth" and deps.zhihu.uses_personal_quota:
            notices.append("个人知乎 Access Secret 鉴权失败。请回首页检查或更换密钥。")
        else:
            notices.append(f"知乎检索不可用（{exc.kind}），已按证据不足处理")
        return [], {}
    out: list[Evidence] = []
    excerpts: dict[str, str] = {}
    seen = set()
    for it in items:
        body = re.sub(r"\s+", " ", it.get("ContentText", "")).strip()
        title = clean_title(it.get("Title", ""))
        url = public_zhihu_url(it.get("Url", ""))
        if not title or not url or url in seen:
            continue
        seen.add(url)
        matched = [
            t for t in terms
            if any(word in title or word in body for word in (t.surface, *aliases.get(t.id, [])))
        ]
        scopes = "、".join(f"「{term.surface}」" for term in matched)
        ctype = {"Answer": "answer", "Article": "article", "Question": "question"}.get(it.get("ContentType", ""), "other")
        ev_id = f"L{len(out) + 1}"
        if body:
            excerpts[ev_id] = (body[:EVIDENCE_EXCERPT_CHARS] + "…") if len(body) > EVIDENCE_EXCERPT_CHARS else body
        out.append(Evidence(
            id=ev_id, provider="zhihu", sourceMode="zhihu_cached" if src == "cache" else "zhihu_live", contentType=ctype,
            title=title, author=(it.get("AuthorName") or "").strip() or None, url=url,
            summary=(body[:EVIDENCE_SUMMARY_CHARS] + "…") if len(body) > EVIDENCE_SUMMARY_CHARS else body, role="context",
            supports=f"可帮助核对{scopes}的用法或语境，引用前请查看原文。" if scopes else "提供相关话题的线索，适用的词义或译法仍需核对。",
            limits="这条社区资料单独无法证明产品功效、性能参数、认证，或原文没有交代的设定。",
            termIds=[term.id for term in matched], fetchedAt=it.get("fetchedAt"), status="candidate",
        ))
        if len(out) == 4:
            break
    if not out:
        notices.append("知乎检索未返回可展示的来源")
    return out, excerpts


async def _retrieve_global_evidence(
    text: str,
    terms: list[Term],
    deps: Deps,
    notices: list[str],
    *,
    query: str | None,
    aliases: dict[str, list[str]],
) -> tuple[list[Evidence], dict[str, str]]:
    if deps.zhihu_auth_failed or not deps.zhihu.enabled:
        notices.append("全网对照检索未启用（需开启知乎实时凭据或导入个人密钥）")
        return [], {}
    base = " ".join(t.surface for t in terms[:3]) or text[:20]
    q = query or f"{base} 英文 含义"
    try:
        items, _src = await deps.zhihu.global_search(q, count=4)
    except ZhihuError as exc:
        if exc.kind == "budget":
            notices.append("全网搜索今日共享额度已用完，已自动降级为仅知乎站内循证。")
        elif exc.kind == "rate_limit":
            notices.append("全网搜索触发频率或额度限制，已自动降级。")
        else:
            notices.append(f"全网对照检索暂不可用（{exc.kind}），已自动跳过。")
        return [], {}
    out: list[Evidence] = []
    excerpts: dict[str, str] = {}
    for it in items:
        body = it.get("contentText", "")
        title = it.get("title", "")
        url = it.get("url", "")
        if not title or not url:
            continue
        matched = [
            t for t in terms
            if any(word in title or word in body for word in (t.surface, *aliases.get(t.id, [])))
        ]
        ev_id = f"G{len(out) + 1}"
        if body:
            excerpts[ev_id] = (body[:EVIDENCE_EXCERPT_CHARS] + "…") if len(body) > EVIDENCE_EXCERPT_CHARS else body
        host = it.get("host") or "全网来源"
        out.append(Evidence(
            id=ev_id,
            provider="other",
            sourceMode="other",
            contentType="other",
            title=title,
            author=it.get("author") or host,
            url=url,
            summary=(body[:EVIDENCE_SUMMARY_CHARS] + "…") if len(body) > EVIDENCE_SUMMARY_CHARS else (body or f"来自 {host} 的全网对照资料"),
            role="context",
            supports="来自知乎开放平台全网搜索的站外对照信息，可辅助核对外部语境或行业规范。",
            limits="站外搜索摘录需结合原站权威性自行核实，不能单独作为合规背书。",
            termIds=[t.id for t in matched],
            fetchedAt=it.get("fetchedAt"),
            status="candidate",
        ))
        if len(out) == 2:
            break
    return out, excerpts


async def _retrieve_knowledge_evidence(
    text: str,
    terms: list[Term],
    kb_ids: list[str],
    deps: Deps,
    notices: list[str],
    *,
    query: str | None,
) -> tuple[list[Evidence], dict[str, str]]:
    if deps.zhihu_auth_failed or not deps.zhihu.enabled:
        notices.append("知乎知识库检索未启用（需导入个人 Access Secret 或开启服务端密钥）")
        return [], {}
    q = query or (" ".join(t.surface for t in terms[:3]) or text[:40])
    try:
        items = await deps.zhihu.knowledge_search(q, kb_ids=kb_ids[:5], limit=3)
    except ZhihuError as exc:
        if exc.kind == "budget":
            notices.append("知识库共享额度已用完，已跳过知识库检索。")
        else:
            notices.append(f"知乎知识库检索暂不可用（{exc.kind}），已自动跳过。")
        return [], {}
    out: list[Evidence] = []
    excerpts: dict[str, str] = {}
    for it in items:
        chunks = it.get("content") or []
        joined = " / ".join(chunks)
        title = it.get("title") or "知乎知识库片段"
        ev_id = f"K{len(out) + 1}"
        if joined:
            excerpts[ev_id] = (joined[:EVIDENCE_EXCERPT_CHARS] + "…") if len(joined) > EVIDENCE_EXCERPT_CHARS else joined
        matched = [t for t in terms if t.surface in title or t.surface in joined]
        out.append(Evidence(
            id=ev_id,
            provider="zhihu",
            sourceMode="zhihu_live",
            contentType="glossary",
            title=title,
            author="知乎知识库",
            url=it.get("originUrl") or "https://www.zhihu.com/",
            summary=(joined[:EVIDENCE_SUMMARY_CHARS] + "…") if len(joined) > EVIDENCE_SUMMARY_CHARS else (joined or "已命中个人知识库资料"),
            role="setting",
            supports="来自你关联的知乎知识库 RAG 检索，可用于统一品牌术语表或既定设定约束。",
            limits="知识库片段为按句召回结果，引用关键条款前请核对知识库原文档。",
            termIds=[t.id for t in matched],
            fetchedAt=now_iso(),
            status="reviewed",
        ))
        if len(out) == 2:
            break
    return out, excerpts


def _as_str_list(val) -> list[str]:
    if val is None:
        return []
    if isinstance(val, str):
        s = val.strip()
        return [s] if s else []
    if isinstance(val, list):
        return [str(x).strip() for x in val if x is not None and str(x).strip()]
    raise TypeError(f"expected list[str], got {type(val).__name__}")


def _normalize_segment(s) -> Segment:
    if isinstance(s, str):
        return Segment(text=s)
    if not isinstance(s, dict):
        raise TypeError("segment must be an object")
    if "text" not in s or s["text"] is None:
        raise KeyError("segment.text")
    dec_id = s.get("decisionId")
    dec_id = (str(dec_id).strip() or None) if dec_id is not None else None
    return Segment(
        text=str(s["text"]),
        termIds=_as_str_list(s.get("termIds")),
        evidenceIds=_as_str_list(s.get("evidenceIds")),
        decisionId=dec_id,
    )


def _normalize_note(n) -> Note:
    if isinstance(n, str):
        return Note(text=n)
    if not isinstance(n, dict):
        raise TypeError("note must be an object")
    if "text" not in n or n["text"] is None:
        raise KeyError("note.text")
    return Note(text=str(n["text"]), evidenceIds=_as_str_list(n.get("evidenceIds")))


def _normalize_decision(d, ctx: GenerateContext) -> Decision:
    if not isinstance(d, dict):
        raise TypeError("decision must be an object")
    attr_raw = d.get("attribution")
    attr_key = str(attr_raw).strip().lower() if attr_raw is not None else ""
    attribution = _ATTRIBUTION_ALIAS.get(attr_key, attr_raw)
    levels: list[str] = []
    for lv in _as_str_list(d.get("levels")):
        low = lv.lower()
        for item in (ctx.levels if low in ("all", "*") else (low,)):
            if item not in levels:
                levels.append(item)
    return Decision(
        id=str(d["id"]).strip(),
        termId=str(d["termId"]).strip(),
        title=str(d.get("title") or ""),
        choice=str(d["choice"]),
        rationale=str(d["rationale"]),
        evidenceIds=_as_str_list(d.get("evidenceIds")),
        attribution=attribution,
        levels=levels,
    )


def _parse_generation(raw: dict, ctx: GenerateContext) -> dict:
    if not isinstance(raw, dict):
        raise TypeError("generation payload must be an object")
    raw_variants = raw.get("variants")
    if not isinstance(raw_variants, list):
        raise TypeError("variants must be a list")
    raw_decisions = raw.get("decisions")
    if raw_decisions is None:
        raw_decisions = []
    elif not isinstance(raw_decisions, list):
        raise TypeError("decisions must be a list")
    decisions = [_normalize_decision(d, ctx) for d in raw_decisions]
    variants = []
    for v in raw_variants:
        if not isinstance(v, dict):
            raise TypeError("variant must be an object")
        raw_segs = v.get("segments")
        if not isinstance(raw_segs, list):
            raise TypeError("segments must be a list")
        raw_notes = v.get("notes")
        if raw_notes is None:
            raw_notes = []
        elif not isinstance(raw_notes, list):
            raise TypeError("notes must be a list")
        variants.append(Variant(
            level=str(v["level"]).strip(),
            segments=[_normalize_segment(s) for s in raw_segs],
            notes=[_normalize_note(n) for n in raw_notes],
            checks=[], exportState="draft",
            candidateText="__placeholder__" if v.get("placeholder") else None,
        ))
    order = ["literal", *ctx.levels]
    by_level: dict[str, Variant] = {}
    dups: list[str] = []
    for v in variants:
        if v.level in by_level:
            dups.append(v.level)
        else:
            by_level[v.level] = v
    missing = [lv for lv in order if lv not in by_level]
    extra = [v.level for v in variants if v.level not in order]
    if missing or extra or dups:
        parts = []
        if missing:
            parts.append(f"缺失 {', '.join(missing)}")
        if extra:
            parts.append(f"多余 {', '.join(extra)}")
        if dups:
            parts.append(f"重复 {', '.join(dups)}")
        raise ReferenceError_(f"转译档位不匹配（{'；'.join(parts)}）")
    if len(ctx.levels) > 2:
        norm_by_level = {
            level: re.sub(r"[\W_]+", " ", variant_text(by_level[level].segments)).strip().casefold()
            for level in ctx.levels
        }
        empty_levels = [lv for lv, t in norm_by_level.items() if not t]
        if empty_levels:
            raise ReferenceError_(f"以下档位译稿为空：{', '.join(empty_levels)}")
        groups: dict[str, list[str]] = {}
        for lv, t in norm_by_level.items():
            groups.setdefault(t, []).append(lv)
        dup_groups = [lvs for lvs in groups.values() if len(lvs) > 1]
        if dup_groups:
            desc = "；".join(" 与 ".join(g) for g in dup_groups)
            raise ReferenceError_(f"多档译稿重复（{desc} 译文完全相同）")
    variants = [by_level[level] for level in order]
    validate_references(variants, decisions, {t.id for t in ctx.terms}, {e.id for e in ctx.evidence})
    return {"variants": variants, "decisions": decisions, "reason": str(raw.get("recommendationReason") or "")}


def _retry_feedback(exc: Exception, ctx: GenerateContext) -> str:
    if isinstance(exc, LLMError):
        if "截断" in str(exc):
            return "上次输出因超过长度上限被截断，请精简 notes 和 decisions[].rationale 的篇幅，确保返回完整合法的单个 JSON 对象。"
        return f"上次输出格式异常（{exc}），请仅输出一个合法的 JSON 对象，不要附加解释文字。"
    if isinstance(exc, ReferenceError_):
        msg = str(exc)
        hints = [msg]
        if "未知" in msg:
            hints.append(
                f"允许的 termId：{[t.id for t in ctx.terms]}；允许的 evidenceId：{[e.id for e in ctx.evidence]}；"
                "segments[].decisionId 必须为 null 或出现在 decisions[].id 中。"
            )
        if "档位" in msg:
            hints.append(f"variants 必须严格包含且仅包含：{['literal', *ctx.levels]}。")
        if "译稿重复" in msg or "为空" in msg:
            lang = get_language(ctx.target_language)
            hints.append(f"请调整重复档位的用词、术语保留程度或句式，使 {ctx.levels} 的{lang.label}译文两两互不相同且非空。")
        return " ".join(hints)
    if isinstance(exc, ValidationError):
        return (
            f"上次输出字段校验失败（{_error_detail(exc)}），请严格遵守 JSON 格式，"
            f"attribution 仅允许 zhihu|other|model|editor，decisions[].levels 仅允许 {ctx.levels}。"
        )
    return f"上次输出结构错误（{_error_detail(exc)}），请按指定格式输出完整的 variants / segments / decisions。"


async def _generate_validated(ctx: GenerateContext, deps: Deps) -> dict:
    last: Optional[Exception] = None
    current_ctx = ctx
    for attempt in range(2):  # 失败携带诊断反馈重试 1 次
        try:
            raw = await deps.call_llm(deps.llm.generate, current_ctx)
            return _parse_generation(raw, ctx)
        except (ReferenceError_, ValidationError, KeyError, TypeError) as exc:
            last = exc
            if attempt == 0:
                log_event("run.generate_retry", attempt=1, errorType=exc.__class__.__name__, detail=_error_detail(exc))
                current_ctx = replace(ctx, retry_feedback=_retry_feedback(exc, ctx))
        except LLMError as exc:
            if exc.kind in ("budget", "auth"):
                raise
            last = exc
            if attempt == 0:
                log_event("run.generate_retry", attempt=1, errorType=exc.__class__.__name__, detail=_error_detail(exc))
                current_ctx = replace(ctx, retry_feedback=_retry_feedback(exc, ctx))
    assert last is not None
    raise last


def _deterministic_checks(ctx: GenerateContext, case, text: str, deps: Deps) -> list[Check]:
    checks: list[Check] = []
    lang = get_language(ctx.target_language)
    script_err = script_check(text, lang.code)
    if script_err:
        checks.append(Check(id="F-LANG", kind="fidelity", label="目标语言", rule=f"{lang.label}终稿",
                            status="fail", action="rewrite", reason=script_err))
    raw = case.raw if case else {}
    if lang.code == "en":
        fid = guard.fidelity_hits(text, raw.get("fidelityRules", {}))
        for kp in ctx.key_points:
            if kp.id not in fid:
                continue
            ok = fid[kp.id]
            checks.append(Check(id=f"F-{kp.id}", kind="fidelity", label=kp.id, keyPointId=kp.id, rule="信息点保真（确定性）",
                                status="pass" if ok else "fail", action="none" if ok else "rewrite",
                                reason="已保留" if ok else f"未检测到“{kp.short or kp.text}”的英文表达"))
        for i, f in enumerate(guard.forbidden_hits(text, raw.get("forbiddenPatterns", [])), 1):
            label = f.get("label", "新增设定")
            checks.append(Check(id=f"F-X{i}", kind="fidelity", label=label, keyPointId=f.get("violates"),
                                rule=f.get("label", "禁止新增设定"),
                                status="fail", action="rewrite", reason=f["reason"]))
    elif case and case.caseId == "case_b" and UNIVERSAL_PCT_RE.search(text):
        checks.append(Check(id="F-X1", kind="fidelity", label="续航或功耗数值", keyPointId="KP2",
                            rule="续航或功耗数值", status="fail", action="rewrite",
                            reason="原文没有电池续航、用电数值或百分比，请删除量化承诺。"))
    return checks


def _claim_checks(ctx: GenerateContext, case, text: str, deps: Deps) -> list[Check]:
    lang = get_language(ctx.target_language)
    rules = deps.store.list_compliance_rules(market=lang.code, enabled_only=True)
    legal_total = sum(1 for r in rules if r["category"] == "legal")
    custom_total = sum(1 for r in rules if r["category"] == "custom")
    comp_hits = guard.scan_compliance_rules(text, ctx.text, lang.code, rules)
    checks: list[Check] = []

    if case and case.raw.get("claimPolicy"):
        lex = deps.fx.lexicon
        target_hits = guard.scan_target_claims(text, lang.code, lex)
        policy = case.raw.get("claimPolicy", {})
        n = 0
        for t in sorted(ctx.terms, key=lambda x: x.start):
            if t.id not in policy:
                continue
            n += 1
            p = policy[t.id]
            matched = [h.match for h in target_hits if h.zh and (h.zh == t.surface or h.zh in t.surface or t.surface in h.zh)]
            span = t.surface + (f" → {' / '.join(matched)}" if matched else "")
            status = p.get("status") or ("fail" if (matched or t.kind == "claim") else "pass")
            rule = p.get("rule", "功效声称词表" if t.kind == "claim" else "生活场景边界")
            checks.append(Check(id=f"R{n}", kind="claim", label=f"R{n}", termId=t.id, rule=rule,
                                span=span, status=status, action=p["action"], reason=p["reason"],
                                evidenceIds=p.get("evidenceIds", []), riskCategory="legal"))

    legal_n = 0
    custom_n = 0
    for hit in comp_hits:
        if hit.category == "legal":
            legal_n += 1
            cid = f"L{legal_n}"
        else:
            custom_n += 1
            cid = f"C{custom_n}"
        matched_term = next(
            (t.id for t in ctx.terms if any(m in t.surface or t.surface in m for m in hit.matches)),
            None,
        )
        checks.append(
            Check(
                id=cid,
                kind="claim",
                label=hit.title,
                termId=matched_term,
                rule=hit.title,
                span=" / ".join(hit.matches),
                status="fail" if hit.severity == "block" else "warn",
                action=hit.action,
                reason=hit.reason,
                riskCategory=hit.category,
                jurisdiction=hit.jurisdiction,
                suggestion=hit.suggestion or None,
            )
        )

    if not any(c.riskCategory == "legal" for c in checks):
        checks.append(
            Check(
                id="L0",
                kind="claim",
                label="当地广告法排查",
                rule=f"法律法规库（{legal_total} 条规则）",
                status="pass",
                action="none",
                reason=f"已比对 {lang.markets} 广告法与功效监管规则，未检出违法风险词",
                riskCategory="legal",
                jurisdiction=f"{lang.markets} 广告法与监管规则",
            )
        )
    if not any(c.riskCategory == "custom" for c in checks):
        checks.append(
            Check(
                id="C0",
                kind="claim",
                label="当地风俗习惯排查",
                rule=f"风俗禁忌库（{custom_total} 条规则）",
                status="pass",
                action="none",
                reason=f"已比对 {lang.markets} 宗教、礼仪与文化禁忌规则，未检出冒犯表述",
                riskCategory="custom",
                jurisdiction=f"{lang.markets} 文化与风俗规范",
            )
        )
    return checks


async def _validation_checks(ctx: GenerateContext, level: str, case, text: str, deps: Deps) -> list[Check]:
    checks = _deterministic_checks(ctx, case, text, deps)
    try:
        raw = await deps.call_llm(deps.llm.semantic_check, ctx, level, text)
        if not isinstance(raw, list):
            raise TypeError("expected a list of checks")
        issues = [f for f in raw if isinstance(f, dict) and f.get("status") != "pass"]
        checks.extend([
            Check(
                id=f"S{i}",
                kind=f.get("kind", "fidelity"),
                label="语义检查",
                keyPointId=f.get("keyPointId"),
                rule="语义检查",
                status=f["status"],
                action=f["action"],
                reason=str(f["reason"]),
                riskCategory=f.get("riskCategory") if f.get("riskCategory") in ("legal", "custom") else None,
                jurisdiction=f.get("jurisdiction") or None,
                suggestion=f.get("suggestion") or None,
            )
            for i, f in enumerate(issues, 1)
        ])
    except (LLMError, ValidationError, AttributeError, KeyError, TypeError):
        checks.append(Check(id="S0", kind="fidelity", label="语义检查", rule="语义检查", status="warn", action="review",
                            reason="语义检查未完成，待复核"))
    return checks


def _inherit_segment_evidence(
    segments: list[Segment],
    decisions: list[Decision],
    level: str,
    prev_segments: list[Segment] | None = None,
) -> list[Segment]:
    """保留改写前与决策中已校验的 evidenceIds，避免单术语片段丢失循证标注。"""
    dec_by_id = {d.id: d for d in decisions}
    ev_by_term: dict[str, list[str]] = {}
    for seg in prev_segments or ():
        if len(seg.termIds) == 1 and seg.evidenceIds:
            bucket = ev_by_term.setdefault(seg.termIds[0], [])
            for eid in seg.evidenceIds:
                if eid not in bucket:
                    bucket.append(eid)
    for d in decisions:
        if d.evidenceIds and (not d.levels or level in d.levels):
            bucket = ev_by_term.setdefault(d.termId, [])
            for eid in d.evidenceIds:
                if eid not in bucket:
                    bucket.append(eid)
    out: list[Segment] = []
    for seg in segments:
        if seg.evidenceIds:
            out.append(seg)
            continue
        inherited: list[str] = []
        if seg.decisionId and seg.decisionId in dec_by_id:
            inherited = list(dec_by_id[seg.decisionId].evidenceIds)
        elif len(seg.termIds) == 1:
            inherited = list(ev_by_term.get(seg.termIds[0], []))
        out.append(seg.model_copy(update={"evidenceIds": inherited}) if inherited else seg)
    return out


async def _check_one_variant(ctx: GenerateContext, v: Variant, decisions: list[Decision], case, deps: Deps) -> tuple[Variant, list[str]]:
    if v.level == "literal":
        return v.model_copy(update={"exportState": "draft", "checks": []}), []
    if v.candidateText == "__placeholder__":
        return v.model_copy(update={"exportState": "draft", "candidateText": None, "checks": [
            Check(id="P0", kind="fidelity", label="开发占位", rule="未接入真实模型", status="warn", action="review",
                  reason="开发占位：没有真实译稿，不能复制")]}), []
    local_notices: list[str] = []
    text = variant_text(v.segments)
    validation = await _validation_checks(ctx, v.level, case, text, deps)
    claims = _claim_checks(ctx, case, text, deps)

    segments, notes, candidate = _inherit_segment_evidence(v.segments, decisions, v.level), v.notes, None
    needs_fix = [c for c in validation + claims if c.status == "fail" and c.action in ("remove", "rewrite")]
    if needs_fix:
        try:
            problems = [
                f"{c.reason}（改写方向：{c.suggestion}）" if c.suggestion else c.reason
                for c in needs_fix
            ]
            rw = await deps.call_llm(deps.llm.rewrite, ctx, v.level, text, problems)
            if not isinstance(rw, dict) or not isinstance(rw.get("segments"), list):
                raise TypeError("rewrite payload missing segments list")
            new_segments = [_normalize_segment(x) for x in rw["segments"]]
            new_notes = [_normalize_note(n) for n in rw.get("notes") or []] or notes
            validate_references([v.model_copy(update={"segments": new_segments, "notes": new_notes})], decisions,
                                {t.id for t in ctx.terms}, {e.id for e in ctx.evidence})
            candidate = text
            segments = _inherit_segment_evidence(new_segments, decisions, v.level, prev_segments=segments)
            notes = new_notes
        except (LLMError, ReferenceError_, ValidationError, AttributeError, KeyError, TypeError) as exc:
            local_notices.append(f"{v.level} 改写未完成（{exc.__class__.__name__}），该档保持草稿")

    final_text = variant_text(segments)
    if candidate is not None:
        validation = await _validation_checks(ctx, v.level, case, final_text, deps)
    active_rules = deps.store.list_compliance_rules(market=ctx.target_language, enabled_only=True)
    residual_blocks = [
        h for h in guard.scan_compliance_rules(final_text, ctx.text, ctx.target_language, active_rules)
        if h.severity == "block"
    ]
    if candidate is not None and not residual_blocks:
        # 保留候选稿的拦截说明。放行仍依赖终稿的独立复查。
        claims = [
            c.model_copy(update={"finalText": final_text}) if c.status == "fail" and c.action in ("remove", "rewrite") else c
            for c in claims
        ]
    needs_data = any(c.action == "needs_data" and c.status != "pass" for c in validation + claims)
    incomplete = any(c.status != "pass" and c.action != "needs_data" for c in validation)
    unresolved_claim = any(c.status == "fail" and c.action != "needs_data" and not c.finalText for c in claims)
    if not final_text.strip() or residual_blocks or incomplete or unresolved_claim:
        state = "draft"
    elif needs_data:
        state = "needs_data"
    else:
        state = "exportable"
    return v.model_copy(update={"segments": segments, "notes": notes, "checks": validation + claims, "exportState": state, "candidateText": candidate}), local_notices


async def _check_variants(ctx: GenerateContext, variants: list[Variant], decisions: list[Decision], case, deps: Deps, notices: list[str]) -> list[Variant]:
    checked = await asyncio.gather(*(_check_one_variant(ctx, v, decisions, case, deps) for v in variants))
    out: list[Variant] = []
    for variant, local_notices in checked:
        out.append(variant)
        notices.extend(local_notices)
    return out


async def _play_replay(entry: dict, ev, deps: Deps, reason: Optional[str], run_id: str):
    snap = dict(entry["snapshot"])
    snap.update({"runId": run_id, "mode": "replay", "provenance": "real_run", "frozenAt": entry.get("frozenAt"), "degradedReason": reason})
    snapshot = RunSnapshot(**snap)
    yield ev("terms", {"sourceSegments": snap["sourceSegments"], "terms": snap["terms"], "keyPoints": snap["keyPoints"]})
    await asyncio.sleep(0.2)
    yield ev("evidence", {"evidence": snap["evidence"], "evidenceSource": snap["evidenceSource"], "notices": []})
    await asyncio.sleep(0.2)
    deps.runs.put(snapshot.runId, RunRecord(snapshot=snapshot, ctx=None, case=None, key=entry["key"]))
    yield ev("ready", snapshot.model_dump())
