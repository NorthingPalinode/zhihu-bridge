"""模型适配器接口与工厂（V6 §6.6）。所有调用经过统一适配器，用环境变量切换供应商和模型。

- LLM_PROVIDER=disabled（默认）：提供证据查看，生成由操作员配置后启用。
- LLM_PROVIDER=fake：FakeLLM，读取 fixtures/dev_stubs/，产出一律标 provenance=dev_stub。
- LLM_PROVIDER=openai_compatible：OpenAI 兼容 /chat/completions，JSON 输出（未在本阶段真实调用过）。
- LLM_PROVIDER=zhihu_direct：知乎直答，使用开放平台 Access Secret。
- LLM_PROVIDER=siliconflow：硅基流动国内站的 DeepSeek V4.1 Flash，使用独立 API Key。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional, Protocol


class LLMError(Exception):
    def __init__(self, kind: str, message: str = "", *, retry_after: int = 0):
        super().__init__(message or kind)
        self.kind = kind  # timeout | rate_limit | bad_output | upstream | budget | unavailable
        self.retry_after = retry_after


@dataclass
class GenerateContext:
    text: str
    case_id: Optional[str]
    audience_id: str
    audience_label: str
    audience_constraint: str
    recommended_level: str
    levels: list[str]
    terms: list[Any]
    key_points: list[Any]
    evidence: list[Any]
    evidence_excerpts: dict[str, str] = field(default_factory=dict)
    planned_decisions: list[Any] = field(default_factory=list)
    fidelity_rules: dict = field(default_factory=dict)
    prompt_version: str = "prompt-v3"
    target_language: str = "en"
    retry_feedback: Optional[str] = None


@dataclass
class DraftContext:
    case_id: Optional[str]
    source_kind: str
    source_text: str
    source_label: str
    term_surface: Optional[str]
    key_point_text: Optional[str]
    query: str
    existing: list[dict]
    target_language: str = "en"


class LLMAdapter(Protocol):
    name: str
    model_version: str
    provenance: str  # real_run | dev_stub

    async def extract_terms(self, text: str) -> dict: ...
    async def generate(self, ctx: GenerateContext) -> dict: ...
    async def semantic_check(self, ctx: GenerateContext, level: str, text: str) -> list[dict]: ...
    async def rewrite(self, ctx: GenerateContext, level: str, text: str, problems: list[str]) -> dict: ...
    async def retell(self, ctx: GenerateContext, persona: dict, version_level: str, text: str) -> str: ...
    async def judge(self, ctx: GenerateContext, key_points: list[Any], retellings: list[str], rules: dict) -> list[list[dict]]: ...
    async def refine_query(self, seed_query: str, source_text: str) -> str: ...
    async def draft_question(self, ctx: DraftContext) -> dict: ...
    async def recommend(self, ctx: DraftContext) -> dict: ...


def make_llm(settings, fixtures) -> Optional[LLMAdapter]:
    provider = settings.llm_provider
    if provider == "disabled":
        return None
    if provider == "fake":
        from .llm_fake import FakeLLM

        return FakeLLM(fixtures, settings)
    if provider == "openai_compatible":
        from .llm_openai import OpenAICompatibleLLM

        return OpenAICompatibleLLM(settings)
    if provider == "zhihu_direct":
        from .llm_openai import ZhihuDirectLLM

        return ZhihuDirectLLM(settings)
    if provider == "siliconflow":
        from .llm_openai import SiliconFlowLLM

        return SiliconFlowLLM(settings)
    raise ValueError(f"未知 LLM_PROVIDER：{provider!r}（可选 disabled / fake / openai_compatible / zhihu_direct / siliconflow）")
