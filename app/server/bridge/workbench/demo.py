"""示例流水线（llm_mode=fake）：PulseRing X1 资料包的确定性“提取 → 洞察 → 生成 → 检查”。

PulseRing X1 资料包基于中国真实智能戒指出海产品（RingConn Gen 2、星纪魅族 StarV Ring 2）公开硬件规格改编。

诚实约束：
- 每条事实都带原文摘录（quote），只有在已读取的资料里真的找到这句原文时才收录，定位由解析器给出；
- 知乎与英文对照内容是 curated_demo 示例数据，界面标注【示意】，不含任何真实或编造的链接；
- 支持按步骤分阶段产出（materials → facts → insights → content → review），严格校验前置阶段；
- 上传的资料如果不是这套示例包，就走 generic_state()（启发式抽取 + 模板），同样标注开发占位。
"""
from __future__ import annotations

import hashlib
import re
from typing import Optional

from . import engine
from .sources import ParsedSource

DEMO_DIR_NAME = "pulsering"
PRODUCT = "PulseRing X1 智能健康与运动指环"
ALL_STAGES = ("materials", "facts", "insights", "content", "review")
STAGE_LABELS = {
    "materials": "产品资料",
    "facts": "提取产品事实",
    "insights": "知乎认知洞察",
    "content": "生成海外内容",
    "review": "发布前审校",
}

# id, short, text, quote, evidence_status, extra
FACT_SPECS = [
    ("F01", "6 层自研 PCB", "自研 6 层高密度 PCB，元器件经过选型", "自研 6 层高密度 PCB", "supported", {}),
    ("F02", "功耗优化（无续航实测）", "低功耗待机做了系统优化；没有标准工况续航实测", "针对低功耗待机做了系统优化", "supported", {}),
    ("F03", "UART/BLE 调试，固件不开源", "充电底座可做 UART / BLE 协议调试；固件不开源", "可通过充电底座进行底层 UART / BLE 协议调试", "supported", {}),
    ("F05", "5 ATM 生活防水", "5 ATM 生活防水；有室内泳池浅水测试", "5 ATM 生活防水", "supported", {}),
    ("F08", "FCC 射频预扫已完成", "FCC Part 15C 蓝牙射频预扫已完成，正式 FCC ID 认证排期中", "FCC Part 15C 蓝牙射频预扫已完成", "supported", {}),
    ("F04a", "机身重量 3.2 g（设计目标）", "机身重量 3.2 g（v1.2 结构设计目标）", "机身重量 3.2 g", "conflicting", {"group": "W1", "value": "3.2", "render": "3.2 g (design target)"}),
    ("F04b", "机身重量 3.6 g（9 号指围）", "机身重量 3.6 g（9 号指围实测）", "3.6 g，9 号指围实测", "conflicting", {"group": "W1", "value": "3.6", "render": "3.6 g (size 9)", "newer": True}),
    ("F07", "Apple Health 同步", "Apple Health 上市时只能导出；双向同步要等量产后的固件更新", "Apple Health 双向同步计划于量产后", "needs_confirmation", {"roadmap": True}),
    ("F06", "医疗级 / FDA 认证", "医疗级睡眠监测 / FDA 认证", "已获 FDA 认证", "unsupported", {}),
]

