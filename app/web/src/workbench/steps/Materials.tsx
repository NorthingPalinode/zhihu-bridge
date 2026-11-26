import { useState } from "react";
import { api } from "../api";
import { useWb } from "../context";
import { DecisionCard } from "../Decision";
import { Icon } from "../icons";
import type { Fact } from "../types";

/** 事实的图标按内容推断（只是视觉提示，不改变任何判定）。 */
export function factIcon(text: string): string {
  if (/续航|电池|battery/i.test(text)) return "battery";
  if (/功耗|低功耗|power/i.test(text)) return "bolt";
  if (/防水|ATM|water/i.test(text)) return "drop";
  if (/PCB|主板|芯片|元器件|chip/i.test(text)) return "chip";
  if (/调试|协议|固件|UART|BLE|蓝牙/i.test(text)) return "gear";
  if (/重量|克|\bg\b|尺寸/i.test(text)) return "scale";
  if (/健康|心率|睡眠|医疗|FDA/i.test(text)) return "heart";
  if (/同步|Apple|App/i.test(text)) return "reflow";
  return "box";
}

const ftype = (name: string) => {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return ["pdf", "docx", "csv", "md", "txt"].includes(ext) ? ext : "other";
};

export function Materials() {
  const { ws, toast } = useWb();
  const parsed = ws.sources.filter((s) => s.status === "parsed").length;
  const conflicts = ws.decisions.filter((d) => d.kind === "conflict");
  const openConflicts = conflicts.filter((d) => d.value === null).length;
  const stub = (what: string) => toast(`骨架阶段暂未开放${what}。正式版补充后，系统会自动更新事实，并重写、重查受影响的句子`);
  return (
    <div className="cols cols-mat main-first">
      <div className="stack">
        <section className="glass">
          <div className="ph-head">
            <span className="itile"><Icon name="file" /></span>
            <h2>产品资料 <small>/ Product Materials</small></h2>
            <span className="grow" />
            <button type="button" className="btn btn-outline-glow btn-sm" onClick={() => stub("补充资料")}><Icon name="upload" small />上传资料</button>
          </div>
          <div className="ph-body">
            <ul className="files">
              {ws.sources.map((s) => (
                <li key={s.filename} className="glass-inner file">
                  <span className={`ftype ${ftype(s.filename)}`}>{ftype(s.filename) === "other" ? "FILE" : ftype(s.filename).toUpperCase()}</span>
                  <div>
                    <b>{s.filename}</b>
                    <small>{s.status === "parsed" ? s.size : s.note}</small>
                    {s.status !== "parsed" && <div className="acts"><button type="button" className="link" onClick={() => stub("粘贴补充")}>粘贴其中文字</button></div>}
                  </div>
                  <span className="st">{s.status === "parsed" ? <><Icon name="checkCircle" className="ok-ic" />已解析</> : <><Icon name="info" className="need-ic" />未使用</>}</span>
                </li>
              ))}
            </ul>
            <p className="muted" style={{ margin: "12px 2px 0", fontSize: 12.5 }}>{parsed} 份已解析{ws.sources.length > parsed ? ` · ${ws.sources.length - parsed} 份读不出文字，没有用作依据` : ""}</p>
          </div>
        </section>

        <section className="glass conflict-row">
          <span className={`itile sm${openConflicts ? " amber" : " teal"}`}><Icon name="shield" /></span>
          <b>冲突检查</b><span className="muted" style={{ fontSize: 13 }}>Conflict Check</span><span className="grow" />
          {conflicts.length === 0 ? <span className="tag t-ok"><Icon name="check" />未发现明显冲突</span>
            : openConflicts ? <span className="tag t-need"><Icon name="hand" />{openConflicts} 处资料互相矛盾，等你定</span>
              : <span className="tag t-ok"><Icon name="check" />冲突都已拍板</span>}
        </section>

        {(ws.blocked.length > 0 || ws.gaps.length > 0) && (
          <section className="glass">
            <div className="ph-head"><span className="itile sm teal"><Icon name="shield" /></span><h3>系统已替你处理 <small>/ Handled</small></h3></div>
            <div className="ph-body facts-list">
              {ws.blocked.map((b) => (
                <div key={b.id} className="glass-inner fact">
                  <span className="itile sm red"><Icon name="x" /></span>
                  <div><b>已挡下“{b.short}”</b><div className="txt">资料里没有任何证明，英文页不会出现这类说法。</div><div className="src">{b.quote.file} · {b.quote.locator}</div></div>
                  <button type="button" className="link" onClick={() => stub("补充证书")}>有证书？</button>
                </div>
              ))}
              {ws.gaps.map((g) => (
                <div key={g.id} className="glass-inner fact">
                  <span className="itile sm amber"><Icon name="clock" /></span>
                  <div><b>不写：{g.title}</b><div className="txt">{g.why}</div></div>
                  <button type="button" className="link" onClick={() => stub("上传实测报告")}>补资料</button>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>

      <div className="stack main"><FactPanel /></div>
    </div>
  );
}

function FactPanel() {
  const { ws } = useWb();
  const pending = ws.decisions.filter((d) => d.kind !== "confirm_facts");
  const need = pending.filter((d) => d.value === null).length;
  const confirm = ws.decisions.find((d) => d.kind === "confirm_facts");
  const byId = Object.fromEntries(ws.facts.map((f) => [f.id, f]));
  const okFacts = (confirm?.fact_ids ?? []).map((id) => byId[id]).filter(Boolean);
  const notUsed = ws.facts.filter((f) => f.evidence_status === "unsupported" || f.user_decision === "rejected");
  const usable = ws.facts.filter((f) => f.evidence_status !== "unsupported");
  const settled = usable.filter((f) => f.user_decision !== "pending").length;
  return (
    <section className="glass">
      <div className="ph-head">
        <span className="itile"><Icon name="box" /></span>
        <h2>产品事实档案 <small>/ Product Facts</small></h2>
        <span className="grow" />
        <span className="tag t-info"><Icon name="sparkle" />AI 提取生成 · 原文已核对</span>
      </div>
      <div className="ph-body stack" style={{ gap: 16 }}>
        {pending.length > 0 && (
          <div>
            <div className={`group-h${need ? " need" : ""}`}><Icon name="hand" small />{need ? "需要你决定" : "你的决定"}{need > 0 && <span className="count">{need}</span>}<small>系统给推荐，但不替你选</small></div>
            <div className={`dgrid${pending.length === 1 ? " one" : ""}`}>
              {pending.map((d) => (
                <div key={d.id} className={`glass-inner dcell${d.value === null ? "" : " done"}`}>
                  <DecisionCard dkey={d.id} />
                  {d.value === null && d.used_in && <div className="used-in">英文页里在等它：{d.used_in}</div>}
                </div>
              ))}
            </div>
          </div>
        )}
        {confirm && (
          <div>
            <div className={`group-h${confirm.value ? "" : " need"}`}><Icon name="checkCircle" small />资料写得明确的 {okFacts.length} 条{confirm.value ? " · 已确认" : ""}
              <small>{confirm.value ? <UndoConfirm /> : "英文页已经用上，等你确认"}</small></div>
            <div className="facts-list">{okFacts.map((f) => <FactRow key={f.id} fact={f} confirmed={!!confirm.value} />)}</div>
            {!confirm.value && <div style={{ marginTop: 12, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              <ConfirmButton n={okFacts.length} /><span className="muted" style={{ fontSize: 12.5 }}>哪条不对就点“不对？”就地改，改完再确认</span></div>}
          </div>
        )}
        {notUsed.length > 0 && (
          <div>
            <div className="group-h"><Icon name="shield" small />系统不会使用的<small>不需要你处理</small></div>
            <div className="facts-list">
              {notUsed.map((f) => (
                <div key={f.id} className="glass-inner fact struck">
                  <span className="itile sm red"><Icon name={factIcon(f.text)} /></span>
                  <div><b>{f.short}</b><div className="txt">{f.text}</div><div className="src">{f.source.file} · {f.source.locator}</div></div>
                  <span className={`tag ${f.evidence_status === "unsupported" ? "t-risk" : "t-muted"}`}>{f.evidence_status === "unsupported" ? "资料里没有依据" : "没有选用"}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="glass-inner bar-wrap">
          <Icon name="layers" /><b style={{ fontSize: 14 }}>资料完整度</b>
          <div className="bar"><i style={{ width: `${usable.length ? Math.round((settled / usable.length) * 100) : 0}%` }} /></div>
          <b style={{ fontSize: 14 }}>{usable.length ? Math.round((settled / usable.length) * 100) : 0}%</b>
          <span className="tag t-ok"><Icon name="check" />已确认 {settled} 项</span>
          {usable.length - settled > 0 && <span className="tag t-need"><Icon name="clock" />待确认 {usable.length - settled} 项</span>}
        </div>
      </div>
    </section>
  );
}

function ConfirmButton({ n }: { n: number }) {
  const { ws, run } = useWb();
  return <button type="button" className="btn btn-primary" onClick={() => run(() => api.decide(ws.id, "facts", "confirmed"))}><Icon name="check" small />都对，确认这 {n} 条</button>;
}

function UndoConfirm() {
  const { ws, run } = useWb();
  return <button type="button" className="link" onClick={() => run(() => api.decide(ws.id, "facts", null))}>撤销确认</button>;
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
    <div className={`glass-inner fact${edited ? " edited" : ""}`}>
      <span className="itile sm"><Icon name={factIcon(fact.text)} /></span>
      <div><b>{fact.short}</b><div className="txt">{fact.user_text ?? fact.text}</div><div className="src">{edited ? "你改过 · " : ""}来源：{fact.source.file} · {fact.source.locator}</div></div>
      <div className="side">
        {confirmed ? <span className="tag t-ok"><Icon name="check" />{edited ? "已修改" : "已确认"}</span> : <span className="tag t-need"><Icon name="clock" />待确认</span>}
        <button type="button" className="link" onClick={() => setEditing(true)}>{edited ? "再改" : "不对？"}</button>
      </div>
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
