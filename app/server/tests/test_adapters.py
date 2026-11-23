"""适配器测试：全部使用 httpx.MockTransport，不发出任何真实网络请求。"""
import asyncio
import json

import httpx
import pytest

from bridge import contracts as C
from bridge.adapters.llm import LLMError
from bridge.adapters.llm_openai import OpenAICompatibleLLM, SiliconFlowLLM, ZhihuDirectLLM
from bridge.adapters.zhihu import ZhihuClient, ZhihuError
from bridge.core.store import Store
from bridge.pipeline.deps import build_deps
from bridge.pipeline.runs import execute_run

# 结构取自 Day 0 实测响应：多出 Headline/AuthorSignature/CreateTime，AuthorName 为空串，CommentInfoList 缺失。
SEARCH_OK = {"Code": 0, "Message": "success", "Data": {"HasMore": False, "Items": [
    {"Title": "修真小说设定知识点随笔 - 知乎", "Headline": "h", "ContentType": "Article", "AuthorSignature": "x", "CreateTime": 1,
     "ContentText": "渡得过就活，渡不过就灭。", "Url": "https://zhuanlan.zhihu.com/p/721900687?utm_medium=openapi_platform", "AuthorName": ""},
    {"Title": "第1章 渡劫失败后我重生了 - 知乎", "ContentType": "Article", "ContentText": "小说正文", "Url": "https://zhuanlan.zhihu.com/p/1", "AuthorName": "某作者"},
]}}


def zsettings(make_settings, **kw):
    return make_settings(ZHIHU_LIVE_ENABLED="true", ZHIHU_ACCESS_SECRET="test-secret-not-real", **kw)


def client(settings, handler, tmp_path):
    return ZhihuClient(settings, Store(tmp_path / "z.sqlite3"), transport=httpx.MockTransport(handler))


async def test_zhihu_disabled_by_default(make_settings, tmp_path):
    c = client(make_settings(), lambda r: httpx.Response(500), tmp_path)
    with pytest.raises(ZhihuError) as e:
        await c.search("q")
    assert e.value.kind == "disabled"


async def test_zhihu_search_parses_real_shaped_payload(make_settings, tmp_path):
    seen = []

    def handler(req: httpx.Request):
        seen.append(req)
        return httpx.Response(200, json=SEARCH_OK)

    c = client(zsettings(make_settings), handler, tmp_path)
    items, src = await c.search("雷劫 渡劫")
    assert src == "zhihu_live" and len(items) == 1  # “第1章”正文噪音被过滤
    assert items[0]["AuthorName"] is None and items[0]["CommentInfoList"] == []
    h = seen[0].headers
    assert h["Authorization"] == "Bearer test-secret-not-real" and h["X-Request-Timestamp"].isdigit()  # scan:allow-fake
    assert seen[0].url.params["Query"] == "雷劫 渡劫" and seen[0].url.params["Count"] == "10"
    # 第二次同查询命中缓存，不再请求
    items2, src2 = await c.search("雷劫  渡劫")
    assert src2 == "cache" and len(seen) == 1


@pytest.mark.parametrize("code,kind", [(30001, "rate_limit"), (30003, "rate_limit"), (20001, "auth"), (10001, "bad_request"), (90001, "upstream")])
async def test_zhihu_error_codes(make_settings, tmp_path, code, kind):
    c = client(zsettings(make_settings), lambda r: httpx.Response(200, json={"Code": code, "Message": "m"}), tmp_path)
    with pytest.raises(ZhihuError) as e:
        await c.search("q")
    assert e.value.kind == kind and e.value.code == code
    assert c.store.used("zhihu_search") == 1  # 失败也计数


