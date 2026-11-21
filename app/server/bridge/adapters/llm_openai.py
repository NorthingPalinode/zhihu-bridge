"""OpenAI 兼容 /chat/completions 适配器及固定供应商配置。"""
from __future__ import annotations

import asyncio
import json
import re
import time
from typing import Any, Optional

import httpx

from . import prompts
from .llm import DraftContext, GenerateContext, LLMError


class OpenAICompatibleLLM:
    name = "openai_compatible"
    provenance = "real_run"

    def __init__(self, settings, transport: Optional[httpx.AsyncBaseTransport] = None):
        if not (settings.llm_base_url and settings.llm_api_key and settings.llm_main_model):
            raise LLMError("unavailable", "缺少 LLM_BASE_URL / LLM_API_KEY / LLM_MAIN_MODEL")
        self._configure(base=settings.llm_base_url, token=settings.llm_api_key, main=settings.llm_main_model,
                        light=settings.llm_light_model, timeout=settings.llm_timeout_s, transport=transport)

    def _configure(self, *, base, token, main, light, timeout, transport):
        self.main = main
        self.light = light or main
        self.model_version = f"{self.main}|{self.light}"
        self._client = httpx.AsyncClient(
            base_url=base.rstrip("/"),
            timeout=timeout,
            transport=transport,
            headers={"Authorization": f"Bearer {token}"},
        )

    def _body(self, model: str, system: str, user: str, max_tokens: int) -> dict:
        return {
            "model": model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "response_format": {"type": "json_object"},
            "max_tokens": max_tokens,
            "temperature": 0.2,
        }

    def _request_headers(self) -> dict:
        return {}

    def _decode_content(self, content: str) -> Any:
        text = content.strip()
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            pass
        blocks = re.findall(r"```(?:json)?\s*([\s\S]*?)\s*```", text, flags=re.IGNORECASE)
        parsed = []
        for block in blocks:
            try:
                obj = json.loads(block.strip())
            except json.JSONDecodeError:
                continue
            if isinstance(obj, dict):
                parsed.append(obj)
        if len(parsed) == 1:
            return parsed[0]
        start = text.find("{")
        if start >= 0:
            decoder = json.JSONDecoder()
            obj, end = decoder.raw_decode(text, start)
            if isinstance(obj, dict) and "{" not in text[end:]:
                return obj
        raise json.JSONDecodeError("Unable to decode JSON object", text, 0)

    async def _json(self, model: str, system: str, user: str, max_tokens: int = 1200) -> Any:
        try:
            resp = await self._client.post("/chat/completions", json=self._body(model, system, user, max_tokens),
                                           headers=self._request_headers())
        except httpx.TimeoutException as exc:
            raise LLMError("timeout", "模型请求超时") from exc
        except httpx.HTTPError as exc:
            raise LLMError("upstream", f"模型请求失败：{exc.__class__.__name__}") from exc
        if resp.status_code == 429:
            retry = resp.headers.get("Retry-After", "")
            raise LLMError("rate_limit", "模型限流（429）", retry_after=int(retry) if retry.isdigit() else 0)
        if resp.status_code in (401, 403):
            raise LLMError("auth", f"模型鉴权失败（HTTP {resp.status_code}）")
        if resp.status_code >= 400:
            raise LLMError("upstream", f"模型返回 HTTP {resp.status_code}")
        try:
            choice = resp.json()["choices"][0]
            finish_reason = choice.get("finish_reason")
            content = choice.get("message", {}).get("content")
            if not isinstance(content, str) or not content.strip():
                if finish_reason == "length":
                    raise LLMError("bad_output", "模型输出因达到 max_tokens 上限被截断，内容为空")
                raise LLMError("bad_output", "模型返回空内容")
            result = self._decode_content(content)
            if not isinstance(result, dict):
                raise ValueError("expected a JSON object")
            return result
        except LLMError:
            raise
        except Exception as exc:  # noqa: BLE001
            if locals().get("finish_reason") == "length":
                raise LLMError("bad_output", "模型输出因达到 max_tokens 上限被截断，JSON 不完整") from exc
            raise LLMError("bad_output", f"模型输出不是合法 JSON（{exc.__class__.__name__}）") from exc

    async def extract_terms(self, text: str) -> dict:
        return await self._json(self.light, prompts.TERMS_SYSTEM, prompts.terms_user(text), 600)

    async def generate(self, ctx: GenerateContext) -> dict:
        budget = 5600 if len(ctx.levels) > 2 else 2600
        return await self._json(self.main, prompts.generate_system(ctx), prompts.generate_user(ctx), budget)

    async def semantic_check(self, ctx: GenerateContext, level: str, text: str) -> list[dict]:
        out = await self._json(self.main, prompts.CHECK_SYSTEM, prompts.check_user(ctx, level, text), 900)
        findings = out.get("findings")
        if not isinstance(findings, list):
            raise LLMError("bad_output", "语义检查缺少 findings 列表")
        return findings

    async def rewrite(self, ctx: GenerateContext, level: str, text: str, problems: list[str]) -> dict:
        return await self._json(self.main, prompts.rewrite_system(ctx), prompts.rewrite_user(ctx, level, text, problems), 900)

    async def retell(self, ctx: GenerateContext, persona: dict, version_level: str, text: str) -> str:
        out = await self._json(self.light, prompts.retell_system(ctx), prompts.retell_user(persona, text, ctx), 450)
        retelling = out.get("retelling")
        if not isinstance(retelling, str) or not retelling.strip():
            raise LLMError("bad_output", "复述为空")
        return retelling

    async def judge(self, ctx: GenerateContext, key_points: list[Any], retellings: list[str], rules: dict) -> list[list[dict]]:
        out = await self._json(self.main, prompts.JUDGE_SYSTEM, prompts.judge_user(key_points, retellings), 1200)
        results = out.get("results")
        if not isinstance(results, list):
            raise LLMError("bad_output", "评判缺少 results 列表")
        return results

    async def refine_query(self, seed_query: str, source_text: str) -> str:
        out = await self._json(self.light, prompts.QUERY_SYSTEM, prompts.query_user(seed_query, source_text), 120)
        q = out.get("query")
        return q if isinstance(q, str) and q.strip() else seed_query

    async def draft_question(self, ctx: DraftContext) -> dict:
        return await self._json(self.light, prompts.DRAFT_SYSTEM, prompts.draft_user(ctx), 600)

    async def recommend(self, ctx: DraftContext) -> dict:
        out = await self._json(self.light, prompts.RECOMMEND_SYSTEM, prompts.recommend_user(ctx), 200)
        rec = out.get("recommendation")
        if rec not in ("answer_existing", "new_question"):
            rec = "new_question"
        return {"recommendation": rec, "reason": str(out.get("reason", ""))}


