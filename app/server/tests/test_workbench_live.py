"""真实流水线（live.py）的守卫：模型输出不被直接信任。用替身模型与替身知乎客户端，不触达外部 API。"""
import asyncio
import json

import pytest

from bridge.workbench import engine
from bridge.workbench.live import build_live_state, english_ok
from bridge.workbench.sources import parse_source

SOURCES = [
    ("spec.csv", "项目,参数,备注\n主板,自研 6 层 PCB,\n机身重量,3.6 g,9 号指围\n".encode()),
    ("intro.md", "# AcmeRing\n\n## 2. 外观\n机身重量 3.2 g。\n\n## 3. 软件\n睡眠分析计划于量产后 OTA 推送。\n".encode()),
    ("notes.txt", "自研堆料主板，功耗做了系统优化。\n\n营销稿：全天续航，已获 FDA 认证。".encode()),
]

EXTRACT = {
    "product_name": "AcmeRing 智能指环", "channel": "ks", "audience": "geek", "tone": "pro",
    "facts": [
        {"short": "6 层 PCB", "text": "自研 6 层 PCB", "quote": "自研 6 层 PCB", "file": "spec.csv", "status": "supported", "group": "", "value": "", "roadmap": False},
        {"short": "机身重量 3.6 g", "text": "机身重量 3.6 g（9 号指围）", "quote": "机身重量，3.6 g，9 号指围", "file": "spec.csv", "status": "conflicting", "group": "W1", "value": "3.6 g", "roadmap": False},
        {"short": "机身重量 3.2 g", "text": "机身重量 3.2 g", "quote": "机身重量 3.2 g", "file": "intro.md", "status": "conflicting", "group": "W1", "value": "3.2 g", "roadmap": False},
        {"short": "睡眠分析", "text": "睡眠分析计划量产后 OTA", "quote": "睡眠分析计划于量产后 OTA 推送", "file": "intro.md", "status": "needs_confirmation", "group": "", "value": "", "roadmap": True},
        {"short": "FDA 认证", "text": "已获 FDA 认证", "quote": "已获 FDA 认证", "file": "notes.txt", "status": "unsupported", "group": "", "value": "", "roadmap": False},
        {"short": "续航 10 天", "text": "续航 10 天", "quote": "续航长达 10 天", "file": "notes.txt", "status": "supported", "group": "", "value": "", "roadmap": False},
    ],
    "gaps": [{"title": "续航实测", "why": "资料里没有标准工况续航数据"}],
    "concepts": [{"zh": "堆料", "fact": 0, "zh_query": "堆料 主板", "en_query": "custom PCB components"}],
}
INSIGHT = {"insights": [{"concept": "堆料", "strategy": "转化为具体工程价值", "zhihu": "用更多更好的元器件", "zhihu_ref": 1,
                         "english": "carefully selected components", "english_ref": 7, "risk": "直译看不懂", "action": "写具体工程事实",
                         "literal": "stacking materials", "localized": "high-grade component selection"}]}
GENERATE = {
    "headline": "AcmeRing — Industry-Leading Smart Ring", "tagline": "Built on a custom 6-layer PCB.",
    "features": [{"text": "Custom 6-layer PCB with all-day battery life", "facts": [0], "insights": ["堆料"]}],
    "story": ["At 3.2 g, it is light.", "It is waterproof for swimming."],
    "specs": [{"label": "Weight", "value": "3.2 g (intro); 3.6 g measured on size 9", "facts": []}, {"label": "Main board", "value": "6-layer PCB", "facts": [0]}],
    "faq": [{"q": "Is it a medical device?", "a": "No."}],
    "roadmap": [{"fact": 1, "feature": "Sleep analysis planned via post-launch OTA", "faq_q": "Sleep analysis?", "faq_a": "Planned after launch."}],
    "brief": {"priorities": ["续航"], "faq": ["Battery?"], "forbidden": ["all-day battery"], "glossary": [["堆料", "high-grade component selection", "stacking materials"]]},
}


class FakeZhihu:
    enabled = True

    async def search(self, q, n):
        return [{"Title": "无关结果", "Url": "https://www.zhihu.com/question/1", "ContentText": "x"},
                {"Title": "堆料是什么", "Url": "https://www.zhihu.com/question/2", "ContentText": "用料"}], "zhihu_live"

    async def global_search(self, q, n):
        return [{"title": "淘宝 smart ring components on sale cheap price", "url": "https://goods.taobao.com/a", "contentText": "smart ring components buy now cheap " * 3},
                {"title": "Custom PCB design for wearables", "url": "https://www.hackster.io/p", "contentText": "carefully selected components and custom PCB layout " * 3}], "zhihu_live"


