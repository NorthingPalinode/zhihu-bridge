"""真实流水线（PR-03 / PR-04 / PR-05）：知乎直答提取事实与生成英文页，知乎搜索 + 全网搜索提供语境。

模型输出一律不直接信任：
- 事实的原文摘录必须能在已读取的资料里找到，否则丢弃（定位由解析器给出）；
- 知乎与英文引用只能指向接口真实返回的结果（按编号引用），模型给不出就标“AI 推断 · 待验证”；
- 英文全网结果只保留英文正文，并排除电商、中文站与知乎本站（G0 实测结论）；
- 生成文本里的风险说法由规则自动弱化（保守修订，留痕可撤销）；
- 冲突取值与计划功能的写法只做占位，等用户决定。
每个项目约 3 次模型调用、最多 6 次知乎检索。
"""
from __future__ import annotations

import json
import re
from typing import Any, Awaitable, Callable, Optional
from urllib.parse import urlsplit

from .demo import SETTINGS_OPTIONS, T
from .sources import ParsedSource

Progress = Callable[[str, str], Awaitable[None]]

EXCLUDED_HOST = re.compile(r"(taobao|tmall|jd\.com|alibaba|1688|accio|aliexpress|amazon\.|ebay\.|zhihu\.com|baidu|csdn|\.cn$|huanqiu|sohu|163\.com|qq\.com|bilibili|weibo)", re.I)
CJK = re.compile(r"[一-鿿]")
TOKEN = re.compile(r"\{\{([A-Za-z0-9_]+)\}\}")


class LiveError(Exception):
    pass


def english_ok(item: dict) -> bool:
    text = f"{item.get('title', '')} {item.get('contentText', '')}"
    letters = len(re.findall(r"[A-Za-z]", text))
    host = urlsplit(item.get("url", "")).hostname or ""
    return letters > 40 and len(CJK.findall(text)) < letters / 10 and not EXCLUDED_HOST.search(host)


def _clip(s: Any, n: int) -> str:
    return re.sub(r"\s+", " ", str(s or "")).strip()[:n]


EXTRACT_SYSTEM = """你是硬件出海内容团队的资料分析员。只根据用户给出的企业资料提取产品事实，绝不补充资料里没有的参数、认证或测试结果。
输出 JSON：
{"product_name": "产品名（中文资料里的叫法）",
 "channel": "ks 或 site（资料提到众筹/Kickstarter 用 ks，否则 site）",
 "audience": "geek 或 everyday", "tone": "pro 或 plain",
 "facts": [{"short": "不超过 14 字的短名", "text": "事实陈述（中文）", "quote": "从资料中逐字复制的原文片段，8-40 字，必须能在资料里原样找到",
            "file": "来源文件名", "status": "supported | needs_confirmation | conflicting | unsupported",
            "group": "冲突组名（如 W1；同一属性在不同资料里数值不同时，两条都标 conflicting 并用同一组名），否则空字符串",
            "value": "冲突组里本条的取值（如 3.6 g），否则空字符串", "roadmap": true/false（计划中、尚未上线的功能）}],
 "gaps": [{"title": "缺什么", "why": "为什么不能写"}],
 "concepts": [{"zh": "资料里出现的中文工程黑话或卖点说法（直译会被误读）", "fact": 对应 facts 的下标, "zh_query": "知乎检索词", "en_query": "英文检索词（同类产品怎么说）"}]}
规则：只在营销文案里出现、资料没有证明的认证/医疗/续航/排名类声称标 unsupported；roadmap 只用于产品功能“现在还没有、计划上市后才有”，发布计划、渠道、营销安排都不算；facts 最多 12 条；concepts 最多 3 个。"""

