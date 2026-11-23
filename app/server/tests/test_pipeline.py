import pytest

from bridge import contracts as C
from bridge.adapters.llm import LLMError
from bridge.adapters.llm_fake import FakeLLM
from bridge.adapters.prompts import check_user
from bridge.pipeline.deps import build_deps
from bridge.pipeline.questions import DraftError, make_draft
from bridge.pipeline.runs import InputError, execute_run
from bridge.pipeline.tests import TestRequestError, run_test
from bridge.core.text import variant_text

KPS = ["KP1", "KP2", "KP3"]


async def collect(deps, text, aud, case_id=None):
    return [e async for e in execute_run(C.RunRequest(text=text, audienceId=aud, caseId=case_id), deps)]


def vt(snap, level):
    return variant_text(next(v for v in snap.variants if v.level == level).segments)


@pytest.mark.parametrize("aud,rec", [("a_new", "plain"), ("a_genre", "genre")])
async def test_case_a_full_run(deps, case_a_text, aud, rec):
    evs = await collect(deps, case_a_text, aud, "case_a")
    assert [e["type"] for e in evs] == ["started", "terms", "evidence", "ready"]
    assert [e["seq"] for e in evs] == [1, 2, 3, 4]
    assert len({e["runId"] for e in evs}) == 1
    snap = C.RunSnapshot(**evs[-1]["payload"])
    assert snap.mode == "dev_stub" and snap.provenance == "dev_stub"  # 开发占位，不得是 live/replay
    assert snap.evidenceSource == "zhihu_curated"
    assert snap.recommendedLevel == rec  # 推荐档由案例配置确定性给出
    levels = {v.level: v for v in snap.variants}
    assert set(levels) == {"literal", "plain", "genre"}
    assert levels["literal"].exportState == "draft"  # 直译参照不可复制
    for lv in ("plain", "genre"):
        v = levels[lv]
        assert v.exportState == "exportable"
        assert all(c.status == "pass" for c in v.checks if c.kind == "fidelity")
        assert {c.keyPointId for c in v.checks if c.kind == "fidelity"} == set(KPS)
    assert "ninefold" in vt(snap, "plain").lower() and "Ninefold Thunder Tribulation" in vt(snap, "genre")
    d1 = next(d for d in snap.decisions if d.id == "D1")
    assert d1.attribution == "zhihu" and d1.evidenceIds == ["A1#1"]
    assert levels["genre"].notes and levels["genre"].notes[0].evidenceIds


async def test_case_c_translates_fully_and_passes_compliance_db(deps, case_c_text):
    evs = await collect(deps, case_c_text, "c_shopper", "case_c")
    snap = C.RunSnapshot(**evs[-1]["payload"])
    single = next(v for v in snap.variants if v.level == "single")
    final = variant_text(single.segments)
    assert final == "A light, refreshing herbal tea for humid days — cooling and soothing to rescue you from late-night burnout."
    assert single.exportState == "exportable"
    assert single.candidateText is None
    fid = [c for c in single.checks if c.kind == "fidelity"]
    assert {c.keyPointId for c in fid} == {"KP1", "KP2", "KP3"}
    assert all(c.status == "pass" for c in fid)
    claims = [c for c in single.checks if c.kind == "claim"]
    assert {c.riskCategory for c in claims} == {"legal", "custom"}
    assert all(c.status == "pass" for c in claims)
    for word in ("detox", "dampness", "cure", "immun"):
        assert word not in final.lower()


