"""HTTP 层（V6 §6.3）。仅供本地运行（默认绑定 127.0.0.1）；本阶段不部署。"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import re
import uuid
from contextlib import asynccontextmanager
from dataclasses import replace
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from ..adapters.zhihu import QUOTA_API_LABELS, SUPPORTED_QUOTA_API_IDS, ZhihuError
from ..config import Settings
from ..contracts import (
    ComplianceRuleCreate,
    GlobalSearchRequest,
    Health,
    KnowledgeSearchRequest,
    QuestionDraftRequest,
    RunRequest,
    TestRequest,
    ZhidaAskRequest,
)
from ..core.languages import LANGUAGES, SUPPORTED_LANGUAGE_CODES
from ..pipeline.deps import Deps, build_deps
from ..pipeline.questions import DraftError, make_draft
from ..pipeline.runs import InputError, execute_run, validate_request
from ..pipeline.tests import TestRequestError, run_test
from .zhihu_sessions import COOKIE, PersonalSession, ZhihuSessions

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
# httpx's INFO request line includes search query text supplied by the user.
logging.getLogger("httpx").setLevel(logging.WARNING)


def client_ip(request: Request, deps: Deps) -> str:
    peer = request.client.host if request.client else "unknown"
    if peer in deps.settings.trusted_proxy_ips:
        fwd = request.headers.get("x-forwarded-for", "")
        if fwd:
            return fwd.split(",")[0].strip()
    return peer


def is_https_request(request: Request, deps: Deps) -> bool:
    if request.url.scheme == "https":
        return True
    peer = request.client.host if request.client else ""
    if peer in deps.settings.trusted_proxy_ips:
        proto = request.headers.get("x-forwarded-proto", "").split(",")[0].strip().lower()
        return proto == "https"
    return False


def _err(status: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"detail": message})


_FIELD_LABELS = {
    "text": "原文内容",
    "audienceId": "目标受众",
    "caseId": "案例编号",
    "targetLanguage": "目标语言",
    "keyPointIds": "信息点",
    "level": "转译档位",
    "revision": "译稿版本",
    "source": "评论来源",
}


def _format_validation_error(exc: RequestValidationError) -> str:
    errors = exc.errors()
    if not errors:
        return "请求参数不合法，请检查输入后重试"
    first = errors[0]
    err_type = str(first.get("type", ""))
    loc = [str(p) for p in first.get("loc", ()) if p not in ("body", "query", "path")]
    field = loc[-1] if loc else ""
    label = _FIELD_LABELS.get(field, field or "请求参数")
    if err_type == "extra_forbidden":
        return f"请求包含不支持的参数（{label}），请刷新页面后重试"
    if err_type == "string_too_long":
        max_len = (first.get("ctx") or {}).get("max_length")
        return f"{label}超过长度上限" + (f"（最多 {max_len} 字）" if max_len else "")
    if err_type in ("string_too_short", "too_short"):
        if field == "keyPointIds":
            return "请至少勾选一个要验证的信息点"
        return f"请填写有效的{label}"
    if err_type == "literal_error":
        return f"{label}取值不支持，请重新选择"
    if err_type == "missing":
        return f"缺少必填参数：{label}"
    if err_type == "json_invalid":
        return "请求体 JSON 格式不正确"
    msg = str(first.get("msg") or "").strip()
    return f"请求参数校验失败（{label}）" + (f"：{msg}" if msg else "")


def create_app(settings: Optional[Settings] = None, deps: Optional[Deps] = None) -> FastAPI:
    deps = deps or build_deps(settings)
    app = FastAPI(title="Zhihu Bridge", version="0.6.0", docs_url="/api/docs", openapi_url="/api/openapi.json")
    app.state.deps = deps
    sessions = ZhihuSessions()

    @app.exception_handler(RequestValidationError)
    async def validation_error_handler(_request: Request, exc: RequestValidationError):
        return _err(422, _format_validation_error(exc))

    def shared_quota() -> dict[str, int]:
        s = deps.settings
        return {
            "zhihu_search": deps.store.left("zhihu_search", s.budget_zhihu_search_cap),
            "question_discovery": deps.store.left("question_discovery", s.budget_question_discovery_cap),
        }

    def session_status(session: PersonalSession | None, expired: bool = False) -> JSONResponse:
        return JSONResponse({
            "mode": "personal" if session else "expired" if expired else "shared",
            "sharedQuota": shared_quota(),
            "sharedAvailable": deps.zhihu.enabled and not deps.zhihu_auth_failed,
            "personalQuotaAtImport": session.quota_at_import if session else None,
        }, headers={"Cache-Control": "no-store"})

    @asynccontextmanager
    async def scoped(session: PersonalSession | None):
        if session is None:
            yield deps
            return
        client = deps.zhihu.personal(session.access_secret)
        try:
            yield replace(deps, zhihu=client, zhihu_auth_failed=False)
        finally:
            await client.close()

    @app.get("/api/zhihu/session")
    async def zhihu_session(request: Request):
        token = request.cookies.get(COOKIE)
        session = sessions.get(token)
        return session_status(session, expired=bool(token and not session))

    @app.post("/api/zhihu/session")
    async def import_zhihu_secret(request: Request):
        if request.headers.get("content-type", "").partition(";")[0] != "application/json":
            return _err(400, "请提交有效的知乎 Access Secret")
        try:
            data = await request.json()
        except ValueError:
            return _err(400, "请提交有效的知乎 Access Secret")
        secret = data.get("accessSecret") if isinstance(data, dict) else None
        secret = secret.strip() if isinstance(secret, str) else ""
        if not 16 <= len(secret) <= 256 or any(not ch.isascii() or not ch.isprintable() or ch.isspace() for ch in secret):
            return _err(400, "请检查知乎 Access Secret 的格式")
        if not deps.store.rate_hit(client_ip(request, deps), "zhihu_import", deps.settings.rate_runs_per_ip_hour):
            return _err(429, "本小时密钥校验次数已达上限，请稍后重试")
        client = deps.zhihu.personal(secret)
        try:
            quota = await client.import_quota()
        except ZhihuError as exc:
            if exc.kind == "auth":
                return _err(401, "知乎未接受此 Access Secret，请检查后重试")
            if exc.kind == "rate_limit":
                return _err(429, "知乎暂时限制额度查询，请稍后重试")
            return _err(502, "目前无法向知乎验证密钥，请稍后重试")
        finally:
            await client.close()
        token, session = sessions.install(secret, quota, request.cookies.get(COOKIE))
        response = session_status(session)
        response.set_cookie(COOKIE, token, httponly=True,
                            secure=is_https_request(request, deps), samesite="strict")
        return response

    @app.delete("/api/zhihu/session")
    async def clear_zhihu_secret(request: Request):
        sessions.clear(request.cookies.get(COOKIE))
        response = session_status(None)
        response.delete_cookie(COOKIE, httponly=True, secure=is_https_request(request, deps), samesite="strict")
        return response

    def _zhihu_err(exc: ZhihuError, personal: bool) -> JSONResponse:
        if exc.kind == "disabled":
            return _err(503, "知乎实时接口未启用，可在首页底部导入个人 Access Secret 使用此能力")
        if exc.kind == "budget":
            return _err(429, "该项目共享能力组今日额度已用完，可在首页底部导入个人 Access Secret 继续使用")
        if exc.kind == "auth":
            if not personal:
                deps.zhihu_auth_failed = True
            return _err(401, "知乎 Access Secret 鉴权失败或未开通该能力组授权")
        if exc.kind == "rate_limit":
            return _err(429, "知乎开放平台触发频率或日额度限制，请查看额度或稍后再试")
        if exc.kind == "bad_request":
            return _err(422, str(exc) or "请求参数不符合知乎接口要求")
        if exc.kind == "not_found":
            return _err(404, "未找到对应的知乎知识库或内容")
        if exc.kind == "processing":
            return _err(409, "相同文件正在解析中，请稍后再试")
        if exc.kind == "parse_failed":
            return _err(422, "知识库解析该文件失败，请更换文件格式后重试")
        if exc.kind == "timeout":
            return _err(504, str(exc) or "知乎接口响应超时，请稍后重试")
        return _err(502, str(exc) or "知乎开放平台暂时不可用，请稍后重试")

    def _session_or_expired(request: Request) -> tuple[PersonalSession | None, JSONResponse | None]:
        token = request.cookies.get(COOKIE)
        session = sessions.get(token)
        if token and not session:
            return None, _err(409, "个人密钥会话已过期，请在「本人创作」重新导入或切回项目共享额度")
        return session, None

    @app.get("/api/zhihu/quota")
    async def zhihu_quota(request: Request):
        session, expired_err = _session_or_expired(request)
        if expired_err:
            return expired_err
        s = deps.settings
        local_caps = {
            "zhihu_search": s.budget_zhihu_search_cap,
            "global_search": s.budget_global_search_cap,
            "question_discovery": s.budget_question_discovery_cap,
            "zhida_openai": s.budget_zhida_cap,
            "knowledge": s.budget_knowledge_cap,
            "creator": 0,
        }
        async with scoped(session) as zdeps:
            if zdeps.zhihu.enabled and not zdeps.zhihu_auth_failed:
                try:
                    items = await zdeps.zhihu.quota_details(SUPPORTED_QUOTA_API_IDS)
                    return JSONResponse({
                        "mode": "personal" if session else "shared",
                        "live": True,
                        "items": items,
                    }, headers={"Cache-Control": "no-store"})
                except ZhihuError as exc:
                    if exc.kind == "auth" and not session:
                        deps.zhihu_auth_failed = True
                    fallback_note = str(exc) or exc.kind
            else:
                fallback_note = "知乎实时接口未启用，当前展示本地共享配额配置"
        items = []
        for aid in SUPPORTED_QUOTA_API_IDS:
            cap = local_caps[aid]
            used = deps.store.used(aid) if cap > 0 else None
            left = deps.store.left(aid, cap) if cap > 0 else None
            items.append({
                "apiId": aid,
                "apiName": QUOTA_API_LABELS[aid],
                "totalQuota": cap if cap > 0 else None,
                "totalUsed": used,
                "remainingQuota": left,
                "personalOnly": aid == "creator",
            })
        return JSONResponse({
            "mode": "personal" if session else "shared",
            "live": False,
            "note": fallback_note,
            "items": items,
        }, headers={"Cache-Control": "no-store"})

    @app.post("/api/zhihu/global-search")
    async def zhihu_global_search(body: GlobalSearchRequest, request: Request):
        session, expired_err = _session_or_expired(request)
        if expired_err:
            return expired_err
        if not deps.store.rate_hit(client_ip(request, deps), "zhihu_ext", deps.settings.rate_runs_per_ip_hour):
            return _err(429, "扩展检索次数已达本小时上限，请稍后再试")
        async with scoped(session) as zdeps:
            try:
                items, src = await zdeps.zhihu.global_search(
                    body.query.strip(),
                    count=body.count,
                    filter_expr=body.filter,
                    search_db=body.searchDb,
                )
            except ZhihuError as exc:
                return _zhihu_err(exc, personal=session is not None)
        return {"query": body.query.strip(), "source": src, "items": items}

    @app.get("/api/zhihu/question-answers")
    async def zhihu_question_answers(
        request: Request,
        questionUrl: str,
        offset: int = 0,
        limit: int = 10,
    ):
        session, expired_err = _session_or_expired(request)
        if expired_err:
            return expired_err
        if not deps.store.rate_hit(client_ip(request, deps), "zhihu_ext", deps.settings.rate_runs_per_ip_hour):
            return _err(429, "问题回答查询次数已达本小时上限，请稍后再试")
        async with scoped(session) as zdeps:
            try:
                data, src = await zdeps.zhihu.question_answers(questionUrl, offset=offset, limit=limit)
            except ZhihuError as exc:
                return _zhihu_err(exc, personal=session is not None)
        return {**data, "source": src}

    @app.post("/api/zhihu/zhida")
    async def zhihu_zhida(body: ZhidaAskRequest, request: Request):
        session, expired_err = _session_or_expired(request)
        if expired_err:
            return expired_err
        if not deps.store.rate_hit(client_ip(request, deps), "zhihu_ext", deps.settings.rate_runs_per_ip_hour):
            return _err(429, "直答追问次数已达本小时上限，请稍后再试")
        ctx_parts = []
        if body.term:
            ctx_parts.append(f"关注术语：{body.term.strip()}")
        if body.sourceText:
            ctx_parts.append(f"中文原文：{body.sourceText.strip()}")
        async with scoped(session) as zdeps:
            try:
                ans = await zdeps.zhihu.zhida_ask(body.query.strip(), model=body.model, context="\n".join(ctx_parts))
            except ZhihuError as exc:
                return _zhihu_err(exc, personal=session is not None)
        return {
            **ans,
            "disclaimer": "由知乎直答生成，适合快速理解背景与追问，不替代知乎原始回答/专栏证据。",
        }

    @app.get("/api/zhihu/knowledge/bases")
    async def zhihu_knowledge_bases(request: Request, scope: str = "all"):
        session, expired_err = _session_or_expired(request)
        if expired_err:
            return expired_err
        async with scoped(session) as zdeps:
            try:
                items = await zdeps.zhihu.knowledge_bases(scope=scope)
            except ZhihuError as exc:
                return _zhihu_err(exc, personal=session is not None)
        return {"scope": scope, "items": items}

    @app.get("/api/zhihu/knowledge/bases/{kb_id}/items")
    async def zhihu_knowledge_items(request: Request, kb_id: str, cursor: str = "", limit: int = 20):
        session, expired_err = _session_or_expired(request)
        if expired_err:
            return expired_err
        async with scoped(session) as zdeps:
            try:
                data = await zdeps.zhihu.knowledge_items(kb_id, cursor=cursor, limit=limit)
            except ZhihuError as exc:
                return _zhihu_err(exc, personal=session is not None)
        return data

    @app.post("/api/zhihu/knowledge/search")
    async def zhihu_knowledge_search(body: KnowledgeSearchRequest, request: Request):
        session, expired_err = _session_or_expired(request)
        if expired_err:
            return expired_err
        if not deps.store.rate_hit(client_ip(request, deps), "zhihu_ext", deps.settings.rate_runs_per_ip_hour):
            return _err(429, "知识库检索次数已达本小时上限，请稍后再试")
        async with scoped(session) as zdeps:
            try:
                items = await zdeps.zhihu.knowledge_search(
                    body.query,
                    kb_ids=body.knowledgeBaseIds,
                    recall_scopes=body.recallScopes,
                    limit=body.limit,
                )
            except ZhihuError as exc:
                return _zhihu_err(exc, personal=session is not None)
        return {"query": body.query.strip(), "items": items}

    @app.post("/api/zhihu/knowledge/upload")
    async def zhihu_knowledge_upload(request: Request):
        session, expired_err = _session_or_expired(request)
        if expired_err:
            return expired_err
        if session is None:
            return _err(403, "上传文件到知乎知识库仅支持个人 Access Secret，请先在「本人创作」导入个人密钥")
        if not deps.store.rate_hit(client_ip(request, deps), "zhihu_upload", 30):
            return _err(429, "知识库上传次数已达本小时上限，请稍后再试")
        try:
            payload = await request.json()
        except ValueError:
            return _err(400, "请提交 JSON 格式的上传请求")
        if not isinstance(payload, dict):
            return _err(400, "请求体格式无效")
        file_name = str(payload.get("fileName") or "").strip()[:120]
        b64 = payload.get("contentBase64")
        content_type = str(payload.get("contentType") or "application/octet-stream").strip()[:100]
        kb_id = str(payload.get("knowledgeBaseId") or "").strip() or None
        if not file_name or not isinstance(b64, str) or not b64.strip():
            return _err(422, "请提供文件名和文件内容")
        try:
            raw = base64.b64decode(b64, validate=True)
        except ValueError:
            return _err(422, "文件内容编码无效")
        if not raw or len(raw) > 10 * 1024 * 1024:
            return _err(422, "文件需非空且不超过 10 MiB")
        async with scoped(session) as zdeps:
            try:
                uploaded = await zdeps.zhihu.knowledge_upload(file_name, raw, content_type, kb_id=kb_id)
            except ZhihuError as exc:
                return _zhihu_err(exc, personal=True)
        return JSONResponse(status_code=201, content=uploaded)

    @app.get("/api/zhihu/creator/content")
    async def zhihu_creator_content(request: Request, contentUrl: str):
        session, expired_err = _session_or_expired(request)
        if expired_err:
            return expired_err
        if session is None:
            return _err(403, "本人创作能力仅支持个人 Access Secret，请先导入个人密钥")
        async with scoped(session) as zdeps:
            try:
                return await zdeps.zhihu.creator_content_detail(contentUrl)
            except ZhihuError as exc:
                return _zhihu_err(exc, personal=True)

    @app.get("/api/zhihu/creator/comments")
    async def zhihu_creator_comments(
        request: Request,
        contentUrl: str,
        offset: int = 0,
        limit: int = 20,
        order: str = "score",
    ):
        session, expired_err = _session_or_expired(request)
        if expired_err:
            return expired_err
        if session is None:
            return _err(403, "本人创作能力仅支持个人 Access Secret，请先导入个人密钥")
        async with scoped(session) as zdeps:
            try:
                return await zdeps.zhihu.creator_content_comments(contentUrl, offset=offset, limit=limit, order=order)
            except ZhihuError as exc:
                return _zhihu_err(exc, personal=True)

    @app.get("/api/zhihu/creator/account-stats")
    async def zhihu_creator_account_stats(
        request: Request,
        contentType: str = "all",
        startDate: Optional[str] = None,
        endDate: Optional[str] = None,
    ):
        session, expired_err = _session_or_expired(request)
        if expired_err:
            return expired_err
        if session is None:
            return _err(403, "本人创作能力仅支持个人 Access Secret，请先导入个人密钥")
        async with scoped(session) as zdeps:
            try:
                return await zdeps.zhihu.creator_account_stats(
                    content_type=contentType,
                    start_date=startDate,
                    end_date=endDate,
                )
            except ZhihuError as exc:
                return _zhihu_err(exc, personal=True)

    @app.get("/api/zhihu/creator/content-stats")
    async def zhihu_creator_content_stats(
        request: Request,
        contentUrl: str,
        startDate: Optional[str] = None,
        endDate: Optional[str] = None,
    ):
        session, expired_err = _session_or_expired(request)
        if expired_err:
            return expired_err
        if session is None:
            return _err(403, "本人创作能力仅支持个人 Access Secret，请先导入个人密钥")
        async with scoped(session) as zdeps:
            try:
                return await zdeps.zhihu.creator_content_stats(
                    contentUrl,
                    start_date=startDate,
                    end_date=endDate,
                )
            except ZhihuError as exc:
                return _zhihu_err(exc, personal=True)

    @app.get("/api/health", response_model=Health)
    def health() -> Health:
        s = deps.settings
        view = s.public_view()
        llm_left = deps.store.left("llm_calls", s.llm_daily_cap) if deps.generation_mode == "live" else None
        return Health(
            ok=True,
            zhihuBudgetLeft=shared_quota(),
            llmBudgetLeft=llm_left,
            replayAvailable=len(deps.replays) > 0,
            replayCount=len(deps.replays),
            generationMode=deps.generation_mode,
            llmProvider=view["llmProvider"],
            zhihuLive=deps.zhihu.enabled,
            zhihuSecretConfigured=view["zhihuSecretConfigured"],
            llmKeyConfigured=view["llmKeyConfigured"],
        )

    @app.get("/api/cases")
    def cases() -> dict:
        return {"cases": [c.public(expanded=deps.generation_mode == "live") for c in deps.fx.cases.values()],
                "languages": [lang.public() for lang in LANGUAGES],
                "corpusVersion": deps.fx.corpus_version}

    @app.get("/api/compliance/rules")
    def list_compliance_rules(category: Optional[str] = None, market: Optional[str] = None) -> dict:
        cat = category if category in ("legal", "custom") else None
        mkt = market.strip().lower() if market and market.strip().lower() in SUPPORTED_LANGUAGE_CODES else None
        rules = deps.store.list_compliance_rules(category=cat, market=mkt, enabled_only=True)
        all_for_market = deps.store.list_compliance_rules(market=mkt, enabled_only=True)
        return {
            "rules": rules,
            "counts": {
                "legal": sum(1 for r in all_for_market if r["category"] == "legal"),
                "custom": sum(1 for r in all_for_market if r["category"] == "custom"),
                "total": len(all_for_market),
            },
        }

    @app.post("/api/compliance/rules")
    def create_compliance_rule(body: ComplianceRuleCreate):
        valid_markets = {"*", *SUPPORTED_LANGUAGE_CODES}
        markets = [m.strip().lower() for m in body.markets if m.strip().lower() in valid_markets]
        if not markets:
            return _err(422, "请至少选择一个有效的适用目标市场")
        clean_patterns = [p.strip() for p in body.patterns if p.strip()]
        if not clean_patterns:
            return _err(422, "请至少填写一个匹配关键词或正则表达式")
        for pat in clean_patterns:
            try:
                re.compile(pat)
            except re.error:
                return _err(422, f"匹配规则正则语法无效：{pat}")
        prefix = "USR-LAW" if body.category == "legal" else "USR-CUS"
        rule_id = f"{prefix}-{uuid.uuid4().hex[:6].upper()}"
        created = deps.store.add_compliance_rule(
            {
                "ruleId": rule_id,
                "category": body.category,
                "subcategory": "user_custom",
                "title": body.title.strip(),
                "markets": markets,
                "jurisdiction": body.jurisdiction.strip(),
                "severity": body.severity,
                "action": "rewrite" if body.severity == "block" else "review",
                "patterns": clean_patterns,
                "zhCues": [c.strip() for c in body.zhCues if c.strip()],
                "reason": body.reason.strip(),
                "suggestion": body.suggestion.strip(),
            }
        )
        return JSONResponse(status_code=201, content={"rule": created})

    @app.delete("/api/compliance/rules/{rule_id}")
    def delete_compliance_rule(rule_id: str):
        deleted = deps.store.delete_compliance_rule(rule_id)
        if not deleted:
            return _err(404, "未找到该自定义规则，或内置规则不可删除")
        return {"deleted": True, "ruleId": rule_id}

    @app.post("/api/runs")
    async def runs(body: RunRequest, request: Request):
        token = request.cookies.get(COOKIE)
        session = sessions.get(token)
        if token and not session:
            return _err(409, "个人密钥会话已过期，请在「本人创作」重新导入或切回项目共享额度")
        try:
            validate_request(body, deps)
        except InputError as exc:
            return _err(422, str(exc))
        if not deps.store.rate_hit(client_ip(request, deps), "runs", deps.settings.rate_runs_per_ip_hour):
            return _err(429, "生成次数已达每小时上限，请稍后再试（仍可查看回放）")
        slots = deps.run_slots
        if slots.locked():
            return _err(429, "当前同时运行数已满，请稍后再试")
        await slots.acquire()

        async def stream():
            keepalive_s = max(0.05, deps.settings.sse_keepalive_s)
            try:
                async with scoped(session) as run_deps:
                    aiter = execute_run(body, run_deps)
                    pending: asyncio.Task | None = None
                    try:
                        while True:
                            if pending is None:
                                pending = asyncio.create_task(aiter.__anext__())
                            done, _ = await asyncio.wait({pending}, timeout=keepalive_s)
                            if not done:
                                if await request.is_disconnected():
                                    break
                                yield ": keep-alive\n\n"
                                continue
                            task, pending = pending, None
                            try:
                                evt = task.result()
                            except StopAsyncIteration:
                                break
                            if await request.is_disconnected():
                                break  # 客户端断开：取消后续步骤
                            yield f"data: {json.dumps(evt, ensure_ascii=False)}\n\n"
                    finally:
                        if pending is not None:
                            pending.cancel()
                            try:
                                await pending
                            except (asyncio.CancelledError, StopAsyncIteration):
                                pass
                        await aiter.aclose()
            finally:
                slots.release()

        return StreamingResponse(stream(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    @app.post("/api/runs/{run_id}/tests")
    async def tests(run_id: str, body: TestRequest, request: Request):
        if not deps.store.rate_hit(client_ip(request, deps), "tests", deps.settings.rate_tests_per_ip_hour):
            return _err(429, "测试次数已达每小时上限，请稍后再试")
        try:
            result = await run_test(run_id, body, deps)
        except TestRequestError as exc:
            return _err(exc.status, str(exc))
        return result.model_dump()

    @app.post("/api/questions/draft")
    async def draft(body: QuestionDraftRequest, request: Request):
        token = request.cookies.get(COOKIE)
        session = sessions.get(token)
        if token and not session:
            return _err(409, "个人密钥会话已过期，请在「本人创作」重新导入或切回项目共享额度")
        if not deps.store.rate_hit(client_ip(request, deps), "drafts", deps.settings.rate_drafts_per_ip_hour):
            return _err(429, "回流草稿次数已达每小时上限，请稍后再试")
        try:
            async with scoped(session) as draft_deps:
                result = await make_draft(body, draft_deps)
        except DraftError as exc:
            return _err(exc.status, str(exc))
        return result.model_dump()

    dist: Path = deps.settings.web_dist
    if (dist / "index.html").exists():
        if (dist / "assets").exists():
            app.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")

        @app.get("/{path:path}", include_in_schema=False)
        def spa(path: str):
            target = (dist / path).resolve()
            if path and target.is_file() and dist.resolve() in target.parents:
                return FileResponse(target)
            return FileResponse(dist / "index.html")

    return app


def get_app() -> FastAPI:  # uvicorn --factory 入口
    return create_app()
