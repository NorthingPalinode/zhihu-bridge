"""守门与保真的确定性部分（V6 §6.7 第 1 步）。语义检查由模型适配器补充。"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional


@dataclass
class ClaimHit:
    zh: Optional[str]
    pattern: str
    match: str


@dataclass
class ComplianceHit:
    ruleId: str
    category: str          # "legal" | "custom"
    title: str
    jurisdiction: str
    severity: str          # "block" | "warn"
    action: str            # "rewrite" | "remove" | "review"
    matches: list[str]
    reason: str
    suggestion: str
    sourceOnly: bool = False


def scan_compliance_rules(
    target_text: str,
    source_text: str,
    lang_code: str,
    rules: list[dict],
) -> list[ComplianceHit]:
    """按 SQLite 风险规则库排查两类风险：当地法律法规（legal）与当地风俗习惯（custom）。

    - 优先扫描目标语言译稿（命中即按规则 severity/action 拦截改写或提醒）；
    - 对于风俗禁忌类规则，若中文原文提及目标市场明确禁忌物/概念且译稿未命中硬拦截，发出复核提醒。
    """
    hits: list[ComplianceHit] = []
    lang = (lang_code or "en").strip().lower()
    for rule in rules:
        if not rule.get("enabled", True):
            continue
        markets = rule.get("markets") or ["*"]
        if "*" not in markets and lang not in markets:
            continue
        matched: list[str] = []
        seen_low: set[str] = set()
        for pat in rule.get("patterns") or []:
            try:
                for m in re.finditer(pat, target_text, flags=re.IGNORECASE):
                    val = m.group(0).strip()
                    if val and val.lower() not in seen_low:
                        seen_low.add(val.lower())
                        matched.append(val)
            except re.error:
                continue
        if matched:
            hits.append(
                ComplianceHit(
                    ruleId=rule["ruleId"],
                    category=rule["category"],
                    title=rule["title"],
                    jurisdiction=rule["jurisdiction"],
                    severity=rule.get("severity", "block"),
                    action=rule.get("action", "rewrite" if rule.get("severity", "block") == "block" else "review"),
                    matches=matched[:4],
                    reason=rule["reason"],
                    suggestion=rule.get("suggestion", ""),
                    sourceOnly=False,
                )
            )
            continue

        # 仅对“风俗习惯”规则检查中文原文是否提及目标市场高度敏感元素（如清真市场的猪肉/酒精），以提醒复核而非盲目掐断。
        if rule.get("category") == "custom" and source_text:
            zh_hits = [cue for cue in (rule.get("zhCues") or []) if cue and cue in source_text]
            if zh_hits:
                hits.append(
                    ComplianceHit(
                        ruleId=rule["ruleId"],
                        category="custom",
                        title=rule["title"],
                        jurisdiction=rule["jurisdiction"],
                        severity="warn",
                        action="review",
                        matches=zh_hits[:4],
                        reason=f"原文含目标市场风俗敏感元素（{' / '.join(zh_hits[:4])}）：{rule['reason']}",
                        suggestion=rule.get("suggestion", ""),
                        sourceOnly=True,
                    )
                )
    return hits


def scan_zh_claims(text: str, lexicon: dict) -> list[str]:
    """返回原文中出现的中文功效词（按长词优先去重，例如“清热解毒”覆盖“清热”“解毒”）。"""
    words = sorted(lexicon.get("zh", []), key=len, reverse=True)
    found: list[str] = []
    covered: list[tuple[int, int]] = []
    for w in words:
        start = 0
        while True:
            i = text.find(w, start)
            if i < 0:
                break
            span = (i, i + len(w))
            if not any(a <= span[0] and span[1] <= b for a, b in covered):
                covered.append(span)
                if w not in found:
                    found.append(w)
            start = i + 1
    return found


def scan_target_claims(text: str, lang_code: str, lexicon: dict) -> list[ClaimHit]:
    hits = []
    seen: set[tuple[int, int]] = set()
    # 扫描目标语言词表；非英语时若译稿夹带英文功效词（如 detox），一并拦截。
    buckets = [lang_code] if lang_code == "en" else [lang_code, "en"]
    for bucket in buckets:
        for entry in lexicon.get(bucket, []):
            for m in re.finditer(entry["pattern"], text, flags=re.IGNORECASE):
                span = (m.start(), m.end())
                if span in seen:
                    continue
                seen.add(span)
                hits.append(ClaimHit(zh=entry.get("zh"), pattern=entry["pattern"], match=m.group(0)))
    return hits


def scan_en_claims(text: str, lexicon: dict) -> list[ClaimHit]:
    return scan_target_claims(text, "en", lexicon)


def fidelity_hits(text: str, rules: dict) -> dict[str, bool]:
    """KP 保真的确定性信号：例如 KP2 必须保留 nine/ninefold（V6 §6.7）。"""
    low = text.lower()
    out = {}
    for kp, rule in rules.items():
        if "any" in rule:
            out[kp] = any(w in low for w in rule["any"])
        elif "all" in rule:
            out[kp] = all(any(w in low for w in group) for group in rule["all"])
        else:
            out[kp] = True
    return out


def forbidden_hits(text: str, patterns: list[dict]) -> list[dict]:
    return [p for p in patterns if re.search(p["pattern"], text, flags=re.IGNORECASE)]