async def test_compliance_db_blocks_foreign_ad_law_and_custom_taboos(deps, monkeypatch):
    # 1. Foreign ad-law violation (legal) triggers rewrite instead of truncating
    async def generate_illegal(ctx):
        return {"variants": [
            {"level": "literal", "segments": [{"text": "lit"}]},
            {"level": "single", "segments": [{"text": "Dampness-removing herbal tea that detoxes and 100% guaranteed cures internal heat."}]},
        ]}

    async def rewrite_compliant(ctx, level, text, problems):
        assert any("排毒" in p or "医疗" in p or "绝对化" in p for p in problems)
        return {"segments": [
            {"text": "A light, refreshing herbal tea for humid days — cooling and soothing to rescue you from late-night burnout."}
        ]}

    monkeypatch.setattr(deps.llm, "generate", generate_illegal)
    monkeypatch.setattr(deps.llm, "rewrite", rewrite_compliant)
    evs = await collect(deps, deps.fx.cases["case_c"].text, "c_shopper", "case_c")
    snap = C.RunSnapshot(**evs[-1]["payload"])
    single = next(v for v in snap.variants if v.level == "single")
    assert single.exportState == "exportable"
    assert single.candidateText and "detoxes" in single.candidateText
    legal_hits = [c for c in single.checks if c.riskCategory == "legal" and c.status == "fail"]
    assert legal_hits and all(c.finalText and "cooling and soothing" in c.finalText for c in legal_hits)

    # 2. Target market cultural taboo (custom: Arabic market pork/alcohol) is blocked
    async def generate_taboo(ctx):
        variants = [{"level": "literal", "segments": [{"text": "عرض خاص"}]}]
        for idx, lv in enumerate(ctx.levels):
            variants.append({"level": lv, "segments": [{"text": f"شاي أعشاب بنكهة لحم الخنزير و كحول {idx + 1}"}]})
        return {"variants": variants}

    async def rewrite_fail(ctx, level, text, problems):
        raise LLMError("unavailable", "no rewrite")

    monkeypatch.setattr(deps.llm, "generate", generate_taboo)
    monkeypatch.setattr(deps.llm, "rewrite", rewrite_fail)
    req = C.RunRequest(text="手工草本风味特调", audienceId="general_overseas", targetLanguage="ar")
    evs_ar = [e async for e in execute_run(req, deps)]
    snap_ar = C.RunSnapshot(**evs_ar[-1]["payload"])
    plain_ar = next(v for v in snap_ar.variants if v.level == "plain")
    assert plain_ar.exportState == "draft"
    custom_blocks = [c for c in plain_ar.checks if c.riskCategory == "custom" and c.status == "fail"]
    assert len(custom_blocks) >= 2


async def test_case_b_blocks_invented_hardware_claims_until_rewritten(deps, monkeypatch):
    verified_copy = "In-house high-density PCB with carefully selected components, optimized for power efficiency and supporting low-level protocol debugging."
    initial = verified_copy + " Open-source design with 72 hours of battery life and award-winning performance."

    async def generate(ctx):
        return {"variants": [
            {"level": level, "segments": [{"text": initial}]} for level in ("literal", *ctx.levels)
        ]}

    async def semantic_check(ctx, level, text):
        job = check_user(ctx, level, text)
        assert "power-optimized" in job and "不承诺功耗水平、续航或开源" in job
        return []

    case = deps.fx.cases["case_b"]
    monkeypatch.setattr(deps.llm, "generate", generate)
    monkeypatch.setattr(deps.llm, "semantic_check", semantic_check)
    blocked = await _ready(deps, case.text, case.defaultAudienceId, case.caseId)
    plain = next(v for v in blocked.variants if v.level == "plain")
    assert plain.exportState == "draft"
    assert {"调试承诺", "续航或功耗数值", "无依据的比较或认证"}.issubset({c.rule for c in plain.checks if c.status == "fail"})
    assert {e.id for e in blocked.evidence} == {"B1#1", "B2#1", "B2#2", "B3#1"}
    assert blocked.evidenceSource == "zhihu_curated"

    async def rewrite(*args):
        return {"segments": [{"text": verified_copy}]}

    monkeypatch.setattr(deps.llm, "rewrite", rewrite)
    revised = await _ready(deps, case.text, case.defaultAudienceId, case.caseId)
    plain = next(v for v in revised.variants if v.level == "plain")
    assert plain.exportState == "exportable" and plain.candidateText == initial
    assert vt(revised, "plain") == verified_copy
    assert any(c.rule == "性能声称" and c.status == "warn" for c in plain.checks)


async def test_semantic_check_pass_items_do_not_duplicate_fidelity_checks(deps, case_a_text, monkeypatch):
    async def semantic_check(ctx, level, text):
        return [
            {"kind": "fidelity", "keyPointId": kp.id, "status": "pass", "action": "none", "reason": "已保留"}
            for kp in ctx.key_points
        ]

    monkeypatch.setattr(deps.llm, "semantic_check", semantic_check)
    snap = await _ready(deps, case_a_text, "a_new", "case_a")
    for variant in snap.variants:
        if variant.level != "literal":
            assert [c.id for c in variant.checks] == ["F-KP1", "F-KP2", "F-KP3", "L0", "C0"]


