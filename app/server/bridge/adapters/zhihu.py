"""知乎开放平台适配器（V6 §1.3、§6.5）。接口与配额均为【V5 记录·待复核】，全部配置化。

默认 ZHIHU_LIVE_ENABLED=false：本阶段**未真实调用**知乎；单元测试用 httpx.MockTransport 覆盖解析与错误路径。
- 调用前先查缓存（规范化查询词，TTL 24h），相同查询的在途请求合并；
- 调用前在 SQLite 里“检查并 +1”日预算，失败也计数；
- 30001/30002/30003 与超时 → 不重试、降级；20001 → 鉴权失败告警，全站切换为精选证据。
"""
from __future__ import annotations

import asyncio
import hashlib
import re
import time
from typing import Optional
from urllib.parse import urlsplit

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from ..core.text import normalize_text

NOISE = re.compile(r"第\s*[0-9一二三四五六七八九十百千]+\s*章|穿书|系统")


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


CODE_KIND = {10001: "bad_request", 20001: "auth", 30001: "rate_limit", 30002: "rate_limit", 30003: "rate_limit", 90001: "upstream"}


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

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self._access_secret}", "X-Request-Timestamp": str(int(self.clock())),
                "Content-Type": "application/json"}

    async def _request(self, path: str, params: dict):
        if not self.enabled:
            raise ZhihuError("disabled", message="知乎实时调用未启用（ZHIHU_LIVE_ENABLED=false 或未配置凭据）")
        try:
            resp = await self._client.get(path, params=params, headers=self._headers())
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
            raise ZhihuError(CODE_KIND.get(data["Code"], "upstream"), data["Code"])
        return data

    async def import_quota(self) -> dict[str, int]:
        data = await self._request("/api/v1/quota", {"APIIDs": "zhihu_search,question_discovery"})
        quotas = data.get("Data")
        if not isinstance(quotas, list):
            raise ZhihuError("bad_response")
        return {
            item["APIID"]: item["RemainingQuota"]
            for item in quotas if isinstance(item, dict)
            and item.get("APIID") in ("zhihu_search", "question_discovery")
            and type(item.get("RemainingQuota")) is int and item["RemainingQuota"] >= 0
        }

    async def _get(self, path: str, params: dict, resource: str, cap: int) -> dict:
        if self.enabled and not self.uses_personal_quota and not self.store.try_consume(resource, cap):
            raise ZhihuError("budget", message=f"{resource} 今日公网额度已用完")
        data = await self._request(path, params)
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
