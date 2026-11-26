import { useState } from "react";
import { api } from "./api";
import { KEEP_REASONS, LAYER_CLASS, decisionDone } from "./copy";
import { useWb } from "./context";
import { Icon } from "./icons";
import type { Basis, Issue } from "./types";

/** 同一个决定卡片用在：第 1 步决定区、第 3 步正文占位弹层、第 4 步检查详情（DESIGN.md §9）。 */
export function DecisionCard({ dkey, onDecided }: { dkey: string; onDecided?: () => void }) {
  const { ws, run } = useWb();
  const [custom, setCustom] = useState<string | null>(null);
  const [keeping, setKeeping] = useState(false);
  const decide = async (value: string | null, extra: { custom?: string; reason?: string } = {}, busy: string[] = []) => {
    const ok = await run(() => api.decide(ws.id, dkey, value, extra), busy);
    if (ok && value !== null) onDecided?.();
  };

  if (dkey.startsWith("x:")) {
    const iss = ws.issues.find((i) => i.id === dkey.slice(2));
    if (!iss) return null;
    if (iss.status !== "open") {
      return (
        <div className="dcard"><div className="decided"><Icon name="check" />
          {iss.status === "resolved" ? `已换成 “${iss.suggestion}”` : `你保留了 “${iss.term}”，理由：${iss.keep_reason}`}
        </div></div>
      );
    }
    return (
      <div className="dcard">
        <h4>你刚写的 “{iss.term}” 没有依据</h4>
        <p>{iss.why}。在「{iss.loc}」里。</p>
        <div className="opts">
          <button type="button" className="opt primary" onClick={() => decide("fix", {}, [iss.asset])}><b>换成 “{iss.suggestion}”</b><span className="rec">推荐</span></button>
          <button type="button" className="opt" onClick={() => setKeeping(true)}><b>仍然保留</b><span /><small>需要选一个理由，会写进检查报告</small></button>
        </div>
        {keeping && <Reasons onPick={(r) => decide("keep", { reason: r })} />}
      </div>
    );
  }

  const d = ws.decisions.find((x) => x.id === dkey);
  if (!d) return null;
  if (d.value !== null) {
    return (
      <div className="dcard"><div className="decided"><Icon name="check" />{decisionDone(d)}
        <button type="button" className="link" onClick={() => decide(null)}>{d.kind === "confirm_facts" ? "撤销" : "改一下"}</button>
      </div></div>
    );
  }
  if (d.kind === "confirm_facts") {
    return (
      <div className="dcard">
        <h4>这 {d.fact_ids?.length} 条产品事实读得对吗？</h4>
        <p>系统从你的资料里读出来，英文页已经用上。你确认后才算可以发布；哪条不对，到「产品资料」里点“不对？”改。</p>
        <button type="button" className="btn btn-primary" data-primary style={{ width: "100%" }} onClick={() => decide("confirmed")}>
          <Icon name="check" small />都对，确认这 {d.fact_ids?.length} 条
        </button>
      </div>
    );
  }
  const affected = d.kind === "conflict" ? ["story", "specs", "faq"] : ["features", "faq"];
  return (
    <div className="dcard">
      <h4>{d.title}</h4>
      <p>{d.why}</p>
      <div className="opts">
        {d.options?.map((o) => (
          <button type="button" key={o.value} className={`opt${o.recommended ? " primary" : ""}`} onClick={() => decide(o.value, {}, affected)}>
            <b>{o.label}</b>{o.recommended ? <span className="rec">推荐</span> : <span />}
            {o.source && <small>来自 {o.source}</small>}
            {o.preview && <small className="en">{o.preview}</small>}
            {o.note && <small>{o.note}</small>}
          </button>
        ))}
        {d.allow_custom && <button type="button" className="opt" onClick={() => setCustom("")}><b>都不对，我来填</b><span /></button>}
      </div>
      {custom !== null && (
        <CustomValue onCancel={() => setCustom(null)} onSave={(v) => decide("custom", { custom: v }, affected)} />
      )}
    </div>
  );
}

