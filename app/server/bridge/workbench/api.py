"""工作台 HTTP 接口（PLAN_V1.4 §6.2），统一挂在 /api/projects 下。写操作都返回新的 workspace 和一句提示。"""
from __future__ import annotations

import asyncio
import base64
import binascii
import copy
import json
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Literal, Optional

from fastapi import FastAPI
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from . import engine
from .demo import DEMO_DIR_NAME, SETTINGS_OPTIONS, build_demo_state, generic_state
from .engine import WorkbenchError
from .sources import ParsedSource, parse_pasted, parse_source
from .store import WorkbenchStore


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class UploadFile(_Strict):
    name: str = Field(min_length=1, max_length=200)
    content_b64: str = Field(max_length=3_000_000)


class CreateProject(_Strict):
    demo: bool = False
    files: list[UploadFile] = Field(default_factory=list, max_length=10)
    text: Optional[str] = Field(default=None, max_length=20000)


class DecisionBody(_Strict):
    value: Optional[str] = Field(default=None, max_length=40)
    custom: Optional[str] = Field(default=None, max_length=40)
    reason: Optional[Literal["has_data_later", "owner_approved", "will_revise"]] = None


class FactBody(_Strict):
    text: str = Field(min_length=1, max_length=300)


class InsightBody(_Strict):
    enabled: bool


class ContentBody(_Strict):
    items: dict[str, str] = Field(min_length=1, max_length=20)


class SettingBody(_Strict):
    key: Literal["channel", "audience", "tone"]
    value: str = Field(min_length=1, max_length=20)


class UndoFixBody(_Strict):
    reason: Optional[Literal["has_data_later", "owner_approved", "will_revise"]] = None


def _err(status: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"detail": message})


def _demo_sources(fixtures_dir: Path) -> list[ParsedSource]:
    d = fixtures_dir / "workbench" / DEMO_DIR_NAME
    return [parse_source(p.name, p.read_bytes()) for p in sorted(d.iterdir()) if p.is_file()]


def new_state(parsed: list[ParsedSource]) -> dict:
    core = build_demo_state(parsed) or generic_state(parsed)
    state = {
        "id": uuid.uuid4().hex[:12],
        "created_at": time.time(),
        "llm_mode": "fake",
        "retrieval_mode": "curated_demo",
        "fact_set_version": 1,
        "sources": [{"filename": p.filename, "kind": p.kind, "status": p.status, "size": p.size_label if p.status == "parsed" else "", "note": p.note} for p in parsed],
        **core,
    }
    for a in state["assets"]:
        a.update(version=1, reviewed_version=1, reviewed_fact_set=1)
    for iss in state["issues"]:
        assert iss["fix_kind"] in engine.AUTO_FIX_KINDS, "流水线只能产出四类保守修订"
        iss.setdefault("keep_reason", None)
    return state


def workspace(state: dict) -> dict:
    """前端渲染所需的一切，正文已经渲染成片段。"""
    assets = []
    for a in state["assets"]:
        items = []
        for it in a["items"]:
            if engine.item_hidden(state, it):
                continue
            items.append({"id": it["id"], "kind": it["kind"], "label": it.get("label"), "note": it.get("note"),
                          "facts": it.get("facts", []), "insights": it.get("insights", []),
                          "user_edited": bool(it.get("user_edited")), "parts": engine.render_item(state, it)})
        stale = a.get("reviewed_version", 1) != a.get("version", 1)
        assets.append({"id": a["id"], "title": a["title"], "items": items, "need": engine.section_need(state, a["id"]), "stale": stale})
    return {
        "id": state["id"], "name": state["name"], "is_demo": state["is_demo"],
        "llm_mode": state["llm_mode"], "retrieval_mode": state["retrieval_mode"],
        "settings": state["settings"], "settings_options": SETTINGS_OPTIONS,
        "sources": state["sources"], "facts": state["facts"], "decisions": state["decisions"],
        "insights": state["insights"], "brief": state["brief"], "assets": assets,
        "issues": [i for i in state["issues"] if i["status"] != "superseded"],
        "blocked": state["blocked"], "gaps": state["gaps"], "run": state["run"],
        "summary": engine.summary(state),
    }