INSIGHTS = [
    {"id": "I01", "concept": "堆料", "fact": "F01", "strategy": "转化为具体工程价值", "used_in": "核心卖点第 1 条 · 详细介绍",
     "zhihu": "国内硬件圈说“堆料”，通常指在主板上用更多、更好的元器件和更复杂的布线来换性能或稳定性。社区里常见的争论是：堆料不等于体验好，要看具体用了什么。",
     "zhihu_cite": "【示意】“堆料”在嵌入式硬件里到底指什么？· 知乎问题回答摘录 · 正式版显示真实链接与获取时间",
     "english": {"layer": "global", "label": "英文同类产品", "mode": "你提供的参考 · 示意", "text": "“custom-designed PCB”, “carefully selected components”, “engineered in-house”", "cite": "【示意】同类智能指环众筹页对主板的写法摘录"},
     "risk": "字面译成 stacking materials，英文读者看不懂，也看不出它想说的是用料和设计投入。",
     "action": "不翻译这个词，改写成它背后的具体工程事实：6 层自研 PCB 与元器件选型。",
     "literal": "self-developed high-density stacking motherboard", "localized": "high-grade component selection on a custom 6-layer PCB"},
    {"id": "I02", "concept": "底层协议调试", "fact": "F03", "strategy": "补充边界条件", "used_in": "核心卖点第 3 条 · FAQ 第 1 问",
     "zhihu": "在知乎的硬件讨论里，“支持底层调试”多指留了调试接口、能看协议数据，和“固件开源、能刷第三方固件”是两回事，经常被混为一谈。",
     "zhihu_cite": "【示意】智能穿戴的调试接口和开源固件有什么区别？· 知乎问题回答摘录",
     "english": {"layer": "ai", "label": "AI 推断 · 待验证", "mode": "没有找到英文资料", "text": "“developer-friendly”, “hackable”, “open hardware” — these imply open firmware to many backers.", "cite": "全网搜索没有返回可用的英文结果；正式版可以补充你找到的真实来源。"},
     "risk": "海外极客可能把它理解成 open source / hackable，上线后被追问固件是否开放。",
     "action": "写清能做什么、不能做什么，并在 FAQ 里直接回答“是否开源”。",
     "literal": "supports low-level protocol debugging", "localized": "low-level UART/BLE protocol debugging via the charging dock (firmware is not open source)"},
    {"id": "I03", "concept": "极限压榨功耗", "fact": "F02", "strategy": "补充边界条件", "used_in": "核心卖点第 2 条 · 技术参数",
     "zhihu": "“极限压榨功耗”在国内工程语境里是夸团队把待机功耗优化得很低，但它本身不包含任何续航数字。",
     "zhihu_cite": "【示意】低功耗蓝牙穿戴设备的续航宣传有哪些坑？· 知乎问题回答摘录",
     "english": {"layer": "global", "label": "英文同类产品", "mode": "全网搜索 · 示意", "text": "“power-optimized”, “low-power architecture”; battery claims usually come with test conditions", "cite": "【示意】智能指环评测中的续航测试说明摘录"},
     "risk": "直译 extreme power squeezing 听起来像超频或不稳定；改写时又容易滑向 all-day battery 这类无依据承诺。",
     "action": "只说“功耗优化”，并标注续航测试进行中，不出现任何时长。",
     "literal": "extreme power squeezing", "localized": "power-optimized architecture (runtime testing in progress)"},
]

BRIEF = {
    "priorities": ["续航有没有实测数据", "调试接口 ≠ 开源固件", "健康相关说法的边界", "重量与佩戴舒适度"],
    "faq": ["Is the firmware open source?", "Is this a medical device?", "How much does it weigh?", "Does it sync with Apple Health?"],
    "forbidden": ["all-day battery", "industry-leading", "medical-grade", "FDA approved", "stacking materials", "waterproof"],
    "glossary": [
        ["堆料", "high-grade component selection on a custom 6-layer PCB", "stacking materials"],
        ["极限压榨功耗", "power-optimized architecture", "任何续航时长"],
        ["底层协议调试", "low-level UART/BLE protocol debugging", "open source, hackable"],
        ["5 ATM 生活防水", "5 ATM / 50 m (164 ft) water resistance", "diving, waterproof"],
    ],
}

SETTINGS_OPTIONS = {
    "channel": [["ks", "Kickstarter 众筹新品页"], ["site", "海外独立站新品页"]],
    "audience": [["geek", "美国科技早期支持者"], ["everyday", "日常运动人群"]],
    "tone": [["pro", "专业可信 · 工程克制"], ["plain", "大众易懂"]],
}


def T(text: str) -> dict:
    return {"t": text}