async def test_missing_semantic_check_keeps_variants_locked(deps, case_a_text, monkeypatch):
    async def timeout(*args):
        raise LLMError("timeout", "semantic check timed out")

    monkeypatch.setattr(deps.llm, "semantic_check", timeout)
    snap = await _ready(deps, case_a_text, "a_new", "case_a")
    for variant in snap.variants:
        assert variant.exportState == "draft"
        if variant.level != "literal":
            assert any(c.id == "S0" and c.action == "review" for c in variant.checks)


async def test_rewrite_remains_locked_until_final_semantic_check_passes(deps, case_c_text, monkeypatch):
    seen = []
    rewritten = "A light, refreshing herbal tea for humid days — cooling and soothing to rescue you from late-night burnout."

    async def generate_bad(ctx):
        return {"variants": [
            {"level": "literal", "segments": [{"text": "lit"}]},
            {"level": "single", "segments": [{"text": "Dampness-removing herbal tea that detoxes."}]},
        ]}

    async def rewrite_ok(ctx, level, text, problems):
        return {"segments": [{"text": rewritten}]}

    async def semantic_check(ctx, level, text):
        seen.append(text)
        if text == rewritten:
            return [{"kind": "claim", "status": "fail", "action": "review", "reason": "仍需人工复核"}]
        return []

    monkeypatch.setattr(deps.llm, "generate", generate_bad)
    monkeypatch.setattr(deps.llm, "rewrite", rewrite_ok)
    monkeypatch.setattr(deps.llm, "semantic_check", semantic_check)
    snap = await _ready(deps, case_c_text, "c_shopper", "case_c")
    variant = next(v for v in snap.variants if v.level == "single")
    assert seen == [variant.candidateText, rewritten]
    assert variant.exportState == "draft"
    assert any(c.rule == "语义检查" and c.action == "review" for c in variant.checks)


async def test_edited_case_text_becomes_custom_input(deps):
    evs = await collect(deps, "此乃天道因果，若扛不过九重雷劫，只能魂飞魄散。", "a_new", "case_a")
    snap = C.RunSnapshot(**evs[-1]["payload"])
    assert snap.caseId is None
    assert snap.evidenceSource == "none" and snap.evidence == []
    assert any("知乎证据不足" in n for n in snap.notices)
    assert all(v.exportState == "draft" for v in snap.variants)  # fake 不生成自定义译稿 → 不可复制
    assert snap.mode == "dev_stub"


async def test_custom_input_with_claim_words_rewrites_to_safe_copy(deps):
    # 自定义输入命中中文功效词时，应触发剥离改写并生成安全可复制终稿（而非死锁在 needs_data）。
    class RewritingLLM(FakeLLM):
        async def generate(self, ctx):
            assert ctx.audience_id == "general_overseas"
            bad = [{"text": "Dampness-clearing herbal tea for summer days", "termIds": [], "evidenceIds": []}]
            return {"recommendationReason": "", "variants": [
                {"level": "literal", "segments": bad},
                {"level": "plain", "segments": bad},
                {"level": "genre", "segments": bad},
            ], "decisions": []}

        async def rewrite(self, ctx, level, text, problems):
            return {"segments": [{"text": "Herbal tea for summer days", "termIds": [], "evidenceIds": []}], "notes": []}

    deps.llm = RewritingLLM(deps.fx, deps.settings)
    evs = await collect(deps, "祛湿凉茶，夏天喝", "general_overseas")
    snap = C.RunSnapshot(**evs[-1]["payload"])
    plain = next(v for v in snap.variants if v.level == "plain")
    assert plain.exportState == "exportable"
    assert variant_text(plain.segments) == "Herbal tea for summer days"
    assert plain.candidateText == "Dampness-clearing herbal tea for summer days"
    legal_claim = next(c for c in plain.checks if c.id == "L1")
    assert legal_claim.riskCategory == "legal" and legal_claim.action == "rewrite" and legal_claim.finalText == "Herbal tea for summer days"

    # 若改写未完成，则必须保持不可复制的草稿态。
    class FailingRewriteLLM(RewritingLLM):
        async def rewrite(self, ctx, level, text, problems):
            raise LLMError("unavailable", "rewrite failed")

    deps.llm = FailingRewriteLLM(deps.fx, deps.settings)
    blocked_evs = await collect(deps, "祛湿凉茶，夏天喝", "general_overseas")
    blocked_snap = C.RunSnapshot(**blocked_evs[-1]["payload"])
    blocked_plain = next(v for v in blocked_snap.variants if v.level == "plain")
    assert blocked_plain.exportState == "draft"