INSIGHT_SYSTEM = """你是跨文化本地化顾问。根据给出的知乎搜索结果（中文语境）和英文搜索结果（英文同类产品表达），为每个中文概念写一张洞察卡。
只能引用给出的结果编号；结果里没有能用的内容时，对应 ref 填 -1，绝不编造出处。
输出 JSON：{"insights": [{"concept": "中文概念", "strategy": "转化为具体工程价值 | 补充边界条件 | 保留并解释 | 删除夸张说法",
  "zhihu": "知乎上这个说法的真实含义与争议（中文，60-120 字）", "zhihu_ref": 知乎结果编号或 -1,
  "english": "英文同类产品常见的说法（英文短语）", "english_ref": 英文结果编号或 -1,
  "risk": "直译可能引起的误解（中文）", "action": "系统应该怎么写（中文）",
  "literal": "字面直译（英文）", "localized": "推荐的英文写法（只用资料里的事实）"}]}"""

GENERATE_SYSTEM = """你是美国众筹页文案写手。只用给出的产品事实写英文新品页，不得添加任何资料之外的参数、认证、续航时长、排名或医疗声称。
采纳给出的本地化写法，不要直译中文黑话。冲突未决定的数值用占位符 {{组名}} 原样写出（例如 {{W1}}），不要自己选。
计划功能不要写进正文，只放进 roadmap。
输出 JSON：
{"headline": "主标题", "tagline": "一句话介绍",
 "features": [{"text": "卖点", "facts": [事实编号], "insights": ["中文概念"]}],
 "story": ["段落1", "段落2"],
 "specs": [{"label": "参数名", "value": "参数值（缺数据写 Testing in progress）", "facts": [事实编号]}],
 "faq": [{"q": "问题", "a": "回答"}],
 "roadmap": [{"fact": 事实编号, "feature": "照实写的卖点（说明上市时的状态与计划）", "faq_q": "问题", "faq_a": "回答"}],
 "brief": {"priorities": ["美国读者最关心的点"], "faq": ["必须回答的质疑"], "forbidden": ["不该出现的英文说法"], "glossary": [["中文说法", "对外英文说法", "不要说"]]}}
features 3-5 条，story 2 段，specs 4-8 行，faq 3-5 问。"""


