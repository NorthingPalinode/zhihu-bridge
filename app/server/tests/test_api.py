import json
import logging

import httpx
from fastapi.testclient import TestClient

from bridge.api.app import create_app
from bridge.pipeline.deps import build_deps

KPS = ["KP1", "KP2", "KP3"]


def sse(resp) -> list[dict]:
    return [json.loads(line[6:]) for line in resp.text.splitlines() if line.startswith("data: ")]


def make_client(make_settings, **env):
    return TestClient(create_app(deps=build_deps(make_settings(**env))))


def test_health_reports_dev_stub_and_no_secrets(make_settings):
    c = make_client(make_settings, ZHIHU_ACCESS_SECRET="super-secret-value-123", LLM_API_KEY="sk-notarealkey1234567890")  # scan:allow-fake
    r = c.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body["generationMode"] == "dev_stub" and body["llmProvider"] == "fake"
    assert body["replayAvailable"] is False and body["replayCount"] == 0
    assert body["zhihuLive"] is False  # 未开启 ZHIHU_LIVE_ENABLED
    assert body["zhihuBudgetLeft"] == {"zhihu_search": 6, "question_discovery": 6}
    assert "super-secret-value-123" not in r.text and "sk-notarealkey" not in r.text


def test_cases_endpoint(make_settings):
    c = make_client(make_settings)
    cases = {x["caseId"]: x for x in c.get("/api/cases").json()["cases"]}
    assert list(cases) == ["case_a", "case_b", "case_c"]
    assert cases["case_a"]["label"] == "仙侠字幕 · 广深短剧"
    assert cases["case_b"]["text"] == "自研高密度堆料主板，极限压榨功耗，支持底层协议调试。"
    assert cases["case_b"]["defaultAudienceId"] == "b_backer" and cases["case_b"]["testEnabled"]
    assert cases["case_c"]["label"] == "草本茶 · 岭南品牌"
    assert cases["case_a"]["text"] == "此乃天道因果，若扛不过九重雷劫，便只能魂飞魄散。"


def test_personal_zhihu_session_bypasses_exhausted_shared_budget(make_settings):
    creator_token = "fixture-shared-source"
    personal_token = "fixture-personal-source"
    queries = []

    def zhihu(req):
        token = req.headers["Authorization"].removeprefix("Bearer ")
        assert req.url.host == "developer.zhihu.com"
        if req.url.path.endswith("/quota"):
            if token != personal_token:
                return httpx.Response(200, json={"Code": 20001, "Message": token})
            return httpx.Response(200, json={"Code": 0, "Data": [
                {"APIID": "zhihu_search", "RemainingQuota": 8},
                {"APIID": "question_discovery", "RemainingQuota": 4},
            ]})
        queries.append((req.url.path, token))
        return httpx.Response(200, json={"Code": 0, "Data": {"Items": [{
            "Title": "术语语境资料", "Url": "https://www.zhihu.com/question/999", "ContentText": "九重雷劫",
        }]}})

    settings = make_settings(ZHIHU_LIVE_ENABLED="true", ZHIHU_ACCESS_SECRET=creator_token,
                             BUDGET_ZHIHU_SEARCH_PUBLIC_CAP="1", BUDGET_QUESTION_DISCOVERY_PUBLIC_CAP="1")
    deps = build_deps(settings, zhihu_transport=httpx.MockTransport(zhihu))
    assert all(deps.store.try_consume(kind, 1) for kind in ("zhihu_search", "question_discovery"))
    app = create_app(deps=deps)
    url = "/api/zhihu/session"
    run = {"text": deps.fx.cases["case_a"].text, "caseId": "case_a", "audienceId": "a_new"}
    with TestClient(app) as browser, TestClient(app) as other:
        assert browser.get(url).json()["mode"] == "shared"
        invalid = browser.post(url, json={"accessSecret": creator_token})
        assert invalid.status_code == 401 and creator_token not in invalid.text
        assert browser.get(url).json()["mode"] == "shared"
        imported = browser.post(url, json={"accessSecret": personal_token})
        assert imported.status_code == 200 and personal_token not in imported.text + imported.headers["set-cookie"]
        assert "HttpOnly" in imported.headers["set-cookie"] and "SameSite=strict" in imported.headers["set-cookie"]
        assert imported.json()["personalQuotaAtImport"]["zhihu_search"] == 8
        assert imported.json()["sharedQuota"]["zhihu_search"] == 0
        assert other.get(url).json()["mode"] == "shared"
        assert sse(browser.post("/api/runs", json=run))[-1]["payload"]["evidenceSource"] == "zhihu_live"
        assert sse(browser.post("/api/runs", json=run))[-1]["payload"]["evidenceSource"] == "zhihu_cached"
        assert sse(other.post("/api/runs", json=run))[-1]["payload"]["evidenceSource"] == "zhihu_curated"
        draft = browser.post("/api/questions/draft", json={"source": {"kind": "manual", "text": "Lightning?"},
                                                         "caseId": "case_a", "termIds": ["T2"]})
        assert draft.json()["existingSource"] == "zhihu_live"
        assert queries == [("/api/v1/content/zhihu_search", personal_token),
                           ("/api/v1/user/question_recommendations", personal_token)]
        assert browser.delete(url).json()["mode"] == "shared"
        browser.cookies.set("zb_zhihu_session", "expired-session")
        assert browser.get(url).json()["mode"] == "expired"
        assert browser.post("/api/runs", json=run).status_code == 409


