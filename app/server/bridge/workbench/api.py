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
from .demo import (
    ALL_STAGES,
    DEMO_DIR_NAME,
    SETTINGS_OPTIONS,
    _extract_demo_facts,
    advance_demo_stage,
    build_demo_state,
    build_staged_demo_state,
    generic_state,
    prune_missing_fact_items,
)
from .live import LiveError, build_live_state
from .engine import WorkbenchError
from .sources import ParsedSource, parse_pasted, parse_source
from .store import WorkbenchStore

MAX_TOTAL_UPLOAD_BYTES = 20 * 1024 * 1024  # 单次请求总上传上限 20 MiB


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class UploadFile(_Strict):
    name: str = Field(min_length=1, max_length=200)
    content_b64: str = Field(max_length=14_000_000)


class CreateProject(_Strict):
    demo: bool = False
    staged: Optional[bool] = None
    files: list[UploadFile] = Field(default_factory=list, max_length=10)
    text: Optional[str] = Field(default=None, max_length=20000)


class AddSourcesBody(_Strict):
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


def _source_summary(p: ParsedSource) -> dict:
    return {
        "filename": p.filename,
        "kind": p.kind,
        "status": p.status,
        "size": p.size_label if p.status == "parsed" else "",
        "note": p.note,
        "preview": p.text[:4000] if p.status == "parsed" else "",
    }


async def _decode_and_parse(files: list[UploadFile], text: Optional[str]) -> tuple[list[ParsedSource], Optional[JSONResponse]]:
    total_bytes = 0
    raw_items: list[tuple[str, bytes]] = []
    for f in files:
        try:
            data = base64.b64decode(f.content_b64, validate=True)
        except (binascii.Error, ValueError):
            return [], _err(400, f"{f.name} 上传不完整，请重新选择文件")
        total_bytes += len(data)
        if total_bytes > MAX_TOTAL_UPLOAD_BYTES:
            return [], _err(413, "单次上传文件总大小超过 20 MB，请分批或精简后再试")
        raw_items.append((f.name, data))

    parsed: list[ParsedSource] = []
    for name, data in raw_items:
        parsed.append(await asyncio.to_thread(parse_source, name, data))
    if text and text.strip():
        parsed.append(parse_pasted(text))
    return parsed, None


def new_state(parsed: list[ParsedSource], core: Optional[dict] = None) -> dict:
    core = core or build_demo_state(parsed) or generic_state(parsed)
    state = {
        "id": uuid.uuid4().hex[:12],
        "created_at": time.time(),
        "llm_mode": "fake",
        "retrieval_mode": "curated_demo",
        "fact_set_version": 1,
        "sources": [_source_summary(p) for p in parsed],
        "_sources_data": [p.to_record() for p in parsed],
        **core,
    }
    state.setdefault("completed_stages", list(ALL_STAGES))
    state.setdefault("pipeline_status", "done")
    state["run"].setdefault("status", "done")
    for a in state["assets"]:
        a.setdefault("version", 1)
        a.setdefault("reviewed_version", 1)
        a.setdefault("reviewed_fact_set", 1)
    for iss in state["issues"]:
        assert iss["fix_kind"] in engine.AUTO_FIX_KINDS, "流水线只能产出四类保守修订"
        iss.setdefault("keep_reason", None)
    return state


def workspace(state: dict) -> dict:
    """前端渲染所需的一切，正文已经渲染成片段。"""
    completed = list(state.get("completed_stages") or ALL_STAGES)
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
    visible_issues = [i for i in state["issues"] if i["status"] not in ("superseded", "pending_review")]
    return {
        "id": state["id"], "name": state["name"], "is_demo": state["is_demo"],
        "llm_mode": state["llm_mode"], "retrieval_mode": state["retrieval_mode"],
        "completed_stages": completed,
        "settings": state["settings"], "settings_options": SETTINGS_OPTIONS,
        "sources": state["sources"], "facts": state["facts"], "decisions": state["decisions"],
        "insights": state["insights"], "brief": state["brief"], "assets": assets,
        "issues": visible_issues,
        "blocked": state["blocked"], "gaps": state["gaps"], "run": state["run"],
        "summary": engine.summary(state),
    }