async def build_live_state(parsed: list[ParsedSource], llm_json: Callable[[str, str, int], Awaitable[dict]],
                           zhihu: Any, rules: list[dict], progress: Progress, zh_claims: Optional[list[dict]] = None) -> dict:
    readable = [p for p in parsed if p.status == "parsed"]
    if not readable:
        raise LiveError("没有可读的资料")
    await progress("读取资料", f"读到 {len(readable)} 份资料" + (f"；{len(parsed) - len(readable)} 份读不出文字，不影响继续" if len(parsed) > len(readable) else ""))

    # ---------- 1. 事实（模型提取 + 原文核对） ----------
    corpus = "\n\n".join(f"=== 文件：{p.filename} ===\n{p.text[:3500]}" for p in readable)[:10000]
    ex = await llm_json(EXTRACT_SYSTEM, corpus, 2200)
    facts, raw_index = _verified_facts(ex.get("facts") or [], readable)
    dropped = sum(1 for f in ex.get("facts") or [] if isinstance(f, dict)) - len(facts)
    _merge_conflicts(facts, detect_conflicts(readable))
    _merge_claims(facts, detect_claims(readable, zh_claims or []))
    groups: dict[str, list[dict]] = {}
    for f in facts:
        if f["evidence_status"] == "conflicting":
            groups.setdefault(f["group"], []).append(f)
    for g, fs in list(groups.items()):
        if len(fs) < 2:  # 另一边没核对上：不能算冲突
            for f in fs:
                f.update(evidence_status="needs_confirmation", group=None)
            groups.pop(g)
    await progress("找出产品事实", f"{len(facts)} 条事实" + (f"；{len(groups)} 处资料互相矛盾，留给你定" if groups else "")
                   + (f"；{dropped} 条在资料里找不到原文，已丢弃" if dropped > 0 else ""))

    # ---------- 2. 知乎洞察（真实检索 + 编号引用） ----------
    concepts = [c for c in (ex.get("concepts") or []) if isinstance(c, dict) and c.get("zh")][:3]
    insights, zh_mode = await _insights(concepts, facts, raw_index, llm_json, zhihu)
    await progress("查知乎上的行业说法", f"{len(insights)} 个说法直译会被误读，已全部用上" + (f"（{zh_mode}）" if zh_mode else ""))

    # ---------- 3. 英文页 ----------
    usable = [f for f in facts if f["evidence_status"] in ("supported", "needs_confirmation") and not f.get("roadmap")]
    roadmap = [f for f in facts if f.get("roadmap") and f["evidence_status"] != "unsupported"]
    ref = {i: f for i, f in enumerate(usable + roadmap)}
    lines = [f"[{i}] {f['text']}" for i, f in enumerate(usable)]
    lines += [f"[{len(usable) + j}] （计划功能）{f['text']}" for j, f in enumerate(roadmap)]
    conflict_lines = [f"{{{{{g}}}}}：{fs[0]['short']}，两份资料分别写 " + " / ".join(x['value'] for x in fs) for g, fs in groups.items()]
    ins_lines = [f"{i['concept']} → {i['localized']}" for i in insights]
    settings = {"channel": _pick(ex.get("channel"), "channel", "ks"), "audience": _pick(ex.get("audience"), "audience", "geek"), "tone": _pick(ex.get("tone"), "tone", "pro")}
    user = (f"产品：{ex.get('product_name') or readable[0].filename}\n渠道：{dict(SETTINGS_OPTIONS['channel'])[settings['channel']]}；受众：{dict(SETTINGS_OPTIONS['audience'])[settings['audience']]}；语气：{dict(SETTINGS_OPTIONS['tone'])[settings['tone']]}\n\n"
            "产品事实：\n" + "\n".join(lines) + "\n\n冲突占位符：\n" + ("\n".join(conflict_lines) or "无") + "\n\n本地化写法：\n" + ("\n".join(ins_lines) or "无"))
    gen = await llm_json(GENERATE_SYSTEM, user, 2600)
    assets, issues = _assets(gen, ref, groups, rules)
    await progress("写英文页", "标题、卖点、详细介绍、技术参数、FAQ")
    await progress("发布前检查", f"替你改掉 {len(issues)} 处风险说法" + (f"，挡下 {sum(1 for f in facts if f['evidence_status'] == 'unsupported')} 处无依据声称" if any(f['evidence_status'] == 'unsupported' for f in facts) else ""))

    decisions = _decisions(facts, groups)
    blocked = [{"id": f["id"], "title": f"没有写“{f['short']}”", "short": f["short"], "quote": f["source"],
                "why": "资料里没有任何证明，英文页不会出现这类说法。",
                "basis": [["company", "你的资料", f"{len(readable)} 份资料", "没有找到对应的证书、检测报告或实测数据。"]]}
               for f in facts if f["evidence_status"] == "unsupported"]
    brief = gen.get("brief") if isinstance(gen.get("brief"), dict) else {}
    return {
        "name": _clip(ex.get("product_name"), 40) or readable[0].filename.rsplit(".", 1)[0], "is_demo": False,
        "llm_mode": "live", "retrieval_mode": "live" if insights else "none",
        "facts": facts, "decisions": decisions, "insights": insights,
        "brief": {"priorities": [_clip(x, 40) for x in brief.get("priorities") or []][:6], "faq": [_clip(x, 120) for x in brief.get("faq") or []][:6],
                  "forbidden": [_clip(x, 40) for x in brief.get("forbidden") or []][:10],
                  "glossary": [[_clip(a, 30), _clip(b, 80), _clip(c, 40)] for a, b, c in (g for g in brief.get("glossary") or [] if isinstance(g, list) and len(g) == 3)][:8]},
        "assets": assets, "issues": issues, "blocked": blocked,
        "gaps": [{"id": f"gap{i}", "title": _clip(g.get("title"), 30), "why": _clip(g.get("why"), 120)} for i, g in enumerate(ex.get("gaps") or []) if isinstance(g, dict) and g.get("title")][:4],
        "settings": {**settings, "source": {k: "inferred" for k in settings}},
    }


def _pick(v: Any, key: str, default: str) -> str:
    return v if v in {o[0] for o in SETTINGS_OPTIONS[key]} else default