def test_full_flow_over_http(make_settings, caplog):
    c = make_client(make_settings)
    text = "此乃天道因果，若扛不过九重雷劫，便只能魂飞魄散。"
    with caplog.at_level(logging.INFO, logger="bridge"):
        r = c.post("/api/runs", json={"text": text, "audienceId": "a_new", "caseId": "case_a"})
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream")
    evs = sse(r)
    assert [e["type"] for e in evs] == ["started", "terms", "evidence", "ready"]
    snap = evs[-1]["payload"]
    assert text not in caplog.text  # 日志不记原文
    t = c.post(f"/api/runs/{snap['runId']}/tests", json={"revision": 1, "level": "plain", "keyPointIds": KPS})
    assert t.status_code == 200 and t.json()["completed"] == 6
    quote = next(j["quote"] for rd in t.json()["readers"] for j in rd["judgments"] if j["verdict"] == "contradicted")
    d = c.post("/api/questions/draft", json={"source": {"kind": "reader_misreading", "text": quote, "testId": t.json()["testId"], "keyPointId": "KP2"},
                                             "caseId": "case_a", "runId": snap["runId"], "termIds": ["T2"]})
    assert d.status_code == 200 and d.json()["existingSource"] == "cache"


def test_input_validation_http(make_settings):
    c = make_client(make_settings)
    assert c.post("/api/runs", json={"text": "  ", "audienceId": "a_new"}).status_code == 422
    r = c.post("/api/runs", json={"text": "字" * 401, "audienceId": "a_new"})
    assert r.status_code == 422 and "400" in r.json()["detail"]
    assert c.post("/api/runs", json={"text": "你好", "audienceId": "nope"}).status_code == 422


def test_rate_limit_per_ip(make_settings):
    c = make_client(make_settings, RATE_LIMIT_RUNS_PER_IP_HOUR="2")
    body = {"text": "回南天祛湿茶，清热解毒，拯救熬夜上火。", "audienceId": "c_shopper", "caseId": "case_c"}
    assert c.post("/api/runs", json=body).status_code == 200
    assert c.post("/api/runs", json=body).status_code == 200
    r = c.post("/api/runs", json=body)
    assert r.status_code == 429 and "上限" in r.json()["detail"]


def test_trusted_proxy_forwarded_ip(make_settings):
    c = make_client(make_settings, RATE_LIMIT_DRAFTS_PER_IP_HOUR="1", TRUSTED_PROXY_IPS="testclient")
    body = {"source": {"kind": "manual", "text": "storm?"}, "caseId": "case_a", "termIds": ["T2"]}
    assert c.post("/api/questions/draft", json=body, headers={"X-Forwarded-For": "9.9.9.9"}).status_code == 200
    assert c.post("/api/questions/draft", json=body, headers={"X-Forwarded-For": "9.9.9.9"}).status_code == 429
    assert c.post("/api/questions/draft", json=body, headers={"X-Forwarded-For": "8.8.8.8"}).status_code == 200


def test_counters_survive_restart(make_settings):
    s = make_settings(RATE_LIMIT_TESTS_PER_IP_HOUR="1")
    c1 = TestClient(create_app(deps=build_deps(s)))
    snap = sse(c1.post("/api/runs", json={"text": "此乃天道因果，若扛不过九重雷劫，便只能魂飞魄散。", "audienceId": "a_new", "caseId": "case_a"}))[-1]["payload"]
    assert c1.post(f"/api/runs/{snap['runId']}/tests", json={"revision": 1, "level": "plain", "keyPointIds": KPS}).status_code == 200
    c2 = TestClient(create_app(deps=build_deps(s)))  # 新进程 / 重启：同一 SQLite
    r = c2.post(f"/api/runs/{snap['runId']}/tests", json={"revision": 1, "level": "plain", "keyPointIds": KPS})
    assert r.status_code == 429  # 限流计数在重启后仍在


def test_generate_failure_http_emits_error_event(make_settings):
    c = make_client(make_settings, FAKE_FAILURE="generate")
    evs = sse(c.post("/api/runs", json={"text": "此乃天道因果，若扛不过九重雷劫，便只能魂飞魄散。", "audienceId": "a_new", "caseId": "case_a"}))
    assert evs[-1]["type"] == "error" and evs[-1]["payload"]["mode"] == "degraded"


def test_unknown_run_tests_404(make_settings):
    c = make_client(make_settings)
    assert c.post("/api/runs/r_nope/tests", json={"revision": 1, "level": "plain", "keyPointIds": KPS}).status_code == 404


