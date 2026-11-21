"""HTTP 层（V6 §6.3）。仅供本地运行（默认绑定 127.0.0.1）；本阶段不部署。"""
from __future__ import annotations

import asyncio
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

from ..adapters.zhihu import ZhihuError
from ..config import Settings
from ..contracts import ComplianceRuleCreate, Health, QuestionDraftRequest, RunRequest, TestRequest
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
            return _err(409, "个人密钥会话已过期，请在首页重新导入或切回项目共享额度")
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
            return _err(409, "个人密钥会话已过期，请在首页重新导入或切回项目共享额度")
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