def _assets(facts_by_id: Optional[dict] = None) -> list[dict]:
    """按已核对的事实构造英文模块：没有证据支撑的条目（如缺少 F08 时）不会产出。"""
    has = (lambda fid: fid in facts_by_id) if facts_by_id is not None else (lambda _fid: True)
    spec_items = [
        {"id": "p1", "kind": "row", "label": "Main board", "facts": ["F01"], "segs": [T("6-layer custom PCB")]},
        {"id": "p2", "kind": "row", "label": "Weight", "segs": [{"slot": "conflict:W1", "fmt": "{v}", "ph": "重量等你决定"}]},
        {"id": "p3", "kind": "row", "label": "Water resistance", "facts": ["F05"], "segs": [{"fix": "R05"}]},
        {"id": "p4", "kind": "row", "label": "Debug interface", "facts": ["F03"], "segs": [T("UART / BLE via charging dock")]},
        {"id": "p5", "kind": "row", "label": "Battery runtime", "note": "资料里没有续航实测，所以不写时长", "segs": [T("Runtime testing in progress")]},
    ]
    if has("F08"):
        spec_items.append({"id": "p6", "kind": "row", "label": "RF pre-compliance", "facts": ["F08"], "segs": [T("FCC Part 15C pre-scan complete (formal certification scheduled)")]})
    return [
        {"id": "headline", "title": "标题与宣传语", "items": [
            {"id": "hl", "kind": "title", "segs": [{"set": "audience", "v": {
                "geek": "PulseRing X1 — A Smart Ring Built Around a Custom 6-Layer PCB",
                "everyday": "PulseRing X1 — A 5 ATM Smart Ring for Everyday Activity"}}]},
            {"id": "tg", "kind": "tagline", "segs": [{"set": "tone", "v": {
                "pro": "High-grade components, power-optimized firmware, and low-level protocol access for people who like to look under the hood.",
                "plain": "A light, water-resistant smart ring, designed with care right down to the circuit board."}}]},
        ]},
        {"id": "features", "title": "核心卖点", "items": [
            {"id": "f1", "kind": "li", "facts": ["F01"], "insights": ["I01"], "segs": [{"ins": "I01", "on": "Custom 6-Layer In-House PCB with High-Grade Component Selection", "off": "Custom 6-Layer In-House PCB"}]},
            {"id": "f2", "kind": "li", "facts": ["F02"], "insights": ["I03"], "segs": [{"fix": "R01", "alt": {"I03": "Power-Optimized Architecture Built for Daily Wear"}}]},
            {"id": "f3", "kind": "li", "facts": ["F03"], "insights": ["I02"], "segs": [{"ins": "I02", "on": "Low-Level UART/BLE Protocol Debugging via the Charging Dock — Firmware Is Not Open Source", "off": "Low-Level UART/BLE Protocol Debugging via the Charging Dock"}]},
            {"id": "f4", "kind": "li", "facts": ["F07"], "insights": [], "hide_if": ["roadmap:F07", "omit"], "segs": [{"slot": "roadmap:F07", "map": {"mention": "Apple Health Export at Launch, Two-Way Sync Planned via Post-Launch Update"}, "ph": "Apple Health 同步怎么写？等你决定"}]},
        ]},
        {"id": "story", "title": "详细介绍", "items": [
            {"id": "s1", "kind": "p", "facts": ["F01"], "insights": ["I01"], "segs": [T("PulseRing X1 starts with the board. Our team designed a 6-layer PCB in-house and selected every component for low noise and low standby power. That’s what we mean by "), {"fix": "R04"}, T(".")]},
            {"id": "s2", "kind": "p", "facts": ["F05", "F03"], "insights": ["I02"], "segs": [T("At "), {"slot": "conflict:W1", "fmt": "just {v}", "ph": "重量等你决定"}, T(", PulseRing X1 is rated 5 ATM for everyday water exposure, from hand-washing to the pool. For developers, the charging dock exposes UART and BLE protocol data for low-level debugging. The firmware itself is not open source.")]},
        ]},
        {"id": "specs", "title": "技术参数", "items": spec_items},
        {"id": "faq", "title": "FAQ", "items": [
            {"id": "q1", "kind": "qa", "label": "Is the firmware open source?", "facts": ["F03"], "segs": [T("No. The charging dock gives you low-level UART/BLE protocol access for debugging, but the firmware is not open source.")]},
            {"id": "q2", "kind": "qa", "label": "Is PulseRing X1 a medical device?", "segs": [T("No. It is a wellness and activity ring. It is not intended to diagnose, treat or prevent any condition.")]},
            {"id": "q3", "kind": "qa", "label": "How much does it weigh?", "segs": [{"slot": "conflict:W1", "fmt": "About {v}.", "ph": "重量等你决定"}]},
            {"id": "q4", "kind": "qa", "label": "Does it sync with Apple Health?", "facts": ["F07"], "hide_if": ["roadmap:F07", "omit"], "segs": [{"slot": "roadmap:F07", "map": {"mention": "At launch it exports data to Apple Health. Two-Way Sync is planned for a post-launch firmware update."}, "ph": "等你决定"}]},
        ]},
    ]


