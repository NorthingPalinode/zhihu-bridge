import { useState } from "react";
import { api } from "../api";
import { useWb } from "../context";
import { DecisionCard } from "../Decision";
import { Icon } from "../icons";
import type { Fact } from "../types";

export function Materials() {
  const { ws, toast } = useWb();
  const parsed = ws.sources.filter((s) => s.status === "parsed").length;
  const unread = ws.sources.length - parsed;
  const stub = (what: string) => toast(`骨架阶段暂未开放${what}。正式版补充后，系统会自动更新事实，并重写、重查受影响的句子`);
  return (
    <div className="panelset main-right">
      <div className="col">
        <div className="panel">
          <div className="panel-h"><h3>原始资料</h3><span className="meta">{parsed} 份已读取{unread ? ` · ${unread} 份读不出` : ""}</span></div>
          <ul className="src-list">
            {ws.sources.map((s) => (
              <li key={s.filename}>
                <Icon name="file" />
                <div>
                  <b>{s.filename}</b>
                  <small>{s.status === "parsed" ? s.size : s.note}</small>
                  {s.status !== "parsed" && (
                    <div className="acts"><button type="button" className="link" onClick={() => stub("粘贴补充")}>粘贴其中文字</button></div>
                  )}
                </div>
                <span className={`tag ${s.status === "parsed" ? "st-ok" : "st-neutral"}`}>{s.status === "parsed" ? "已读取" : "未使用"}</span>
              </li>
            ))}
          </ul>
          <div className="drop"><Icon name="upload" style={{ verticalAlign: -3 }} /> 拖入 .txt / .md / .csv / .docx 补充资料<small>补充后系统会自动更新事实，并重写、重查受影响的句子（骨架阶段暂未开放）</small></div>
        </div>
        {(ws.blocked.length > 0 || ws.gaps.length > 0) && (
          <div className="panel">
            <div className="panel-h"><h3>系统已替你处理</h3><span className="meta">资料相关</span></div>
            <ul className="alerts">
              {ws.blocked.map((b) => (
                <li key={b.id}><span className="tag st-neutral">已挡下</span><b>“{b.short}”</b>
                  <p>只出现在{b.quote.file.includes("营销") ? "营销初稿" : "资料"}里，资料中没有任何证明。英文页不会出现这类说法。<button type="button" className="link" onClick={() => stub("补充证书")}>有证书？补充资料</button></p></li>
              ))}
              {ws.gaps.map((g) => (
                <li key={g.id}><span className="tag st-neutral">不写</span><b>{g.title}</b><p>{g.why}<button type="button" className="link" onClick={() => stub("上传实测报告")}>上传实测报告</button></p></li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <div className="col"><FactPanel /></div>
    </div>
  );
}

function FactPanel() {
  const { ws } = useWb();
  const pendingDecisions = ws.decisions.filter((d) => d.kind !== "confirm_facts");
  const need = pendingDecisions.filter((d) => d.value === null).length;
  const confirm = ws.decisions.find((d) => d.kind === "confirm_facts");
  const factsById = Object.fromEntries(ws.facts.map((f) => [f.id, f]));
  const okFacts = (confirm?.fact_ids ?? []).map((id) => factsById[id]).filter(Boolean);
  const notUsed = ws.facts.filter((f) => f.evidence_status === "unsupported" || f.user_decision === "rejected");
  return (
    <div className="panel">
      <div className="panel-h"><h3>产品事实</h3><span className="meta">系统从资料里读出 {ws.facts.length} 条，只有下面这些需要你</span></div>
      {pendingDecisions.length > 0 && (
        <div className="fg">
          <div className={`fg-h${need ? " need" : ""}`}><Icon name="hand" small />{need ? "需要你决定" : "你的决定"}{need > 0 && <span className="count">{need}</span>}<span className="grow" /><span style={{ fontWeight: 400 }}>系统给推荐，但不替你选</span></div>
          <div className={`dgrid${pendingDecisions.length === 1 ? " one" : ""}`}>
            {pendingDecisions.map((d) => (
              <div className="dcell" key={d.id}>
                <DecisionCard dkey={d.id} />
                {d.value === null && d.used_in && <div className="floc" style={{ marginTop: 8, fontSize: 11.5, color: "var(--text-muted)" }}>英文页里在等它：{d.used_in}</div>}
              </div>
            ))}
          </div>
        </div>
      )}
      {confirm && (
        <div className="fg">
          <div className={`fg-h${confirm.value ? "" : " need"}`}><Icon name="check" small />资料写得明确的 {okFacts.length} 条{confirm.value ? " · 已确认" : ""}<span className="grow" />
            {confirm.value ? <UndoConfirm /> : <span style={{ fontWeight: 400 }}>英文页已经用上，等你确认</span>}
          </div>
          {okFacts.map((f) => <FactRow key={f.id} fact={f} confirmed={!!confirm.value} />)}
          {!confirm.value && (
            <div className="fg-f">
              <ConfirmButton n={okFacts.length} />
              <span className="muted" style={{ fontSize: 12.5 }}>哪条不对就点“不对？”就地改，改完再确认</span>
            </div>
          )}
        </div>
      )}
      {notUsed.length > 0 && (
        <div className="fg">
          <div className="fg-h"><Icon name="shield" small />系统不会使用的<span className="grow" /><span style={{ fontWeight: 400 }}>不需要你处理</span></div>
          {notUsed.map((f) => (
            <div className="frow struck" key={f.id}>
              <div className="ftext"><b>{f.text}</b><span className="floc"><Icon name="file" small />{f.source.file} · {f.source.locator}</span></div>
              <div className="ract"><span className={`tag ${f.evidence_status === "unsupported" ? "st-danger" : "st-neutral"}`}>{f.evidence_status === "unsupported" ? "资料里没有依据" : "没有选用"}</span></div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ConfirmButton({ n }: { n: number }) {
  const { ws, run } = useWb();
  return <button type="button" className="btn btn-primary" onClick={() => run(() => api.decide(ws.id, "facts", "confirmed"))}><Icon name="check" small />都对，确认这 {n} 条</button>;
}

function UndoConfirm() {
  const { ws, run } = useWb();
  return <button type="button" className="link" style={{ fontWeight: 400 }} onClick={() => run(() => api.decide(ws.id, "facts", null))}>撤销确认</button>;
}

function FactRow({ fact, confirmed }: { fact: Fact; confirmed: boolean }) {
  const { ws, run } = useWb();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(fact.user_text ?? fact.text);
  const edited = fact.user_decision === "edited";
  const save = async () => {
    if (!text.trim() || text.trim() === (fact.user_text ?? fact.text)) { setEditing(false); return; }
    if (await run(() => api.editFact(ws.id, fact.id, text.trim()))) setEditing(false);
  };
  return (
    <div className={`frow${edited ? " edited" : ""}`}>
      <div className="ftext"><b>{fact.user_text ?? fact.text}</b><span className="floc"><Icon name="file" small />{edited ? "你改过 · " : ""}{fact.source.file} · {fact.source.locator}</span></div>
      <div className="ract">{confirmed && <span className="tag st-ok">{edited ? "已修改" : "已确认"}</span>}<button type="button" className="link" onClick={() => setEditing(true)}>{edited ? "再改" : "不对？"}</button></div>
      {editing && (
        <div className="inline-edit">
          <textarea rows={2} autoFocus aria-label="改写这条事实" value={text} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") setEditing(false); if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void save(); }} />
          <div className="row">
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => { setText(fact.user_text ?? fact.text); setEditing(false); }}>取消</button>
            <button type="button" className="btn btn-sm btn-primary" onClick={save}>保存</button>
          </div>
        </div>
      )}
    </div>
  );
}