async def test_check_variants_runs_concurrently(deps, case_a_text):
    import asyncio

    active = 0
    peak = 0

    class ConcurrentCheckLLM(FakeLLM):
        async def semantic_check(self, ctx, level, text):
            nonlocal active, peak
            active += 1
            peak = max(peak, active)
            await asyncio.sleep(0.05)
            active -= 1
            return []

    deps.llm = ConcurrentCheckLLM(deps.fx, deps.settings)
    snap = await _ready(deps, case_a_text, "a_new", "case_a")
    assert snap.mode == "dev_stub"
    assert peak >= 2


@pytest.mark.parametrize("text,msg", [("   ", "请输入原文"), ("字" * 401, "超过 400")])
async def test_input_validation(deps, text, msg):
    with pytest.raises(InputError, match=msg):
        await collect(deps, text, "a_new")


async def test_generate_failure_without_replay_degrades(make_settings, case_a_text):
    deps = build_deps(make_settings(FAKE_FAILURE="generate"))
    evs = await collect(deps, case_a_text, "a_new", "case_a")
    assert [e["type"] for e in evs] == ["started", "terms", "evidence", "error"]
    err = evs[-1]["payload"]
    assert err["mode"] == "degraded" and err["retryable"] is True and err["step"] == "generate"


async def test_invalid_model_output_retried_then_degraded(deps, case_a_text):
    calls = {"n": 0}

    class Bad(FakeLLM):
        async def generate(self, ctx):
            calls["n"] += 1
            return {"variants": [{"level": "literal", "segments": [{"text": "x", "evidenceIds": ["INVENTED"]}]}], "decisions": []}

    deps.llm = Bad(deps.fx, deps.settings)
    evs = await collect(deps, case_a_text, "a_new", "case_a")
    assert calls["n"] == 2  # 失败重试 1 次
    assert evs[-1]["type"] == "error"


async def test_replay_mode_without_frozen_replay_is_honest(deps, case_a_text):
    evs = [e async for e in execute_run(C.RunRequest(text=case_a_text, audienceId="a_new", caseId="case_a", mode="replay"), deps)]
    assert evs[-1]["type"] == "error" and "没有与该输入匹配的真实运行回放" in evs[-1]["payload"]["message"]


async def _ready(deps, text, aud, case_id):
    evs = await collect(deps, text, aud, case_id)
    return C.RunSnapshot(**evs[-1]["payload"])


async def test_reader_test_counts_and_labels(deps, case_a_text):
    snap = await _ready(deps, case_a_text, "a_new", "case_a")
    res = await run_test(snap.runId, C.TestRequest(revision=1, level="plain", keyPointIds=KPS), deps)
    assert res.expected == 6 and res.completed == 6
    assert all(r.simulated is True for r in res.readers)
    assert res.provenance == "dev_stub" and res.mode == "dev_stub"
    assert res.summary.literal.valid == 9 and res.summary.selected.valid == 9
    verdicts = [j.verdict for r in res.readers if r.version == "literal" for j in r.judgments]
    assert "contradicted" in verdicts  # 直译版存在误解（开发占位样例）


async def test_reader_test_partial_failure_not_backfilled(make_settings, case_a_text):
    deps = build_deps(make_settings(FAKE_FAILURE="retell_partial"))
    snap = await _ready(deps, case_a_text, "a_genre", "case_a")
    res = await run_test(snap.runId, C.TestRequest(revision=1, level="genre", keyPointIds=KPS), deps)
    assert res.expected == 6 and res.completed == 4
    failed = [r for r in res.readers if r.status == "failed"]
    assert len(failed) == 2 and all(r.retelling is None and r.judgments == [] for r in failed)
    assert res.summary.literal.valid == 6 and res.summary.selected.valid == 6


async def test_judge_timeout_keeps_retellings_without_claiming_verdicts(deps, case_a_text, monkeypatch):
    async def timeout(*args):
        raise LLMError("timeout", "judge timed out")

    monkeypatch.setattr(deps.llm, "judge", timeout)
    snap = await _ready(deps, case_a_text, "a_new", "case_a")
    result = await run_test(snap.runId, C.TestRequest(revision=1, level="plain", keyPointIds=KPS), deps)
    assert result.completed == result.expected == 6
    assert all(r.retelling and not r.judgments for r in result.readers)
    assert result.summary.literal.valid == result.summary.selected.valid == 0
    assert result.judgeError and "timeout" in result.judgeError