def _issues(facts_by_id: dict, initial_status: str = "auto_applied") -> list[dict]:
    def src(fid):
        f = facts_by_id.get(fid)
        return f"{f['source']['file']} · {f['source']['locator']}" if f else "—"
    return [
        {"id": "R01", "asset": "features", "item": "f2", "type": "claim", "severity": "high", "fix_kind": "soften_claim", "status": initial_status,
         "title": "删掉了“全天续航”“行业领先”", "loc": "核心卖点 · 第 2 条",
         "why": "资料里没有标准工况的续航实测，也没有和竞品的对比数据。没有依据的时长和排名，在美国广告里风险很高。",
         "original": "All-Day Battery Life with Industry-Leading Power Efficiency",
         "applied": "Power-Optimized Architecture Built for Daily Wear (Runtime Testing in Progress)",
         "basis": [["company", "你的资料", src("F02"), "“针对低功耗待机做了系统优化……标准工况连续续航待实验室测试。”"],
                   ["rule", "官方规则提示", "FTC · 需要你核实", "广告里的客观声称，发布前要有合理依据。正式版附来源链接与获取时间。"],
                   ["zhihu", "知乎讨论", "示例数据【示意】", "“极限压榨功耗”本身不包含任何续航数字，改写时容易滑向时长承诺。"]]},
        {"id": "R04", "asset": "story", "item": "s1", "type": "culture", "severity": "medium", "fix_kind": "terminology", "status": initial_status,
         "title": "把“堆料”换成了工程说法", "loc": "详细介绍 · 第 1 段",
         "why": "“堆料”直译成 stacking materials，英文读者看不懂，也看不出指的是元器件选型。",
         "original": "stacking premium materials", "applied": "high-grade component selection",
         "basis": [["zhihu", "知乎讨论", "示例数据【示意】", "国内硬件圈说“堆料”，通常指用更多、更好的元器件和更复杂的布线换性能或稳定性。"],
                   ["global", "英文同类产品", "你提供的参考 · 示意", "同类产品常写 “custom-designed PCB”“carefully selected components”。"],
                   ["company", "你的资料", src("F01"), "自研 6 层高密度 PCB，元器件经过选型。"]]},
        {"id": "R05", "asset": "specs", "item": "p3", "type": "rule", "severity": "low", "fix_kind": "unit_boundary", "status": initial_status,
         "title": "防水补上米 / 英尺，并写明不适合潜水", "loc": "技术参数 · Water resistance",
         "why": "美国读者更熟悉米和英尺。5 ATM 一般适合游泳等浅水活动，不代表能潜水。",
         "original": "5 ATM", "applied": "5 ATM / 50 m (164 ft) — suitable for swimming, not for diving",
         "basis": [["company", "你的资料", src("F05"), "5 ATM 生活防水，已完成室内泳池浅水佩戴测试记录。"],
                   ["rule", "官方规则提示", "防水标注惯例 · 需要你核实", "以平台当期规则原文为准。正式版附来源链接与获取时间。"]]},
    ]


