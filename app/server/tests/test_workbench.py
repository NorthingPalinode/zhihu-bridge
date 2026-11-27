"""V1.4 四步工作台：负面测试（PLAN §8.3）与撤销还原（§8.4 第 5 条）。"""
import base64
import copy
import io
import zipfile

import pytest
from fastapi.testclient import TestClient

from bridge.api.app import create_app


@pytest.fixture
def client(make_settings):
    return TestClient(create_app(make_settings()))


@pytest.fixture
def demo(client):
    r = client.post("/api/projects", json={"demo": True})
    assert r.status_code == 200, r.text
    pid = r.json()["id"]
    return pid, client.get(f"/api/projects/{pid}/workspace").json()


def ws(client, pid):
    return client.get(f"/api/projects/{pid}/workspace").json()


def text_of(w, aid):
    a = next(a for a in w["assets"] if a["id"] == aid)
    return " ".join("".join(p["text"] for p in it["parts"]) for it in a["items"])


def export(client, pid):
    return client.get(f"/api/projects/{pid}/export").json()


# ---------------------------------------------------------------- pipeline & facts
def test_demo_facts_have_real_locators_and_unreadable_pdf_is_not_used(demo):
    _, w = demo
    facts = {f["id"]: f for f in w["facts"]}
    assert set(facts) == {"F01", "F02", "F03", "F05", "F04a", "F04b", "F07", "F06"}
    assert facts["F01"]["source"]["locator"] == "第 4 行"
    assert facts["F04b"]["source"]["locator"] == "第 11 行"
    assert facts["F04a"]["source"]["locator"] == "第 2 节"
    assert facts["F06"]["source"]["file"].endswith(".docx")
    pdf = next(s for s in w["sources"] if s["filename"].endswith(".pdf"))
    assert pdf["status"] == "unsupported" and "没有用作依据" in pdf["note"]
    assert all(f["user_decision"] == "pending" for f in facts.values()), "模型/流水线不得写入用户决定"


def test_conflict_keeps_both_sides_recommends_but_never_picks(client, demo):
    pid, w = demo
    a, b = (next(f for f in w["facts"] if f["id"] == k) for k in ("F04a", "F04b"))
    assert a["evidence_status"] == b["evidence_status"] == "conflicting"
    assert a["group"] == b["group"] == "W1"
    d = next(d for d in w["decisions"] if d["id"] == "conflict:W1")
    assert d["value"] is None
    assert [o["recommended"] for o in d["options"]].count(True) == 1
    md = export(client, pid)["markdown"]
    assert md.count("[待确认]") >= 3 and "3.2 g" not in md and "3.6 g" not in md


def test_roadmap_feature_is_not_auto_handled_and_unsupported_claims_never_appear(client, demo):
    pid, w = demo
    assert next(d for d in w["decisions"] if d["id"] == "roadmap:F07")["value"] is None
    assert "roadmap:F07" in w["summary"]["open_decisions"]
    assert "F06" not in [d["id"] for d in w["decisions"]], "无依据声称不需要用户驳回"
    md = export(client, pid)["markdown"].lower()
    for bad in ("fda approved", "medical-grade", "all-day battery", "industry-leading", "stacking", "out of the box"):
        assert bad not in md


def test_auto_fixes_are_conservative_and_keep_original(demo):
    _, w = demo
    fixes = [i for i in w["issues"] if i["status"] == "auto_applied"]
    assert {i["fix_kind"] for i in fixes} <= {"remove_claim", "soften_claim", "terminology", "unit_boundary"}
    assert all(i["original"] and i["applied"] for i in fixes)
    assert "Runtime Testing in Progress" in text_of(w, "features")


def test_three_decisions_lead_to_ready(client, demo):
    pid, w = demo
    assert len(w["summary"]["open_decisions"]) == 3
    v0 = client.app.state.workbench_store.get(pid)["fact_set_version"]
    r = client.post(f"/api/projects/{pid}/decisions/facts", json={"value": "confirmed"}).json()
    assert client.app.state.workbench_store.get(pid)["fact_set_version"] == v0 + 1, "批量确认只加 1"
    assert all(f["decided_via"] == "batch" for f in r["workspace"]["facts"] if f["id"] in ("F01", "F02", "F03", "F05"))
    client.post(f"/api/projects/{pid}/decisions/conflict:W1", json={"value": "3.6"})
    r = client.post(f"/api/projects/{pid}/decisions/roadmap:F07", json={"value": "mention"}).json()
    assert r["workspace"]["summary"]["ready"] is True
    md = export(client, pid)["markdown"]
    assert "[待确认]" not in md and "3.6 g (size 9)" in md and "Two-Way Sync Planned" in md


def test_custom_weight_and_omit_roadmap(client, demo):
    pid, _ = demo
    assert client.post(f"/api/projects/{pid}/decisions/conflict:W1", json={"value": "custom"}).status_code == 400
    client.post(f"/api/projects/{pid}/decisions/conflict:W1", json={"value": "custom", "custom": "3.4 g (size 8)"})
    w = client.post(f"/api/projects/{pid}/decisions/roadmap:F07", json={"value": "omit"}).json()["workspace"]
    assert "3.4 g (size 8)" in text_of(w, "specs")
    assert "Apple Health" not in text_of(w, "features") + text_of(w, "faq")


