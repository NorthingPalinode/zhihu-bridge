import { useEffect, useState, type ReactNode } from "react";
import { buildBridgeRows } from "../lib/bridge";
import { ATTRIBUTION_LABEL, EXPORT_LABEL, LEVEL_LABEL, contentTypeLabel } from "../lib/labels";
import type { AudienceMeta, Check, Decision, Evidence, Level, RunSnapshot, Term, Variant } from "../lib/types";
import { IconArrow, IconBridge, IconChevron, IconShield } from "./icons";

interface Props {
  snap: RunSnapshot | null;
  dimmed: boolean;
  level: Level | null;
  audience: AudienceMeta | undefined;
  activeTermId: string | null;
  activeCheckId: string | null;
  onLevel: (l: Level) => void;
  onTerm: (id: string) => void;
  onCheck: (id: string | null) => void;
  onEvidence: (id: string) => void;
  running: boolean;
  errorText: string | null;
  onRetry: () => void;
}

export function CenterPanel(p: Props) {
  const snap = p.snap;
  const variant = snap?.variants.find((v) => v.level === p.level) ?? null;
  const literal = snap?.variants.find((v) => v.level === "literal") ?? null;
  const levels = (snap?.variants.map((v) => v.level).filter((l) => l !== "literal") ?? []) as Level[];
  const evById = new Map((snap?.evidence ?? []).map((e) => [e.id, e]));
  const terms = snap?.terms ?? [];
  const decisions = (snap?.decisions ?? []).filter(
    (d) => d.termId === p.activeTermId && (!d.levels.length || (p.level && d.levels.includes(p.level))),
  );
  const activeTerm = terms.find((t) => t.id === p.activeTermId);
  const [decisionId, setDecisionId] = useState<string | null>(null);
  useEffect(() => setDecisionId(null), [p.activeTermId, p.level]);
  const shownDecision = decisions.find((d) => d.id === decisionId) ?? decisions[0];

  return (
    <section className="panel" aria-labelledby="mid-h">
      <div className="panel-h">
        <span className="icon"><IconBridge /></span>
        <span className="step">02</span>
        <h2 id="mid-h">认知桥与选稿</h2>
      </div>

      {!snap && !p.running && p.errorText && (
        <div className="empty">
          {p.errorText}
          <div style={{ marginTop: 8 }}>
            <button className="btn small" onClick={p.onRetry}>重试</button>
          </div>
        </div>
      )}
      {!snap && p.running && <div className="empty">译稿生成中…</div>}

      {snap && (
        <div className={p.dimmed ? "dimmed" : undefined} aria-busy={p.dimmed}>
          {p.dimmed && <div className="muted" style={{ marginBottom: 6 }}>上一受众的结果</div>}
          <div className="audience-row">
            <span className="muted">受众 <b style={{ color: "var(--ink)" }}>{p.audience?.label ?? snap.audienceId}</b></span>
            {levels.length > 1 ? (
              <div className="seg" role="group" aria-label="选择档位">
                {levels.map((l) => (
                  <button key={l} aria-pressed={p.level === l} onClick={() => p.onLevel(l)}>
                    {LEVEL_LABEL[l]}
                    {snap.recommendedLevel === l && <span className="rec">推荐</span>}
                  </button>
                ))}
              </div>
            ) : (
              <span className="badge">{LEVEL_LABEL[levels[0] ?? "single"]}</span>
            )}
          </div>
          <div className="rec-line">
            当前受众推荐：{LEVEL_LABEL[snap.recommendedLevel]}
            {snap.recommendationReason && <> · {snap.recommendationReason}</>}
          </div>

          <Bridge variant={variant} terms={terms} decisions={snap.decisions} evidence={snap.evidence} activeTermId={p.activeTermId} onTerm={p.onTerm} />

          {activeTerm && shownDecision && (
            <div aria-live="polite">
              {decisions.length > 1 && (
                <div className="dec-tabs" role="group" aria-label={`「${activeTerm.surface}」的译法决策`}>
                  <span className="muted">译法决策 {decisions.length} 条：</span>
                  {decisions.map((d) => (
                    <button key={d.id} aria-pressed={d.id === shownDecision.id} onClick={() => setDecisionId(d.id)}>
                      {d.id} · {d.title}
                    </button>
                  ))}
                </div>
              )}
              <DecisionCard d={shownDecision} evById={evById} onEvidence={p.onEvidence} />
            </div>
          )}
          {activeTerm && decisions.length === 0 && (
            <div className="decision"><span className="muted">「{activeTerm.surface}」在{p.level ? LEVEL_LABEL[p.level] : "当前档"}没有单独的译法决策。</span></div>
          )}

          {variant && (
            <div className="draft">
              <div className="draft-label">
                <span>译稿（{LEVEL_LABEL[variant.level]}）</span>
                <span className={`badge${variant.exportState === "exportable" ? " zhihu" : " cand"}`}>{EXPORT_LABEL[variant.exportState]}</span>
                {snap.provenance === "dev_stub" && <span className="badge stub">开发占位 · 非模型输出</span>}
                {snap.mode === "replay" && snap.frozenAt && <span className="badge">冻结于 {snap.frozenAt}</span>}
              </div>
              <p className="draft-text" lang="en">
                {variant.segments.map((s, i) => {
                  const isActive = !!p.activeTermId && s.termIds.includes(p.activeTermId);
                  return s.termIds.length ? (
                    <span key={i} className={`seg-term${isActive ? " hl" : ""}`} onClick={() => p.onTerm(s.termIds[0])}>
                      {s.text}
                    </span>
                  ) : (
                    <span key={i}>{s.text}</span>
                  );
                })}
              </p>
              {snap.provenance === "dev_stub" && snap.caseId && (
                <div className="fineprint">开发占位：英文取自 V6 验收参考译稿，是评判方向参考，不是模型生成结果。</div>
              )}
              {variant.notes.length > 0 && (
                <Collapse title="字幕外注释">
                  {variant.notes.map((n, i) => (
                    <div key={i}>
                      <div lang="en" className="literal">{n.text}</div>
                      <div className="muted">依据：{n.evidenceIds.map((id) => evLabel(evById.get(id))).join("、") || "无"}</div>
                    </div>
                  ))}
                </Collapse>
              )}
              <Checks variant={variant} activeCheckId={p.activeCheckId} onCheck={p.onCheck} keyPoints={snap.keyPoints.map((k) => k.id)} />
              {literal && (
                <Collapse title="直译参照 · 不可复制">
                  <div className="literal" lang="en">{literal.segments.map((s) => s.text).join("")}</div>
                  <div className="muted">只用于对照和模拟读者测试，不提供复制。</div>
                </Collapse>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function evLabel(e: Evidence | undefined): string {
  if (!e) return "未知证据";
  return `${contentTypeLabel(e)}${e.title ? ` · ${e.title}` : ""}`;
}

function Bridge({
  variant,
  terms,
  decisions,
  evidence,
  activeTermId,
  onTerm,
}: {
  variant: Variant | null;
  terms: Term[];
  decisions: Decision[];
  evidence: Evidence[];
  activeTermId: string | null;
  onTerm: (id: string) => void;
}) {
  if (!variant || !terms.length) return null;
  const rows = buildBridgeRows(variant, terms, decisions, evidence).filter((r) => r.landing || r.removed);
  if (!rows.length) return null;
  return (
    <div className="bridge" role="list" aria-label="认知桥">
      {rows.map((row) => (
        <button key={row.term.id} role="listitem" className={`b-row${activeTermId === row.term.id ? " active" : ""}`} onClick={() => onTerm(row.term.id)} aria-pressed={activeTermId === row.term.id}>
          <span className="b-zh" lang="zh-CN">{row.term.surface}</span>
          <span className="b-arrow"><IconArrow /></span>
          <span className="b-en" lang={row.removed ? "zh-CN" : "en"}>
            {row.removed ? <><s>{row.removedSpan ?? row.term.surface}</s> 已移除</> : row.landing}
          </span>
        </button>
      ))}
    </div>
  );
}

function DecisionCard({ d, evById, onEvidence }: { d: Decision; evById: Map<string, Evidence>; onEvidence: (id: string) => void }) {
  const evs = d.evidenceIds.map((id) => evById.get(id)).filter(Boolean) as Evidence[];
  return (
    <div className="decision fade-in">
      <h3>
        <span className="idtag">{d.id}</span> {d.title}
      </h3>
      <div className="kv">
        <span>选择</span>
        <span>{d.choice}</span>
        <span>理由</span>
        <span>{d.rationale}</span>
        <span>依据</span>
        <span>
          {evs.length === 0 && "无外部依据"}
          {evs.map((e, i) => (
            <span key={e.id}>
              {i > 0 && "、"}
              <a href={`#ev-${e.id}`} onClick={(ev) => { ev.preventDefault(); onEvidence(e.id); }}>{evLabel(e)}</a>
            </span>
          ))}
        </span>
        <span>归因</span>
        <span className={`attr ${d.attribution}`}>{ATTRIBUTION_LABEL[d.attribution]}</span>
      </div>
    </div>
  );
}

function Checks({ variant, activeCheckId, onCheck, keyPoints }: { variant: Variant; activeCheckId: string | null; onCheck: (id: string | null) => void; keyPoints: string[] }) {
  const fid = variant.checks.filter((c) => c.kind === "fidelity");
  const claims = variant.checks.filter((c) => c.kind === "claim");
  return (
    <div className="checks">
      {(fid.length > 0 || keyPoints.length > 0) && (
        <div className="check-row">
          <span className="st" style={{ minWidth: 64 }}>保真检查</span>
          <span>
            {fid.map((c) => (
              <span key={c.id} style={{ marginRight: 10 }} title={c.reason}>
                {c.label}{" "}
                <span className={`st ${c.status}`}>{c.status === "pass" ? "✓ 通过" : c.status === "warn" ? "! 待核对" : "✗ 未通过"}</span>
              </span>
            ))}
            {fid.length === 0 && <span className="muted">无</span>}
          </span>
        </div>
      )}
      <div className="sub" style={{ marginTop: 10 }}>
        <IconShield /> 声称守门 <span className="muted">编号可点击，查看原候选 → 规则 → 理由 → 终稿</span>
      </div>
      {claims.map((c) => {
        const open = activeCheckId === c.id;
        return (
          <div key={c.id}>
            <div className="check-row">
              <button className="lab" aria-expanded={open} onClick={() => onCheck(open ? null : c.id)}>{c.label ?? c.id}</button>
              <span className={`st ${c.status}`}>{c.status === "pass" ? "通过" : c.status === "warn" ? "提醒" : "拦截"}</span>
              <span style={{ flex: 1 }}>
                {c.span ?? c.reason}
                {c.action !== "none" && <span className="muted"> · {ACTION[c.action]}</span>}
              </span>
            </div>
            {open && (
              <div className="chain fade-in">
                <span>原候选</span>
                <span>{c.span ?? "—"}{variant.candidateText && <><br /><span className="literal">{variant.candidateText}</span></>}</span>
                <span>命中规则</span>
                <span>{c.rule ?? "—"}</span>
                <span>处理理由</span>
                <span>{c.reason}</span>
                <span>终稿</span>
                <span className="final" lang="en">{c.finalText ?? variant.segments.map((s) => s.text).join("")}</span>
              </div>
            )}
          </div>
        );
      })}
      <div className="fineprint">本功能只是编辑预检，不构成法律或合规意见。</div>
    </div>
  );
}

const ACTION: Record<Check["action"], string> = { none: "无需处理", remove: "移除", rewrite: "改写", needs_data: "待补材料", review: "人工复核" };

function Collapse({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="collapse">
      <button aria-expanded={open} onClick={() => setOpen(!open)}>
        <IconChevron open={open} /> {title}
      </button>
      {open && <div className="content fade-in">{children}</div>}
    </div>
  );
}
