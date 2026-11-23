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


def test_zhihu_extended_apis_and_personal_gate(make_settings):
    import base64

    def zhihu(req: httpx.Request) -> httpx.Response:
        p = req.url.path
        if p == "/api/v1/quota":
            return httpx.Response(200, json={
                "Code": 0,
                "Message": "success",
                "Data": [
                    {"APIID": "zhihu_search", "APIName": "知乎搜索", "TotalQuota": 100, "TotalUsed": 2, "RemainingQuota": 98},
                    {"APIID": "global_search", "APIName": "全网搜索", "TotalQuota": 100, "TotalUsed": 1, "RemainingQuota": 99},
                    {"APIID": "question_discovery", "APIName": "问题发现", "TotalQuota": 100, "TotalUsed": 0, "RemainingQuota": 100},
                    {"APIID": "zhida_openai", "APIName": "知乎直答", "TotalQuota": 50, "TotalUsed": 3, "RemainingQuota": 47},
                    {"APIID": "knowledge", "APIName": "知识库", "TotalQuota": 50, "TotalUsed": 0, "RemainingQuota": 50},
                    {"APIID": "creator", "APIName": "创作能力", "TotalQuota": 50, "TotalUsed": 0, "RemainingQuota": 50},
                ],
            })
        if p == "/api/v1/content/global_search":
            return httpx.Response(200, json={
                "Code": 0,
                "Data": {"HasMore": False, "Items": [{
                    "Title": "FTC Dietary Supplement Guide",
                    "ContentText": "Claims about curing disease require clinical substantiation.",
                    "Url": "https://example.org/ftc-guide",
                    "ContentType": "web",
                }]},
            })
        if p == "/api/v1/content/question_answers":
            return httpx.Response(200, json={
                "Code": 0,
                "Data": {
                    "Paging": {"IsEnd": True, "Totals": 1},
                    "Items": [{"ContentType": "answer", "ContentToken": "999", "Summary": "把天劫当作进阶考验更容易理解。", "Url": "https://www.zhihu.com/question/123456/answer/999"}],
                },
            })
        if p == "/v1/chat/completions":
            return httpx.Response(200, json={
                "id": "chatcmpl-test",
                "model": "zhida-fast-1p5",
                "choices": [{"index": 0, "message": {"role": "assistant", "reasoning_content": "先拆解语境", "content": "「渡劫」在跨文化转译中常译为 heavenly tribulation。"}}],
            })
        if p == "/api/v1/knowledge/bases":
            return httpx.Response(200, json={
                "Code": 0,
                "Data": {"Items": [{"KnowledgeBaseID": "7526139256098382426", "Name": "品牌合规术语库", "Relation": "created", "IsDefault": True, "Visibility": "private", "ContentCount": 3}]},
            })
        if p == "/api/v1/knowledge/bases/7526139256098382426/items":
            return httpx.Response(200, json={
                "Code": 0,
                "Data": {"HasMore": False, "NextCursor": "", "Items": [{"RecallContentID": "c1", "ContentType": "file", "Title": "出海合规白皮书.pdf", "Abstract": "严禁疾病疗效宣称"}]},
            })
        if p == "/api/v1/knowledge/search":
            return httpx.Response(200, json={
                "Code": 0,
                "Data": {"Items": [{"RecallContentID": "c1", "Title": "出海合规白皮书.pdf", "Content": ["清热去火在北美市场应转译为 herbal wellness support。"], "OriginUrl": "https://www.zhihu.com/knowledge-base/7526139256098382426"}]},
            })
        if p == "/api/v1/knowledge/files":
            return httpx.Response(200, json={
                "Code": 0,
                "Data": {"KnowledgeBaseID": "7526139256098382426", "RecallContentID": "c2", "FileName": "terms.txt", "FileSize": 12, "Title": "terms.txt"},
            })
        if p == "/api/v1/user/content_detail":
            return httpx.Response(200, json={
                "Code": 0,
                "Data": {"ContentType": "answer", "ContentToken": "777", "Title": "我的出海转译复盘", "Body": "<p>先看目标读者背景，再做语义取舍。</p>", "Url": "https://www.zhihu.com/question/123456/answer/777"},
            })
        if p == "/api/v1/user/content_comments":
            return httpx.Response(200, json={
                "Code": 0,
                "Data": {"Paging": {"IsEnd": True}, "Items": [{"Comment": {"Content": "讲得很透彻", "LikeCount": 12}, "Children": []}]},
            })
        if p == "/api/v1/user/creator_account_stats":
            return httpx.Response(200, json={
                "Code": 0,
                "Data": {"ContentType": "all", "Status": "ok", "Metrics": {"views": 1200, "likes": 85}},
            })
        if p == "/api/v1/user/creator_content_stats":
            return httpx.Response(200, json={
                "Code": 0,
                "Data": {"Items": [{"Title": "我的出海转译复盘", "Url": "https://www.zhihu.com/question/123456/answer/777", "Metrics": {"views": 420, "likes": 30}}]},
            })
        return httpx.Response(404, json={"Code": 40004, "Message": f"unexpected path {p}"})

    settings = make_settings(ZHIHU_LIVE_ENABLED="true", ZHIHU_ACCESS_SECRET="shared-secret-not-real")
    deps = build_deps(settings, zhihu_transport=httpx.MockTransport(zhihu))
    c = TestClient(create_app(deps=deps))

    # 1. Quota lists only the 6 supported API groups and excludes hot_list / user data
    q = c.get("/api/zhihu/quota")
    assert q.status_code == 200
    q_body = q.json()
    ids = {item["apiId"] for item in q_body["items"]}
    assert ids == {"zhihu_search", "global_search", "question_discovery", "zhida_openai", "knowledge", "creator"}
    assert "hot_list" not in ids and "user_contents" not in ids and "followees" not in ids and "favorites" not in ids

    # 2. Shared-accessible extended endpoints work
    gs = c.post("/api/zhihu/global-search", json={"query": "FTC dietary supplement", "count": 5})
    assert gs.status_code == 200 and gs.json()["items"][0]["title"] == "FTC Dietary Supplement Guide"

    qa = c.get("/api/zhihu/question-answers", params={"questionUrl": "https://www.zhihu.com/question/123456"})
    assert qa.status_code == 200 and "把天劫当作进阶考验" in qa.json()["items"][0]["summary"]

    zd = c.post("/api/zhihu/zhida", json={"query": "渡劫怎么译更自然？", "model": "zhida-fast-1p5", "term": "渡劫"})
    assert zd.status_code == 200 and "heavenly tribulation" in zd.json()["content"]

    kbs = c.get("/api/zhihu/knowledge/bases")
    assert kbs.status_code == 200 and kbs.json()["items"][0]["knowledgeBaseId"] == "7526139256098382426"

    kbi = c.get("/api/zhihu/knowledge/bases/7526139256098382426/items")
    assert kbi.status_code == 200 and kbi.json()["items"][0]["title"] == "出海合规白皮书.pdf"

    kbsr = c.post("/api/zhihu/knowledge/search", json={"query": "清热去火", "knowledgeBaseIds": ["7526139256098382426"]})
    assert kbsr.status_code == 200 and "herbal wellness" in kbsr.json()["items"][0]["content"][0]

    # 3. Personal-only endpoints reject shared mode with 403
    assert c.post("/api/zhihu/knowledge/upload", json={"fileName": "terms.txt", "contentBase64": base64.b64encode(b"hello terms!").decode()}).status_code == 403
    assert c.get("/api/zhihu/creator/content", params={"contentUrl": "https://www.zhihu.com/question/123456/answer/777"}).status_code == 403
    assert c.get("/api/zhihu/creator/comments", params={"contentUrl": "https://www.zhihu.com/question/123456/answer/777"}).status_code == 403
    assert c.get("/api/zhihu/creator/account-stats").status_code == 403
    assert c.get("/api/zhihu/creator/content-stats", params={"contentUrl": "https://www.zhihu.com/question/123456/answer/777"}).status_code == 403

    # 4. After importing personal Access Secret, upload + creator endpoints succeed
    sess = c.post("/api/zhihu/session", json={"accessSecret": "personal-secret-not-real"})
    assert sess.status_code == 200

    up = c.post("/api/zhihu/knowledge/upload", json={
        "fileName": "terms.txt",
        "contentBase64": base64.b64encode(b"hello terms!").decode(),
        "knowledgeBaseId": "7526139256098382426",
    })
    assert up.status_code == 201 and up.json()["fileName"] == "terms.txt"

    cd = c.get("/api/zhihu/creator/content", params={"contentUrl": "https://www.zhihu.com/question/123456/answer/777"})
    assert cd.status_code == 200 and "先看目标读者背景" in cd.json()["plainText"]

    cc = c.get("/api/zhihu/creator/comments", params={"contentUrl": "https://www.zhihu.com/question/123456/answer/777"})
    assert cc.status_code == 200 and cc.json()["items"][0]["comment"]["content"] == "讲得很透彻"

    ast = c.get("/api/zhihu/creator/account-stats", params={"contentType": "all"})
    assert ast.status_code == 200 and ast.json()["metrics"]["views"] == 1200

    cst = c.get("/api/zhihu/creator/content-stats", params={"contentUrl": "https://www.zhihu.com/question/123456/answer/777"})
    assert cst.status_code == 200 and cst.json()["items"][0]["metrics"]["views"] == 420


def test_flowback_multi_target_modes_and_destinations(make_settings):
    c = make_client(make_settings)
    base_payload = {
        "caseId": "case_a",
        "termIds": ["t1"],
        "source": {"kind": "manual", "text": "Why does a storm decide if he becomes immortal?", "keyPointId": "kp1"},
    }
    for target_type, expected_host_path in [
        ("answer", "https://www.zhihu.com/question/"),
        ("question", "https://www.zhihu.com/search?type=content&q="),
        ("article", "https://zhuanlan.zhihu.com/write"),
        ("pin", "https://www.zhihu.com/pins"),
    ]:
        r = c.post("/api/questions/draft", json={**base_payload, "targetType": target_type})
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["targetType"] == target_type
        assert data["recommendedTarget"] in ("answer", "question", "article", "pin")
        dest_map = {d["targetType"]: d for d in data["destinations"]}
        assert set(dest_map.keys()) == {"answer", "question", "article", "pin"}
        assert dest_map[target_type]["url"].startswith(expected_host_path)
        assert data["draft"]["title"].strip() and data["draft"]["body"].strip()
