import { useRef, useState, type ReactNode } from "react";
import { api } from "../api";
import { SECTION_NAMES, plainText } from "../copy";
import { useWb } from "../context";
import { DecisionPop, FixPop } from "../Decision";
import { Icon } from "../icons";
import type { Asset, Item, Part } from "../types";

export function Content() {
  const { ws } = useWb();
  const [active, setActive] = useState<Item | null>(null);
  return (
    <div className="panelset main-right">
      <div className="col">
        <EvidenceIndex active={active} />
        {ws.is_demo && (
          <div className="change">
            <div className="panel-h"><h3>洞察带来的改变</h3><span className="meta">同一句工程笔记</span></div>
            <div className="row"><div className="k"><b>中文原句</b>工程笔记 · 第 1 段</div><div>自研高密度堆料主板，极限压榨功耗，支持底层协议调试。</div></div>
            <div className="row"><div className="k"><b>普通直译</b>同一模型直接翻译</div><div className="lit en">Self-developed high-density stacking motherboard, extreme power squeezing, supports low-level protocol debugging.</div></div>
            <div className="row"><div className="k"><b>Zhihu Bridge</b>资料事实 + 知乎建议</div><div className="en">A custom 6-layer PCB with high-grade component selection<sup>堆料</sup>, power-optimized firmware<sup>功耗</sup>, and low-level UART/BLE protocol debugging via the charging dock — firmware is not open source<sup>调试</sup>.</div></div>
          </div>
        )}
      </div>
      <div className="col">
        <div className="module-legend"><span><i className="sw" />系统改过，点开可看原句、可撤销</span><span><i className="sw need" />等你决定，点开直接选</span></div>
        {ws.assets.map((a) => <Module key={a.id} asset={a} activeId={active?.id ?? null} onPick={setActive} />)}
      </div>
    </div>
  );
}

function EvidenceIndex({ active }: { active: Item | null }) {
  const { ws } = useWb();
  const linked = new Set([...(active?.facts ?? []), ...(active?.insights ?? [])]);
  const facts = Object.fromEntries(ws.facts.map((f) => [f.id, f]));
  const confirm = ws.decisions.find((d) => d.kind === "confirm_facts");
  const chip = (key: string, keys: string[], label: string, sub: ReactNode, cls = "") => (
    <div key={key} className={`lchip ${cls}${keys.some((k) => linked.has(k)) ? " is-linked" : ""}`}><span>{label}</span><span className="lab">{sub}</span></div>
  );
  const names = [...linked].map((id) => facts[id]?.short ?? ws.insights.find((i) => i.id === id)?.concept).filter(Boolean);
  return (
    <div className="panel">
      <div className="panel-h"><h3>依据</h3><span className="meta">点任意一条卖点</span></div>
      <p className="link-hint">{active ? `这条卖点用到了：${names.join("、") || "没有关联的事实"}。` : "点任意一条核心卖点，这里会高亮它用到的事实和知乎建议。"}</p>
      <div className="idx-group"><h4>用到的产品事实</h4><div className="chip-list">
        {(confirm?.fact_ids ?? []).map((id) => facts[id] && chip(id, [id], facts[id].user_text ?? facts[id].short,
          <>你的资料 · {confirm?.value ? "已确认" : <span className="tagx">等你确认</span>}</>))}
        {ws.decisions.filter((d) => d.kind !== "confirm_facts").map((d) => {
          const keys = (d.options ?? []).map((o) => o.fact ?? "").filter(Boolean);
          if (d.value === null) return chip(d.id, keys, d.kind === "conflict" ? `${d.subject ?? "数值"}：资料之间不一致` : `${d.subject ?? "计划功能"}的写法`, <>你的资料 · <span className="tagx">等你决定</span></>, "need");
          if (d.kind === "roadmap_wording" && d.value === "omit") return null;
          const v = d.kind === "conflict" ? `${d.subject ?? "数值"} ${d.value === "custom" ? d.custom : d.options?.find((o) => o.value === d.value)?.render}` : `${d.subject ?? "计划功能"}：照实写上市状态与计划`;
          return chip(d.id, keys, v, "你的资料 · 你选的");
        })}
      </div></div>
      {ws.insights.length > 0 && <div className="idx-group"><h4>用到的知乎建议</h4><div className="chip-list">
        {ws.insights.map((i) => chip(i.id, [i.id], `${i.concept} → ${i.localized.split(" (")[0]}`, `知乎讨论 · ${i.enabled ? "在用" : "没用"}`, i.enabled ? "z" : "z off"))}
      </div></div>}
      {ws.blocked.length > 0 && <div className="idx-group"><h4>不会使用</h4><div className="chip-list">
        {ws.blocked.map((b) => chip(b.id, [b.id], b.short, "资料里没有依据", "off"))}
      </div></div>}
    </div>
  );
}