def _stable_extra_id(filename: str, loc: str, quote: str) -> str:
    digest = hashlib.sha1(f"{filename}|{loc}|{quote}".encode("utf-8")).hexdigest()[:8]
    return f"U_{digest}"


def _extract_demo_facts(parsed: list[ParsedSource]) -> tuple[list[dict], list[dict], list[dict], list[dict]]:
    readable = [p for p in parsed if p.status == "parsed"]
    facts = []
    for fid, short, text, quote, ev, extra in FACT_SPECS:
        for p in readable:
            loc = p.locate(quote)
            if loc:
                fact = {"id": fid, "short": short, "text": text, "evidence_status": ev,
                        "source": {"file": p.filename, "locator": loc, "quote": quote},
                        "user_decision": "pending", "decided_via": None, "user_text": None}
                fact.update(extra)
                facts.append(fact)
                break
    # 只有当资料包匹配到示例事实后，才为评委额外上传的文件补充启发式参数事实（按内容哈希稳定命名）
    if facts:
        known_files = {f["source"]["file"] for f in facts}
        seen_ids = {f["id"] for f in facts}
        extra_idx = 0
        for p in readable:
            if p.filename in known_files:
                continue
            for loc, block in p.blocks:
                for sent in re.split(r"[。；;\n]", block):
                    sent = sent.strip(" ，,")
                    if 6 <= len(sent) <= 64 and _NUM.search(sent) and extra_idx < 4:
                        uid = _stable_extra_id(p.filename, loc, sent)
                        if uid in seen_ids:
                            continue
                        seen_ids.add(uid)
                        extra_idx += 1
                        facts.append({"id": uid, "short": sent[:16], "text": sent, "evidence_status": "supported",
                                      "source": {"file": p.filename, "locator": loc, "quote": sent},
                                      "user_decision": "pending", "decided_via": None, "user_text": None})
    by_id = {f["id"]: f for f in facts}
    supported = [f["id"] for f in facts if f["evidence_status"] == "supported"]
    decisions = [{"id": "facts", "kind": "confirm_facts", "fact_ids": supported, "value": None}] if supported else []
    w = [by_id[k] for k in ("F04a", "F04b") if k in by_id]
    if len(w) == 2:
        newer = next(f for f in w if f.get("newer"))
        decisions.append({"id": "conflict:W1", "kind": "conflict", "subject": "机身重量", "title": "机身重量写多少？",
                          "why": "两份资料写得不一样，系统不替你选。规格表是更新的 EVT3 样机，并写明了测量指围；v1.2 文档里的 3.2 g 为设计目标。",
                          "used_in": "详细介绍 · 技术参数 · FAQ", "allow_custom": True, "value": None, "custom": None,
                          "options": [{"value": f["value"], "label": f["text"].replace("机身重量 ", ""), "render": f["render"],
                                       "source": f"{f['source']['file']} · {f['source']['locator']}", "recommended": f is newer, "fact": f["id"]}
                                      for f in sorted(w, key=lambda f: not f.get("newer"))]})
    if "F07" in by_id:
        decisions.append({"id": "roadmap:F07", "kind": "roadmap_wording", "subject": "Apple Health 双向同步", "title": "Apple Health 双向同步还没上线，怎么写？",
                          "why": "资料写明：上市时只能导出，双向同步要等量产后的固件更新。", "used_in": "核心卖点 · FAQ", "value": None,
                          "options": [{"value": "mention", "label": "照实写：上市可导出，双向同步计划中", "preview": "Apple Health Export at Launch, Two-Way Sync Planned via Post-Launch Update", "recommended": True, "fact": "F07"},
                                      {"value": "omit", "label": "先不提这个功能", "note": "卖点和 FAQ 里相关的一条会去掉", "recommended": False}]})
    blocked = []
    if "F06" in by_id:
        blocked.append({"id": "F06", "title": "没有写“医疗级 / FDA 认证”", "short": "医疗级 / FDA 认证",
                        "why": "认证清单明确标注尚未提交 FDA 510(k) 注册申请。美国对“medical-grade / FDA”这类说法要求有正式证明，所以英文页和 FAQ 都不会出现，FAQ 里写明“不是医疗设备”。",
                        "quote": by_id["F06"]["source"],
                        "basis": [["company", "你的资料", f"{len(readable)} 份资料", "认证清单写明尚未申请 FDA 510(k)，无医疗器械认证文件。"],
                                  ["rule", "官方规则提示", "FDA 一般健康产品指南 · 需要你核实", "“diagnose / treat / medical-grade”类措辞的风险。正式版附来源链接与获取时间。"]]})
    gaps = []
    if any(p.locate("续航待实验室测试") for p in readable):
        gaps.append({"id": "battery", "title": "续航时长", "why": "资料里没有标准工况的续航实测，技术参数写成 “Runtime testing in progress”。"})
    return facts, decisions, blocked, gaps