async def test_zhihu_timeout_and_budget(make_settings, tmp_path):
    def handler(req):
        raise httpx.ReadTimeout("t", request=req)

    c = client(zsettings(make_settings, BUDGET_ZHIHU_SEARCH_PUBLIC_CAP="2"), handler, tmp_path)
    for q in ("a", "b"):
        with pytest.raises(ZhihuError) as e:
            await c.search(q)
        assert e.value.kind == "timeout"
    with pytest.raises(ZhihuError) as e:
        await c.search("c")
    assert e.value.kind == "budget"


async def test_zhihu_inflight_requests_merged(make_settings, tmp_path):
    calls = []

    async def slow(req):
        calls.append(1)
        await asyncio.sleep(0.05)
        return httpx.Response(200, json={"Code": 0, "Data": {"Items": [{"Title": "t - 知乎", "Url": "https://www.zhihu.com/question/1"}]}})

    c = client(zsettings(make_settings), slow, tmp_path)
    r = await asyncio.gather(c.question_recommendations("同一个查询"), c.question_recommendations("同一个查询"))
    assert len(calls) == 1
    assert r[0][0] == [{"title": "t", "url": "https://www.zhihu.com/question/1"}]


def llm_settings(make_settings):
    return make_settings(LLM_PROVIDER="openai_compatible", LLM_BASE_URL="https://llm.invalid/v1", LLM_API_KEY="test-key-not-real",
                         LLM_MAIN_MODEL="main-model", LLM_LIGHT_MODEL="light-model")


def chat(content: dict) -> httpx.Response:
    return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(content)}}]})


async def test_openai_adapter_request_and_errors(make_settings):
    seen = []

    def handler(req):
        seen.append(json.loads(req.content))
        assert req.headers["Authorization"] == "Bearer test-key-not-real"
        return chat({"query": "渡劫 外国人 怎么理解"})

    llm = OpenAICompatibleLLM(llm_settings(make_settings), transport=httpx.MockTransport(handler))
    assert await llm.refine_query("seed", "storm") == "渡劫 外国人 怎么理解"
    assert seen[0]["model"] == "light-model" and seen[0]["response_format"] == {"type": "json_object"}

    for resp, kind in [(httpx.Response(429), "rate_limit"), (httpx.Response(500), "upstream"),
                       (httpx.Response(200, json={"choices": [{"message": {"content": "not json"}}]}), "bad_output")]:
        bad = OpenAICompatibleLLM(llm_settings(make_settings), transport=httpx.MockTransport(lambda r, resp=resp: resp))
        with pytest.raises(LLMError) as e:
            await bad.retell(None, {"brief": "b"}, "plain", "t")
        assert e.value.kind == kind


async def test_openai_adapter_requires_config(make_settings):
    with pytest.raises(LLMError):
        OpenAICompatibleLLM(make_settings(LLM_PROVIDER="openai_compatible"))


async def test_siliconflow_deepseek_preset_request(make_settings):
    stub_token = "transport-test"
    settings = zsettings(make_settings, LLM_PROVIDER="siliconflow", SILICONFLOW_API_KEY=stub_token,
                         LLM_BASE_URL="https://unused.invalid/v1", LLM_MAIN_MODEL="unused-model")

    def handler(req):
        assert str(req.url) == "https://api.siliconflow.cn/v1/chat/completions"
        assert req.headers["Authorization"] == f"Bearer {stub_token}"
        assert "X-Request-Timestamp" not in req.headers
        body = json.loads(req.content)
        assert body["model"] == "deepseek-ai/DeepSeek-V4.1-Flash"
        assert body["response_format"] == {"type": "json_object"}
        assert body["enable_thinking"] is False and body["stream"] is False
        return chat({"retelling": "I read this as a test."})

    llm = SiliconFlowLLM(settings, transport=httpx.MockTransport(handler))
    assert await llm.retell(None, {"brief": "reader"}, "plain", "Test.") == "I read this as a test."
    assert build_deps(settings).llm.name == "siliconflow"
    assert settings.public_view()["llmKeyConfigured"] and settings.public_view()["zhihuSecretConfigured"]


