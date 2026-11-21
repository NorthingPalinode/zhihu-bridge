"""运行时依赖容器。"""
from __future__ import annotations

import asyncio
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any, Optional

from ..adapters.llm import LLMAdapter, LLMError, make_llm
from ..adapters.zhihu import ZhihuClient
from ..config import Settings
from ..core.replay import ReplayStore
from ..core.store import Store
from ..fixtures import FixtureStore


@dataclass
class RunRecord:
    snapshot: Any
    ctx: Any
    case: Any
    key: str


class LRU(OrderedDict):
    def __init__(self, cap: int = 200):
        super().__init__()
        self.cap = cap

    def put(self, k, v):
        self[k] = v
        self.move_to_end(k)
        while len(self) > self.cap:
            self.popitem(last=False)


@dataclass
class Deps:
    settings: Settings
    fx: FixtureStore
    store: Store
    llm: Optional[LLMAdapter]
    zhihu: ZhihuClient
    replays: ReplayStore
    runs: LRU = field(default_factory=LRU)
    tests: LRU = field(default_factory=LRU)
    run_slots: Optional[asyncio.Semaphore] = None
    zhihu_auth_failed: bool = False

    @property
    def generation_mode(self) -> str:
        if self.llm is None:
            return "degraded"
        return "dev_stub" if self.llm.provenance == "dev_stub" else "live"

    async def call_llm(self, fn, *args):
        """真实模型调用前按次数计入日预算（V6 §6.8）；fake 不计数。"""
        retry_waits = iter({"zhihu_direct": (3, 12, 45), "siliconflow": (1, 3)}.get(self.settings.llm_provider, ()))
        while True:
            if self.generation_mode == "live" and not self.store.try_consume("llm_calls", self.settings.llm_daily_cap):
                raise LLMError("budget", "模型日预算已触顶")
            try:
                return await fn(*args)
            except LLMError as exc:
                delay = next(retry_waits, None)
                if exc.kind != "rate_limit" or delay is None:
                    raise
                # If upstream asks for a longer wait, let the caller surface the limit.
                if exc.retry_after > 60:
                    raise
                await asyncio.sleep(max(delay, exc.retry_after))


def build_deps(settings: Optional[Settings] = None, llm=None, zhihu_transport=None) -> Deps:
    settings = settings or Settings()
    fx = FixtureStore(settings.fixtures_dir)
    store = Store(settings.db_path)
    if fx.compliance_rules:
        store.seed_compliance_rules(fx.compliance_rules)
    return Deps(
        settings=settings,
        fx=fx,
        store=store,
        llm=llm or make_llm(settings, fx),
        zhihu=ZhihuClient(settings, store, transport=zhihu_transport),
        replays=ReplayStore(settings.fixtures_dir / "replays"),
        run_slots=asyncio.Semaphore(max(1, settings.max_concurrent_runs)),
    )