async def test_reader_test_rejections(deps, case_a_text, case_c_text):
    snap = await _ready(deps, case_a_text, "a_new", "case_a")
    with pytest.raises(TestRequestError) as e1:
        await run_test(snap.runId, C.TestRequest(revision=2, level="plain", keyPointIds=KPS), deps)
    assert e1.value.status == 409
    with pytest.raises(TestRequestError) as e2:
        await run_test(snap.runId, C.TestRequest(revision=1, level="literal", keyPointIds=KPS), deps)
    assert e2.value.status == 400
    csnap = await _ready(deps, case_c_text, "c_shopper", "case_c")
    with pytest.raises(TestRequestError) as e3:
        await run_test(csnap.runId, C.TestRequest(revision=1, level="single", keyPointIds=["KP1"]), deps)
    assert e3.value.status == 400
    with pytest.raises(TestRequestError) as e4:
        await run_test("r_missing", C.TestRequest(revision=1, level="plain", keyPointIds=KPS), deps)
    assert e4.value.status == 404


async def test_flowback_from_reader_misreading_uses_real_day0_cache(deps, case_a_text):
    snap = await _ready(deps, case_a_text, "a_new", "case_a")
    res = await run_test(snap.runId, C.TestRequest(revision=1, level="plain", keyPointIds=KPS), deps)
    j = next(j for r in res.readers if r.version == "literal" for j in r.judgments if j.verdict == "contradicted" and j.keyPointId == "KP2")
    d = await make_draft(C.QuestionDraftRequest(
        source={"kind": "reader_misreading", "text": j.quote, "testId": res.testId, "keyPointId": "KP2"},
        caseId="case_a", runId=snap.runId, termIds=["T2"]), deps)
    assert d.sourceLabel == "模拟读者误解（非真实用户）"
    assert d.existingSource == "cache" and len(d.existing) == 5
    assert "2026-11-19" in d.existingNote and d.query == "仙侠 渡劫 雷劫 翻译 英文"
    assert d.recommendation in ("new_question", "answer_existing")
    assert d.draft.title and j.quote in d.draft.body and "模拟读者误解（非真实用户）" in d.draft.body
    assert d.mode == "dev_stub" and d.provenance == "dev_stub"


async def test_flowback_manual_paste_without_cache_is_not_invented(deps):
    d = await make_draft(C.QuestionDraftRequest(source={"kind": "manual", "text": "Is huinantian a kind of tea?"},
                                                caseId="case_c", termIds=["C1"]), deps)
    assert d.sourceLabel == "用户粘贴"
    assert d.existingSource == "none" and d.existing == []
    assert "未启用" in d.existingNote
    assert d.recommendation == "new_question"


async def test_flowback_query_failure_still_drafts(make_settings):
    deps = build_deps(make_settings(FAKE_FAILURE="zhihu"))
    d = await make_draft(C.QuestionDraftRequest(source={"kind": "manual", "text": "storm?"}, caseId="case_a", termIds=["T2"]), deps)
    assert d.existingSource == "failed" and d.draft.title


async def test_flowback_guard_gap_is_p1(deps):
    with pytest.raises(DraftError) as e:
        await make_draft(C.QuestionDraftRequest(source={"kind": "guard_gap", "text": "x"}), deps)
    assert e.value.status == 400


async def test_live_llm_budget_exhaustion_degrades(make_settings, case_a_text):
    deps = build_deps(make_settings(LLM_DAILY_CAP="1"))

    class Live(FakeLLM):
        provenance = "real_run"
        name = "live-test-double"

    deps.llm = Live(deps.fx, deps.settings)
    assert deps.store.try_consume("llm_calls", 1)  # 用掉唯一的一次
    evs = await collect(deps, case_a_text, "a_new", "case_a")
    assert evs[-1]["type"] == "error" and "预算" in evs[-1]["payload"]["message"]