async def test_openai_adapter_parses_fenced_json(make_settings):
    def handler(req):
        return httpx.Response(200, json={"choices": [{"message": {"content": '```json\n{"query": "雷劫 语境"}\n```'}}]})

    llm = OpenAICompatibleLLM(llm_settings(make_settings), transport=httpx.MockTransport(handler))
    assert await llm.refine_query("seed", "text") == "雷劫 语境"


async def test_siliconflow_model_override(make_settings):
    stub_token = "transport-test"
    settings = zsettings(make_settings, LLM_PROVIDER="siliconflow", SILICONFLOW_API_KEY=stub_token,
                         SILICONFLOW_MODEL="deepseek-ai/DeepSeek-V3.2")

    def handler(req):
        body = json.loads(req.content)
        assert body["model"] == "deepseek-ai/DeepSeek-V3.2"
        return chat({"retelling": "Overridden model response."})

    llm = SiliconFlowLLM(settings, transport=httpx.MockTransport(handler))
    assert await llm.retell(None, {"brief": "reader"}, "plain", "Test.") == "Overridden model response."
    assert llm.model_version == "deepseek-ai/DeepSeek-V3.2|deepseek-ai/DeepSeek-V3.2"


def test_siliconflow_requires_its_own_credentials(make_settings):
    settings = zsettings(make_settings, LLM_PROVIDER="siliconflow", SILICONFLOW_API_KEY="")
    assert not settings.public_view()["llmKeyConfigured"]
    with pytest.raises(LLMError, match="SILICONFLOW_API_KEY"):
        build_deps(settings)


async def test_zhihu_direct_uses_documented_request_and_reads_fenced_json(make_settings):
    def handler(req):
        assert str(req.url) == "https://developer.zhihu.com/v1/chat/completions"
        assert req.headers["X-Request-Timestamp"].isdigit()
        body = json.loads(req.content)
        assert set(body) == {"model", "messages", "stream"}
        assert body["model"] == "zhida-fast-1p5" and body["stream"] is False
        return httpx.Response(200, json={"choices": [{"message": {"content": '```json\n{"query":"九重雷劫"}\n```'}}]})

    llm = ZhihuDirectLLM(zsettings(make_settings, LLM_PROVIDER="zhihu_direct"), transport=httpx.MockTransport(handler))
    assert await llm.refine_query("三种译法", "test") == "九重雷劫"


async def test_zhihu_direct_retries_429_with_backoff_and_counts_attempts(make_settings, monkeypatch):
    pauses = []

    async def sleep(delay):
        pauses.append(delay)

    async def limited_then_ok():
        if not pauses:
            raise LLMError("rate_limit", retry_after=5)
        return "ok"

    monkeypatch.setattr("bridge.pipeline.deps.asyncio.sleep", sleep)
    deps = build_deps(zsettings(make_settings, LLM_PROVIDER="zhihu_direct"))
    assert await deps.call_llm(limited_then_ok) == "ok"
    assert pauses == [5]
    assert deps.store.used("llm_calls") == 2


async def test_evidence_only_preset_retrieves_live_then_labels_cache(make_settings):
    calls = []

    def handler(req):
        calls.append(req.url.path)
        assert req.url.params["Query"] == "仙侠小说 渡雷劫 设定"
        return httpx.Response(200, json=SEARCH_OK)

    deps = build_deps(zsettings(make_settings, LLM_PROVIDER="disabled", ZHIHU_PRESET_LIVE_SEARCH="true"),
                      zhihu_transport=httpx.MockTransport(handler))
    req = C.RunRequest(text=deps.fx.cases["case_a"].text, audienceId="a_new", caseId="case_a")
    for source in ("zhihu_live", "zhihu_cached"):
        evs = [e async for e in execute_run(req, deps)]
        assert evs[-1]["type"] == "error" and not evs[-1]["payload"]["retryable"]
        payload = next(e["payload"] for e in evs if e["type"] == "evidence")
        card = payload["evidence"][0]
        assert payload["evidenceSource"] == card["sourceMode"] == source
        assert card["url"].startswith("https://zhuanlan.zhihu.com/")
        assert card["author"] is None and card["fetchedAt"]
        assert any(e["id"] == "A1#1" for e in payload["evidence"])
    assert calls == ["/api/v1/content/zhihu_search"]
    assert deps.store.used("llm_calls") == 0