# ---------------------------------------------------------------- fixes & reasons
def test_restoring_high_risk_original_requires_reason(client, demo):
    pid, _ = demo
    r = client.post(f"/api/projects/{pid}/issues/R01/undo-fix", json={})
    assert r.status_code == 422
    w = client.post(f"/api/projects/{pid}/issues/R01/undo-fix", json={"reason": "owner_approved"}).json()["workspace"]
    part = next(p for it in next(a for a in w["assets"] if a["id"] == "features")["items"] for p in it["parts"] if p.get("issue") == "R01")
    assert part["type"] == "kept" and "All-Day" in part["text"]
    assert "负责人确认保留" in export(client, pid)["report"]
    # low-risk can be undone without reason
    assert client.post(f"/api/projects/{pid}/issues/R05/undo-fix", json={}).status_code == 200


# ---------------------------------------------------------------- edit & recheck
def test_edit_rechecks_and_new_risk_becomes_a_decision(client, demo):
    pid, w = demo
    r = client.patch(f"/api/projects/{pid}/content/faq", json={"items": {"q2": "No. It is fully waterproof and FDA approved."}}).json()
    w = r["workspace"]
    xs = [i for i in w["issues"] if i["fix_kind"] == "user_introduced" and i["status"] == "open"]
    assert {i["term"].lower() for i in xs} == {"waterproof", "fda approved"}
    assert len(w["summary"]["open_decisions"]) == 5
    x = next(i for i in xs if i["term"].lower() == "waterproof")
    assert client.post(f"/api/projects/{pid}/decisions/x:{x['id']}", json={"value": "keep"}).status_code == 400, "保留必须选理由"
    w = client.post(f"/api/projects/{pid}/decisions/x:{x['id']}", json={"value": "fix"}).json()["workspace"]
    assert "water-resistant" in text_of(w, "faq") and "5 ATM" not in text_of(w, "faq").split("water-resistant")[1][:8]


def test_cannot_edit_sentence_waiting_for_decision(client, demo):
    pid, _ = demo
    r = client.patch(f"/api/projects/{pid}/content/specs", json={"items": {"p2": "3.3 g"}})
    assert r.status_code == 400 and "等你决定" in r.json()["detail"]


def test_user_edit_survives_insight_toggle_and_regenerate(client, demo):
    pid, _ = demo
    client.patch(f"/api/projects/{pid}/content/features", json={"items": {"f1": "My own line about the PCB"}})
    client.patch(f"/api/projects/{pid}/insights/I01", json={"enabled": False})
    w = client.post(f"/api/projects/{pid}/content/features/regenerate").json()["workspace"]
    assert "My own line about the PCB" in text_of(w, "features")


def test_insight_toggle_changes_sentence(client, demo):
    pid, w = demo
    assert "Firmware Is Not Open Source" in text_of(w, "features")
    w = client.patch(f"/api/projects/{pid}/insights/I02", json={"enabled": False}).json()["workspace"]
    assert "Firmware Is Not Open Source" not in text_of(w, "features")


# ---------------------------------------------------------------- undo covers every write
WRITES = [
    ("post", "/decisions/facts", {"value": "confirmed"}),
    ("post", "/decisions/conflict:W1", {"value": "3.2"}),
    ("post", "/decisions/roadmap:F07", {"value": "omit"}),
    ("patch", "/facts/F01", {"text": "自研 6 层 PCB"}),
    ("patch", "/insights/I03", {"enabled": False}),
    ("patch", "/content/story", {"items": {"s1": "A new story line."}}),
    ("post", "/content/headline/regenerate", None),
    ("patch", "/settings", {"key": "audience", "value": "everyday"}),
    ("post", "/issues/R04/undo-fix", {}),
]


@pytest.mark.parametrize("method,path,body", WRITES)
def test_every_write_can_be_undone_exactly(client, demo, method, path, body):
    pid, before = demo
    r = getattr(client, method)(f"/api/projects/{pid}{path}", **({"json": body} if body is not None else {}))
    assert r.status_code == 200, r.text
    assert r.json()["undoable"] is True
    u = client.post(f"/api/projects/{pid}/actions/undo")
    assert u.status_code == 200
    assert u.json()["workspace"] == before


def test_undo_with_nothing_to_undo(client, demo):
    pid, _ = demo
    assert client.post(f"/api/projects/{pid}/actions/undo").status_code == 409


# ---------------------------------------------------------------- uploads
def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def test_generic_upload_with_docx_and_unsupported_pdf(client):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>续航 7 天，重量 45 g。</w:t></w:r></w:p></w:body></w:document>')
    files = [{"name": "spec.docx", "content_b64": _b64(buf.getvalue())}, {"name": "scan.pdf", "content_b64": _b64(b"%PDF-1.4")}]
    r = client.post("/api/projects", json={"files": files})
    assert r.status_code == 200, r.text
    w = ws(client, r.json()["id"])
    assert w["is_demo"] is False and w["facts"] and w["facts"][0]["source"]["file"] == "spec.docx"
    assert any(s["status"] == "unsupported" for s in w["sources"])
    assert "开发占位" in text_of(w, "features")


def test_upload_of_only_unreadable_files_is_explained(client):
    r = client.post("/api/projects", json={"files": [{"name": "a.pdf", "content_b64": _b64(b"%PDF")}]})
    assert r.status_code == 422 and "读不出文字" in r.json()["detail"]


def test_upload_needs_something(client):
    assert client.post("/api/projects", json={}).status_code == 400


def test_run_events_stream(client, demo):
    pid, _ = demo
    with client.stream("GET", f"/api/projects/{pid}/run/events") as r:
        body = "".join(r.iter_text())
    assert body.count("event: step") == 10 and "event: done" in body