def _verified_facts(raw: list, readable: list[ParsedSource]) -> tuple[list[dict], dict[int, str]]:
    facts, index = [], {}
    for i, f in enumerate(raw):
        if not isinstance(f, dict):
            continue
        quote = _clip(f.get("quote"), 80)
        if len(quote) < 4:
            continue
        order = sorted(readable, key=lambda p: p.filename != f.get("file"))
        for p in order:
            loc = p.locate(quote)
            if loc:
                status = f.get("status") if f.get("status") in ("supported", "needs_confirmation", "conflicting", "unsupported") else "needs_confirmation"
                fid = f"L{len(facts) + 1:02d}"
                index[i] = fid
                facts.append({"id": fid, "short": _clip(f.get("short"), 16) or quote[:14], "text": _clip(f.get("text"), 120) or quote,
                              "evidence_status": status, "group": _clip(f.get("group"), 8) or None, "value": _clip(f.get("value"), 20) or None,
                              "render": _clip(f.get("value"), 20) or None, "roadmap": bool(f.get("roadmap")),
                              "source": {"file": p.filename, "locator": loc, "quote": quote},
                              "user_decision": "pending", "decided_via": None, "user_text": None})
                break
    return facts, index


async def _insights(concepts: list[dict], facts: list[dict], raw_index: dict[int, str], llm_json, zhihu) -> tuple[list[dict], str]:
    if not concepts or zhihu is None or not zhihu.enabled:
        return [], "知乎检索未启用" if concepts else ""
    blocks, zh_hits, en_hits, modes = [], {}, {}, set()
    for ci, c in enumerate(concepts):
        zh_items, en_items = [], []
        try:
            res, src = await zhihu.search(_clip(c.get("zh_query") or c["zh"], 40), 6)
            modes.add(src)
            zh_items = [{"title": _clip(r.get("Title"), 60), "url": str(r.get("Url") or ""), "text": _clip(r.get("ContentText"), 220)} for r in res if r.get("Url")][:4]
        except Exception:  # noqa: BLE001 - 降级而不是中断
            pass
        try:
            res, src = await zhihu.global_search(_clip(c.get("en_query") or c["zh"], 60), 8)
            modes.add(src)
            en_items = [{"title": _clip(r["title"], 80), "url": r["url"], "text": _clip(r["contentText"], 220)} for r in res if english_ok(r)][:4]
        except Exception:  # noqa: BLE001
            pass
        zh_hits[ci], en_hits[ci] = zh_items, en_items
        blocks.append(f"## 概念 {ci}：{c['zh']}\n知乎结果：\n" + ("\n".join(f"Z{j}. {x['title']}｜{x['text']}" for j, x in enumerate(zh_items)) or "（无）")
                      + "\n英文结果：\n" + ("\n".join(f"E{j}. {x['title']}｜{x['text']}" for j, x in enumerate(en_items)) or "（无）"))
    out = await llm_json(INSIGHT_SYSTEM + "\n引用编号只写数字（Z2 写 2，E0 写 0）。", "\n\n".join(blocks), 2200)
    by_id = {f["id"]: f for f in facts}
    insights = []
    for ci, (c, ins) in enumerate(zip(concepts, out.get("insights") or [])):
        if not isinstance(ins, dict):
            continue
        zi, ei = _int(ins.get("zhihu_ref")), _int(ins.get("english_ref"))
        z = zh_hits[ci][zi] if 0 <= zi < len(zh_hits[ci]) else None
        e = en_hits[ci][ei] if 0 <= ei < len(en_hits[ci]) else None
        fid = raw_index.get(_int(c.get("fact")))
        mode = "缓存" if modes == {"cache"} else "实时检索"
        insights.append({
            "id": f"LI{ci + 1}", "concept": _clip(c["zh"], 16), "fact": fid if fid in by_id else (facts[0]["id"] if facts else ""),
            "strategy": _clip(ins.get("strategy"), 16) or "补充边界条件", "used_in": "英文页相关段落", "enabled": True,
            "zhihu": _clip(ins.get("zhihu"), 240), "zhihu_mode": mode if z else "AI 推断 · 待验证",
            "zhihu_cite": (f"{z['title']} · 知乎" if z else "没有找到可用的知乎讨论；以上为 AI 推断，待验证"), "zhihu_url": z["url"].split("?")[0] if z else None,
            "english": {"layer": "global" if e else "ai", "label": "英文同类产品" if e else "AI 推断 · 待验证",
                        "mode": (f"全网搜索 · {urlsplit(e['url']).hostname}" if e else "没有找到英文资料"),
                        "text": _clip(ins.get("english"), 200), "cite": e["title"] if e else "全网搜索没有返回可用的英文结果。", "url": e["url"] if e else None},
            "risk": _clip(ins.get("risk"), 160), "action": _clip(ins.get("action"), 160),
            "literal": _clip(ins.get("literal"), 120), "localized": _clip(ins.get("localized"), 160),
        })
    return insights, ("缓存" if modes == {"cache"} else "知乎实时检索") if insights else ""