async def test_curated_preset_preserves_shared_zhihu_budget_and_passes_full_excerpt(make_settings):
    calls = []
    long_body = "关于硬件主板高密度布线与低功耗调试的知乎长文讨论：" + ("实测表明需要区分设计目标与认证数据。" * 25)
    assert len(long_body) > 400

    def zhihu_handler(req):
        calls.append(req.url.params["Query"])
        return httpx.Response(200, json={"Code": 0, "Data": {"Items": [{
            "Title": "嵌入式低功耗与 PCB 设计经验 - 知乎",
            "ContentType": "Answer",
            "ContentText": long_body,
            "Url": "https://www.zhihu.com/question/123/answer/456",
            "AuthorName": "硬件工程师",
        }]}})

    # case_a 已有精选证据：默认不消耗共享 zhihu_search 额度
    deps = build_deps(zsettings(make_settings, LLM_PROVIDER="disabled"), zhihu_transport=httpx.MockTransport(zhihu_handler))
    evs_a = [e async for e in execute_run(C.RunRequest(text=deps.fx.cases["case_a"].text, audienceId="a_new", caseId="case_a"), deps)]
    ev_a = next(e["payload"] for e in evs_a if e["type"] == "evidence")
    assert ev_a["evidenceSource"] == "zhihu_curated"
    assert calls == [] and deps.store.used("zhihu_search") == 0

    # 开启 ZHIHU_PRESET_LIVE_SEARCH 时执行实时检索，且模型上下文应收到超过 80 字的完整摘录，UI 卡片摘要保持精简
    captured_prompt = {}

    def llm_handler(req):
        body = json.loads(req.content)
        system = body["messages"][0]["content"]
        if "合规与风俗检查员" in system:
            return chat({"findings": []})
        captured_prompt["user"] = body["messages"][1]["content"]
        return chat({"recommendationReason": "r", "decisions": [], "variants": [
            {"level": "literal", "segments": [{"text": "lit pcb power debug"}]},
            {"level": "plain", "segments": [{"text": "In-house high-density PCB with selected components, optimized for power efficiency and low-level protocol debugging."}]},
            {"level": "light", "segments": [{"text": "Custom high-density PCB built with quality components, power-optimized and supporting low-level protocol debugging."}]},
            {"level": "balanced", "segments": [{"text": "In-house high-density PCB with carefully chosen parts, tuned for power efficiency and low-level protocol debugging."}]},
            {"level": "technical", "segments": [{"text": "Custom high-density PCB using selected components, power-optimized with low-level protocol debugging support."}]},
            {"level": "genre", "segments": [{"text": "In-house high-density component-dense PCB, power-optimized with native low-level protocol debugging."}]},
        ]})

    stub_token = "transport-test"
    live_settings = zsettings(make_settings, LLM_PROVIDER="openai_compatible", LLM_API_KEY=stub_token,
                              LLM_BASE_URL="https://llm.invalid/v1", LLM_MAIN_MODEL="m", LLM_LIGHT_MODEL="l",
                              ZHIHU_PRESET_LIVE_SEARCH="true")
    deps_b = build_deps(live_settings, zhihu_transport=httpx.MockTransport(zhihu_handler),
                        llm=OpenAICompatibleLLM(live_settings, transport=httpx.MockTransport(llm_handler)))
    evs_b = [e async for e in execute_run(C.RunRequest(text=deps_b.fx.cases["case_b"].text, audienceId="b_backer", caseId="case_b"), deps_b)]
    snap_b = C.RunSnapshot(**evs_b[-1]["payload"])
    assert len(calls) == 1 and deps_b.store.used("zhihu_search") == 1
    assert len(snap_b.evidence[0].summary) <= 121
    assert long_body[:400] in captured_prompt["user"]


