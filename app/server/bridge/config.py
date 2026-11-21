"""运行配置：全部来自环境变量（见 app/.env.example），不读取 .env 文件、不内置任何密钥。"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parents[2]  # work/app


def _bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    try:
        return int(raw) if raw else default
    except ValueError:
        return default


def _float(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    try:
        return float(raw) if raw else default
    except ValueError:
        return default


def _llm_provider() -> str:
    return (os.environ.get("LLM_PROVIDER") or "disabled").strip().lower()


@dataclass
class Settings:
    fixtures_dir: Path = field(default_factory=lambda: Path(os.environ.get("FIXTURES_DIR") or APP_ROOT / "fixtures"))
    db_path: Path = field(default_factory=lambda: Path(os.environ.get("DB_PATH") or APP_ROOT / "var" / "bridge.sqlite3"))
    web_dist: Path = field(default_factory=lambda: Path(os.environ.get("WEB_DIST") or APP_ROOT / "web" / "dist"))

    # 模型
    llm_provider: str = field(default_factory=_llm_provider)
    llm_base_url: str = field(default_factory=lambda: os.environ.get("LLM_BASE_URL", "").strip())
    llm_api_key: str = field(default_factory=lambda: os.environ.get("LLM_API_KEY", "").strip(), repr=False)
    siliconflow_api_key: str = field(default_factory=lambda: os.environ.get("SILICONFLOW_API_KEY", "").strip(), repr=False)
    siliconflow_model: str = field(default_factory=lambda: os.environ.get("SILICONFLOW_MODEL", "").strip())
    llm_main_model: str = field(default_factory=lambda: os.environ.get("LLM_MAIN_MODEL", "").strip())
    llm_light_model: str = field(default_factory=lambda: os.environ.get("LLM_LIGHT_MODEL", "").strip())
    llm_daily_cap: int = field(default_factory=lambda: _int("LLM_DAILY_CAP", 1000))
    llm_timeout_s: float = field(default_factory=lambda: _float("LLM_TIMEOUT_S", 45.0 if _llm_provider() in ("zhihu_direct", "siliconflow") else 20.0))

    # 知乎开放平台（接口路径为 V5 记录·待复核）
    zhihu_live_enabled: bool = field(default_factory=lambda: _bool("ZHIHU_LIVE_ENABLED", False))
    zhihu_preset_live_search: bool = field(default_factory=lambda: _bool("ZHIHU_PRESET_LIVE_SEARCH", False))
    zhihu_access_secret: str = field(default_factory=lambda: os.environ.get("ZHIHU_ACCESS_SECRET", "").strip(), repr=False)
    zhihu_api_base: str = field(default_factory=lambda: os.environ.get("ZHIHU_API_BASE", "https://developer.zhihu.com").rstrip("/"))
    zhihu_search_path: str = field(default_factory=lambda: os.environ.get("ZHIHU_SEARCH_PATH", "/api/v1/content/zhihu_search"))
    zhihu_question_rec_path: str = field(default_factory=lambda: os.environ.get("ZHIHU_QUESTION_REC_PATH", "/api/v1/user/question_recommendations"))
    zhihu_soft_timeout_s: float = field(default_factory=lambda: _float("ZHIHU_SOFT_TIMEOUT_S", 5.0))
    sse_keepalive_s: float = field(default_factory=lambda: _float("SSE_KEEPALIVE_S", 10.0))

    # 预算与限流（V6 §6.8 初值）
    budget_zhihu_search_cap: int = field(default_factory=lambda: _int("BUDGET_ZHIHU_SEARCH_PUBLIC_CAP", 6))
    budget_question_discovery_cap: int = field(default_factory=lambda: _int("BUDGET_QUESTION_DISCOVERY_PUBLIC_CAP", 6))
    rate_runs_per_ip_hour: int = field(default_factory=lambda: _int("RATE_LIMIT_RUNS_PER_IP_HOUR", 120))
    rate_tests_per_ip_hour: int = field(default_factory=lambda: _int("RATE_LIMIT_TESTS_PER_IP_HOUR", 120))
    rate_drafts_per_ip_hour: int = field(default_factory=lambda: _int("RATE_LIMIT_DRAFTS_PER_IP_HOUR", 120))
    max_concurrent_runs: int = field(default_factory=lambda: _int("GLOBAL_MAX_CONCURRENT_RUNS", 3))
    trusted_proxy_ips: tuple[str, ...] = field(
        default_factory=lambda: tuple(x.strip() for x in os.environ.get("TRUSTED_PROXY_IPS", "").split(",") if x.strip())
    )

    # 本地演示：fake 适配器的节奏与故障演练（只影响 fake）
    fake_step_delay_ms: int = field(default_factory=lambda: _int("FAKE_STEP_DELAY_MS", 350))
    fake_failure: str = field(default_factory=lambda: (os.environ.get("FAKE_FAILURE") or "none").strip().lower())
    test_timeout_s: float = field(default_factory=lambda: _float(
        "TEST_TIMEOUT_S", {"zhihu_direct": 200.0, "siliconflow": 90.0}.get(_llm_provider(), 15.0),
    ))

    prompt_version: str = "prompt-v3"

    @property
    def is_fake(self) -> bool:
        return self.llm_provider == "fake"

    def public_view(self) -> dict:
        """可写进 health/日志的非敏感视图。"""
        key_configured = {
            "zhihu_direct": bool(self.zhihu_access_secret),
            "siliconflow": bool(self.siliconflow_api_key),
            "openai_compatible": bool(self.llm_api_key),
            "fake": bool(self.llm_api_key),
        }
        return {
            "llmProvider": self.llm_provider,
            "zhihuLive": self.zhihu_live_enabled,
            "zhihuSecretConfigured": bool(self.zhihu_access_secret),
            "llmKeyConfigured": key_configured.get(self.llm_provider, False),
        }