class SiliconFlowLLM(OpenAICompatibleLLM):
    """SiliconFlow China preset for DeepSeek V4.1 Flash (overridable via SILICONFLOW_MODEL)."""

    name = "siliconflow"
    model_id = "deepseek-ai/DeepSeek-V4.1-Flash"

    def __init__(self, settings, transport: Optional[httpx.AsyncBaseTransport] = None):
        if not settings.siliconflow_api_key:
            raise LLMError("unavailable", "缺少 SILICONFLOW_API_KEY")
        model = settings.siliconflow_model or self.model_id
        self._configure(base="https://api.siliconflow.cn/v1", token=settings.siliconflow_api_key,
                        main=model, light=model, timeout=settings.llm_timeout_s, transport=transport)

    def _body(self, model: str, system: str, user: str, max_tokens: int) -> dict:
        return {**super()._body(model, system, user, max_tokens), "enable_thinking": False, "stream": False}


class ZhihuDirectLLM(OpenAICompatibleLLM):
    """Zhihu Direct uses the platform secret and the model/messages/stream wire format."""

    name = "zhihu_direct"
    models = ("zhida-fast-1p5", "zhida-thinking-1p5")

    def __init__(self, settings, transport: Optional[httpx.AsyncBaseTransport] = None):
        main = settings.llm_main_model or self.models[0]
        light = settings.llm_light_model or main
        if not settings.zhihu_access_secret:
            raise LLMError("unavailable", "缺少 ZHIHU_ACCESS_SECRET")
        if main not in self.models or light not in self.models:
            raise LLMError("unavailable", "知乎直答需要选择支持上下文的模型档位")
        self._configure(base="https://developer.zhihu.com/v1", token=settings.zhihu_access_secret,
                        main=main, light=light, timeout=settings.llm_timeout_s, transport=transport)
        self._inflight = asyncio.Lock()

    async def _json(self, model: str, system: str, user: str, max_tokens: int = 1200) -> Any:
        async with self._inflight:
            return await super()._json(model, system, user, max_tokens)

    def _request_headers(self) -> dict:
        return {"X-Request-Timestamp": str(int(time.time()))}

    def _body(self, model: str, system: str, user: str, max_tokens: int) -> dict:
        return {"model": model, "stream": False, "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": "任务要求：" + system + "\n\n" + user + "\n仅输出一个符合上述格式的 JSON 对象。"},
        ]}