async def test_live_path_end_to_end_with_mocked_model(make_settings):
    """用 MockTransport 模拟“真实模型”响应，验证 live 模式的标签与契约校验（不是真实调用）。"""
    settings = llm_settings(make_settings)
    gen = {"recommendationReason": "r", "decisions": [], "variants": [
        {"level": "literal", "segments": [{"text": "lit nine soul scatter heaven", "termIds": [], "evidenceIds": []}]},
        {"level": "plain", "segments": [{"text": "Heaven's law. Fail the ninefold trial and your soul will be destroyed.", "termIds": ["T2"], "evidenceIds": ["A1#1"]}]},
        {"level": "light", "segments": [{"text": "By heaven's law, fail the ninefold lightning trial and your soul will scatter."}]},
        {"level": "balanced", "segments": [{"text": "The Dao brings this trial. Fail the ninefold lightning ordeal and your soul will be destroyed."}]},
        {"level": "technical", "segments": [{"text": "This is the Heavenly Dao's law. Fail the ninefold lightning tribulation and your soul will scatter."}]},
        {"level": "genre", "segments": [{"text": "Heavenly Dao's reckoning. Fail the Ninefold Thunder Tribulation, and your soul will scatter.", "termIds": [], "evidenceIds": []}]},
    ]}

    def handler(req):
        body = json.loads(req.content)
        system = body["messages"][0]["content"]
        if "合规与风俗检查员" in system:
            return chat({"findings": []})
        assert all(level in body["messages"][1]["content"] for level in ("light", "balanced", "technical"))
        return chat(gen)

    deps = build_deps(settings, llm=OpenAICompatibleLLM(settings, transport=httpx.MockTransport(handler)))
    text = deps.fx.cases["case_a"].text
    evs = [e async for e in execute_run(C.RunRequest(text=text, audienceId="a_genre", caseId="case_a"), deps)]
    snap = C.RunSnapshot(**evs[-1]["payload"])
    assert snap.mode == "live" and snap.provenance == "real_run"
    assert snap.modelVersion == "main-model|light-model"
    assert [v.level for v in snap.variants] == ["literal", "plain", "light", "balanced", "technical", "genre"]
    assert all(v.exportState == "exportable" for v in snap.variants if v.level != "literal")
    assert deps.store.used("llm_calls") == 6  # 一次生成 + 五档分别守门


async def test_openai_adapter_extracts_json_with_prose_and_detects_truncation(make_settings):
    def prose_handler(req):
        return httpx.Response(200, json={"choices": [{
            "finish_reason": "stop",
            "message": {"content": 'Here is the JSON result:\n{"query": "九重雷劫 英文"}\nDone.'},
        }]})

    llm = OpenAICompatibleLLM(llm_settings(make_settings), transport=httpx.MockTransport(prose_handler))
    assert await llm.refine_query("seed", "text") == "九重雷劫 英文"

    def truncated_handler(req):
        return httpx.Response(200, json={"choices": [{
            "finish_reason": "length",
            "message": {"content": '{"variants": [{"level": "plain", "segments": [{"text": "cut off'},
        }]})

    trunc_llm = OpenAICompatibleLLM(llm_settings(make_settings), transport=httpx.MockTransport(truncated_handler))
    with pytest.raises(LLMError) as exc_info:
        await trunc_llm.refine_query("seed", "text")
    assert exc_info.value.kind == "bad_output" and "截断" in str(exc_info.value)