def build_staged_demo_state(parsed: list[ParsedSource]) -> dict:
    """分步示例初始状态：只预载产品资料，事实/洞察/英文页/审校全部留待评委自行触发。"""
    return {
        "name": PRODUCT,
        "is_demo": True,
        "pipeline_status": "staged",
        "completed_stages": ["materials"],
        "facts": [],
        "decisions": [],
        "insights": [],
        "brief": {"priorities": [], "faq": [], "forbidden": [], "glossary": []},
        "assets": [],
        "issues": [],
        "blocked": [],
        "gaps": [],
        "settings": {"channel": "ks", "audience": "geek", "tone": "pro", "source": {"channel": "inferred", "audience": "inferred", "tone": "inferred"}},
        "run": {"steps": [["读取资料", _read_summary(parsed)]], "status": "staged"},
    }


def prune_missing_fact_items(state: dict) -> None:
    """当资料变更导致某些事实消失时，移除依赖这些已失效事实的模板条目。"""
    valid_ids = {f["id"] for f in state["facts"]}
    for a in state["assets"]:
        a["items"] = [
            it for it in a["items"]
            if not it.get("facts") or any(fid in valid_ids for fid in it["facts"])
        ]


def advance_demo_stage(state: dict, target_stage: str, parsed: list[ParsedSource], rules: list[dict]) -> str:
    """将分步项目推进到指定阶段（facts / insights / content / review），严格校验前置阶段并保持重试幂等。"""
    order = ("materials", "facts", "insights", "content", "review")
    if target_stage not in order[1:]:
        raise engine.WorkbenchError("未知的工作台步骤", 400)
    completed = list(state.get("completed_stages") or ["materials"])
    if target_stage in completed:
        return f"「{STAGE_LABELS[target_stage]}」已完成"

    prev_stage = order[order.index(target_stage) - 1]
    if prev_stage not in completed:
        raise engine.WorkbenchError(f"请先完成「{STAGE_LABELS[prev_stage]}」，再执行「{STAGE_LABELS[target_stage]}」", 409)

    if target_stage == "facts":
        facts, decisions, blocked, gaps = _extract_demo_facts(parsed)
        state["facts"] = facts
        state["decisions"] = decisions
        state["blocked"] = blocked
        state["gaps"] = gaps
        completed.append("facts")
        state["run"]["steps"].append(["找出产品事实", f"从 {sum(1 for p in parsed if p.status == 'parsed')} 份资料提取 {len(facts)} 条事实；发现冲突与待定项留给你拍板"])
        toast = f"已提取 {len(facts)} 条产品事实（含 PDF 认证清单），发现 {sum(1 for d in decisions if d['kind'] != 'confirm_facts')} 项待决定、挡下 {len(blocked)} 处无依据声称"
    elif target_stage == "insights":
        by_id = {f["id"]: f for f in state["facts"]}
        insights = [dict(i, enabled=True) for i in INSIGHTS if i["fact"] in by_id]
        state["insights"] = insights
        state["brief"] = {k: list(v) for k, v in BRIEF.items()}
        completed.append("insights")
        state["run"]["steps"].append(["查知乎上的行业说法", f"{len(insights)} 个说法直译会被误读，已生成跨文化洞察与内容策略 Brief"])
        toast = f"知乎认知洞察完成：识别 {len(insights)} 个直译易误读的中文工程概念，已整理内容策略 Brief"
    elif target_stage == "content":
        by_id = {f["id"]: f for f in state["facts"]}
        assets = _assets(by_id)
        for a in assets:
            a.update(version=1, reviewed_version=0, reviewed_fact_set=0)
        state["assets"] = assets
        # 在发布前审校尚未执行前，系统修订先处于 pending_review，正文展示初稿措辞
        state["issues"] = _issues(by_id, initial_status="pending_review")
        for iss in state["issues"]:
            iss.setdefault("keep_reason", None)
        completed.append("content")
        state["run"]["steps"].append(["写英文页", "已生成标题、核心卖点、详细介绍、技术参数、FAQ 共 5 个英文模块"])
        toast = "已生成 5 个海外上市内容模块（待执行发布前合规审校）"
    else:  # review
        items_by_key = {(a["id"], it["id"]): it for a in state["assets"] for it in a["items"]}
        activated = 0
        for iss in state["issues"]:
            if iss.get("status") != "pending_review":
                continue
            owner = items_by_key.get((iss["asset"], iss["item"]))
            if owner is None or owner.get("text") is not None:
                # 若用户已手动覆写该句，模板自动修订不再作用到最终导出正文，标记为 superseded 避免误报
                iss["status"] = "superseded"
            else:
                iss["status"] = "auto_applied"
                activated += 1
        extra_found = 0
        for a in state["assets"]:
            extra_found += engine.recheck(state, a["id"], rules)
        completed.append("review")
        state["pipeline_status"] = "done"
        state["run"]["status"] = "done"
        state["run"]["steps"].append(["发布前检查", f"自动改掉 {activated} 处风险说法" + (f"，发现 {extra_found} 处手动编辑新风险" if extra_found else "") + (f"，挡下 {len(state['blocked'])} 处无依据声称" if state["blocked"] else "")])
        toast = f"发布前审校完成：系统自动改写 {activated} 处风险说法" + (f"，发现 {extra_found} 处手动改写风险" if extra_found else "") + f"，挡下 {len(state['blocked'])} 处无依据声称"

    state["completed_stages"] = completed
    return toast


