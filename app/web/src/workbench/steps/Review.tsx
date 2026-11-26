import { useEffect, useState } from "react";
import { api } from "../api";
import { SECTION_NAMES, SEVERITY, decisionTitle, isAutoFix } from "../copy";
import { useWb } from "../context";
import { BasisList, DecisionCard, Reasons } from "../Decision";
import { Icon } from "../icons";
import type { Basis, Workspace } from "../types";

type Group = "need" | "sys" | "kept" | "done";
interface Row { key: string; group: Group; title: string; sub: string; dot: string }

export function reviewRows(ws: Workspace): Row[] {
  const rows: Row[] = [];
  const open = new Set(ws.summary.open_decisions);
  for (const d of ws.decisions) {
    const t = decisionTitle(ws, d.id);
    rows.push({ key: d.id, group: open.has(d.id) ? "need" : "done", title: t.title, sub: t.sub, dot: open.has(d.id) ? "need" : "" });
  }
  for (const i of ws.issues.filter((x) => x.fix_kind === "user_introduced")) {
    const k = `x:${i.id}`;
    const g: Group = i.status === "open" ? "need" : i.status === "kept" ? "kept" : "done";
    rows.push({ key: k, group: g, title: `你写的 “${i.term}”`, sub: SECTION_NAMES[i.asset], dot: g === "need" ? "need" : g === "kept" ? "risk" : "" });
  }
  for (const i of ws.issues.filter(isAutoFix)) {
    rows.push({ key: i.id, group: i.status === "kept" ? "kept" : "sys", title: i.title, sub: i.loc, dot: i.status === "kept" ? "risk" : "" });
  }
  for (const b of ws.blocked) rows.push({ key: `b:${b.id}`, group: "sys", title: b.title, sub: "资料里没有任何证明", dot: "block" });
  return rows;
}

const GROUPS: [Group, string, string][] = [["need", "需要你决定", "need"], ["sys", "系统已替你处理", ""], ["kept", "你保留了原句", ""], ["done", "你已决定", ""]];

export function Review() {
  const { ws, reviewSel, setReviewSel, busy } = useWb();
  const rows = reviewRows(ws);
  const sel = rows.find((r) => r.key === reviewSel) ?? rows.find((r) => r.group === "need") ?? rows[0];
  useEffect(() => { if (sel && sel.key !== reviewSel) setReviewSel(sel.key); }, [sel, reviewSel, setReviewSel]);
  const count = (g: Group) => rows.filter((r) => r.group === g).length;
  return (
    <>
      <div className="kstrip">
        <span className="k need"><b>{count("need")}</b>需要你决定</span>
        <span className="k ok"><b>{count("sys")}</b>系统已替你处理</span>
        {count("kept") > 0 && <span className="k risk"><b>{count("kept")}</b>你保留了原句</span>}
        <span className="mods">{ws.assets.map((a) => <span key={a.id}><i className={busy.has(a.id) ? "busy" : a.need ? "need" : ""} />{a.title}</span>)}</span>
      </div>
      <div className="panelset wide-left">
        <div className="col"><div className="panel">
          <ul className="issues">
            {GROUPS.map(([g, label, cls]) => {
              const list = rows.filter((r) => r.group === g);
              if (!list.length) return null;
              return [
                <li key={`h-${g}`} className={`ig-h ${cls}`}>{label} · {list.length}</li>,
                ...list.map((r) => (
                  <li key={r.key}>
                    <button type="button" className={`issue${r.key === sel?.key ? " is-current" : ""}`} onClick={() => setReviewSel(r.key)}>
                      <span className={`sev ${r.dot}`} /><span className="q">{r.title}</span><span className="meta">{r.sub}</span>
                    </button>
                  </li>
                )),
              ];
            })}
          </ul>
        </div></div>
        <div className="col"><div className="panel review-detail" aria-live="polite">{sel && <Detail rowKey={sel.key} />}</div></div>
      </div>
    </>
  );
}

const Sec = ({ h, children }: { h: string; children: React.ReactNode }) => <div className="detail-sec"><h4>{h}</h4>{children}</div>;