async def test_live_generation_normalizes_harmless_fields_and_retries_with_feedback(make_settings):
    """验证 6 档生成预算提升到 5600、容忍无害多余字段/枚举别名、并对相邻档位重复触发带反馈重试。"""
    settings = llm_settings(make_settings)
    gen_requests = []

    def handler(req):
        body = json.loads(req.content)
        system = body["messages"][0]["content"]
        if "合规与风俗检查员" in system:
            return chat({"findings": []})
        gen_requests.append(body)
        if len(gen_requests) == 1:
            assert body["max_tokens"] == 5600
            # 第 1 次：balanced 与 technical 译文重复，触发带反馈重试
            return chat({"recommendationReason": "r", "decisions": [], "variants": [
                {"level": "literal", "segments": [{"text": "lit"}]},
                {"level": "plain", "segments": [{"text": "Heaven's law. Fail the ninefold trial and your soul will be destroyed."}]},
                {"level": "light", "segments": [{"text": "By heaven's law, fail the ninefold lightning trial and your soul will scatter."}]},
                {"level": "balanced", "segments": [{"text": "The Dao brings this trial. Fail the ninefold lightning ordeal and your soul will be destroyed."}]},
                {"level": "technical", "segments": [{"text": "The Dao brings this trial. Fail the ninefold lightning ordeal and your soul will be destroyed."}]},
                {"level": "genre", "segments": [{"text": "Heavenly Dao's reckoning. Fail the Ninefold Thunder Tribulation, and your soul will scatter."}]},
            ]})
        # 第 2 次应携带具体重复档位反馈，并容忍无害多余字段、null 列表与 zhihu_curated / all 别名
        user_prompt = body["messages"][1]["content"]
        assert "上一次输出未通过校验" in user_prompt
        assert "balanced" in user_prompt and "technical" in user_prompt
        return chat({
            "recommendationReason": "r",
            "decisions": [{
                "id": "D1", "termId": "T2", "title": "九重雷劫", "choice": "Ninefold Thunder Tribulation",
                "rationale": "依知乎社区共识保留九重", "evidenceIds": ["A1#1"],
                "attribution": "zhihu_curated", "levels": ["all"], "extraNote": "ignored",
            }],
            "variants": [
                {"level": "literal", "segments": [{"text": "lit", "termIds": None, "evidenceIds": None, "decisionId": ""}], "notes": None},
                {"level": "plain", "segments": [{"text": "Heaven's law. Fail the ninefold trial and your soul will be destroyed.", "termIds": ["T2"], "evidenceIds": ["A1#1"], "decisionId": "D1", "unused": 1}]},
                {"level": "light", "segments": [{"text": "By heaven's law, fail the ninefold lightning trial and your soul will scatter."}]},
                {"level": "balanced", "segments": [{"text": "The Dao brings this trial. Fail the ninefold lightning ordeal and your soul will be destroyed."}]},
                {"level": "technical", "segments": [{"text": "This is the Heavenly Dao's law. Fail the ninefold lightning tribulation and your soul will scatter."}]},
                {"level": "genre", "segments": [{"text": "Heavenly Dao's reckoning. Fail the Ninefold Thunder Tribulation, and your soul will scatter."}], "notes": [{"text": "注", "evidenceIds": ["A1#1"], "extra": True}]},
            ],
        })

    deps = build_deps(settings, llm=OpenAICompatibleLLM(settings, transport=httpx.MockTransport(handler)))
    text = deps.fx.cases["case_a"].text
    evs = [e async for e in execute_run(C.RunRequest(text=text, audienceId="a_new", caseId="case_a"), deps)]
    assert evs[-1]["type"] == "ready"
    snap = C.RunSnapshot(**evs[-1]["payload"])
    assert len(gen_requests) == 2
    assert snap.decisions[0].attribution == "zhihu"
    assert snap.decisions[0].levels == ["plain", "light", "balanced", "technical", "genre"]
    assert all(v.exportState == "exportable" for v in snap.variants if v.level != "literal")

