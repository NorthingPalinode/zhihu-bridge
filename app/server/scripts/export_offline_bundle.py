"""生成前端离线包数据 web/public/offline/bundle.json（V6 §6.9 离线包）。

- 有真实冻结回放（fixtures/replays/，provenance=real_run）时一并收录，标 replay；
- 否则只能收录 fake 适配器的开发占位结果，整包标 provenance=dev_stub，界面显示“开发占位 · 离线”。
"""
import argparse
import asyncio
import json
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import _path
from bridge.config import Settings
from bridge.contracts import QuestionDraftRequest, RunRequest, TestRequest
from bridge.core.replay import run_key
from bridge.core.text import normalize_text
from bridge.pipeline.deps import Deps, build_deps
from bridge.pipeline.questions import make_draft
from bridge.pipeline.runs import execute_run
from bridge.pipeline.tests import run_test

OUT = _path.APP / "web" / "public" / "offline" / "bundle.json"


async def build_bundle(deps: Deps) -> dict:
    if deps.llm.provenance != "dev_stub" or deps.zhihu.enabled:
        raise ValueError("离线导出只读取冻结文件并允许本地占位数据")
    bundle = {
        "provenance": "dev_stub",
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "note": "离线包：fake 适配器产出的开发占位数据，非真实运行、非评测结果；不得当作回放展示。",
        "cases": [],
        "complianceRules": deps.store.list_compliance_rules(enabled_only=True),
        "runs": {}, "tests": {}, "drafts": {}, "replayDrafts": {}, "replays": 0,
    }
    for case in deps.fx.cases.values():
        for aud in case.audiences:
            prefix = f"{case.caseId}|{aud.id}"
            key = run_key(case.text, aud.id, deps.settings.prompt_version, deps.fx.corpus_version)
            frozen = deps.replays.get(key)
            if not frozen and case.caseId not in deps.fx.gen_stub:
                continue
            if frozen and frozen["snapshot"]["caseId"] != case.caseId:
                raise ValueError(f"回放案例与离线入口不一致：{prefix}")
            mode = "replay" if frozen else "auto"
            events = [e async for e in execute_run(RunRequest(text=case.text, audienceId=aud.id, caseId=case.caseId, mode=mode), deps)]
            assert events[-1]["type"] == "ready", events[-1]
            bundle["runs"][prefix] = events
            snap = events[-1]["payload"]
            if frozen:
                bundle["replays"] += 1
                for result in frozen["tests"].values():
                    subset = ",".join(sorted(result["keyPointIds"]))
                    bundle["tests"][f"{prefix}|{result['level']}|{subset}"] = {**result, "mode": "replay"}
                for source_hash, draft in frozen["drafts"].items():
                    bundle["replayDrafts"][f"{prefix}|{source_hash}"] = {
                        **draft, "mode": "replay",
                        "existingSource": "replay" if draft["existing"] else draft["existingSource"],
                    }
                continue
            if not case.raw.get("testEnabled"):
                continue
            for level in case.levels:
                res = await run_test(snap["runId"], TestRequest(revision=1, level=level, keyPointIds=[k.id for k in case.keyPoints]), deps)
                bundle["tests"][f"{prefix}|{level}"] = res.model_dump()
                for r in res.readers:
                    for j in r.judgments:
                        if j.verdict == "hit" or not j.quote.strip():
                            continue
                        term = next((t.id for t in case.terms if j.keyPointId in t.keyPointIds), None)
                        req = QuestionDraftRequest(source={"kind": "reader_misreading", "text": j.quote, "testId": res.testId, "keyPointId": j.keyPointId},
                                                   caseId=case.caseId, runId=snap["runId"], termIds=[term] if term else [])
                        d = await make_draft(req, deps)
                        bundle["drafts"][f"{prefix}|{j.keyPointId}|{normalize_text(j.quote)}"] = d.model_dump()
        available = [aud.id for aud in case.audiences if f"{case.caseId}|{aud.id}" in bundle["runs"]]
        if available:
            meta = case.public()
            meta["audiences"] = [a for a in meta["audiences"] if a["id"] in available]
            if meta["defaultAudienceId"] not in available:
                meta["defaultAudienceId"] = available[0]
            bundle["cases"].append(meta)
    if bundle["replays"]:
        bundle["provenance"] = "real_run" if bundle["replays"] == len(bundle["runs"]) else "mixed"
        bundle["note"] = "离线包：已冻结的运行使用缓存回放，缺失的案例组合使用明确标注的开发占位。"
    return bundle


async def main(output: Path) -> int:
    with tempfile.TemporaryDirectory() as folder:
        settings = Settings(llm_provider="fake", zhihu_live_enabled=False, fake_step_delay_ms=0,
                            fake_failure="none", db_path=Path(folder) / "bundle.sqlite3")
        deps = build_deps(settings)
        try:
            bundle = await build_bundle(deps)
        finally:
            deps.store.close()
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=output.parent) as folder:
        pending = Path(folder) / output.name
        pending.write_text(json.dumps(bundle, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        pending.replace(output)
    print(f"已写入 {output}：runs={len(bundle['runs'])} replays={bundle['replays']} tests={len(bundle['tests'])} provenance={bundle['provenance']}")
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="导出离线体验包")
    parser.add_argument("--output", type=Path, default=OUT)
    sys.exit(asyncio.run(main(parser.parse_args().output)))