async def test_generate_failure_switches_to_matching_replay(make_settings, case_a_text, tmp_path):
    """V6 §6.8 降级顺序第 2 步：有完全匹配的回放就整轮切换为 replay。

    测试替身：在临时目录里构造一份 provenance=real_run 的回放（只存在于本测试，不进入 fixtures/replays/），
    验证切换路径、mode=replay 与 frozenAt 标注。仓库中真实的 replays/ 仍为空。"""
    import json

    from bridge.core.replay import ReplayStore, run_key

    ok = build_deps(make_settings())
    snap = (await collect(ok, case_a_text, "a_new", "case_a"))[-1]["payload"]
    snap.update(provenance="real_run", mode="live")
    key = run_key(case_a_text, "a_new", ok.settings.prompt_version, ok.fx.corpus_version)
    (tmp_path / "double.json").write_text(json.dumps({"provenance": "real_run", "frozenAt": "2026-11-20T00:00:00Z", "key": key,
                                                       "snapshot": snap, "tests": {}, "drafts": {}}), encoding="utf-8")
    failing = build_deps(make_settings(FAKE_FAILURE="generate", DB_PATH=str(tmp_path / "f.sqlite3")))
    failing.replays = ReplayStore(tmp_path)
    evs = await collect(failing, case_a_text, "a_new", "case_a")
    # 回放整份替换（V6 §6.9）：冻结快照的 terms / evidence 重新下发，seq 继续递增
    assert [e["type"] for e in evs] == ["started", "terms", "evidence", "terms", "evidence", "ready"]
    assert [e["seq"] for e in evs] == [1, 2, 3, 4, 5, 6]
    replayed = C.RunSnapshot(**evs[-1]["payload"])
    assert replayed.mode == "replay" and replayed.frozenAt == "2026-11-20T00:00:00Z"
    assert replayed.degradedReason == "模型上游错误"
    assert replayed.runId == evs[0]["runId"]


async def test_frozen_run_exports_matching_tests_and_drafts(deps, case_a_text, tmp_path, monkeypatch):
    import json
    from bridge.config import APP_ROOT
    from bridge.core.replay import ReplayStore, draft_key, run_key, test_key

    monkeypatch.syspath_prepend(str(APP_ROOT / "server" / "scripts"))
    from export_offline_bundle import build_bundle

    snap = await _ready(deps, case_a_text, "a_new", "case_a")
    result = await run_test(snap.runId, C.TestRequest(revision=1, level="plain", keyPointIds=KPS), deps)
    mis = next(j for reader in result.readers for j in reader.judgments if j.verdict != "hit" and j.quote)
    qreq = C.QuestionDraftRequest(caseId="case_a", runId=snap.runId, source={
        "kind": "reader_misreading", "text": mis.quote, "testId": result.testId, "keyPointId": mis.keyPointId,
    })
    draft = await make_draft(qreq, deps)
    key = run_key(case_a_text, "a_new", deps.settings.prompt_version, deps.fx.corpus_version)
    frozen = {
        "key": key, "provenance": "real_run", "frozenAt": "2026-11-20T00:00:00Z",
        "snapshot": snap.model_copy(update={"mode": "live", "provenance": "real_run"}).model_dump(),
        "tests": {test_key(key, "plain", KPS): result.model_copy(update={"mode": "live", "provenance": "real_run"}).model_dump()},
        "drafts": {draft_key(mis.quote): draft.model_copy(update={"mode": "live", "provenance": "real_run"}).model_dump()},
    }
    # 仅在测试临时目录内模拟冻结的真实资产。
    (tmp_path / "replay.json").write_text(json.dumps(frozen, ensure_ascii=False), encoding="utf-8")
    deps.replays = ReplayStore(tmp_path)
    assert not deps.replays.rejected
    bundle = await build_bundle(deps)
    events = bundle["runs"]["case_a|a_new"]
    assert bundle["provenance"] == "mixed" and bundle["replays"] == 1
    assert events[0]["payload"]["mode"] == events[-1]["payload"]["mode"] == "replay"
    assert events[-1]["payload"]["frozenAt"] == frozen["frozenAt"]
    assert bundle["runs"]["case_a|a_genre"][-1]["payload"]["mode"] == "dev_stub"
    assert bundle["tests"]["case_a|a_new|plain|KP1,KP2,KP3"]["mode"] == "replay"
    assert bundle["replayDrafts"][f"case_a|a_new|{draft_key(mis.quote)}"]["mode"] == "replay"

    replay_id = events[-1]["runId"]
    replayed_test = await run_test(replay_id, C.TestRequest(revision=1, level="plain", keyPointIds=KPS), deps)
    replay_req = qreq.model_copy(update={"runId": replay_id, "source": qreq.source.model_copy(update={"testId": replayed_test.testId})})
    replayed_draft = await make_draft(replay_req, deps)
    assert replayed_draft.mode == "replay" and replayed_draft.draft == draft.draft


