"""知乎开放平台适配器（V6 §1.3、§6.5）。接口与配额均为【V5 记录·待复核】，全部配置化。

默认 ZHIHU_LIVE_ENABLED=false：本阶段**未真实调用**知乎；单元测试用 httpx.MockTransport 覆盖解析与错误路径。
- 调用前先查缓存（规范化查询词，TTL 24h），相同查询的在途请求合并；
- 调用前在 SQLite 里“检查并 +1”日预算，失败也计数；
- 30001/30002/30003 与超时 → 不重试、降级；20001 → 鉴权失败告警，全站切换为精选证据。
"""
from __future__ import annotations

import asyncio
import datetime as dt
import hashlib
import html
import re
import time
from typing import Any, Optional
from urllib.parse import urlsplit

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from ..core.text import normalize_text

NOISE = re.compile(r"第\s*[0-9一二三四五六七八九十百千]+\s*章|穿书|系统")
HTML_TAG_RE = re.compile(r"<[^>]+>")
DEC_ID_RE = re.compile(r"^[0-9]{1,32}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
QUESTION_URL_RE = re.compile(r"^https://www\.zhihu\.com/question/([0-9]+)(?:/|$)")
CREATOR_CONTENT_URL_RE = re.compile(
    r"^https://(?:www\.zhihu\.com/(?:answer/[0-9]+|question/[0-9]+/answer/[0-9]+|pin/[0-9]+|zvideo/[0-9]+)|zhuanlan\.zhihu\.com/p/[0-9]+)(?:[/?#].*)?$"
)

# 明确排除热榜（hot_list）与知乎用户数据（user_data），仅开放已集成的能力组。
SUPPORTED_QUOTA_API_IDS = (
    "zhihu_search",
    "global_search",
    "question_discovery",
    "zhida_openai",
    "knowledge",
    "creator",
)

QUOTA_API_LABELS = {
    "zhihu_search": "知乎搜索",
    "global_search": "全网搜索",
    "question_discovery": "问题发现",
    "zhida_openai": "知乎直答",
    "knowledge": "知识库",
    "creator": "创作能力",
}

ZHIDA_MODELS = ("zhida-fast-1p5", "zhida-thinking-1p5", "zhida-agent")


class ZhihuError(Exception):
    def __init__(self, kind: str, code: Optional[int] = None, message: str = ""):
        super().__init__(message or kind)
        self.kind = kind  # disabled | budget | auth | rate_limit | bad_request | upstream | timeout | bad_response
        self.code = code


class SearchItem(BaseModel):
    model_config = ConfigDict(extra="ignore")
    Title: str = ""
    ContentType: str = ""
    ContentText: str = ""
    Url: str = ""
    AuthorName: Optional[str] = None
    CommentInfoList: list = Field(default_factory=list)


class SearchData(BaseModel):
    model_config = ConfigDict(extra="ignore")
    Items: list[SearchItem] = Field(default_factory=list)


class QuestionItem(BaseModel):
    model_config = ConfigDict(extra="ignore")
    Title: str = ""
    Url: str = ""


class QuestionData(BaseModel):
    model_config = ConfigDict(extra="ignore")
    Items: list[QuestionItem] = Field(default_factory=list)


class Envelope(BaseModel):
    model_config = ConfigDict(extra="ignore")
    Code: int
    Message: str = ""
    Data: Optional[dict] = None


CODE_KIND = {
    10001: "bad_request",
    20001: "auth",
    30001: "rate_limit",
    30002: "rate_limit",
    30003: "rate_limit",
    40004: "not_found",
    40005: "processing",
    40006: "parse_failed",
    50002: "upstream",
    90001: "upstream",
}


def clean_url(url: str) -> str:
    return re.sub(r"\?utm_[^#]*$", "", url)


def clean_title(title: str) -> str:
    return re.sub(r"\s*-\s*知乎\s*$", "", title or "").strip()


def public_zhihu_url(url: str) -> str:
    try:
        parsed = urlsplit(url)
        host = parsed.hostname or ""
        if parsed.scheme == "https" and not parsed.username and not parsed.password and (
            host == "zhihu.com" or host.endswith(".zhihu.com")
        ):
            return clean_url(url)
    except ValueError:
        pass
    return ""


def public_web_url(url: str) -> str:
    try:
        parsed = urlsplit(url)
        host = parsed.hostname or ""
        if parsed.scheme in ("https", "http") and host and not parsed.username and not parsed.password:
            return clean_url(url)
    except ValueError:
        pass
    return ""


def valid_zhihu_question_url(url: str) -> str:
    cleaned = public_zhihu_url(url.strip())
    if not cleaned:
        return ""
    m = QUESTION_URL_RE.match(cleaned)
    if not m:
        return ""
    return f"https://www.zhihu.com/question/{m.group(1)}"


def valid_zhihu_creator_content_url(url: str) -> str:
    cleaned = public_zhihu_url(url.strip())
    if not cleaned or not CREATOR_CONTENT_URL_RE.match(cleaned):
        return ""
    return cleaned.split("?", 1)[0].split("#", 1)[0]


def strip_html_text(raw: str) -> str:
    if not raw:
        return ""
    text = HTML_TAG_RE.sub(" ", raw)
    text = html.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def validate_date_pair(start_date: Optional[str], end_date: Optional[str]) -> tuple[Optional[str], Optional[str]]:
    s = (start_date or "").strip() or None
    e = (end_date or "").strip() or None
    if not s and not e:
        return None, None
    if not s or not e:
        raise ZhihuError("bad_request", message="开始日期与结束日期必须成对提供（YYYY-MM-DD）")
    if not DATE_RE.match(s) or not DATE_RE.match(e):
        raise ZhihuError("bad_request", message="日期格式必须为 YYYY-MM-DD")
    try:
        sd = dt.date.fromisoformat(s)
        ed = dt.date.fromisoformat(e)
    except ValueError as exc:
        raise ZhihuError("bad_request", message="日期不是有效的日历日期") from exc
    if sd > ed:
        raise ZhihuError("bad_request", message="开始日期不能晚于结束日期")
    return s, e


def _stringify_comment(item: Any) -> dict:
    if not isinstance(item, dict):
        return {}
    out: dict[str, Any] = {
        "id": str(item.get("ID", "")),
        "type": str(item.get("Type", "")),
        "content": strip_html_text(str(item.get("Content", ""))),
        "createdAt": item.get("CreatedAt"),
        "likeCount": item.get("LikeCount"),
        "dislikeCount": item.get("DislikeCount"),
        "authorToken": str(item.get("AuthorToken", "")),
    }
    if item.get("RootID") is not None:
        out["rootId"] = str(item["RootID"])
    if item.get("ReplyID") is not None:
        out["replyId"] = str(item["ReplyID"])
    return out


class ZhihuClient:
    def __init__(self, settings, store, transport: Optional[httpx.AsyncBaseTransport] = None, clock=time.time,
                 *, access_secret: str | None = None):
        self.s = settings
        self.store = store
        self.clock = clock
        self.transport = transport
        self.uses_personal_quota = access_secret is not None
        self._access_secret = access_secret if self.uses_personal_quota else settings.zhihu_access_secret
        self._namespace = ":personal:" + hashlib.sha256(access_secret.encode()).hexdigest() if access_secret else ""
        self._inflight: dict[tuple[str, str], asyncio.Future] = {}
        base = "https://developer.zhihu.com" if self.uses_personal_quota else settings.zhihu_api_base
        self._client = httpx.AsyncClient(base_url=base, timeout=settings.zhihu_soft_timeout_s, transport=transport)

    def personal(self, access_secret: str) -> ZhihuClient:
        return ZhihuClient(self.s, self.store, self.transport, self.clock, access_secret=access_secret)

    async def close(self) -> None:
        await self._client.aclose()

    @property
    def enabled(self) -> bool:
        return bool(self._access_secret and (self.uses_personal_quota or self.s.zhihu_live_enabled))

    def _headers(self, *, json_content: bool = True) -> dict:
        headers = {
            "Authorization": f"Bearer {self._access_secret}",
            "X-Request-Timestamp": str(int(self.clock())),
        }
        if json_content:
            headers["Content-Type"] = "application/json"
        return headers

    def _consume_budget(self, resource: str, cap: int) -> None:
        if self.enabled and not self.uses_personal_quota and not self.store.try_consume(resource, cap):
            raise ZhihuError("budget", message=f"{resource} 今日公网额度已用完")

    async def _request(
        self,
        path: str,
        params: Optional[dict] = None,
        *,
        method: str = "GET",
        json_body: Optional[dict] = None,
        files: Any = None,
        form_data: Optional[dict] = None,
        timeout: Optional[float] = None,
    ):
        if not self.enabled:
            raise ZhihuError("disabled", message="知乎实时调用未启用（ZHIHU_LIVE_ENABLED=false 或未配置凭据）")
        headers = self._headers(json_content=files is None)
        kwargs: dict[str, Any] = {"headers": headers}
        if params:
            kwargs["params"] = params
        if json_body is not None:
            kwargs["json"] = json_body
        if files is not None:
            kwargs["files"] = files
        if form_data is not None:
            kwargs["data"] = form_data
        if timeout is not None:
            kwargs["timeout"] = timeout
        try:
            resp = await self._client.request(method, path, **kwargs)
        except httpx.TimeoutException as exc:
            raise ZhihuError("timeout", message="知乎请求超时") from exc
        except httpx.HTTPError as exc:
            raise ZhihuError("upstream", message=f"知乎请求失败：{exc.__class__.__name__}") from exc
        if resp.status_code in (401, 403):
            raise ZhihuError("auth")
        if resp.status_code == 429:
            raise ZhihuError("rate_limit")
        if resp.status_code >= 400:
            raise ZhihuError("upstream")
        try:
            data = resp.json()
            if not isinstance(data, dict) or not isinstance(data.get("Code"), int):
                raise ValueError("missing API code")
        except ValueError as exc:
            raise ZhihuError("bad_response", message=f"知乎响应无法解析（HTTP {resp.status_code}）") from exc
        if data["Code"] != 0:
            msg = str(data.get("Message") or "").strip()
            raise ZhihuError(CODE_KIND.get(data["Code"], "upstream"), data["Code"], msg)
        return data

    async def import_quota(self) -> dict[str, int]:
        data = await self._request("/api/v1/quota", {"APIIDs": ",".join(SUPPORTED_QUOTA_API_IDS)})
        quotas = data.get("Data")
        if not isinstance(quotas, list):
            raise ZhihuError("bad_response")
        return {
            item["APIID"]: item["RemainingQuota"]
            for item in quotas if isinstance(item, dict)
            and item.get("APIID") in SUPPORTED_QUOTA_API_IDS
            and type(item.get("RemainingQuota")) is int and item["RemainingQuota"] >= 0
        }

    async def quota_details(self, api_ids: tuple[str, ...] = SUPPORTED_QUOTA_API_IDS) -> list[dict]:
        valid_ids = [aid for aid in api_ids if aid in SUPPORTED_QUOTA_API_IDS]
        data = await self._request("/api/v1/quota", {"APIIDs": ",".join(valid_ids or SUPPORTED_QUOTA_API_IDS)})
        quotas = data.get("Data")
        if not isinstance(quotas, list):
            raise ZhihuError("bad_response")
        out: list[dict] = []
        for item in quotas:
            if not isinstance(item, dict):
                continue
            aid = item.get("APIID")
            if aid not in SUPPORTED_QUOTA_API_IDS:
                continue
            out.append({
                "apiId": aid,
                "apiName": str(item.get("APIName") or QUOTA_API_LABELS.get(aid, aid)),
                "totalQuota": item.get("TotalQuota") if type(item.get("TotalQuota")) is int else None,
                "totalUsed": item.get("TotalUsed") if type(item.get("TotalUsed")) is int else None,
                "remainingQuota": item.get("RemainingQuota") if type(item.get("RemainingQuota")) is int else None,
            })
        return out

    async def _get(self, path: str, params: dict, resource: str, cap: int, *, timeout: Optional[float] = None) -> dict:
        self._consume_budget(resource, cap)
        data = await self._request(path, params, timeout=timeout)
        try:
            env = Envelope.model_validate(data)
        except ValidationError as exc:
            raise ZhihuError("bad_response") from exc
        return env.Data or {}

    async def _post_json(self, path: str, body: dict, resource: str, cap: int, *, timeout: Optional[float] = None) -> dict:
        self._consume_budget(resource, cap)
        data = await self._request(path, method="POST", json_body=body, timeout=timeout)
        try:
            env = Envelope.model_validate(data)
        except ValidationError as exc:
            raise ZhihuError("bad_response") from exc
        return env.Data or {}

    async def _merged(self, kind: str, query: str, fetch):
        key = (kind + self._namespace, normalize_text(query))
        cached = self.store.cache_get(*key)
        if cached is not None:
            return cached, "cache"
        if key in self._inflight:
            return await asyncio.shield(self._inflight[key]), "zhihu_live"
        fut = asyncio.get_running_loop().create_future()
        self._inflight[key] = fut
        try:
            data = await fetch()
            self.store.cache_put(*key, data)
            fut.set_result(data)
            return data, "zhihu_live"
        except BaseException as exc:
            fut.set_exception(exc)
            fut.exception()  # 标记已取回，避免未处理警告
            raise
        finally:
            self._inflight.pop(key, None)

    async def search(self, query: str, count: int = 10) -> tuple[list[dict], str]:
        async def fetch():
            path = "/api/v1/content/zhihu_search" if self.uses_personal_quota else self.s.zhihu_search_path
            data = await self._get(path, {"Query": query, "Count": min(count, 10)}, "zhihu_search", self.s.budget_zhihu_search_cap)
            try:
                items = SearchData.model_validate(data).Items
            except ValidationError as exc:
                raise ZhihuError("bad_response", message="知乎搜索结果格式不符") from exc
            return {"items": [i.model_dump() for i in items], "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(self.clock()))}

        data, src = await self._merged("zhihu_search", query, fetch)
        out = []
        for it in data["items"]:
            if NOISE.search(it.get("Title", "")):
                continue
            out.append({**it, "AuthorName": (it.get("AuthorName") or None), "fetchedAt": data.get("fetchedAt")})
        return out, src

    async def question_recommendations(self, query: str, count: int = 5) -> tuple[list[dict], str, Optional[str]]:
        async def fetch():
            path = "/api/v1/user/question_recommendations" if self.uses_personal_quota else self.s.zhihu_question_rec_path
            data = await self._get(path, {"Query": query, "Count": count}, "question_discovery", self.s.budget_question_discovery_cap)
            try:
                items = QuestionData.model_validate(data).Items
            except ValidationError as exc:
                raise ZhihuError("bad_response", message="知乎问题发现结果格式不符") from exc
            found = [{"title": clean_title(i.Title), "url": public_zhihu_url(i.Url)} for i in items]
            return {"items": [i for i in found if i["title"] and i["url"]][:5],
                    "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(self.clock()))}

        data, src = await self._merged("question_recommendations", query, fetch)
        return data["items"], src, data.get("fetchedAt")

    # ---------- 全网搜索（global_search） ----------
    async def global_search(
        self,
        query: str,
        count: int = 6,
        *,
        filter_expr: str = "",
        search_db: str = "all",
    ) -> tuple[list[dict], str]:
        db = search_db if search_db in ("all", "realtime", "static") else "all"
        safe_count = max(1, min(int(count), 20))
        flt = filter_expr.strip()

        async def fetch():
            path = "/api/v1/content/global_search" if self.uses_personal_quota else self.s.zhihu_global_search_path
            params: dict[str, Any] = {"Query": query, "Count": safe_count, "SearchDB": db}
            if flt:
                params["Filter"] = flt
            data = await self._get(path, params, "global_search", self.s.budget_global_search_cap)
            try:
                items = SearchData.model_validate(data).Items
            except ValidationError as exc:
                raise ZhihuError("bad_response", message="全网搜索结果格式不符") from exc
            return {
                "items": [i.model_dump() for i in items],
                "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(self.clock())),
            }

        cache_key = f"{query}|{db}|{flt}|{safe_count}"
        data, src = await self._merged("global_search", cache_key, fetch)
        out: list[dict] = []
        seen: set[str] = set()
        for it in data["items"]:
            title = clean_title(it.get("Title", ""))
            url = public_web_url(it.get("Url", ""))
            if not title or not url or url in seen or NOISE.search(title):
                continue
            seen.add(url)
            host = urlsplit(url).hostname or ""
            out.append({
                "title": title,
                "url": url,
                "host": host,
                "contentType": it.get("ContentType") or "web",
                "contentText": re.sub(r"\s+", " ", it.get("ContentText", "")).strip(),
                "author": (it.get("AuthorName") or "").strip() or None,
                "fetchedAt": data.get("fetchedAt"),
            })
        return out, src

    # ---------- 问题回答摘要（question_answers，共用 question_discovery 额度） ----------
    async def question_answers(self, question_url: str, offset: int = 0, limit: int = 10) -> tuple[dict, str]:
        canonical = valid_zhihu_question_url(question_url)
        if not canonical:
            raise ZhihuError("bad_request", message="需要完整的知乎问题链接（https://www.zhihu.com/question/<id>）")
        safe_offset = max(0, int(offset))
        safe_limit = max(1, min(int(limit), 50))

        async def fetch():
            path = "/api/v1/content/question_answers" if self.uses_personal_quota else self.s.zhihu_question_answers_path
            data = await self._get(
                path,
                {"QuestionUrl": canonical, "Offset": safe_offset, "Limit": safe_limit},
                "question_discovery",
                self.s.budget_question_discovery_cap,
            )
            raw_items = data.get("Items")
            if raw_items is None:
                raw_items = []
            if not isinstance(raw_items, list):
                raise ZhihuError("bad_response", message="问题回答摘要格式不符")
            items: list[dict] = []
            for item in raw_items:
                if not isinstance(item, dict):
                    continue
                url = public_zhihu_url(str(item.get("Url", "")))
                summary = strip_html_text(str(item.get("Summary", "")))
                if not url or not summary:
                    continue
                items.append({
                    "contentType": str(item.get("ContentType", "answer")),
                    "contentToken": str(item.get("ContentToken", "")),
                    "url": url,
                    "summary": summary,
                })
            paging_raw = data.get("Paging") if isinstance(data.get("Paging"), dict) else {}
            is_end = bool(paging_raw.get("IsEnd", True))
            next_offset = paging_raw.get("NextOffset") if isinstance(paging_raw.get("NextOffset"), int) else None
            totals = paging_raw.get("Totals") if isinstance(paging_raw.get("Totals"), int) else None
            return {
                "questionUrl": canonical,
                "items": items,
                "paging": {"isEnd": is_end, "nextOffset": next_offset, "totals": totals},
                "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(self.clock())),
            }

        cache_key = f"{canonical}|{safe_offset}|{safe_limit}"
        return await self._merged("question_answers", cache_key, fetch)

    # ---------- 知乎直答（POST /v1/chat/completions） ----------
    async def zhida_ask(self, query: str, model: str = "zhida-fast-1p5", context: str = "") -> dict:
        if not self.enabled:
            raise ZhihuError("disabled", message="知乎直答未启用（请先在首页导入个人 Access Secret 或启用服务端密钥）")
        picked = model if model in ZHIDA_MODELS else "zhida-fast-1p5"
        self._consume_budget("zhida_openai", self.s.budget_zhida_cap)
        messages: list[dict[str, str]] = []
        if context.strip() and picked in ("zhida-fast-1p5", "zhida-thinking-1p5"):
            messages.append({
                "role": "system",
                "content": (
                    "你是跨文化语境调研助手。请结合知乎社区讨论背景，简明解释术语的中文语境、常见误读与海外表达建议。"
                    "保持客观准确，不编造数据或出处。"
                ),
            })
            messages.append({"role": "user", "content": f"参考语境：{context.strip()[:500]}\n\n问题：{query.strip()}"})
        else:
            messages.append({"role": "user", "content": query.strip()})
        path = "/v1/chat/completions" if self.uses_personal_quota else self.s.zhihu_zhida_path
        # 严格遵循 http-api.md：仅传递 model / messages / stream 三个正式字段。
        payload = {"model": picked, "messages": messages, "stream": False}
        try:
            resp = await self._client.post(
                path,
                json=payload,
                headers=self._headers(json_content=True),
                timeout=self.s.zhihu_zhida_timeout_s,
            )
        except httpx.TimeoutException as exc:
            raise ZhihuError("timeout", message="知乎直答响应超时，请重试或切换为快速回答档位") from exc
        except httpx.HTTPError as exc:
            raise ZhihuError("upstream", message=f"知乎直答请求失败：{exc.__class__.__name__}") from exc
        if resp.status_code in (401, 403):
            raise ZhihuError("auth", message="知乎直答鉴权失败，请检查 Access Secret 权限")
        if resp.status_code == 429:
            raise ZhihuError("rate_limit", message="知乎直答触发限流或日额度已满")
        try:
            body = resp.json()
        except ValueError as exc:
            raise ZhihuError("bad_response", message=f"知乎直答响应无法解析（HTTP {resp.status_code}）") from exc
        if isinstance(body, dict) and isinstance(body.get("error"), dict):
            err_msg = str(body["error"].get("message") or "知乎直答返回错误")
            err_code = str(body["error"].get("code") or "")
            kind = "rate_limit" if "rate" in err_code or "quota" in err_code else "bad_request" if resp.status_code == 400 else "upstream"
            raise ZhihuError(kind, message=err_msg)
        if resp.status_code >= 400:
            raise ZhihuError("upstream", message=f"知乎直答返回 HTTP {resp.status_code}")
        choices = body.get("choices") if isinstance(body, dict) else None
        if not isinstance(choices, list) or not choices:
            raise ZhihuError("bad_response", message="知乎直答未返回有效回答")
        msg = choices[0].get("message") if isinstance(choices[0], dict) else None
        if not isinstance(msg, dict) or not isinstance(msg.get("content"), str):
            raise ZhihuError("bad_response", message="知乎直答返回内容为空")
        return {
            "model": str(body.get("model") or picked),
            "content": msg["content"].strip(),
            "reasoningContent": str(msg.get("reasoning_content") or "").strip() or None,
            "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(self.clock())),
        }

    # ---------- 知识库 API（knowledge 额度） ----------
    async def knowledge_bases(self, scope: str = "all") -> list[dict]:
        sc = scope if scope in ("all", "created", "subscribed") else "all"
        data = await self._get("/api/v1/knowledge/bases", {"Scope": sc}, "knowledge", self.s.budget_knowledge_cap)
        raw_items = data.get("Items") or []
        if not isinstance(raw_items, list):
            raise ZhihuError("bad_response", message="知识库列表格式不符")
        out: list[dict] = []
        for item in raw_items:
            if not isinstance(item, dict):
                continue
            kb_id = str(item.get("KnowledgeBaseID", "")).strip()
            if not kb_id:
                continue
            out.append({
                "knowledgeBaseId": kb_id,
                "name": str(item.get("Name") or "未命名知识库"),
                "relation": str(item.get("Relation") or ""),
                "isDefault": bool(item.get("IsDefault", False)),
                "visibility": str(item.get("Visibility") or ""),
                "contentCount": item.get("ContentCount") if isinstance(item.get("ContentCount"), int) else 0,
                "updatedAt": item.get("UpdatedAt"),
                "description": str(item.get("Description") or "").strip() or None,
            })
        return out

    async def knowledge_items(self, kb_id: str, cursor: str = "", limit: int = 20) -> dict:
        cid = kb_id.strip()
        if not DEC_ID_RE.match(cid):
            raise ZhihuError("bad_request", message="知识库 ID 必须为纯数字字符串")
        params: dict[str, Any] = {"Limit": max(1, min(int(limit), 20))}
        if cursor.strip():
            params["Cursor"] = cursor.strip()
        data = await self._get(f"/api/v1/knowledge/bases/{cid}/items", params, "knowledge", self.s.budget_knowledge_cap)
        raw_items = data.get("Items") or []
        if not isinstance(raw_items, list):
            raise ZhihuError("bad_response", message="知识库内容列表格式不符")
        items: list[dict] = []
        for item in raw_items:
            if not isinstance(item, dict):
                continue
            origin = public_web_url(str(item.get("OriginUrl") or ""))
            items.append({
                "recallContentId": str(item.get("RecallContentID", "")),
                "contentType": str(item.get("ContentType", "")),
                "title": str(item.get("Title") or "未命名条目"),
                "abstract": strip_html_text(str(item.get("Abstract") or item.get("Summary") or "")) or None,
                "updatedAt": item.get("UpdatedAt") or item.get("CreatedAt"),
                "originUrl": origin or None,
            })
        return {
            "knowledgeBaseId": cid,
            "items": items,
            "hasMore": bool(data.get("HasMore", False)),
            "nextCursor": str(data.get("NextCursor") or "") or None,
        }

    async def knowledge_search(
        self,
        query: str,
        *,
        kb_ids: Optional[list[str]] = None,
        recall_scopes: Optional[list[str]] = None,
        limit: int = 5,
    ) -> list[dict]:
        q = query.strip()
        if not q:
            raise ZhihuError("bad_request", message="检索词不能为空")
        clean_ids = [x.strip() for x in (kb_ids or []) if DEC_ID_RE.match(x.strip())]
        clean_scopes = [s for s in (recall_scopes or []) if s in ("personal", "subscription", "public")]
        if not clean_ids and not clean_scopes:
            clean_scopes = ["personal"]
        body: dict[str, Any] = {"Query": q, "Limit": max(1, min(int(limit), 10))}
        if clean_ids:
            body["KnowledgeBaseIDs"] = clean_ids
        if clean_scopes:
            body["RecallScopes"] = clean_scopes
        data = await self._post_json("/api/v1/knowledge/search", body, "knowledge", self.s.budget_knowledge_cap)
        raw_items = data.get("Items") or data.get("Results") or []
        if not isinstance(raw_items, list):
            raw_items = []
        out: list[dict] = []
        for item in raw_items:
            if not isinstance(item, dict):
                continue
            raw_chunks = item.get("Content")
            if isinstance(raw_chunks, list):
                chunks = [strip_html_text(str(c)) for c in raw_chunks if str(c).strip()]
            elif isinstance(raw_chunks, str) and raw_chunks.strip():
                chunks = [strip_html_text(raw_chunks)]
            else:
                chunks = []
            origin = public_web_url(str(item.get("OriginUrl") or item.get("Url") or ""))
            out.append({
                "recallContentId": str(item.get("RecallContentID", "")),
                "knowledgeBaseId": str(item.get("KnowledgeBaseID", "")) or None,
                "title": str(item.get("Title") or "知识库片段"),
                "content": chunks,
                "originUrl": origin or None,
                "score": item.get("Score"),
            })
        return out

    async def knowledge_upload(
        self,
        filename: str,
        content: bytes,
        content_type: str = "application/octet-stream",
        kb_id: Optional[str] = None,
    ) -> dict:
        if not content:
            raise ZhihuError("bad_request", message="上传文件不能为空")
        form_data: dict[str, str] = {}
        if kb_id and kb_id.strip():
            if not DEC_ID_RE.match(kb_id.strip()):
                raise ZhihuError("bad_request", message="知识库 ID 必须为纯数字字符串")
            form_data["KnowledgeBaseID"] = kb_id.strip()
        self._consume_budget("knowledge", self.s.budget_knowledge_cap)
        # 上传是同步有副作用的 POST，严禁自动重试。
        data = await self._request(
            "/api/v1/knowledge/files",
            method="POST",
            files={"File": (filename or "document.txt", content, content_type or "application/octet-stream")},
            form_data=form_data or None,
            timeout=30.0,
        )
        d = data.get("Data") if isinstance(data.get("Data"), dict) else {}
        return {
            "knowledgeBaseId": str(d.get("KnowledgeBaseID", "")),
            "recallContentId": str(d.get("RecallContentID", "")),
            "fileName": str(d.get("FileName") or filename),
            "fileSize": d.get("FileSize") if isinstance(d.get("FileSize"), int) else len(content),
            "title": str(d.get("Title") or "").strip() or None,
            "abstract": strip_html_text(str(d.get("Abstract") or "")) or None,
            "originUrl": public_web_url(str(d.get("OriginUrl") or "")) or None,
        }

    # ---------- 本人创作能力（creator 额度，仅限个人 Access Secret，不写入长期缓存） ----------
    async def creator_content_detail(self, content_url: str) -> dict:
        canonical = valid_zhihu_creator_content_url(content_url)
        if not canonical:
            raise ZhihuError(
                "bad_request",
                message="仅支持本人知乎内容链接（answer / question/answer / zhuanlan / pin / zvideo）",
            )
        data = await self._get(
            "/api/v1/user/content_detail",
            {"ContentUrl": canonical},
            "creator",
            0,
            timeout=self.s.zhihu_creator_timeout_s,
        )
        raw_body = str(data.get("Body") or "")
        return {
            "contentType": str(data.get("ContentType") or ""),
            "contentToken": str(data.get("ContentToken") or ""),
            "url": public_zhihu_url(str(data.get("Url") or canonical)) or canonical,
            "title": str(data.get("Title") or ""),
            "plainText": strip_html_text(raw_body),
            "excerpt": strip_html_text(raw_body)[:400],
        }

    async def creator_content_comments(
        self,
        content_url: str,
        *,
        offset: int = 0,
        limit: int = 20,
        order: str = "score",
    ) -> dict:
        canonical = valid_zhihu_creator_content_url(content_url)
        if not canonical:
            raise ZhihuError(
                "bad_request",
                message="仅支持本人知乎内容链接（answer / question/answer / zhuanlan / pin / zvideo）",
            )
        ord_val = order if order in ("score", "reverse", "ascending") else "score"
        safe_offset = max(0, int(offset))
        safe_limit = max(1, min(int(limit), 50))
        data = await self._get(
            "/api/v1/user/content_comments",
            {"ContentUrl": canonical, "Offset": safe_offset, "Limit": safe_limit, "Order": ord_val},
            "creator",
            0,
            timeout=self.s.zhihu_creator_timeout_s,
        )
        raw_items = data.get("Items") or []
        if not isinstance(raw_items, list):
            raise ZhihuError("bad_response", message="评论响应格式不符")
        items: list[dict] = []
        for entry in raw_items:
            if not isinstance(entry, dict):
                continue
            root = _stringify_comment(entry.get("Comment"))
            children_raw = entry.get("Children") or []
            children = [_stringify_comment(ch) for ch in children_raw if isinstance(ch, dict)] if isinstance(children_raw, list) else []
            if root:
                items.append({"comment": root, "children": children})
        paging_raw = data.get("Paging") if isinstance(data.get("Paging"), dict) else {}
        is_end = bool(paging_raw.get("IsEnd", True))
        next_offset = paging_raw.get("NextOffset") if isinstance(paging_raw.get("NextOffset"), int) else None
        if not is_end and (next_offset is None or next_offset <= safe_offset):
            is_end = True
            next_offset = None
        return {
            "contentUrl": canonical,
            "items": items,
            "paging": {"isEnd": is_end, "nextOffset": next_offset},
        }

    async def creator_account_stats(
        self,
        *,
        content_type: str = "all",
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
    ) -> dict:
        ctype = content_type if content_type in ("all", "answer", "article", "pin", "zvideo") else "all"
        sd, ed = validate_date_pair(start_date, end_date)
        params: dict[str, Any] = {"ContentType": ctype}
        if sd and ed:
            params["StartDate"] = sd
            params["EndDate"] = ed
        data = await self._get(
            "/api/v1/user/creator_account_stats",
            params,
            "creator",
            0,
            timeout=self.s.zhihu_creator_timeout_s,
        )
        # 严格按实际返回呈现，不补零或推导缺失字段。
        return {
            "contentType": str(data.get("ContentType") or ctype),
            "metrics": data.get("Metrics"),
            "audience": data.get("Audience"),
            "creationCounts": data.get("CreationCounts"),
            "followers": data.get("Followers"),
            "followerDetails": data.get("FollowerDetails"),
            "followerProfile": data.get("FollowerProfile"),
            "status": data.get("Status"),
            "reason": data.get("Reason"),
        }

    async def creator_content_stats(
        self,
        content_url: str,
        *,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
    ) -> dict:
        canonical = valid_zhihu_creator_content_url(content_url)
        if not canonical:
            raise ZhihuError(
                "bad_request",
                message="仅支持本人知乎内容链接（answer / question/answer / zhuanlan / pin / zvideo）",
            )
        sd, ed = validate_date_pair(start_date, end_date)
        params: dict[str, Any] = {"ContentUrl": canonical}
        if sd and ed:
            params["StartDate"] = sd
            params["EndDate"] = ed
        data = await self._get(
            "/api/v1/user/creator_content_stats",
            params,
            "creator",
            0,
            timeout=self.s.zhihu_creator_timeout_s,
        )
        raw_items = data.get("Items") or []
        items: list[dict] = []
        if isinstance(raw_items, list):
            for it in raw_items:
                if not isinstance(it, dict):
                    continue
                items.append({
                    "contentType": str(it.get("ContentType") or ""),
                    "contentToken": str(it.get("ContentToken") or ""),
                    "url": public_zhihu_url(str(it.get("Url") or canonical)) or canonical,
                    "title": it.get("Title"),
                    "metrics": it.get("Metrics"),
                    "audience": it.get("Audience"),
                    "status": it.get("Status"),
                    "reason": it.get("Reason"),
                })
        return {"contentUrl": canonical, "items": items}
