import { useRef, useState, type ReactNode } from "react";
import { api } from "../api";
import { SECTION_NAMES, hasStage, plainText } from "../copy";
import { useWb } from "../context";
import { DecisionPop, FixPop } from "../Decision";
import { Icon } from "../icons";
import type { Asset, Item, Part } from "../types";
import { factIcon } from "./Materials";

const MOD_ICON: Record<string, string> = { headline: "type", features: "star", story: "doc", specs: "gear", faq: "help" };
const MOD_EN: Record<string, string> = { headline: "Headline", features: "Core Features", story: "Product Story", specs: "Technical Specs", faq: "FAQ" };

export function Content() {
  const { ws, goStep, run } = useWb();
  const [generating, setGenerating] = useState(false);
  const contentDone = hasStage(ws, "content") && ws.assets.length > 0;
  const reviewed = hasStage(ws, "review");
  const [activeMod, setActiveMod] = useState<string>(ws.assets[0]?.id ?? "headline");
  const [activeItem, setActiveItem] = useState<Item | null>(null);

  const trigger = async () => {
    setGenerating(true);
    try {
      await run(() => api.runStage(ws.id, "content"));
    } finally {
      setGenerating(false);
    }
  };

  if (!contentDone) {
    const insightsDone = hasStage(ws, "insights");
    const ch = ws.settings_options.channel.find((o) => o[0] === ws.settings.channel)?.[1];
    const aud = ws.settings_options.audience.find((o) => o[0] === ws.settings.audience)?.[1];
    const tone = ws.settings_options.tone.find((o) => o[0] === ws.settings.tone)?.[1];
    return (
      <section className="glass stage-gate">
        <span className="itile lg"><Icon name="globe" /></span>
        <h3>尚未生成海外上市内容</h3>
        <p>
          {insightsDone
            ? "将基于已提取的产品事实与启用的知乎本地化建议，生成面向美国市场的 5 个英文页面模块（主标题与宣传语、核心卖点、产品详细介绍、技术参数表、FAQ）。冲突参数与未上线功能将保留占位等你拍板。"
            : "请先完成第 2 步「知乎认知洞察」，系统才能结合知乎本地化建议生成高质量英文上市内容。"}
        </p>
        <div className="meta-row">
          <span className="tag t-info">渠道：{ch}</span>
          <span className="tag t-info">受众：{aud}</span>
          <span className="tag t-info">语气：{tone}</span>
        </div>
        {insightsDone ? (
          <button type="button" className="btn btn-primary btn-lg" disabled={generating} onClick={trigger}>
            {generating ? <><span className="spin" />正在撰写英文产品页…</> : <><Icon name="sparkle" />生成海外上市内容 <Icon name="right" /></>}
          </button>
        ) : (
          <button type="button" className="btn btn-primary btn-lg" onClick={() => goStep(hasStage(ws, "facts") ? "insights" : "materials")}>
            <Icon name="left" />先去完成上一步：{hasStage(ws, "facts") ? "知乎认知洞察" : "提取产品事实"}
          </button>
        )}
      </section>
    );
  }

  const pickMod = (id: string, scroll = true) => {
    setActiveMod(id);
    setActiveItem(null);
    if (scroll) document.getElementById(`m-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const current = ws.assets.find((a) => a.id === activeMod) ?? ws.assets[0];
  return (
    <>
      {!reviewed && (
        <div className="state need" style={{ marginBottom: 16 }}>
          <Icon name="alert" />
          <span className="grow">当前为英文初稿，尚未执行第 4 步「发布前合规审校」。你可以先自由编辑、点开琥珀色占位拍板，再点击下方按钮进入发布前审校。</span>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => goStep("review")}>去执行审校</button>
        </div>
      )}
      <div className="cols cols-content">
        <nav className="glass mod-nav" aria-label="内容模块">
          <h3><span className="itile sm"><Icon name="layers" /></span>内容模块</h3>
          {ws.assets.map((a) => (
            <button key={a.id} type="button" className={`mod-btn${a.id === current.id ? " on" : ""}`} aria-current={a.id === current.id ? "true" : undefined} onClick={() => pickMod(a.id)}>
              <Icon name={MOD_ICON[a.id] ?? "doc"} />{a.title}
              <span className="badge">{a.need ? <span className="tag t-need">{a.need}</span> : <Icon name="chev" small />}</span>
            </button>
          ))}
        </nav>

        <section className="glass" style={{ paddingBottom: 6 }}>
          <div className="doc-head">
            <h2>海外内容 <small>/ Global Launch Content</small></h2>
            <span className="grow" />
            <span className="tag t-info">美式英语 · {ws.settings_options.channel.find((o) => o[0] === ws.settings.channel)?.[1]}</span>
          </div>
          <div className="legend"><span><i className="sw" />系统改过，点开可看原句、可撤销</span><span><i className="sw need" />等你决定，点开直接选</span></div>
          {ws.assets.map((a) => (
            <Module key={a.id} asset={a} active={a.id === current.id} activeItemId={activeItem?.id ?? null} reviewed={reviewed}
              onFocus={() => setActiveMod(a.id)} onPick={(it) => { setActiveMod(a.id); setActiveItem(it); }} />
          ))}
        </section>

        <aside className="links-col"><LinksPanel asset={current} item={activeItem} /></aside>
      </div>

      <div className="bottom-actions">
        <button type="button" className="btn btn-lg btn-outline-glow" onClick={() => run(() => api.regenerate(ws.id, current.id), [current.id])}><Icon name="reflow" />重新写「{current.title}」</button>
        <span className="grow" />
        <button type="button" className="btn btn-lg btn-primary" onClick={() => goStep("review")}><Icon name="checkCircle" />进入发布前审校 <Icon name="right" /></button>
      </div>
    </>
  );
}

function LinksPanel({ asset, item }: { asset: Asset; item: Item | null }) {
  const { ws } = useWb();
  const facts = Object.fromEntries(ws.facts.map((f) => [f.id, f]));
  const scope = item ? [item] : asset.items;
  const factIds = [...new Set(scope.flatMap((i) => i.facts))].filter((id) => facts[id]);
  const insIds = [...new Set(scope.flatMap((i) => i.insights))];
  const insights = ws.insights.filter((i) => insIds.includes(i.id));
  const pendingDecisions = ws.decisions.filter((d) => d.kind !== "confirm_facts" && d.value === null &&
    scope.some((i) => i.parts.some((p) => p.type === "ph" && p.decision === d.id)));
  return (
    <section className="glass links-panel">
      <div className="ph-head"><span className="itile"><Icon name="link" /></span><h2>依据与关联 <small>/ Fact & Insight Links</small></h2></div>
      <div className="ph-body">
        <div className="glass-inner sel"><span className="muted">当前内容模块：</span><span className="itile sm"><Icon name={MOD_ICON[asset.id] ?? "doc"} /></span><b>{item ? "这一条" : asset.title}</b></div>
        <h4><span className="itile sm"><Icon name="box" /></span>关联的产品资料 <small>(Product Facts)</small></h4>
        <div className="hash-list">
          {factIds.length === 0 && pendingDecisions.length === 0 && <span className="muted" style={{ fontSize: 13 }}>这一段没有直接引用的事实。</span>}
          {factIds.map((id) => <span key={id} className={`hash${facts[id].user_decision === "rejected" ? " off" : ""}`}># {facts[id].user_text ?? facts[id].short}</span>)}
          {pendingDecisions.map((d) => <span key={d.id} className="hash need"># {d.subject ?? "待决定"}（等你决定）</span>)}
        </div>
        {factIds.length > 0 && (
          <div className="glass-inner support" style={{ marginBottom: 16 }}>
            <b><Icon name="checkCircle" small />支持说明</b>
            {factIds.slice(0, 3).map((id) => <div key={id}>· {facts[id].user_text ?? facts[id].text}<span className="muted">（{facts[id].source.file} · {facts[id].source.locator}）</span></div>)}
          </div>
        )}
        <h4><span className="itile sm"><Icon name="layers" /></span>关联的知乎洞察 <small>(Zhihu Insights)</small></h4>
        <div className="hash-list">
          {insights.length === 0 && <span className="muted" style={{ fontSize: 13 }}>这一段没有用到知乎建议。</span>}
          {insights.map((i) => <span key={i.id} className={`hash${i.enabled ? "" : " off"}`}># {i.concept}</span>)}
        </div>
        {insights.length > 0 && (
          <div className="glass-inner support">
            <b><Icon name="checkCircle" small />支持说明</b>
            {insights.map((i) => <div key={i.id}>· {i.concept} → <span className="en">{i.localized}</span>{i.enabled ? "" : "（已关掉）"}</div>)}
          </div>
        )}
        {ws.is_demo && (
          <div className="change-card" style={{ marginTop: 16 }}>
            <h4><span className="itile sm violet"><Icon name="scale" /></span>洞察带来的改变</h4>
            <div className="row"><span className="k"><b>中文原句</b>工程笔记 · 第 1 段</span><span>自研高密度堆料主板，极限压榨功耗，支持底层协议调试。</span></div>
            <div className="row"><span className="k"><b>普通直译</b>同一模型直接翻译</span><span className="lit en">Self-developed high-density stacking motherboard, extreme power squeezing, supports low-level protocol debugging.</span></div>
            <div className="row"><span className="k"><b>Zhihu Bridge</b>资料事实 + 知乎建议</span><span className="en">A custom 6-layer PCB with high-grade component selection<sup>堆料</sup>, power-optimized firmware<sup>功耗</sup>, and low-level UART/BLE protocol debugging via the charging dock — firmware is not open source<sup>调试</sup>.</span></div>
          </div>
        )}
      </div>
    </section>
  );
}

function Module({ asset, active, activeItemId, reviewed, onFocus, onPick }: { asset: Asset; active: boolean; activeItemId: string | null; reviewed: boolean; onFocus: () => void; onPick: (i: Item) => void }) {
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
        void navigator.clipboard?.writeText(t).then(() => toast(`已复制「${SECTION_NAMES[asset.id] ?? asset.title}」`), () => toast("浏览器不允许复制，请手动选择文字"));
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
    <article className={`glass-inner module${active ? " active" : ""}${isEditing ? " editing" : ""}`} id={`m-${asset.id}`} onClickCapture={onFocus}>
      <div className="module-h">
        <h3>{asset.title.toUpperCase()} · {MOD_EN[asset.id] ?? ""}</h3>
        <span className={`st ${isBusy ? "busy" : n ? "need" : reviewed ? "ok" : ""}`}>
          {isBusy ? <><span className="spin" style={{ width: 12, height: 12, borderWidth: 1.5 }} />检查中…</>
            : n ? <><Icon name="hand" />{n} 处等你决定</> : reviewed ? <><Icon name="checkCircle" />已检查</> : <>待审校初稿</>}
        </span>
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
          <ul className="feat-grid">
            {asset.items.map((it) => (
              <li key={it.id} className={`feat${activeItemId === it.id ? " is-active" : ""}`} tabIndex={0}
                onClick={(e) => { if (!isEditing && !(e.target as HTMLElement).closest(".fx,.kept,.ph,mark")) onPick(it); }}
                onKeyDown={(e) => { if (!isEditing && (e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) { e.preventDefault(); onPick(it); } }}>
                <span className="itile sm"><Icon name={factIcon(plainText(it.parts) + " " + it.facts.map((f) => ws.facts.find((x) => x.id === f)?.text ?? "").join(" "))} /></span>
                {body(it, (c) => <span className="ftxt">{c}</span>)}
                <span className="links">{it.facts.length > 0 && <span>资料</span>}{it.insights.length > 0 && <span className="i">知乎</span>}</span>
              </li>
            ))}
          </ul>
        ) : asset.id === "specs" ? (
          <div className="spec-grid">
            {asset.items.map((it) => (
              <div key={it.id} className="spec-cell"><span className="k">{it.label}</span><span>{body(it, (c) => c)}{it.note && !isEditing && <span className="note">（{it.note}）</span>}</span></div>
            ))}
          </div>
        ) : asset.id === "faq" ? (
          <dl className="faq">{asset.items.map((it) => <div key={it.id}><dt>{it.label}</dt><dd>{body(it, (c) => c)}</dd></div>)}</dl>
        ) : (
          asset.items.map((it) => (
            <p key={it.id} className={it.kind === "title" ? "headline-t" : it.kind === "tagline" ? "tagline-t" : undefined}>{body(it, (c) => c)}</p>
          ))
        )}
      </div>
    </article>
  );
}

/** 正文片段：绿色虚线 = 系统改过；红底 = 你保留的原句；琥珀 = 等你决定；红框 = 你新写的风险说法。 */
export function Parts({ parts, numbered }: { parts: Part[]; numbered?: Record<string, number> }) {
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
        const num = numbered?.[p.issue];
        const marker = num ? <span className={`marker${p.type === "fix" ? " ok" : p.type === "kept" ? " risk" : ""}`}>{num}</span> : null;
        if (p.type === "risk") {
          return <span key={i}>{marker}<mark className="risk" tabIndex={0} role="button" onClick={(e) => { if (!editing) openPop(e.currentTarget, <DecisionPop dkey={`x:${p.issue}`} />); }}>{p.text}</mark></span>;
        }
        const cls = p.type === "fix" ? "fx" : "kept";
        if (!iss || iss.fix_kind === "user_introduced") return <span key={i} className={cls}>{p.text}</span>;
        return <span key={i}>{marker}<span className={cls} tabIndex={0} role="button"
          onClick={(e) => { if (!editing) openPop(e.currentTarget, <FixPop issue={iss} />); }}
          onKeyDown={(e) => { if (e.key === "Enter" && !editing) openPop(e.currentTarget, <FixPop issue={iss} />); }}>{p.text}</span></span>;
      })}
    </>
  );
}