async def test_contract_failure_reports_specific_diagnostic_and_keeps_reference_guard(deps, case_a_text):
    seen_feedback = []

    class UnknownRefLLM(FakeLLM):
        async def generate(self, ctx):
            seen_feedback.append(ctx.retry_feedback)
            return {
                "recommendationReason": "r",
                "decisions": [],
                "variants": [
                    {"level": "literal", "segments": [{"text": "lit"}]},
                    {"level": "plain", "segments": [{"text": "Heaven's law.", "evidenceIds": ["FAKE_EV"]}]},
                    {"level": "genre", "segments": [{"text": "Heavenly Dao's law."}]},
                ],
            }

    deps.llm = UnknownRefLLM(deps.fx, deps.settings)
    evs = await collect(deps, case_a_text, "a_new", "case_a")
    assert evs[-1]["type"] == "error"
    assert seen_feedback[0] is None
    assert seen_feedback[1] and "FAKE_EV" in seen_feedback[1] and "A1#1" in seen_feedback[1]
    assert "未知 ID" in evs[-1]["payload"]["message"] and "FAKE_EV" in evs[-1]["payload"]["message"]


async def test_segment_evidence_inherited_from_decisions_and_preserved_across_rewrite(deps, case_a_text):
    class MissingSegEvidenceLLM(FakeLLM):
        async def generate(self, ctx):
            return {
                "recommendationReason": "r",
                "decisions": [{
                    "id": "D1",
                    "termId": "T2",
                    "title": "九重雷劫",
                    "choice": "ninefold trial by lightning",
                    "rationale": "依知乎证据拆解",
                    "evidenceIds": ["A1#1"],
                    "attribution": "zhihu",
                    "levels": ["plain", "genre"],
                }],
                "variants": [
                    {"level": "literal", "segments": [{"text": "lit"}]},
                    {"level": "plain", "segments": [
                        {"text": "Heaven's law brings ", "termIds": ["T1"], "evidenceIds": []},
                        {"text": "ninefold lightning", "termIds": ["T2"], "evidenceIds": []},
                        {"text": " without soul consequence.", "termIds": [], "evidenceIds": []},
                    ]},
                    {"level": "genre", "segments": [
                        {"text": "Heavenly Dao's reckoning: ", "termIds": ["T1"], "evidenceIds": []},
                        {"text": "Ninefold Thunder Tribulation", "termIds": ["T2"], "evidenceIds": [], "decisionId": "D1"},
                        {"text": ", and ", "termIds": [], "evidenceIds": []},
                        {"text": "your soul will scatter", "termIds": ["T3"], "evidenceIds": ["A2_refined#1"]},
                        {"text": ".", "termIds": [], "evidenceIds": []},
                    ]},
                ],
            }

        async def rewrite(self, ctx, level, text, problems):
            return {
                "segments": [
                    {"text": "Heaven's law has brought this upon you. Fail the ", "termIds": ["T1"], "evidenceIds": []},
                    {"text": "ninefold trial by lightning", "termIds": ["T2"], "evidenceIds": []},
                    {"text": ", and ", "termIds": [], "evidenceIds": []},
                    {"text": "your soul will be destroyed", "termIds": ["T3"], "evidenceIds": []},
                    {"text": ".", "termIds": [], "evidenceIds": []},
                ],
                "notes": [],
            }

    deps.llm = MissingSegEvidenceLLM(deps.fx, deps.settings)
    evs = await collect(deps, case_a_text, "a_new", "case_a")
    snap = C.RunSnapshot.model_validate(evs[-1]["payload"])
    by_level = {v.level: v for v in snap.variants}
    plain_t2 = next(s for s in by_level["plain"].segments if s.termIds == ["T2"])
    genre_t2 = next(s for s in by_level["genre"].segments if s.termIds == ["T2"])
    assert plain_t2.evidenceIds == ["A1#1"]
    assert genre_t2.evidenceIds == ["A1#1"]