function Module({ asset, activeId, onPick }: { asset: Asset; activeId: string | null; onPick: (i: Item) => void }) {
  const { ws, busy, editing, setEditing, run, openPop, closePop, toast } = useWb();
  const refs = useRef<Record<string, HTMLElement | null>>({});
  const isEditing = editing === asset.id;
  const isBusy = busy.has(asset.id);

  const save = async () => {
    const changed: Record<string, string> = {};
    for (const it of asset.items) {
      const el = refs.current[it.id];
      if (!el) continue;
      const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
      if (text !== plainText(it.parts).replace(/\s+/g, " ").trim()) changed[it.id] = text;
    }
    setEditing(null);
    if (!Object.keys(changed).length) return;
    await run(() => api.editContent(ws.id, asset.id, changed), [asset.id]);
  };

  const more = (el: HTMLElement) => openPop(el, (
    <div className="menu-list" role="menu">
      <button type="button" role="menuitem" onClick={() => { closePop(); void run(() => api.regenerate(ws.id, asset.id), [asset.id]); }}>重新写这一段</button>
      <button type="button" role="menuitem" onClick={() => {
        closePop();
        const t = asset.items.map((i) => (i.label ? `${i.label}: ` : "") + plainText(i.parts)).join("\n");
        void navigator.clipboard?.writeText(t).then(() => toast(`已复制「${SECTION_NAMES[asset.id]}」`), () => toast("浏览器不允许复制，请手动选择文字"));
      }}>复制这一段</button>
    </div>), "menu-pop");

  const body = (it: Item, wrap: (c: ReactNode) => ReactNode) => {
    const hasPh = it.parts.some((p) => p.type === "ph");
    if (isEditing && !hasPh) {
      return wrap(<span className="editable" contentEditable suppressContentEditableWarning spellCheck={false}
        ref={(el) => { refs.current[it.id] = el; }}
        onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); setEditing(null); } if (e.key === "Enter") { e.preventDefault(); if (e.ctrlKey || e.metaKey) void save(); } }}>
        {plainText(it.parts)}</span>);
    }
    refs.current[it.id] = null;
    return wrap(<span title={isEditing && hasPh ? "这句还在等你决定，决定后才能编辑" : undefined}><Parts parts={it.parts} /></span>);
  };

  const n = asset.need;
  return (
    <article className={`module${isEditing ? " editing" : ""}`} id={`m-${asset.id}`}>
      <div className="module-h">
        <h3>{asset.title}</h3>
        <span className={`st ${isBusy ? "busy" : n ? "need" : "ok"}`}>
          {isBusy ? <><span className="spin" style={{ width: 12, height: 12, borderWidth: 1.5 }} />检查中…</>
            : n ? <><Icon name="hand" />{n} 处等你决定</> : <><Icon name="check" />已检查</>}
        </span>
        <span className="grow" />
        <span className="tools">
          {isEditing ? (
            <><button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(null)}>放弃</button>
              <button type="button" className="btn btn-sm btn-primary" onClick={save}>保存</button></>
          ) : (
            <><button type="button" className="btn btn-sm btn-ghost" disabled={isBusy} onClick={() => { closePop(); setEditing(asset.id); }}><Icon name="pencil" small />编辑</button>
              <button type="button" className="btn btn-sm btn-ghost" aria-label="更多" onClick={(e) => more(e.currentTarget)}><Icon name="more" small /></button></>
          )}
        </span>
      </div>
      <div className="module-b en">
        {asset.id === "features" ? (
          <ul className="feats">
            {asset.items.map((it, idx) => (
              <li key={it.id} className={`feat${activeId === it.id ? " is-active" : ""}`} tabIndex={0}
                onClick={(e) => { if (!isEditing && !(e.target as HTMLElement).closest(".fx,.kept,.ph,mark")) onPick(it); }}
                onKeyDown={(e) => { if (!isEditing && (e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) { e.preventDefault(); onPick(it); } }}>
                <span className="num">{String(idx + 1).padStart(2, "0")}</span>
                {body(it, (c) => <span className="feat-text">{c}</span>)}
                <span className="links">{it.facts.length > 0 && <span className="c">资料</span>}{it.insights.length > 0 && <span className="i">知乎</span>}</span>
              </li>
            ))}
          </ul>
        ) : asset.id === "specs" ? (
          <table className="spec"><tbody>
            {asset.items.map((it) => (
              <tr key={it.id}><th>{it.label}</th><td>{body(it, (c) => c)}{it.note && !isEditing && <span className="muted" style={{ fontSize: 12 }}>（{it.note}）</span>}</td></tr>
            ))}
          </tbody></table>
        ) : asset.id === "faq" ? (
          <dl className="faq">{asset.items.map((it) => <div key={it.id}><dt>{it.label}</dt><dd>{body(it, (c) => c)}</dd></div>)}</dl>
        ) : (
          asset.items.map((it) => (
            <p key={it.id} className={it.kind === "title" ? "headline-t" : it.kind === "tagline" ? "muted" : undefined}>{body(it, (c) => c)}</p>
          ))
        )}
      </div>
    </article>
  );
}

/** 正文片段：绿色虚线 = 系统改过；红底 = 你保留的原句；琥珀 = 等你决定；红色下划线 = 你新写的风险说法。 */
export function Parts({ parts }: { parts: Part[] }) {
  const { ws, openPop, editing } = useWb();
  const issue = (id: string) => ws.issues.find((i) => i.id === id);
  return (
    <>
      {parts.map((p, i) => {
        if (p.type === "text") return <span key={i}>{p.text}</span>;
        if (p.type === "ph") {
          return <button type="button" key={i} className="ph" onClick={(e) => { if (!editing) openPop(e.currentTarget, <DecisionPop dkey={p.decision} />); }}>{p.text}</button>;
        }
        const iss = issue(p.issue);
        if (p.type === "risk") {
          return <mark key={i} className="risk" tabIndex={0} role="button" onClick={(e) => { if (!editing) openPop(e.currentTarget, <DecisionPop dkey={`x:${p.issue}`} />); }}>{p.text}</mark>;
        }
        const cls = p.type === "fix" ? "fx" : "kept";
        if (!iss || iss.fix_kind === "user_introduced") return <span key={i} className={cls}>{p.text}</span>;
        return <span key={i} className={cls} tabIndex={0} role="button"
          onClick={(e) => { if (!editing) openPop(e.currentTarget, <FixPop issue={iss} />); }}
          onKeyDown={(e) => { if (e.key === "Enter" && !editing) openPop(e.currentTarget, <FixPop issue={iss} />); }}>{p.text}</span>;
      })}
    </>
  );
}