function CustomValue({ onSave, onCancel }: { onSave: (v: string) => void; onCancel: () => void }) {
  const [v, setV] = useState("");
  const [bad, setBad] = useState(false);
  const save = () => (v.trim() ? onSave(v.trim()) : setBad(true));
  return (
    <div className="inline-edit">
      <input autoFocus value={v} aria-label="自己填写的数值" placeholder={bad ? "先填一个数值" : "例如 3.4 g（8 号指围）"}
        style={bad ? { borderColor: "var(--status-danger)" } : undefined}
        onChange={(e) => { setV(e.target.value); setBad(false); }} onKeyDown={(e) => e.key === "Enter" && save()} />
      <div className="row">
        <button type="button" className="btn btn-sm btn-ghost" onClick={onCancel}>取消</button>
        <button type="button" className="btn btn-sm btn-primary" onClick={save}>用这个</button>
      </div>
    </div>
  );
}

export function Reasons({ onPick, intro }: { onPick: (code: string) => void; intro?: string }) {
  return (
    <div style={{ marginTop: 10 }}>
      {intro && <p style={{ margin: "0 0 4px", fontSize: 13 }}>{intro}</p>}
      <div className="reasons" role="group" aria-label="保留理由">
        {KEEP_REASONS.map(([code, label]) => <button type="button" key={code} onClick={() => onPick(code)}>{label}</button>)}
      </div>
    </div>
  );
}

export function BasisList({ basis }: { basis: Basis[] }) {
  return (
    <ul className="basis">
      {basis.map((b, i) => (
        <li key={i}><div><span className={`ly ${LAYER_CLASS[b[0]]}`}>{b[1]}</span><span className="mode">{b[2]}</span></div><div>{b[3]}</div></li>
      ))}
    </ul>
  );
}

function PopHead({ icon, color, title }: { icon: string; color: string; title: string }) {
  const { closePop } = useWb();
  return (
    <div className="pop-h"><Icon name={icon} style={{ color }} />{title}<span className="grow" />
      <button type="button" className="btn btn-ghost btn-sm" data-pclose aria-label="关闭" onClick={closePop}><Icon name="x" /></button>
    </div>
  );
}

/** 正文绿色虚线 / 红色原句的弹层：原句、原因、依据、恢复或改回。 */
export function FixPop({ issue }: { issue: Issue }) {
  const { ws, run, closePop } = useWb();
  const [asking, setAsking] = useState(false);
  const restore = (reason?: string) => { closePop(); void run(() => api.undoFix(ws.id, issue.id, reason), [issue.asset]); };
  if (issue.status === "kept") {
    return (
      <>
        <PopHead icon="alert" color="var(--status-danger)" title="你保留了原句" />
        <div className="pop-b"><p>{issue.why}</p><div><h5>你的理由</h5><p>{issue.keep_reason}</p></div></div>
        <div className="pop-f"><button type="button" className="btn btn-primary btn-sm" onClick={() => { closePop(); void run(() => api.reapply(ws.id, issue.id), [issue.asset]); }}>按系统建议改</button></div>
      </>
    );
  }
  return (
    <>
      <PopHead icon="check" color="var(--status-success)" title="系统改过这里" />
      <div className="pop-b">
        <div><h5>原来写的是</h5><p className="en"><del>{issue.original}</del></p></div>
        <div><h5>为什么改</h5><p>{issue.why}</p></div>
        {issue.basis && <div><h5>依据</h5><BasisList basis={issue.basis} /></div>}
        {asking && <Reasons intro="原句没有依据，恢复后会以红色标出，并写进检查报告。请选一个理由：" onPick={restore} />}
      </div>
      <div className="pop-f">
        <button type="button" className="btn btn-sm" onClick={() => (issue.severity === "high" ? setAsking(true) : restore())}><Icon name="undo" small />恢复原句</button>
        <button type="button" className="btn btn-sm btn-primary" data-pclose onClick={closePop}>好的</button>
      </div>
    </>
  );
}

export function DecisionPop({ dkey }: { dkey: string }) {
  const { closePop } = useWb();
  return (
    <>
      <PopHead icon="hand" color="var(--need)" title="等你决定" />
      <div className="pop-b"><DecisionCard dkey={dkey} onDecided={closePop} /></div>
    </>
  );
}