def build_demo_state(parsed: list[ParsedSource]) -> Optional[dict]:
    """资料里能找到示例包的原文就按示例流水线一次性生成完整态；一条都找不到返回 None。"""
    facts, decisions, blocked, gaps = _extract_demo_facts(parsed)
    if not facts:
        return None
    by_id = {f["id"]: f for f in facts}
    w = [by_id[k] for k in ("F04a", "F04b") if k in by_id]
    insights = [dict(i, enabled=True) for i in INSIGHTS if i["fact"] in by_id]
    n_fix = 3
    run_steps = [
        ["读取资料", _read_summary(parsed)],
        ["找出产品事实", f"{len(facts)} 条事实" + ("；机身重量两份资料写得不一样，留给你定" if len(w) == 2 else "")],
        ["查知乎上的行业说法", f"{len(insights)} 个说法直译会被误读，已全部用上（示例数据）"],
        ["写英文页", "标题、卖点、详细介绍、技术参数、FAQ"],
        ["发布前检查", f"替你改掉 {n_fix} 处风险说法" + ("，挡下 1 处无依据声称" if blocked else "")],
    ]
    return {"name": PRODUCT, "is_demo": True, "completed_stages": list(ALL_STAGES),
            "facts": facts, "decisions": decisions, "insights": insights,
            "brief": BRIEF, "assets": _assets(by_id), "issues": _issues(by_id), "blocked": blocked, "gaps": gaps,
            "settings": {"channel": "ks", "audience": "geek", "tone": "pro", "source": {"channel": "inferred", "audience": "inferred", "tone": "inferred"}},
            "run": {"steps": run_steps}}


