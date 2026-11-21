"""冻结真实运行为回放（V6 §6.9）。只在配置了真实模型（LLM_PROVIDER != fake）时可用；fake 一律拒绝。

注意：执行会产生真实模型调用费用，需事先获得用户许可。本阶段未执行。
用法：python scripts/freeze_replay.py case_a a_new [--with-drafts]
"""
import argparse
import asyncio
import json
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import _path  # noqa: F401
from bridge.config import Settings
from bridge.contracts import QuestionDraftRequest, RunRequest, TestRequest
from bridge.core.replay import draft_key, run_key, test_key
from bridge.pipeline.deps import build_deps
from bridge.pipeline.questions import make_draft
from bridge.pipeline.runs import execute_run
from bridge.pipeline.tests import run_test


async def freeze(case_id: str, audience_id: str, with_drafts: bool = False) -> int:
    settings = Settings()
    if settings.llm_provider in ("fake", "disabled"):
        print("冻结回放前需要配置真实模型。")
        return 2
    deps = build_deps(settings)
    case = deps.fx.cases[case_id]
    events = [e async for e in execute_run(RunRequest(text=case.text, audienceId=audience_id, caseId=case_id), deps)]
    if events[-1]["type"] != "ready":
        print("真实运行未成功，未冻结：", events[-1]["payload"])
        return 1
    snap = events[-1]["payload"]
    if snap["provenance"] != "real_run" or snap["mode"] != "live":
        print("拒绝：需要本次新生成的真实运行快照")
        return 2
    published_variants = [v for v in snap["variants"] if v["level"] != "literal"]
    if any(v["exportState"] != "exportable" for v in published_variants):
        print("终稿尚未通过守门，未冻结")
        return 1
    key = run_key(case.text, audience_id, settings.prompt_version, deps.fx.corpus_version)
    tests = {}
    drafts = {}
    if case.raw.get("testEnabled"):
        kps = [k.id for k in case.keyPoints]
        for variant in published_variants:
            level = variant["level"]
            res = await run_test(snap["runId"], TestRequest(revision=1, level=level, keyPointIds=kps), deps)
            tests[test_key(key, level, kps)] = res.model_dump()
            if not with_drafts:
                continue
            candidates = [j for reader in res.readers for j in reader.judgments if j.verdict != "hit" and j.quote.strip()]
            if not candidates:
                continue
            example = min(candidates, key=lambda j: j.verdict != "contradicted")
            source_hash = draft_key(example.quote)
            if source_hash in drafts:
                continue
            draft = await make_draft(QuestionDraftRequest(
                source={"kind": "reader_misreading", "text": example.quote, "testId": res.testId, "keyPointId": example.keyPointId},
                caseId=case_id, runId=snap["runId"],
            ), deps)
            drafts[source_hash] = draft.model_dump()
    out = {"provenance": "real_run", "frozenAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "key": key, "caseId": case_id, "audienceId": audience_id, "snapshot": snap, "tests": tests, "drafts": drafts}
    path = settings.fixtures_dir / "replays" / f"{case_id}_{audience_id}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=path.parent) as folder:
        pending = Path(folder) / path.name
        pending.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
        pending.replace(path)
    print("已冻结：", path)
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="冻结验证通过的真实运行")
    parser.add_argument("case_id")
    parser.add_argument("audience_id")
    parser.add_argument("--with-drafts", action="store_true", help="为每档选取一处模拟误解，调用模型生成并冻结提问草稿")
    args = parser.parse_args()
    sys.exit(asyncio.run(freeze(args.case_id, args.audience_id, args.with_drafts)))
