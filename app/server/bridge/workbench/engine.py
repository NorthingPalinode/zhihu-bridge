"""工作台状态引擎：纯函数地读写项目状态（dict），不碰 IO。

数据规则（PLAN_V1.4 §5.4）在这里落地：
- 用户决定只能通过 decide()/edit_fact() 写入；引擎里没有任何“按推荐自动选定”的路径；
- 自动修订只来自流水线的 auto_applied 问题，且 fix_kind 必须是四类保守修订之一；
- 撤销 severity=high 的修订必须带理由；
- 正文编辑后立即复查这一段，新出现的风险说法进入“需要你决定”。
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Optional

AUTO_FIX_KINDS = {"remove_claim", "soften_claim", "terminology", "unit_boundary"}
KEEP_REASONS = {"has_data_later": "已有实测数据，稍后补上", "owner_approved": "负责人确认保留", "will_revise": "上线前会再改"}
ASSET_NAMES = {"headline": "标题与宣传语", "features": "核心卖点", "story": "详细介绍", "specs": "技术参数", "faq": "FAQ"}


class WorkbenchError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def load_rules(fixtures_dir: Path) -> list[dict]:
    path = fixtures_dir / "workbench" / "claim_rules.json"
    return json.loads(path.read_text(encoding="utf-8"))["rules"]


def load_zh_claims(fixtures_dir: Path) -> list[dict]:
    path = fixtures_dir / "workbench" / "claim_rules.json"
    return json.loads(path.read_text(encoding="utf-8")).get("zh_claims", [])


# ---------------------------------------------------------------- lookups
def _find(items: list[dict], key: str, value: Any) -> Optional[dict]:
    return next((x for x in items if x.get(key) == value), None)


def decision(state: dict, did: str) -> Optional[dict]:
    return _find(state["decisions"], "id", did)


def issue(state: dict, iid: str) -> Optional[dict]:
    return _find(state["issues"], "id", iid)


def asset(state: dict, aid: str) -> dict:
    a = _find(state["assets"], "id", aid)
    if a is None:
        raise WorkbenchError("找不到这一段内容", 404)
    return a


def insight_on(state: dict, iid: str) -> bool:
    i = _find(state["insights"], "id", iid)
    return bool(i and i["enabled"])


# ---------------------------------------------------------------- rendering
def _slot_text(state: dict, seg: dict) -> Optional[str]:
    d = decision(state, seg["slot"])
    if d is None or d["value"] is None:
        return None
    if d["kind"] == "conflict":
        if d["value"] == "custom":
            v = d["custom"]
        else:
            v = next(o["render"] for o in d["options"] if o["value"] == d["value"])
        return seg["fmt"].format(v=v)
    return seg.get("map", {}).get(d["value"], "")


def render_item(state: dict, item: dict) -> list[dict]:
    """把条目渲染成前端可直接显示的片段：text / fix / kept / ph / risk。"""
    if item.get("text") is not None:
        return _risk_parts(state, item, item["text"])
    parts: list[dict] = []
    for seg in item["segs"]:
        if "t" in seg:
            parts.append({"type": "text", "text": seg["t"]})
        elif "set" in seg:
            parts.append({"type": "text", "text": seg["v"][state["settings"][seg["set"]]]})
        elif "ins" in seg:
            parts.append({"type": "text", "text": seg["on"] if insight_on(state, seg["ins"]) else seg["off"]})
        elif "slot" in seg:
            text = _slot_text(state, seg)
            parts.append({"type": "ph", "decision": seg["slot"], "text": seg["ph"]} if text is None else {"type": "text", "text": text})
        elif "fix" in seg:
            iss = issue(state, seg["fix"])
            if iss is None:
                continue
            if iss["status"] == "pending_review":
                parts.append({"type": "text", "text": iss["original"]})
            elif iss["status"] == "kept":
                parts.append({"type": "kept", "issue": iss["id"], "text": iss["original"]})
            else:
                text = iss["applied"]
                for ins_id, alt in seg.get("alt", {}).items():
                    if not insight_on(state, ins_id):
                        text = alt
                parts.append({"type": "fix", "issue": iss["id"], "text": text})
    return parts


def _risk_parts(state: dict, item: dict, text: str) -> list[dict]:
    marks = []
    for iss in state["issues"]:
        if iss["fix_kind"] != "user_introduced" or iss["item"] != item["id"] or iss["status"] not in ("open", "kept"):
            continue
        pos = text.lower().find(iss["term"].lower())
        if pos >= 0:
            marks.append((pos, pos + len(iss["term"]), iss))
    marks.sort(key=lambda m: m[0])
    parts, cur = [], 0
    for start, end, iss in marks:
        if start < cur:
            continue
        if start > cur:
            parts.append({"type": "text", "text": text[cur:start]})
        parts.append({"type": "risk" if iss["status"] == "open" else "kept", "issue": iss["id"], "text": text[start:end]})
        cur = end
    if cur < len(text):
        parts.append({"type": "text", "text": text[cur:]})
    return parts


def item_hidden(state: dict, item: dict) -> bool:
    cond = item.get("hide_if")
    if not cond:
        return False
    d = decision(state, cond[0])
    return bool(d and d["value"] == cond[1])


def plain(parts: list[dict], placeholder: str = "[待确认]") -> str:
    return "".join(placeholder if p["type"] == "ph" else p["text"] for p in parts)


# ---------------------------------------------------------------- derived summary
def open_decisions(state: dict) -> list[str]:
    out = [d["id"] for d in state["decisions"] if d["value"] is None]
    out += [f"x:{i['id']}" for i in state["issues"] if i["fix_kind"] == "user_introduced" and i["status"] == "open"]
    return out


def section_need(state: dict, aid: str) -> int:
    a = asset(state, aid)
    n = 0
    for item in a["items"]:
        if item_hidden(state, item):
            continue
        n += sum(1 for p in render_item(state, item) if p["type"] in ("ph", "risk"))
    return n


def summary(state: dict) -> dict:
    completed = set(state.get("completed_stages") or ("materials", "facts", "insights", "content", "review"))
    od = open_decisions(state)
    facts_need = sum(1 for d in state["decisions"] if d["value"] is None)
    auto = [i for i in state["issues"] if i["status"] == "auto_applied" or (i["fix_kind"] == "user_introduced" and i["status"] == "resolved")]
    kept = [i for i in state["issues"] if i["status"] == "kept"]
    return {
        "open_decisions": od,
        "facts_total": len(state["facts"]),
        "facts_need": facts_need,
        "insights_total": len(state["insights"]),
        "insights_on": sum(1 for i in state["insights"] if i["enabled"]),
        "sections_need": [a["id"] for a in state["assets"] if section_need(state, a["id"])],
        "auto_fixed": len(auto),
        "kept": len(kept),
        "blocked": len(state["blocked"]),
        "ready": ("review" in completed) and not od,
    }


# ---------------------------------------------------------------- decisions
def decide(state: dict, did: str, value: Optional[str], custom: Optional[str] = None, reason: Optional[str] = None) -> str:
    """写入一个用户决定，返回给用户看的一句话。value=None 表示撤回这个决定。"""
    if did.startswith("x:"):
        return _decide_extra(state, did[2:], value, reason)
    d = decision(state, did)
    if d is None:
        raise WorkbenchError("找不到这件待决定的事", 404)
    facts = {f["id"]: f for f in state["facts"]}
    if value is None:
        d["value"] = None
        d.pop("custom", None) if d["kind"] != "conflict" else d.update(custom=None)
        for fid in _decision_fact_ids(d):
            if facts[fid]["user_decision"] != "edited":
                facts[fid].update(user_decision="pending", decided_via=None)
        state["fact_set_version"] += 1
        return "已撤销确认" if d["kind"] == "confirm_facts" else f"{d.get('subject', '这件事')}改回“等你决定”"
    if d["kind"] == "confirm_facts":
        if value != "confirmed":
            raise WorkbenchError("这个决定只能是“都对，确认”")
        for fid in d["fact_ids"]:
            if facts[fid]["user_decision"] == "pending":
                facts[fid].update(user_decision="confirmed", decided_via="batch")
        d["value"] = "confirmed"
        state["fact_set_version"] += 1
        return f"已确认 {len(d['fact_ids'])} 条产品事实"
    if d["kind"] == "conflict":
        values = {o["value"]: o for o in d["options"]}
        if value == "custom":
            custom = (custom or "").strip()
            if not custom:
                raise WorkbenchError("先填一个数值")
            if len(custom) > 40:
                raise WorkbenchError("数值太长了，请简短一些")
            d["custom"] = custom
        elif value not in values:
            raise WorkbenchError("没有这个选项")
        d["value"] = value
        for o in d["options"]:
            facts[o["fact"]].update(user_decision="confirmed" if o["value"] == value else "rejected", decided_via="inline")
        state["fact_set_version"] += 1
        shown = custom if value == "custom" else values[value]["render"]
        return f"{d.get('subject', '数值')}写成 {shown}，用到它的段落都已更新"
    if d["kind"] == "roadmap_wording":
        if value not in {o["value"] for o in d["options"]}:
            raise WorkbenchError("没有这个选项")
        d["value"] = value
        for fid in _decision_fact_ids(d):
            facts[fid].update(user_decision="confirmed" if value == "mention" else "rejected", decided_via="inline")
        state["fact_set_version"] += 1
        subj = d.get("subject", "这个功能")
        return f"已照实写“{subj}”的上市状态和计划" if value == "mention" else f"已去掉“{subj}”相关的卖点和 FAQ"
    raise WorkbenchError("未知的决定类型")


def _decision_fact_ids(d: dict) -> list[str]:
    if d["kind"] == "confirm_facts":
        return d["fact_ids"]
    return [o["fact"] for o in d["options"] if o.get("fact")]


def _decide_extra(state: dict, iid: str, value: Optional[str], reason: Optional[str]) -> str:
    iss = issue(state, iid)
    if iss is None or iss["fix_kind"] != "user_introduced":
        raise WorkbenchError("找不到这处风险说法", 404)
    item = _find(asset(state, iss["asset"])["items"], "id", iss["item"])
    if value == "fix":
        if item.get("text") is not None:
            item["text"] = re.sub(re.escape(iss["term"]), iss["suggestion"], item["text"], count=1, flags=re.I)
        iss["status"] = "resolved"
        _bump(state, iss["asset"])
        return f"已换成 “{iss['suggestion']}”"
    if value == "keep":
        if reason not in KEEP_REASONS:
            raise WorkbenchError("请先选一个保留的理由")
        iss.update(status="kept", keep_reason=KEEP_REASONS[reason])
        return "已保留，理由会写进检查报告"
    raise WorkbenchError("只能“换成推荐说法”或“仍然保留”")


# ---------------------------------------------------------------- fixes
def undo_fix(state: dict, iid: str, reason: Optional[str]) -> str:
    iss = issue(state, iid)
    if iss is None or iss["fix_kind"] not in AUTO_FIX_KINDS:
        raise WorkbenchError("这处不是系统修订", 404)
    if iss["status"] != "auto_applied":
        raise WorkbenchError("这处已经是原句了")
    if iss["severity"] == "high":
        if reason not in KEEP_REASONS:
            raise WorkbenchError("原句没有依据，恢复前请先选一个理由", 422)
        why = KEEP_REASONS[reason]
    else:
        why = KEEP_REASONS.get(reason or "", "你撤销了系统修改")
    iss.update(status="kept", keep_reason=why)
    _bump(state, iss["asset"])
    return "已恢复原句。它仍有风险，检查报告里会写明"


def reapply_fix(state: dict, iid: str) -> str:
    iss = issue(state, iid)
    if iss is None or iss["fix_kind"] not in AUTO_FIX_KINDS:
        raise WorkbenchError("这处不是系统修订", 404)
    iss.update(status="auto_applied", keep_reason=None)
    _bump(state, iss["asset"])
    return "已按系统建议改回"


# ---------------------------------------------------------------- edits & recheck
def _bump(state: dict, aid: str) -> None:
    a = asset(state, aid)
    a["version"] = a.get("version", 1) + 1


def edit_items(state: dict, aid: str, texts: dict[str, str], rules: list[dict]) -> tuple[str, int]:
    """保存用户对一段的修改，并立即复查这一段。返回（提示语，新风险数）。"""
    a = asset(state, aid)
    changed = 0
    for iid, new_text in texts.items():
        item = _find(a["items"], "id", iid)
        if item is None:
            raise WorkbenchError("找不到要修改的句子", 404)
        if any(p["type"] == "ph" for p in render_item(state, item)):
            raise WorkbenchError("这句还在等你决定，决定后才能编辑")
        new_text = re.sub(r"\s+", " ", new_text or "").strip()
        if not new_text:
            raise WorkbenchError("不能把一句话改成空的；不需要的话可以改写成别的说法")
        if len(new_text) > 1200:
            raise WorkbenchError("这一句太长了")
        if new_text == plain(render_item(state, item)):
            continue
        item["text"] = new_text
        item["user_edited"] = True
        changed += 1
    if not changed:
        return "没有改动", 0
    _bump(state, aid)
    found = recheck(state, aid, rules)
    name = ASSET_NAMES.get(aid, a["title"])
    return (f"「{name}」已保存。检查完：发现 {found} 处新的风险说法，已标红，等你决定" if found
            else f"「{name}」已保存，检查完没有新问题"), found


def recheck(state: dict, aid: str, rules: list[dict]) -> int:
    """对用户改写过的句子跑规则检查。已有问题若原文里已不存在则作废。"""
    a = asset(state, aid)
    found = 0
    seq = max([int(i["id"][1:]) for i in state["issues"] if i["id"].startswith("X")] or [0])
    for item in a["items"]:
        text = item.get("text")
        tracked = [i for i in state["issues"] if i["fix_kind"] == "user_introduced" and i["item"] == item["id"] and i["status"] in ("open", "kept")]
        for iss in tracked:
            if text is None or iss["term"].lower() not in text.lower():
                iss["status"] = "superseded"
        if text is None:
            continue
        for rule in rules:
            m = re.search(rule["pattern"], text, flags=re.I)
            if not m:
                continue
            term = m.group(0)
            if any(i["term"].lower() == term.lower() for i in tracked if i["status"] in ("open", "kept")):
                continue
            seq += 1
            state["issues"].append({"id": f"X{seq}", "asset": aid, "item": item["id"], "type": "claim", "severity": "high",
                                    "fix_kind": "user_introduced", "status": "open", "term": term,
                                    "suggestion": rule["suggestion"], "why": rule["why"], "title": f"你写的 “{term}”",
                                    "loc": ASSET_NAMES.get(aid, aid)})
            found += 1
    a["reviewed_version"] = a.get("version", 1)
    a["reviewed_fact_set"] = state["fact_set_version"]
    return found


def edit_fact(state: dict, fid: str, text: str) -> str:
    f = _find(state["facts"], "id", fid)
    if f is None:
        raise WorkbenchError("找不到这条事实", 404)
    text = (text or "").strip()
    if not text:
        raise WorkbenchError("事实不能为空")
    if f["evidence_status"] != "supported":
        raise WorkbenchError("冲突或待定的事实请在“需要你决定”里处理")
    f.update(user_text=text, user_decision="edited", decided_via="single")
    state["fact_set_version"] += 1
    return "已保存你的修改，相关句子会按新说法重新检查"


def set_insight(state: dict, iid: str, enabled: bool) -> str:
    i = _find(state["insights"], "id", iid)
    if i is None:
        raise WorkbenchError("找不到这条知乎建议", 404)
    i["enabled"] = bool(enabled)
    for a in state["assets"]:
        if any(iid in (item.get("insights") or []) for item in a["items"]):
            _bump(state, a["id"])
    return f"已重新用上“{i['concept']}”的建议" if enabled else f"已关掉“{i['concept']}”的建议，相关句子改回普通写法"


def set_setting(state: dict, key: str, value: str, options: dict) -> str:
    if key not in options or value not in {o[0] for o in options[key]}:
        raise WorkbenchError("没有这个选项")
    state["settings"][key] = value
    state["settings"]["source"][key] = "user"
    label = next(o[1] for o in options[key] if o[0] == value)
    if not state["assets"]:
        return f"已设为「{label}」，生成海外内容时将按此口径撰写"
    if key == "channel":
        for a in state["assets"]:
            _bump(state, a["id"])
        return f"已按“{label}”调整全文（示例数据里文字不变）"
    if _find(state["assets"], "id", "headline") is not None:
        _bump(state, "headline")
    return f"已按“{label}”重写标题区"


def regenerate(state: dict, aid: str) -> str:
    a = asset(state, aid)
    kept = sum(1 for item in a["items"] if item.get("user_edited"))
    _bump(state, aid)
    name = ASSET_NAMES.get(aid, a["title"])
    msg = f"「{name}」已重新写好（示例数据里文字不变）"
    return msg + (f"，你改过的 {kept} 处保持不变" if kept else "")


# ---------------------------------------------------------------- export
def export_markdown(state: dict) -> str:
    lines: list[str] = []
    for a in state["assets"]:
        items = [i for i in a["items"] if not item_hidden(state, i)]
        if a["id"] == "headline":
            for it in items:
                text = plain(render_item(state, it))
                lines += [f"# {text}" if it["kind"] == "title" else text, ""]
            continue
        lines.append({"features": "## Key Features", "story": "## The Story", "specs": "## Tech Specs", "faq": "## FAQ"}.get(a["id"], f"## {a['title']}"))
        if a["id"] == "specs":
            lines += ["| Item | Value |", "| --- | --- |"]
        for it in items:
            text = plain(render_item(state, it))
            if it["kind"] == "li":
                lines.append(f"- {text}")
            elif it["kind"] == "row":
                lines.append(f"| {it['label']} | {text} |")
            elif it["kind"] == "qa":
                lines += [f"**{it['label']}**", text, ""]
            else:
                lines += [text, ""]
        if lines[-1] != "":
            lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def export_report(state: dict) -> str:
    completed = set(state.get("completed_stages") or ("materials", "facts", "insights", "content", "review"))
    L = ["# 检查报告（内部）", "", ("示例产品（基于中国智能硬件公开资料改编） · " if state["is_demo"] else "") + "AI 辅助撰写和检查，只覆盖下列检查项，不构成法律意见，也不保证通过平台或监管审核"]
    if "review" not in completed:
        L += ["", "> 【未审校初稿】尚未执行发布前合规审校，当前正文可能仍含未改写的夸大或风险说法，请先完成审校后再正式对外发布。"]
    L += ["", "## 系统修改"]
    for iss in state["issues"]:
        if iss["fix_kind"] in AUTO_FIX_KINDS and iss["status"] in ("auto_applied", "kept"):
            L.append(f"- {'【你保留了原句】' if iss['status'] == 'kept' else '【已修改】'}{iss['title']}" + (f"。理由：{iss['keep_reason']}" if iss["status"] == "kept" else ""))
    for b in state["blocked"]:
        L.append(f"- 【已挡下】{b['title']}：资料里没有证明")
    for iss in state["issues"]:
        if iss["fix_kind"] == "user_introduced" and iss["status"] != "superseded":
            tag = {"resolved": "【已修改】", "kept": "【你保留了】", "open": "【待决定】"}[iss["status"]]
            L.append(f"- {tag}“{iss['term']}”：{iss['why']}" + (f"。理由：{iss['keep_reason']}" if iss["status"] == "kept" else ""))
    L += ["", "## 你的决定"]
    for d in state["decisions"]:
        if d["kind"] == "confirm_facts":
            L.append(f"- 产品事实：{'已确认 ' + str(len(d['fact_ids'])) + ' 条' if d['value'] else '未确认'}")
        elif d["kind"] == "conflict":
            v = None if d["value"] is None else (d["custom"] if d["value"] == "custom" else next(o["render"] for o in d["options"] if o["value"] == d["value"]))
            L.append(f"- {d.get('subject', '冲突数值')}：{v or '未决定（英文页里写成 [待确认]）'}")
        elif d["kind"] == "roadmap_wording":
            L.append(f"- {d.get('subject', '计划功能')}：" + {"mention": "照实写上市状态与计划", "omit": "不提", None: "未决定（英文页里写成 [待确认]）"}[d["value"]])
    edited = [f for f in state["facts"] if f["user_decision"] == "edited"]
    for f in edited:
        L.append(f"- 你改写了事实：{f['user_text']}（原文：{f['text']}）")
    L += ["", "## 已知缺口"] + [f"- {g['title']}：{g['why']}" for g in state["gaps"]]
    for s in state["sources"]:
        if s["status"] != "parsed":
            L.append(f"- {s['filename']}：{s['note']}")
    return "\n".join(L) + "\n"


def export_glossary(state: dict) -> str:
    rows = state["brief"].get("glossary") or []
    if not rows:
        return ""
    return "# 中英口径表\n\n| 中文说法 | 对外英文说法 | 不要说 |\n| --- | --- | --- |\n" + "".join(f"| {a} | {b} | {c} |\n" for a, b, c in rows)


DRAFT = {
    "title": "从工程角度看：智能指环的“高密度主板”和“底层协议调试”，怎么向海外极客讲清楚？",
    "meta": "非硬广 · 约 1,800 字 · 只引用本项目资料和已标注的知乎讨论",
    "outline": ["为什么“堆料”这个词翻不出去：从 6 层 PCB 说起", "“极限压榨功耗”背后是什么，以及为什么我们不写续航数字", "调试接口和开源固件不是一回事", "众筹页上我们主动删掉的三句话"],
    "checks": [["没有续航、认证等无依据说法", "system"], ["没有资料以外的参数", "system"], ["引用的知乎回答已注明作者，并获得转载许可", "user"]],
}