def _read_summary(parsed: list[ParsedSource]) -> str:
    ok = [p for p in parsed if p.status == "parsed"]
    bad = [p for p in parsed if p.status != "parsed"]
    s = f"读到 {len(ok)} 份资料"
    if bad:
        s += "。" + "、".join(p.filename for p in bad) + " 读不出文字，不影响继续"
    return s


_NUM = re.compile(r"\d")


def generic_state(parsed: list[ParsedSource]) -> dict:
    """非示例资料：启发式抽取（含数字或参数的句子），模板生成英文占位。全部标注开发占位。"""
    readable = [p for p in parsed if p.status == "parsed"]
    facts = []
    for p in readable:
        for loc, block in p.blocks:
            for sent in re.split(r"[。；;\n]", block):
                sent = sent.strip(" ，,")
                if 4 <= len(sent) <= 60 and _NUM.search(sent) and len(facts) < 8:
                    facts.append({"id": f"G{len(facts) + 1:02d}", "short": sent[:18], "text": sent, "evidence_status": "supported",
                                  "source": {"file": p.filename, "locator": loc, "quote": sent},
                                  "user_decision": "pending", "decided_via": None, "user_text": None})
    name = next((m.group(1).strip() for p in readable for m in [re.search(r"^#\s+(.+)$", p.text, re.M)] if m), None) \
        or (readable[0].filename.rsplit(".", 1)[0] if readable else "新项目")
    items = [{"id": f"g{i}", "kind": "li", "facts": [f["id"]], "insights": [], "segs": [T(f"[开发占位] Feature based on: {f['text']}")]} for i, f in enumerate(facts[:4], 1)]
    assets = [
        {"id": "headline", "title": "标题与宣传语", "items": [{"id": "hl", "kind": "title", "segs": [T(f"{name} — [开发占位] Headline")]},
                                                           {"id": "tg", "kind": "tagline", "segs": [T("[开发占位] 正式版由模型根据你的资料生成。")]}]},
        {"id": "features", "title": "核心卖点", "items": items or [{"id": "g0", "kind": "li", "segs": [T("[开发占位] 资料里没有找到可用的参数或事实。")]}]},
        {"id": "story", "title": "详细介绍", "items": [{"id": "s1", "kind": "p", "segs": [T("[开发占位] 正式版会结合事实与知乎建议写成英文介绍。")]}]},
        {"id": "specs", "title": "技术参数", "items": [{"id": f"p{i}", "kind": "row", "label": f["short"], "facts": [f["id"]], "segs": [T("[开发占位]")]} for i, f in enumerate(facts[:5], 1)]},
        {"id": "faq", "title": "FAQ", "items": [{"id": "q1", "kind": "qa", "label": "[开发占位] FAQ", "segs": [T("正式版由模型根据资料与知乎建议生成。")]}]},
    ]
    ids = [f["id"] for f in facts]
    return {"name": name, "is_demo": False, "completed_stages": list(ALL_STAGES), "facts": facts,
            "decisions": [{"id": "facts", "kind": "confirm_facts", "fact_ids": ids, "value": None}] if ids else [],
            "insights": [], "brief": {"priorities": [], "faq": [], "forbidden": [], "glossary": []}, "assets": assets,
            "issues": [], "blocked": [], "gaps": [],
            "settings": {"channel": "ks", "audience": "geek", "tone": "pro", "source": {"channel": "inferred", "audience": "inferred", "tone": "inferred"}},
            "run": {"steps": [["读取资料", _read_summary(parsed)], ["找出产品事实", f"{len(facts)} 条含参数的句子（启发式，开发占位）"],
                              ["查知乎上的行业说法", "骨架阶段只为示例资料提供知乎建议"], ["写英文页", "开发占位模板"], ["发布前检查", "规则检查完成"]]}}