def _int(v: Any) -> int:
    try:
        return int(str(v).strip().lstrip("ZEze"))
    except (TypeError, ValueError):
        return -1


def _decisions(facts: list[dict], groups: dict[str, list[dict]]) -> list[dict]:
    plain = [f["id"] for f in facts if f["evidence_status"] in ("supported", "needs_confirmation") and not f.get("roadmap")]
    out = [{"id": "facts", "kind": "confirm_facts", "fact_ids": plain, "value": None}] if plain else []
    for g, fs in groups.items():
        subject = re.sub(r"[\s\d.]+[a-zA-Z%]*$", "", fs[0]["short"]).strip() or fs[0]["short"]
        out.append({"id": f"conflict:{g}", "kind": "conflict", "subject": subject, "title": f"{subject}写多少？",
                    "why": "几份资料写得不一样，系统不替你选。请按量产口径选一个，或者自己填写。", "used_in": "英文页里用到这个数值的地方",
                    "allow_custom": True, "value": None, "custom": None,
                    "options": [{"value": f["value"] or f["id"], "label": f["value"] or f["text"], "render": f["value"] or f["text"],
                                 "source": f"{f['source']['file']} · {f['source']['locator']}", "recommended": False, "fact": f["id"]} for f in fs]})
    for f in facts:
        if f.get("roadmap") and f["evidence_status"] != "unsupported":
            out.append({"id": f"roadmap:{f['id']}", "kind": "roadmap_wording", "subject": f["short"], "title": f"“{f['short']}”还没上线，怎么写？",
                        "why": f"资料写明：{f['text']}", "used_in": "核心卖点 · FAQ", "value": None,
                        "options": [{"value": "mention", "label": "照实写：说明上市时的状态和计划", "recommended": True, "fact": f["id"]},
                                    {"value": "omit", "label": "先不提这个功能", "note": "卖点和 FAQ 里相关的一条会去掉", "recommended": False}]})
    return out


