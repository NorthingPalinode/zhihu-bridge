import { ROLE_LABEL, TERM_KIND_LABEL, contentTypeLabel, evidenceSourceLabel } from "../lib/labels";
import type { Check, Evidence, KeyPoint, SourceSegment, Term } from "../lib/types";
import { IconChevron, IconDoc } from "./icons";

interface Props {
  segments: SourceSegment[];
  terms: Term[];
  keyPoints: KeyPoint[];
  evidence: Evidence[];
  claimChecks: Check[];
  activeTermId: string | null;
  activeCheckId: string | null;
  openEvidenceId: string | null;
  notices: string[];
  loading: boolean;
  onTerm: (id: string) => void;
  onEvidence: (id: string | null) => void;
}

export function LeftPanel(p: Props) {
  const termById = new Map(p.terms.map((t) => [t.id, t]));
  const claimByTerm = new Map(p.claimChecks.filter((c) => c.termId).map((c) => [c.termId as string, c]));
  const activeCheck = p.claimChecks.find((c) => c.id === p.activeCheckId);
  const hasAnchors = p.keyPoints.length === 0 && p.terms.length > 0;
  return (
    <section className="panel" aria-labelledby="left-h">
      <div className="panel-h">
        <span className="icon"><IconDoc /></span>
        <span className="step">01</span>
        <h2 id="left-h">原文与知乎证据</h2>
      </div>
      <div className="sub">原文 <span className="muted">点击术语查看译法与依据</span></div>
      <div className="source" lang="zh-CN">
        {p.segments.length === 0 && <span className="muted">{p.loading ? "正在识别术语…" : "—"}</span>}
        {p.segments.map((s, i) => {
          if (!s.termId) return <span key={i}>{s.text}</span>;
          const t = termById.get(s.termId);
          const chk = claimByTerm.get(s.termId);
          const struck = !!chk && chk.action === "remove" && !!chk.finalText;
          const active = p.activeTermId === s.termId || (activeCheck && activeCheck.termId === s.termId);
          return (
            <span
              key={i}
              role="button"
              tabIndex={0}
              className={`term k-${t?.kind ?? "culture"}${active ? " active" : ""}${struck ? " struck" : ""}`}
              aria-pressed={!!active}
              onClick={() => p.onTerm(s.termId as string)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  p.onTerm(s.termId as string);
                }
              }}
              title={t ? TERM_KIND_LABEL[t.kind] : undefined}
            >
              {s.text}
              {chk?.label && chk.kind === "claim" && <sup>{chk.label}</sup>}
            </span>
          );
        })}
      </div>

      {p.keyPoints.length > 0 && (
        <>
          <div className="sub">信息点 <span className="muted">保真检查项</span></div>
          <ul className="kp-list">
            {p.keyPoints.map((k) => (
              <li key={k.id}>
                <span className="idtag">{k.id}</span>
                <span>{k.text}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {hasAnchors && (
        <>
          <div className="sub">锚点</div>
          <ul className="kp-list">
            {p.terms.map((t) => (
              <li key={t.id}>
                <span className="idtag">{TERM_KIND_LABEL[t.kind]}</span>
                <span>{t.surface}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="sub">知乎证据 <span className="muted">{p.evidence.length ? `${p.evidence.length} 条` : ""}</span></div>
      {p.evidence.length === 0 && <div className="empty">{p.loading ? "正在载入证据…" : "知乎证据不足"}</div>}
      {p.evidence.map((e) => (
        <EvidenceCard
          key={e.id}
          e={e}
          open={p.openEvidenceId === e.id}
          linked={!!p.activeTermId && e.termIds.includes(p.activeTermId)}
          onToggle={() => p.onEvidence(p.openEvidenceId === e.id ? null : e.id)}
        />
      ))}
      {p.notices.map((n) => (
        <div key={n} className={`notice${n.startsWith("开发占位") ? " stub" : ""}`}>{n}</div>
      ))}
    </section>
  );
}

function EvidenceCard({ e, open, linked, onToggle }: { e: Evidence; open: boolean; linked: boolean; onToggle: () => void }) {
  const src = evidenceSourceLabel(e);
  return (
    <article className={`ev-card${open ? " open" : ""}${linked ? " linked" : ""}`} id={`ev-${e.id}`}>
      <button className="ev-head" aria-expanded={open} onClick={onToggle}>
        <span className="row">
          <IconChevron open={open} />
          <span className="ev-type">{contentTypeLabel(e)}</span>
          <span className={`badge ${e.provider === "zhihu" ? "zhihu" : "other"}`}>{src}</span>
          <span className={`badge${e.role === "counterexample" ? " counter" : ""}`}>{ROLE_LABEL[e.role]}</span>
        </span>
        {e.title && <span className="ev-title">{e.title}</span>}
      </button>
      {open && (
        <div className="ev-body fade-in">
          <div>{e.summary}</div>
          <dl>
            <dt>能支撑</dt>
            <dd>{e.supports}</dd>
            <dt>不能支撑</dt>
            <dd>{e.limits}</dd>
            {e.author && (
              <>
                <dt>署名</dt>
                <dd>{e.author}</dd>
              </>
            )}
          </dl>
          <a href={e.url} target="_blank" rel="noopener noreferrer">
            {e.provider === "zhihu" ? "打开知乎原文 ↗" : "打开原文 ↗"}
          </a>
        </div>
      )}
    </article>
  );
}
