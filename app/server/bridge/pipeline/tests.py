"""模拟读者复述测试（V6 §6.6）：3 位人设 × 2 个版本（直译 vs 选中档）× 1 次复述 + 1 次隔离评判。

部分失败时按实际有效样本计算，不补造结果（V6 §5.5）。
"""
from __future__ import annotations

import asyncio
import time
import uuid
from collections import Counter

from pydantic import ValidationError

from ..adapters.llm import LLMError
from ..contracts import Judgment, Reader, Tally, TestRequest, TestResult, TestSummary
from ..core.logs import event as log_event
from ..core.replay import test_key
from ..core.text import variant_text
from .deps import Deps


class TestRequestError(ValueError):
    __test__ = False

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


async def run_test(run_id: str, req: TestRequest, deps: Deps) -> TestResult:
    rec = deps.runs.get(run_id)
    if rec is None:
        raise TestRequestError(404, "找不到该运行，请重新开始转译")
    snap = rec.snapshot
    if req.revision != snap.revision:
        raise TestRequestError(409, "测试请求的版本与当前运行不一致")
    if rec.ctx is None:  # 回放运行：只能取冻结的测试结果
        frozen = deps.replays.find_test(rec.key, test_key(rec.key, req.level, req.keyPointIds))
        if not frozen:
            raise TestRequestError(404, "该回放中没有对应的冻结测试结果")
        result = TestResult(**{**frozen, "runId": run_id, "testId": "t_" + uuid.uuid4().hex[:10], "mode": "replay"})
        deps.tests.put(result.testId, result)
        return result
    case = rec.case
    if deps.llm is None:
        raise TestRequestError(503, "模拟读者测试需要先配置模型")
    if case is not None and not case.raw.get("testEnabled"):
        raise TestRequestError(400, case.raw.get("testDisabledReason") or "该案例不含模拟读者测试")
    variant = next((v for v in snap.variants if v.level == req.level), None)
    literal = next((v for v in snap.variants if v.level == "literal"), None)
    if variant is None or req.level == "literal" or literal is None:
        raise TestRequestError(400, "档位不合法（直译只用于对照）")
    kp_by_id = {k.id: k for k in snap.keyPoints}
    requested = set(req.keyPointIds)
    if len(requested) != len(req.keyPointIds) or not requested.issubset(kp_by_id):
        raise TestRequestError(400, "信息点不合法")
    key_points = [kp_by_id[k] for k in req.keyPointIds]

    aud = case.audience(snap.audienceId) if case else None
    persona_set = (aud.personaSetId if aud else None) or snap.audienceId
    personas = deps.fx.personas.get(persona_set, [])[:3]
    if not personas:
        raise TestRequestError(400, "当前受众没有配置模拟读者")

    jobs = []
    for p in personas:
        jobs.append((p, "literal", "literal", variant_text(literal.segments)))
        jobs.append((p, "selected", req.level, variant_text(variant.segments)))

    sem = asyncio.Semaphore(1 if deps.settings.llm_provider == "zhihu_direct" else 6)
    deadline = time.monotonic() + deps.settings.test_timeout_s

    async def one(p, version_level, text):
        async with sem:
            remaining = max(0.1, deadline - time.monotonic() - 1.0)  # 预留评判时间
            return await asyncio.wait_for(deps.call_llm(deps.llm.retell, rec.ctx, p, version_level, text), timeout=remaining)

    results = await asyncio.gather(*(one(p, lvl, t) for p, _, lvl, t in jobs), return_exceptions=True)
    failures = Counter(
        r.kind if isinstance(r, LLMError) else type(r).__name__
        for r in results if isinstance(r, BaseException)
    )
    if failures:
        log_event("test.retell_failed", runId=run_id, reasons=dict(failures))

    readers: list[Reader] = []
    ok_idx, ok_texts = [], []
    for i, ((p, version, _, _), res) in enumerate(zip(jobs, results)):
        if isinstance(res, BaseException):
            readers.append(Reader(personaId=p["id"], personaLabel=p["label"], version=version, status="failed"))
        else:
            readers.append(Reader(personaId=p["id"], personaLabel=p["label"], version=version, retelling=res))
            ok_idx.append(i)
            ok_texts.append(res)

    judge_error: str | None = None
    if ok_texts:
        rules = case.raw.get("judgeRules", {}) if case else {}
        try:
            remaining = max(0.5, deadline - time.monotonic())
            judged = await asyncio.wait_for(deps.call_llm(deps.llm.judge, rec.ctx, key_points, ok_texts, rules), timeout=remaining)
            if not isinstance(judged, list) or len(judged) != len(ok_idx):
                raise LLMError("bad_output", "评判结果与复述列表不对应")
            for i, js in zip(ok_idx, judged):
                if not isinstance(js, list):
                    continue
                judgments: dict[str, Judgment] = {}
                for raw in js:
                    try:
                        judgment = Judgment.model_validate(raw)
                    except ValidationError:
                        continue
                    if judgment.keyPointId in requested:
                        judgments.setdefault(judgment.keyPointId, judgment)
                readers[i] = readers[i].model_copy(update={"judgments": list(judgments.values())})
        except (LLMError, asyncio.TimeoutError) as exc:
            kind = exc.kind if isinstance(exc, LLMError) else "timeout"
            judge_error = f"信息点自动评判未完成（{kind}），以下仅保留读者复述，未生成命中统计，请稍后重试。"
            log_event("test.judge_failed", runId=run_id, reason=kind)

    def tally(version: str) -> Tally:
        cells = [j for r in readers if r.version == version for j in r.judgments]
        return Tally(hit=sum(1 for j in cells if j.verdict == "hit"), valid=len(cells))

    result = TestResult(
        testId="t_" + uuid.uuid4().hex[:10], runId=run_id, revision=snap.revision, level=req.level,
        keyPointIds=req.keyPointIds, expected=len(jobs), completed=len(ok_texts), readers=readers,
        summary=TestSummary(literal=tally("literal"), selected=tally("selected")),
        mode=deps.generation_mode, provenance=deps.llm.provenance,
        judgeError=judge_error,
    )
    deps.tests.put(result.testId, result)
    log_event("test.done", runId=run_id, testId=result.testId, completed=result.completed, expected=result.expected, mode=result.mode)
    return result