def _segs(text: str, groups: dict[str, list[dict]], rules: list[dict], issues: list[dict], asset: str, item: str, loc: str) -> list[dict]:
    """把一句话切成片段：{{组名}} → 冲突占位；风险说法 → 保守修订（留原句）。"""
    segs: list[dict] = []
    for g, fs in groups.items():  # 守卫：模型若把冲突的数值直接写进正文，一律换成占位，等用户决定
        vals = [re.escape(_norm_value(f["value"] or "")) for f in fs if f.get("value")]
        if vals and re.search("|".join(vals), _norm_value(text)):
            if asset == "specs":
                text = "{{" + g + "}}"
            else:
                for f in fs:
                    text = re.sub(_value_regex(f["value"]), "{{" + g + "}}", text)
                text = re.sub(r"(\{\{" + g + r"\}\})(?:[^{}.]{0,60}?\{\{" + g + r"\}\})+", r"\1", text)
    for i, chunk in enumerate(TOKEN.split(text)):
        if i % 2 == 1:
            if chunk in groups:
                segs.append({"slot": f"conflict:{chunk}", "fmt": "{v}", "ph": f"{groups[chunk][0]['short'].split(' ')[0]}等你决定"})
            continue
        rest = chunk
        while rest:
            hit = None
            for r in rules:
                m = re.search(r["pattern"], rest, flags=re.I)
                if m and (hit is None or m.start() < hit[0].start()):
                    hit = (m, r)
            if not hit:
                segs.append(T(rest))
                break
            m, r = hit
            if m.start():
                segs.append(T(rest[:m.start()]))
            iid = f"R{len(issues) + 1:02d}"
            issues.append({"id": iid, "asset": asset, "item": item, "type": "claim", "severity": r.get("severity", "high"),
                           "fix_kind": r.get("fix_kind", "soften_claim"), "status": "auto_applied", "keep_reason": None,
                           "title": f"把 “{m.group(0)}” 改成了 “{r['suggestion']}”", "loc": loc, "why": r["why"] + "。",
                           "original": m.group(0), "applied": r["suggestion"],
                           "basis": [["rule", "规则检查", "Zhihu Bridge 声称规则", f"{r['why']}；系统只做弱化，不添加新事实。"]]})
            segs.append({"fix": iid})
            rest = rest[m.end():]
    return segs or [T("")]


def _assets(gen: dict, ref: dict[int, dict], groups: dict, rules: list[dict]) -> tuple[list[dict], list[dict]]:
    issues: list[dict] = []
    fids = lambda xs: [ref[i]["id"] for i in (xs or []) if isinstance(i, int) and i in ref]  # noqa: E731

    def item(aid, iid, kind, text, loc, **extra):
        return {"id": iid, "kind": kind, "segs": _segs(_clip(text, 600), groups, rules, issues, aid, iid, loc), **extra}

    feats = [item("features", f"f{i}", "li", f.get("text"), f"核心卖点 · 第 {i} 条", facts=fids(f.get("facts")), insights=[])
             for i, f in enumerate((x for x in gen.get("features") or [] if isinstance(x, dict) and x.get("text")), 1)][:5]
    faq = [item("faq", f"q{i}", "qa", q.get("a"), f"FAQ · 第 {i} 问", label=_clip(q.get("q"), 160))
           for i, q in enumerate((x for x in gen.get("faq") or [] if isinstance(x, dict) and x.get("q")), 1)][:5]
    for j, r in enumerate(gen.get("roadmap") or [], 1):
        if not isinstance(r, dict) or not isinstance(r.get("fact"), int) or r["fact"] not in ref:
            continue
        did = f"roadmap:{ref[r['fact']]['id']}"
        feats.append({"id": f"fr{j}", "kind": "li", "facts": [ref[r["fact"]]["id"]], "insights": [], "hide_if": [did, "omit"],
                      "segs": [{"slot": did, "map": {"mention": _clip(r.get("feature"), 300)}, "ph": "计划功能怎么写？等你决定"}]})
        if r.get("faq_q"):
            faq.append({"id": f"qr{j}", "kind": "qa", "label": _clip(r["faq_q"], 160), "hide_if": [did, "omit"],
                        "segs": [{"slot": did, "map": {"mention": _clip(r.get("faq_a"), 400)}, "ph": "等你决定"}]})
    assets = [
        {"id": "headline", "title": "标题与宣传语", "items": [item("headline", "hl", "title", gen.get("headline"), "标题"),
                                                           item("headline", "tg", "tagline", gen.get("tagline"), "一句话介绍")]},
        {"id": "features", "title": "核心卖点", "items": feats},
        {"id": "story", "title": "详细介绍", "items": [item("story", f"s{i}", "p", p, f"详细介绍 · 第 {i} 段") for i, p in enumerate((p for p in gen.get("story") or [] if p), 1)][:3]},
        {"id": "specs", "title": "技术参数", "items": [item("specs", f"p{i}", "row", s.get("value"), f"技术参数 · {_clip(s.get('label'), 30)}", label=_clip(s.get("label"), 40), facts=fids(s.get("facts")))
                                                     for i, s in enumerate((x for x in gen.get("specs") or [] if isinstance(x, dict) and x.get("label")), 1)][:8]},
        {"id": "faq", "title": "FAQ", "items": faq},
    ]
    if not any(a["items"] for a in assets[1:]):
        raise LiveError("模型没有写出英文页内容")
    return assets, issues


