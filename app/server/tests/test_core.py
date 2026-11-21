import json
import logging

import pytest

from bridge import contracts as C
from bridge.core import guard
from bridge.core.ids import ReferenceError_, validate_references
from bridge.core.logs import event, redact
from bridge.core.replay import ReplayStore, run_key
from bridge.core.store import Store, beijing_date
from bridge.core.text import build_segments, normalize_text
from bridge.fixtures import FixtureStore
from bridge.config import APP_ROOT

FX = FixtureStore(APP_ROOT / "fixtures")
LEX = FX.lexicon


def test_source_segments_rejoin_original():
    case = FX.cases["case_a"]
    segs = case.source_segments
    assert "".join(s.text for s in segs) == "此乃天道因果，若扛不过九重雷劫，便只能魂飞魄散。"
    assert [s.termId for s in segs if s.termId] == ["T1", "T2", "T3"]


def test_zh_claim_scan_prefers_longest():
    assert guard.scan_zh_claims("回南天祛湿茶，清热解毒，拯救熬夜上火。", LEX) == ["清热解毒", "祛湿", "上火"]


def test_en_claim_scan_and_clean_final():
    hits = guard.scan_en_claims("Dampness-removing tea that clears heat and detoxes; boosts immunity.", LEX)
    assert {h.zh for h in hits} >= {"祛湿", "清热解毒", "解毒"}
    assert guard.scan_en_claims("Herbal tea for humid days", LEX) == []


def test_fidelity_ninefold_kept_or_missing():
    rules = FX.cases["case_a"].raw["fidelityRules"]
    ok = guard.fidelity_hits("Heaven's law. Fail the ninefold trial, and your soul will be destroyed.", rules)
    assert ok == {"KP1": True, "KP2": True, "KP3": True}
    bad = guard.fidelity_hits("Fail the trial by lightning and you die.", rules)
    assert bad["KP2"] is False and bad["KP3"] is False


def test_forbidden_additions_detected():
    pats = FX.cases["case_a"].raw["forbiddenPatterns"]
    hits = guard.forbidden_hits("Fail it and you will be reborn.", pats)
    assert hits and hits[0]["violates"] == "KP3"


def test_reference_validation_rejects_unknown_ids():
    v = C.Variant(level="plain", segments=[C.Segment(text="x", termIds=["T9"])], exportState="draft")
    with pytest.raises(ReferenceError_):
        validate_references([v], [], {"T1"}, set())
    v2 = C.Variant(level="plain", segments=[C.Segment(text="x", evidenceIds=["NOPE"])], exportState="draft")
    with pytest.raises(ReferenceError_):
        validate_references([v2], [], {"T1"}, {"A1#1"})
    d = C.Decision(id="D1", termId="T1", choice="c", rationale="r", evidenceIds=["X"], attribution="zhihu")
    with pytest.raises(ReferenceError_):
        validate_references([], [d], {"T1"}, {"A1#1"})


def test_budget_persists_across_restart_and_caps(tmp_path):
    db = tmp_path / "b.sqlite3"
    s1 = Store(db)
    assert all(s1.try_consume("zhihu_search", 6) for _ in range(6))
    assert s1.try_consume("zhihu_search", 6) is False  # 第 7 次触顶
    s1.close()
    s2 = Store(db)  # 模拟服务重启
    assert s2.used("zhihu_search") == 6
    assert s2.left("zhihu_search", 6) == 0


def test_budget_day_boundary_is_beijing_midnight():
    # 2026-11-20 15:59:59 UTC = 2026-11-20 23:59:59 北京；+1s 即北京次日
    t = 1795190399
    assert beijing_date(t) == "2026-11-20"
    assert beijing_date(t + 1) == "2026-11-21"


def test_rate_limit_per_ip_hour(tmp_path):
    now = [1_000_000.0]
    s = Store(tmp_path / "r.sqlite3", clock=lambda: now[0])
    assert all(s.rate_hit("1.1.1.1", "runs", 6) for _ in range(6))
    assert s.rate_hit("1.1.1.1", "runs", 6) is False
    assert s.rate_hit("2.2.2.2", "runs", 6) is True  # 其他 IP 不受影响
    now[0] += 3600
    assert s.rate_hit("1.1.1.1", "runs", 6) is True  # 下一个小时桶


def test_cache_ttl_24h(tmp_path):
    now = [0.0]
    s = Store(tmp_path / "c.sqlite3", clock=lambda: now[0])
    s.cache_put("zhihu_search", "q", {"items": [1]})
    now[0] += 86399
    assert s.cache_get("zhihu_search", "q") == {"items": [1]}
    now[0] += 2
    assert s.cache_get("zhihu_search", "q") is None


def test_replay_store_rejects_dev_stub(tmp_path):
    (tmp_path / "fake.json").write_text(json.dumps({"provenance": "dev_stub", "key": "k", "snapshot": {"provenance": "dev_stub"}}))
    (tmp_path / "half.json").write_text(json.dumps({"provenance": "real_run", "key": "k2", "snapshot": {"provenance": "dev_stub"}}))
    rs = ReplayStore(tmp_path)
    assert len(rs) == 0 and len(rs.rejected) == 2


def test_repo_replays_dir_only_accepts_valid_real_replays():
    rs = ReplayStore(APP_ROOT / "fixtures" / "replays")
    assert rs.rejected == []
    assert all(entry["snapshot"]["provenance"] == "real_run" for entry in rs.entries.values())


def test_run_key_normalizes_whitespace():
    a = run_key("此乃天道因果， 若扛不过", "a_new", "p", "c")
    b = run_key("此乃天道因果，  若扛不过 ", "a_new", "p", "c")
    assert a == b
    assert run_key("x", "a_new", "p", "c") != run_key("x", "a_genre", "p", "c")
    assert normalize_text("  a\n b ") == "a b"


def test_redact_and_log_never_contain_text_or_secret(caplog):
    assert "abcdefghijklmnop" not in redact("Authorization: Bearer abcdefghijklmnopqrst")  # scan:allow-fake
    with caplog.at_level(logging.INFO, logger="bridge"):
        event("x", text="原文全文", apiKey="sk-should-not-appear", note="Bearer zzzzzzzzzzzzzzzzzzzzzz")  # scan:allow-fake
    out = caplog.text
    assert "原文全文" not in out and "sk-should-not-appear" not in out and "zzzzzzzzzzzzzzzzzzzz" not in out  # scan:allow-fake


def test_evidence_seed_has_no_fabricated_authors():
    for e in FX.evidence:
        assert e["status"] == "candidate"
        assert e["author"] is None or isinstance(e["author"], str) and e["author"].strip()
    a11 = next(e for e in FX.evidence if e["id"] == "A1#1")
    assert a11["author"] is None  # Day 0：AuthorName 为空 → 不编造署名