def register_workbench(app: FastAPI, deps: Any) -> None:
    store = WorkbenchStore(deps.settings.db_path)
    rules = engine.load_rules(deps.settings.fixtures_dir)
    zh_claims = engine.load_zh_claims(deps.settings.fixtures_dir)
    delay = max(0, deps.settings.fake_step_delay_ms) / 1000
    app.state.workbench_store = store
    tasks: set[asyncio.Task] = set()

    def live_available() -> bool:
        return deps.generation_mode == "live" and hasattr(deps.llm, "task_json")

    async def run_live(pid: str, parsed: list[ParsedSource]) -> None:
        async def progress(title: str, result: str):
            s = store.get(pid)
            s["run"]["steps"].append([title, result])
            store.put(pid, s)

        async def llm_json(system: str, user: str, max_tokens: int) -> dict:
            return await deps.call_llm(deps.llm.task_json, system, user, max_tokens)

        try:
            core = await build_live_state(parsed, llm_json, deps.zhihu if deps.zhihu.enabled else None, rules, progress, zh_claims)
            done = new_state(parsed, {**core, "run": {"steps": store.get(pid)["run"]["steps"], "status": "done"}})
            done.update(id=pid, created_at=store.get(pid)["created_at"])
        except Exception as exc:  # noqa: BLE001 - 失败时如实降级，不留半成品
            steps = store.get(pid)["run"]["steps"]
            reason = str(exc) if isinstance(exc, LiveError) else exc.__class__.__name__
            done = new_state(parsed)
            done.update(id=pid, created_at=store.get(pid)["created_at"])
            done["run"] = {"steps": steps + [["改用开发占位", f"模型或检索没有成功（{reason}），已改用启发式结果，界面标注开发占位"]], "status": "done"}
        store.put(pid, done)

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
    async def create_project(body: CreateProject):
        if body.demo:
            parsed = await asyncio.to_thread(_demo_sources, deps.settings.fixtures_dir)
            use_staged = True if body.staged is None else body.staged
            if use_staged:
                state = new_state(parsed, build_staged_demo_state(parsed))
                store.create(state["id"], state)
                return {"id": state["id"], "staged": True, "run": state["run"]}
        else:
            parsed, err = await _decode_and_parse(body.files, body.text)
            if err is not None:
                return err
            if not parsed:
                return _err(400, "请先放进至少一份资料，或粘贴一段文字")
            if not any(p.status == "parsed" for p in parsed):
                return _err(422, "这些资料都读不出文字：" + "；".join(f"{p.filename}：{p.note}" for p in parsed))
        if not body.demo and live_available():
            pid = uuid.uuid4().hex[:12]
            placeholder = {"id": pid, "name": "正在分析的项目", "is_demo": False, "created_at": time.time(), "pipeline_status": "running",
                           "run": {"steps": [], "status": "running"}, "settings": {"channel": "ks"}, "decisions": [], "issues": []}
            store.create(pid, placeholder)
            task = asyncio.create_task(run_live(pid, parsed))
            tasks.add(task)
            task.add_done_callback(tasks.discard)
            return {"id": pid, "staged": False, "run": placeholder["run"]}
        state = new_state(parsed)
        store.create(state["id"], state)
        return {"id": state["id"], "staged": False, "run": state["run"]}

    @app.post("/api/projects/{pid}/steps/{stage}")
    async def run_stage(pid: str, stage: Literal["facts", "insights", "content", "review"]):
        state = store.get(pid)
        if state is None:
            return _err(404, "找不到这个项目")
        if state.get("pipeline_status") == "running":
            return _err(409, "流水线正在运行中，请稍候")
        before = copy.deepcopy(state)
        raw_records = state.get("_sources_data")
        parsed = [ParsedSource.from_record(r) for r in raw_records] if raw_records else await asyncio.to_thread(_demo_sources, deps.settings.fixtures_dir)
        try:
            toast = advance_demo_stage(state, stage, parsed, rules)
        except WorkbenchError as exc:
            return _err(exc.status, str(exc))
        if state == before:
            return {"workspace": workspace(state), "toast": toast, "undoable": False}
        store.commit(pid, before, state, f"stage.{stage}", toast)
        return {"workspace": workspace(state), "toast": toast, "undoable": True}

    @app.post("/api/projects/{pid}/sources")
    async def add_sources(pid: str, body: AddSourcesBody):
        state = store.get(pid)
        if state is None:
            return _err(404, "找不到这个项目")
        if state.get("pipeline_status") == "running":
            return _err(409, "项目正在分析中，请等待完成后再补充资料")
        if not state.get("is_demo"):
            return _err(400, "当前自定义项目已完成分析，如需分析新资料请从首页创建新项目")

        added, err = await _decode_and_parse(body.files, body.text)
        if err is not None:
            return err
        if not added:
            return _err(400, "请先选择文件或粘贴文字")

        before = copy.deepcopy(state)
        existing_records = list(state.get("_sources_data") or [])
        if not existing_records:
            existing_records = [p.to_record() for p in await asyncio.to_thread(_demo_sources, deps.settings.fixtures_dir)]
        by_name = {r["filename"]: r for r in existing_records}

        # 拒绝用解析失败/不可读的文件覆写已解析的同名资料，避免静默抹掉已有依据
        for p in added:
            prev = by_name.get(p.filename)
            if prev and prev.get("status") == "parsed" and p.status != "parsed":
                return _err(422, f"{p.filename} 无法读取文字（{p.note}），已保留原有同名资料")

        for p in added:
            if p.filename in by_name:
                existing_records = [r for r in existing_records if r["filename"] != p.filename]
            rec = p.to_record()
            existing_records.append(rec)
            by_name[p.filename] = rec

        parsed_all = [ParsedSource.from_record(r) for r in existing_records]
        state["_sources_data"] = existing_records
        state["sources"] = [_source_summary(p) for p in parsed_all]

        completed = list(state.get("completed_stages") or ALL_STAGES)
        ok_added = sum(1 for p in added if p.status == "parsed")
        if "facts" in completed:
            prev_decisions = {d["id"]: d for d in state["decisions"]}
            # 按证据身份 (file, quote) 匹配历史人工确认/改写，避免按位置编号误移
            prev_facts_by_key = {(f["source"]["file"], f["source"]["quote"]): f for f in state["facts"]}

            facts, decisions, blocked, gaps = _extract_demo_facts(parsed_all)
            state["facts"] = facts
            state["decisions"] = decisions
            state["blocked"] = blocked
            state["gaps"] = gaps

            for f in state["facts"]:
                pf = prev_facts_by_key.get((f["source"]["file"], f["source"]["quote"]))
                if pf and pf.get("user_decision") != "pending":
                    f["user_decision"] = pf["user_decision"]
                    f["decided_via"] = pf["decided_via"]
                    f["user_text"] = pf["user_text"]

            facts_by_id = {f["id"]: f for f in state["facts"]}
            for d in state["decisions"]:
                pd = prev_decisions.get(d["id"])
                if not pd or pd.get("value") is None:
                    continue
                if d["kind"] == "confirm_facts":
                    # 只有当所有支持的事实都已确认/编辑时才保持 confirmed；新增或变更事实重新打开待确认
                    if all(facts_by_id.get(fid, {}).get("user_decision") in ("confirmed", "edited") for fid in d["fact_ids"]):
                        d["value"] = pd["value"]
                else:
                    d["value"] = pd["value"]
                    if "custom" in pd:
                        d["custom"] = pd["custom"]

            # 同步清理依赖已失效事实的英文模块条目
            if state["assets"]:
                prune_missing_fact_items(state)
                state["fact_set_version"] = state.get("fact_set_version", 1) + 1

        toast = f"已添加 {len(added)} 份资料（{ok_added} 份成功解析文字）"
        store.commit(pid, before, state, "sources.add", toast)
        return {"workspace": workspace(state), "toast": toast, "undoable": True}

    @app.get("/api/projects")
    def list_projects():
        out = []
        for s in store.list():
            if s.get("pipeline_status") == "running":
                continue
            completed = list(s.get("completed_stages") or ALL_STAGES)
            summ = engine.summary(s)
            out.append({"id": s["id"], "name": s["name"], "is_demo": s["is_demo"], "channel": s["settings"]["channel"],
                        "open": len(summ["open_decisions"]), "staged": "review" not in completed,
                        "completed_stages": completed, "updated_at": s["_updated_at"]})
        return {"projects": out}

    @app.get("/api/projects/{pid}/workspace")
    def get_workspace(pid: str):
        state = store.get(pid)
        if state is None:
            return _err(404, "找不到这个项目")
        if state.get("pipeline_status") == "running":
            return _err(409, "还在写，请稍候")
        return workspace(state)

    @app.get("/api/projects/{pid}/run/events")
    async def run_events(pid: str):
        state = store.get(pid)
        if state is None:
            return _err(404, "找不到这个项目")
        def ev(i: int, title: str, status: str, result: str = "") -> str:
            payload = json.dumps({"index": i, "title": title, "status": status, "result": result}, ensure_ascii=False)
            return f"event: step\ndata: {payload}\n\n"

        def done_ev(s: dict) -> str:
            return f"event: done\ndata: {json.dumps({'open': len(engine.open_decisions(s))})}\n\n"

        async def gen():
            if state.get("pipeline_status") != "running":  # 已完成（示例项目）：按节奏回放每一步
                for i, (title, result) in enumerate(state["run"]["steps"]):
                    yield ev(i, title, "running")
                    await asyncio.sleep(delay)
                    yield ev(i, title, "done", result)
                yield done_ev(state)
                return
            sent, started = 0, time.monotonic()
            yield ev(0, "读取资料", "running")
            while time.monotonic() - started < 300:  # 真实流水线：轮询存储里的进度
                cur = store.get(pid) or {}
                steps = cur.get("run", {}).get("steps", [])
                while sent < len(steps):
                    yield ev(sent, steps[sent][0], "done", steps[sent][1])
                    sent += 1
                    if cur.get("pipeline_status") == "running":
                        yield ev(sent, "", "running")
                if cur.get("pipeline_status") != "running":
                    yield done_ev(cur)
                    return
                yield ": keepalive\n\n"
                await asyncio.sleep(0.5)
            yield "event: failed\ndata: {}\n\n"
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
        completed = set(state.get("completed_stages") or ALL_STAGES)
        reviewed = "review" in completed
        summ = engine.summary(state)
        return {"markdown": engine.export_markdown(state), "report": engine.export_report(state),
                "glossary": engine.export_glossary(state), "draft": engine.DRAFT if state["is_demo"] else None,
                "open": summ["open_decisions"], "reviewed": reviewed, "ready": summ["ready"], "is_demo": state["is_demo"]}

    @app.get("/api/projects/{pid}/trace")
    def get_trace(pid: str):
        state = store.get(pid)
        if state is None:
            return _err(404, "找不到这个项目")
        completed = set(state.get("completed_stages") or ALL_STAGES)
        mode = "实时运行" if state.get("llm_mode") == "live" else "开发占位 · 非真实运行"
        return {"steps": [
            {"step": "读资料、找事实", "llm_mode": mode if "facts" in completed else "待执行", "data": f"你的 {sum(1 for s in state['sources'] if s['status'] == 'parsed')} 份资料", "quota": 0},
            {"step": "查知乎行业说法", "llm_mode": mode if "insights" in completed else "待执行", "data": "示例数据（未实时检索）" if state["insights"] else "尚未运行", "quota": 0},
            {"step": "写英文页", "llm_mode": mode if "content" in completed else "待执行", "data": f"你的资料 + {len(state['insights'])} 条知乎建议" if "content" in completed else "尚未运行", "quota": 0},
            {"step": "逐句检查", "llm_mode": "规则匹配" if "review" in completed else "待执行", "data": f"英文页全部 {len(state['assets'])} 段" if "review" in completed else "尚未运行", "quota": 0},
        ], "actions": store.actions(pid, 20)}