# ---------------------------------------------------------------- 确定性守卫（不依赖模型判断）
_VALUE = r"(\d+(?:\.\d+)?)\s*(g|kg|mm|cm|mAh|Wh|ATM|m|小时|天|h|W|V|克|毫米|英寸)"


def _norm_value(v: str) -> str:
    return re.sub(r"\s+", "", v or "").lower()


def _value_regex(v: str) -> str:
    m = re.match(_VALUE, v or "")
    if not m:
        return re.escape(v or "") or r"(?!x)x"
    return re.escape(m.group(1)) + r"\s*" + re.escape(m.group(2))


def detect_conflicts(readable: list[ParsedSource]) -> dict[str, list[dict]]:
    """同一参数名在不同文件里写了不同的数值 → 冲突。只看“参数名 + 数值单位”这种明确的写法。"""
    seen: dict[str, list[dict]] = {}
    pat = re.compile(r"([一-鿿A-Za-z]{2,8})\s*[:：,，为是]?\s*" + _VALUE)
    for p in readable:
        for loc, block in p.blocks:
            for m in pat.finditer(block):
                label = m.group(1)
                value = f"{m.group(2)} {m.group(3)}"
                quote = m.group(0)
                entry = seen.setdefault(label, [])
                if not any(e["file"] == p.filename and _norm_value(e["value"]) == _norm_value(value) for e in entry):
                    entry.append({"file": p.filename, "locator": loc, "value": value, "quote": quote, "block": block})
    out = {}
    for label, entries in seen.items():
        values = {_norm_value(e["value"]) for e in entries}
        files = {e["file"] for e in entries}
        if len(values) >= 2 and len(files) >= 2:
            out[label] = entries
    return out


def detect_claims(readable: list[ParsedSource], zh_claims: list[dict]) -> list[dict]:
    out = []
    for c in zh_claims:
        for p in readable:
            for loc, block in p.blocks:
                m = re.search(c["cue"], block)
                if m:
                    sent = next((s for s in re.split(r"[。！!；;\n]", block) if m.group(0) in s), m.group(0)).strip()
                    out.append({"short": c["short"], "why": c["why"], "term": m.group(0), "file": p.filename, "locator": loc, "quote": sent[:60] or m.group(0)})
                    break
            else:
                continue
            break
    return out


def _merge_conflicts(facts: list[dict], conflicts: dict[str, list[dict]]) -> None:
    for gi, (label, entries) in enumerate(conflicts.items(), 1):
        group = f"C{gi}"
        # 去掉模型给出的同一参数的事实，改由系统按资料原文建冲突组
        facts[:] = [f for f in facts if not (label in f["source"]["quote"] or label in f["text"])]
        for e in entries:
            facts.append({"id": f"L{len(facts) + 1:02d}c", "short": f"{label} {e['value']}", "text": f"{label} {e['value']}",
                          "evidence_status": "conflicting", "group": group, "value": e["value"], "render": e["value"], "roadmap": False,
                          "source": {"file": e["file"], "locator": e["locator"], "quote": e["quote"]},
                          "user_decision": "pending", "decided_via": None, "user_text": None})


def _merge_claims(facts: list[dict], claims: list[dict]) -> None:
    for c in claims:
        if any(f["evidence_status"] == "unsupported" and (c["term"] in f["text"] or c["term"] in f["source"]["quote"]) for f in facts):
            continue
        facts.append({"id": f"L{len(facts) + 1:02d}u", "short": c["short"], "text": f"{c['short']}（{c['why']}）",
                      "evidence_status": "unsupported", "group": None, "value": None, "render": None, "roadmap": False,
                      "source": {"file": c["file"], "locator": c["locator"], "quote": c["quote"]},
                      "user_decision": "pending", "decided_via": None, "user_text": None})
