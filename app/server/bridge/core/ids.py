"""引用校验（V6 §6.4 后端约束）：segments / decisions / notes 只能引用本快照已有的 termId / evidenceId。"""
from __future__ import annotations


class ReferenceError_(ValueError):
    pass


def validate_references(variants, decisions, term_ids: set[str], evidence_ids: set[str]) -> None:
    decision_ids = {d.id for d in decisions}
    for d in decisions:
        if d.termId not in term_ids:
            raise ReferenceError_(f"决策 {d.id} 引用了未知术语 {d.termId}")
        bad = [e for e in d.evidenceIds if e not in evidence_ids]
        if bad:
            raise ReferenceError_(f"决策 {d.id} 引用了未知证据 {bad}")
    for v in variants:
        for s in v.segments:
            bad_t = [t for t in s.termIds if t not in term_ids]
            bad_e = [e for e in s.evidenceIds if e not in evidence_ids]
            if bad_t or bad_e:
                raise ReferenceError_(f"{v.level} 片段引用了未知 ID：术语 {bad_t} 证据 {bad_e}")
            if s.decisionId and s.decisionId not in decision_ids:
                raise ReferenceError_(f"{v.level} 片段引用了未知决策 {s.decisionId}")
        for n in v.notes:
            bad_e = [e for e in n.evidenceIds if e not in evidence_ids]
            if bad_e:
                raise ReferenceError_(f"{v.level} 注释引用了未知证据 {bad_e}")