def run(llm_responses):
    calls = iter(llm_responses)

    async def llm_json(system, user, max_tokens):
        return next(calls)

    steps = []

    async def progress(t, r):
        steps.append((t, r))

    parsed = [parse_source(n, d) for n, d in SOURCES]
    fx = __import__("pathlib").Path(__file__).resolve().parents[2] / "fixtures"
    state = asyncio.run(build_live_state(parsed, llm_json, FakeZhihu(), engine.load_rules(fx), progress, engine.load_zh_claims(fx)))
    return state, steps


def test_hallucinated_quote_is_dropped_and_conflict_is_not_picked():
    state, steps = run([EXTRACT, INSIGHT, GENERATE])
    texts = [f["text"] for f in state["facts"]]
    assert "续航 10 天" not in texts, "资料里找不到原文的事实必须丢弃"
    assert any("1 条在资料里找不到原文" in r for _, r in steps)
    conflict = next(d for d in state["decisions"] if d["kind"] == "conflict")
    assert conflict["value"] is None and not any(o["recommended"] for o in conflict["options"])
    assert {o["source"].split(" · ")[0] for o in conflict["options"]} == {"spec.csv", "intro.md"}


def test_roadmap_and_unsupported_are_handled_conservatively():
    state, _ = run([EXTRACT, INSIGHT, GENERATE])
    road = next(d for d in state["decisions"] if d["kind"] == "roadmap_wording")
    assert road["value"] is None
    assert {b["short"] for b in state["blocked"]} == {"FDA 认证", "全天续航 / 超长续航"}, "营销稿里的风险说法由系统识别，不依赖模型"
    assert all(f["user_decision"] == "pending" for f in state["facts"])


def test_citations_only_point_to_real_results_and_english_is_filtered():
    state, _ = run([EXTRACT, INSIGHT, GENERATE])
    ins = state["insights"][0]
    assert ins["zhihu_url"] == "https://www.zhihu.com/question/2"
    assert ins["english"]["layer"] == "ai" and ins["english"]["url"] is None, "越界编号不能变成引用"
    assert not english_ok({"title": "x", "url": "https://goods.taobao.com/a", "contentText": "smart ring components buy now " * 5})
    assert english_ok({"title": "Custom PCB", "url": "https://www.hackster.io/p", "contentText": "carefully selected components " * 5})


def test_generated_risky_claims_are_softened_and_placeholders_wait():
    state, _ = run([EXTRACT, INSIGHT, GENERATE])
    full = state.copy()
    full.update(fact_set_version=1, sources=[])
    for a in full["assets"]:
        a.update(version=1)
    md = engine.export_markdown(full).lower()
    for bad in ("industry-leading", "all-day battery", "waterproof"):
        assert bad not in md
    assert "[待确认]" in md and "planned via post-launch ota" not in md, "计划功能的写法必须等用户决定"
    kinds = {i["fix_kind"] for i in state["issues"]}
    assert kinds <= engine.AUTO_FIX_KINDS and all(i["original"] and i["applied"] for i in state["issues"])
    assert "5 atm" not in md, "自动修订不得引入资料外的事实"
    assert "3.2 g" not in md and "3.6 g" not in md, "模型直接写出的冲突数值必须换成占位"
    conflict = next(d for d in state["decisions"] if d["kind"] == "conflict")
    assert conflict["subject"] == "机身重量" and len(conflict["options"]) == 2


def test_live_project_through_api_runs_in_background(make_settings, monkeypatch):
    from fastapi.testclient import TestClient
    from bridge.api.app import create_app
    from bridge.pipeline.deps import build_deps

    class LiveLLM:
        provenance = "live"
        responses = iter([EXTRACT, INSIGHT, GENERATE])

        async def task_json(self, system, user, max_tokens=1800):
            await asyncio.sleep(0.05)
            return next(self.responses)

    deps = build_deps(make_settings(), llm=LiveLLM())
    deps.zhihu = FakeZhihu()
    client = TestClient(create_app(deps=deps))
    import base64
    files = [{"name": n, "content_b64": base64.b64encode(d).decode()} for n, d in SOURCES]
    with client:
        pid = client.post("/api/projects", json={"files": files}).json()["id"]
        with client.stream("GET", f"/api/projects/{pid}/run/events") as r:
            body = "".join(r.iter_text())
        assert "event: done" in body and "找出产品事实" in body
        w = client.get(f"/api/projects/{pid}/workspace").json()
    assert w["llm_mode"] == "live" and w["name"] == "AcmeRing 智能指环"
    assert len(w["summary"]["open_decisions"]) == 3