def register_workbench(app: FastAPI, deps: Any) -> None:
    store = WorkbenchStore(deps.settings.db_path)
    rules = engine.load_rules(deps.settings.fixtures_dir)
    delay = max(0, deps.settings.fake_step_delay_ms) / 1000
    app.state.workbench_store = store

    def mutate(pid: str, action_type: str, fn: Callable[[dict], str], recheck: Optional[list[str]] = None):
        state = store.get(pid)
        if state is None:
            return _err(404, "找不到这个项目")
        before = copy.deepcopy(state)
        try:
            toast = fn(state)
        except WorkbenchError as exc:
            return _err(exc.status, str(exc))
        targets = recheck if recheck is not None else [a["id"] for a in state["assets"] if a.get("reviewed_version") != a.get("version")]
        for aid in targets:
            engine.recheck(state, aid, rules)
        if state == before:
            return {"workspace": workspace(state), "toast": toast, "undoable": False}
        store.commit(pid, before, state, action_type, toast)
        return {"workspace": workspace(state), "toast": toast, "undoable": True}

    @app.post("/api/projects")
    def create_project(body: CreateProject):
        if body.demo:
            parsed = _demo_sources(deps.settings.fixtures_dir)
        else:
            parsed = []
            for f in body.files:
                try:
                    data = base64.b64decode(f.content_b64, validate=True)
                except (binascii.Error, ValueError):
                    return _err(400, f"{f.name} 上传不完整，请重新选择文件")
                parsed.append(parse_source(f.name, data))
            if body.text and body.text.strip():
                parsed.append(parse_pasted(body.text))
            if not parsed:
                return _err(400, "请先放进至少一份资料，或粘贴一段文字")
            if not any(p.status == "parsed" for p in parsed):
                return _err(422, "这些资料都读不出文字：" + "；".join(f"{p.filename}：{p.note}" for p in parsed))
        state = new_state(parsed)
        store.create(state["id"], state)
        return {"id": state["id"], "run": state["run"]}

    @app.get("/api/projects")
    def list_projects():
        out = []
        for s in store.list():
            summ = engine.summary(s)
            out.append({"id": s["id"], "name": s["name"], "is_demo": s["is_demo"], "channel": s["settings"]["channel"],
                        "open": len(summ["open_decisions"]), "updated_at": s["_updated_at"]})
        return {"projects": out}

    @app.get("/api/projects/{pid}/workspace")
    def get_workspace(pid: str):
        state = store.get(pid)
        return _err(404, "找不到这个项目") if state is None else workspace(state)

    @app.get("/api/projects/{pid}/run/events")
    async def run_events(pid: str):
        state = store.get(pid)
        if state is None:
            return _err(404, "找不到这个项目")
        steps = state["run"]["steps"]

        async def gen():
            for i, (title, result) in enumerate(steps):
                yield f"event: step\ndata: {json.dumps({'index': i, 'title': title, 'status': 'running'}, ensure_ascii=False)}\n\n"
                await asyncio.sleep(delay)
                yield f"event: step\ndata: {json.dumps({'index': i, 'title': title, 'status': 'done', 'result': result}, ensure_ascii=False)}\n\n"
            yield f"event: done\ndata: {json.dumps({'open': len(engine.open_decisions(state))})}\n\n"
        return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})

    @app.post("/api/projects/{pid}/decisions/{did}")
    def post_decision(pid: str, did: str, body: DecisionBody):
        return mutate(pid, "decision", lambda s: engine.decide(s, did, body.value, body.custom, body.reason))

    @app.patch("/api/projects/{pid}/facts/{fid}")
    def patch_fact(pid: str, fid: str, body: FactBody):
        def fn(s):
            msg = engine.edit_fact(s, fid, body.text)
            for a in s["assets"]:
                if any(fid in (it.get("facts") or []) for it in a["items"]):
                    a["version"] = a.get("version", 1) + 1
            return msg
        return mutate(pid, "fact.edit", fn)

    @app.patch("/api/projects/{pid}/insights/{iid}")
    def patch_insight(pid: str, iid: str, body: InsightBody):
        return mutate(pid, "insight.toggle", lambda s: engine.set_insight(s, iid, body.enabled))

    @app.patch("/api/projects/{pid}/content/{aid}")
    def patch_content(pid: str, aid: str, body: ContentBody):
        return mutate(pid, "asset.edit", lambda s: engine.edit_items(s, aid, body.items, rules)[0], recheck=[])

    @app.post("/api/projects/{pid}/content/{aid}/regenerate")
    def post_regenerate(pid: str, aid: str):
        return mutate(pid, "asset.regenerate", lambda s: engine.regenerate(s, aid))

    @app.patch("/api/projects/{pid}/settings")
    def patch_settings(pid: str, body: SettingBody):
        return mutate(pid, "settings.change", lambda s: engine.set_setting(s, body.key, body.value, SETTINGS_OPTIONS))

    @app.post("/api/projects/{pid}/issues/{iid}/undo-fix")
    def post_undo_fix(pid: str, iid: str, body: UndoFixBody):
        return mutate(pid, "fix.undo", lambda s: engine.undo_fix(s, iid, body.reason))

    @app.post("/api/projects/{pid}/issues/{iid}/reapply")
    def post_reapply(pid: str, iid: str):
        return mutate(pid, "fix.reapply", lambda s: engine.reapply_fix(s, iid))

    @app.post("/api/projects/{pid}/actions/undo")
    def post_undo(pid: str):
        try:
            res = store.undo_last(pid)
        except RuntimeError as exc:
            return _err(409, str(exc))
        if res is None:
            return _err(409, "没有可以撤销的操作")
        state, label = res
        return {"workspace": workspace(state), "toast": "已撤销：" + label, "undoable": False}

    @app.get("/api/projects/{pid}/actions")
    def get_actions(pid: str):
        return {"actions": store.actions(pid)}

    @app.get("/api/projects/{pid}/export")
    def get_export(pid: str):
        state = store.get(pid)
        if state is None:
            return _err(404, "找不到这个项目")
        return {"markdown": engine.export_markdown(state), "report": engine.export_report(state),
                "glossary": engine.export_glossary(state), "draft": engine.DRAFT if state["is_demo"] else None,
                "open": engine.open_decisions(state), "is_demo": state["is_demo"]}

    @app.get("/api/projects/{pid}/trace")
    def get_trace(pid: str):
        state = store.get(pid)
        if state is None:
            return _err(404, "找不到这个项目")
        mode = "开发占位 · 非真实运行"
        return {"steps": [
            {"step": "读资料、找事实", "llm_mode": mode, "data": f"你的 {sum(1 for s in state['sources'] if s['status'] == 'parsed')} 份资料", "quota": 0},
            {"step": "查知乎行业说法", "llm_mode": mode, "data": "示例数据（未实时检索）" if state["insights"] else "未检索", "quota": 0},
            {"step": "写英文页", "llm_mode": mode, "data": f"你的资料 + {len(state['insights'])} 条知乎建议", "quota": 0},
            {"step": "逐句检查", "llm_mode": "规则匹配", "data": "英文页全部 5 段", "quota": 0},
        ], "actions": store.actions(pid, 20)}