def test_contracts_in_sync():
    import subprocess
    import sys
    from pathlib import Path

    script = Path(__file__).resolve().parents[1] / "scripts" / "export_schema.py"
    out = subprocess.run([sys.executable, str(script), "--check"], capture_output=True, text=True)
    assert out.returncode == 0, out.stdout + out.stderr


def test_secret_scan_detects_planted_key(tmp_path):
    import subprocess
    import sys
    from pathlib import Path

    (tmp_path / "leak.env").write_text("LLM_API_KEY=abc123realvalue\n")
    script = Path(__file__).resolve().parents[1] / "scripts" / "scan_secrets.py"
    out = subprocess.run([sys.executable, str(script), str(tmp_path)], capture_output=True, text=True)
    assert out.returncode == 1 and "env secret assignment" in out.stdout


def test_secret_scan_ignores_empty_example_values(tmp_path):
    import subprocess
    import sys
    from pathlib import Path

    (tmp_path / ".env.example").write_text("LLM_API_KEY=\nSILICONFLOW_API_KEY=\nZHIHU_ACCESS_SECRET=\nZHIHU_API_BASE=https://developer.zhihu.com\n")
    (tmp_path / "t.py").write_text('x = "Bearer abcdefghijklmnopqrstuvwxyz"  # scan:allow-fake\n')
    script = Path(__file__).resolve().parents[1] / "scripts" / "scan_secrets.py"
    out = subprocess.run([sys.executable, str(script), str(tmp_path)], capture_output=True, text=True)
    assert out.returncode == 0, out.stdout


def test_secret_scan_detects_siliconflow_key(tmp_path):
    import subprocess
    import sys
    from pathlib import Path

    (tmp_path / "leak.env").write_text("SILICONFLOW_API_KEY=not-a-real-siliconflow-secret\n")
    script = Path(__file__).resolve().parents[1] / "scripts" / "scan_secrets.py"
    out = subprocess.run([sys.executable, str(script), str(tmp_path)], capture_output=True, text=True)
    assert out.returncode == 1 and "env secret assignment" in out.stdout


def test_trusted_proxy_https_sets_secure_cookie(make_settings):
    personal_token = "personal-transport-test"

    def zhihu(req):
        return httpx.Response(200, json={"Code": 0, "Data": [{"APIID": "zhihu_search", "RemainingQuota": 5}]})

    settings = make_settings(ZHIHU_LIVE_ENABLED="true", TRUSTED_PROXY_IPS="testclient")
    deps = build_deps(settings, zhihu_transport=httpx.MockTransport(zhihu))
    c = TestClient(create_app(deps=deps))
    r = c.post("/api/zhihu/session", json={"accessSecret": personal_token}, headers={"X-Forwarded-Proto": "https"})
    assert r.status_code == 200
    assert "Secure" in r.headers["set-cookie"]

    # 未信任代理来源不得仅凭 X-Forwarded-Proto 误判
    deps_untrusted = build_deps(make_settings(ZHIHU_LIVE_ENABLED="true", TRUSTED_PROXY_IPS=""), zhihu_transport=httpx.MockTransport(zhihu))
    c2 = TestClient(create_app(deps=deps_untrusted))
    r2 = c2.post("/api/zhihu/session", json={"accessSecret": personal_token}, headers={"X-Forwarded-Proto": "https"})
    assert r2.status_code == 200
    assert "Secure" not in r2.headers["set-cookie"]


def test_compliance_rules_api_crud(make_settings):
    c = make_client(make_settings)
    r = c.get("/api/compliance/rules?market=en")
    assert r.status_code == 200
    body = r.json()
    assert body["counts"]["legal"] > 0 and body["counts"]["custom"] > 0
    assert {x["category"] for x in body["rules"]} == {"legal", "custom"}

    # Add a custom cultural taboo rule and persist in SQLite
    created = c.post("/api/compliance/rules", json={
        "category": "custom",
        "title": "测试自定义禁忌",
        "markets": ["en"],
        "jurisdiction": "测试规范",
        "severity": "warn",
        "patterns": ["\\bforbidden_test_phrase\\b"],
        "reason": "用于验证自定义规则持久化",
        "suggestion": "替换为中性词",
    })
    assert created.status_code == 201
    rid = created.json()["rule"]["ruleId"]
    assert rid.startswith("USR-CUS-")

    # Builtin rule cannot be deleted
    assert c.delete("/api/compliance/rules/LAW-MED-01").status_code == 404
    # User custom rule can be deleted
    assert c.delete(f"/api/compliance/rules/{rid}").status_code == 200


def test_sse_emits_keepalive_during_slow_run(make_settings):
    c = make_client(make_settings, SSE_KEEPALIVE_S="0.05", FAKE_STEP_DELAY_MS="120")
    r = c.post("/api/runs", json={"text": "此乃天道因果，若扛不过九重雷劫，便只能魂飞魄散。", "audienceId": "a_new", "caseId": "case_a"})
    assert r.status_code == 200
    assert ": keep-alive" in r.text
    evs = sse(r)
    assert [e["type"] for e in evs] == ["started", "terms", "evidence", "ready"]