function Detail({ rowKey }: { rowKey: string }) {
  const { ws, run, goStep, setReviewSel, toast } = useWb();
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    setAsking(false);
    // 自动选中下一件后，焦点落到推荐选项上，但不滚动页面（DESIGN.md §9）。
    const target = document.querySelector<HTMLElement>(".review-detail .opt.primary, .review-detail [data-primary]");
    target?.focus({ preventScroll: true });
  }, [rowKey]);
  const next = () => { const n = ws.summary.open_decisions.find((k) => k !== rowKey); if (n) setReviewSel(n); };

  const fix = ws.issues.find((i) => i.id === rowKey && isAutoFix(i));
  if (fix) {
    const kept = fix.status === "kept";
    return (
      <>
        <div className="panel-h"><h3>{kept ? <span className="tag st-danger">你保留了原句</span> : <span className="tag st-ok">系统已替你处理</span>}<span className="tag st-neutral">{SEVERITY[fix.severity]}风险</span></h3><span className="meta">{fix.loc}</span></div>
        <Sec h="原句定位"><div className="ctx en"><span className="loc">{SECTION_NAMES[fix.asset]}</span><mark>{fix.original}</mark></div></Sec>
        <Sec h="为什么改"><p style={{ margin: 0 }}>{fix.why}</p></Sec>
        {fix.basis && <Sec h="依据（按来源分层）"><BasisList basis={fix.basis} /></Sec>}
        <Sec h="修改对照"><div className="diff en"><div className="old"><span>−</span><span>{fix.original}</span></div><div className="new"><span>+</span><span>{fix.applied}</span></div></div></Sec>
        <Sec h="处置">
          {kept ? (
            <><div className="resolved" style={{ color: "var(--status-danger)" }}><Icon name="alert" />你保留了原句 · 理由：{fix.keep_reason}</div>
              <div className="actions" style={{ marginTop: 10 }}><button type="button" className="btn btn-primary" onClick={() => run(() => api.reapply(ws.id, fix.id), [fix.asset])}>按系统建议改</button></div></>
          ) : (
            <><div className="resolved"><Icon name="check" />已按系统建议改写，英文页里是绿色虚线</div>
              <div className="actions" style={{ marginTop: 10 }}>
                <button type="button" className="btn" onClick={() => goStep("content")}>在英文页里看</button>
                <button type="button" className="btn btn-ghost" onClick={() => (fix.severity === "high" ? setAsking(true) : run(() => api.undoFix(ws.id, fix.id), [fix.asset]))}><Icon name="undo" small />恢复原句…</button>
              </div>
              {asking && <Reasons intro="原句没有依据，恢复后会以红色标出，并写进检查报告。请选一个理由：" onPick={(r) => run(() => api.undoFix(ws.id, fix.id, r), [fix.asset])} />}</>
          )}
        </Sec>
      </>
    );
  }

  if (rowKey.startsWith("b:")) {
    const b = ws.blocked.find((x) => `b:${x.id}` === rowKey)!;
    return (
      <>
        <div className="panel-h"><h3><span className="tag st-neutral">已挡下</span></h3><span className="meta">产品资料</span></div>
        <Sec h="资料原文"><div className="ctx"><span className="loc">{b.quote.file} · {b.quote.locator}</span><mark>{b.quote.quote}</mark></div></Sec>
        <Sec h="为什么挡下"><p style={{ margin: 0 }}>{b.why}</p></Sec>
        <Sec h="依据（按来源分层）"><BasisList basis={b.basis} /></Sec>
        <Sec h="处置"><div className="actions"><button type="button" className="btn" onClick={() => toast("骨架阶段暂未开放补充资料。正式版补充证书后，系统会重新判断并更新英文页")}>有证书？补充资料</button></div></Sec>
      </>
    );
  }

  const t = decisionTitle(ws, rowKey);
  const open = ws.summary.open_decisions.includes(rowKey);
  const facts = Object.fromEntries(ws.facts.map((f) => [f.id, f]));
  let ctx: React.ReactNode = null;
  let basis: Basis[] = [];
  if (rowKey.startsWith("x:")) {
    const i = ws.issues.find((x) => `x:${x.id}` === rowKey)!;
    ctx = <div className="ctx en"><span className="loc">{SECTION_NAMES[i.asset]}</span><mark>{i.term}</mark></div>;
    basis = [["company", "你的资料", `${ws.sources.filter((s) => s.status === "parsed").length} 份资料`, `${i.why}。`]];
  } else {
    const d = ws.decisions.find((x) => x.id === rowKey)!;
    if (d.kind === "confirm_facts") {
      ctx = <div className="ctx">{(d.fact_ids ?? []).map((id) => <div key={id}>{facts[id]?.user_text ?? facts[id]?.text}</div>)}</div>;
      basis = (d.fact_ids ?? []).map((id) => ["company", "你的资料", `${facts[id]?.source.file} · ${facts[id]?.source.locator}`, facts[id]?.text ?? ""] as Basis);
    } else {
      ctx = <div className="ctx"><span className="loc">英文页里在等它</span>{d.used_in}</div>;
      basis = (d.options ?? []).filter((o) => o.fact).map((o) => ["company", "你的资料", facts[o.fact!]?.source ? `${facts[o.fact!].source.file} · ${facts[o.fact!].source.locator}` : "", facts[o.fact!]?.text ?? ""] as Basis);
    }
  }
  return (
    <>
      <div className="panel-h"><h3>{open ? <span className="tag st-warn">需要你决定</span> : <span className="tag st-ok">你已决定</span>}<span>{t.title}</span></h3><span className="meta">{t.sub}</span></div>
      <Sec h="在英文页里的位置">{ctx}</Sec>
      <Sec h="依据（按来源分层）"><BasisList basis={basis} /></Sec>
      <Sec h={open ? "选一个" : "你的决定"}><DecisionCard dkey={rowKey} onDecided={next} /></Sec>
    </>
  );
}
