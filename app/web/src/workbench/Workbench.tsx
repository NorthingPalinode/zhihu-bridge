import { useEffect, useRef, useState } from "react";
import { api, downloadText } from "./api";
import { DEMO_TAG, DEV_TAG, stepSummary } from "./copy";
import { useWb, type Step } from "./context";
import { Icon, ProductTile, Ring } from "./icons";
import { Content } from "./steps/Content";
import { Insights } from "./steps/Insights";
import { Materials } from "./steps/Materials";
import { Review } from "./steps/Review";
import { TopNav } from "./TopNav";
import type { ExportPack, Trace } from "./types";

const STEPS: [Step, string, string][] = [["materials", "产品资料", "box"], ["insights", "知乎认知洞察", "layers"], ["content", "海外内容", "globe"], ["review", "发布前审校", "shield"]];

export function Workbench({ onHome, onDemo }: { onHome: () => void; onDemo: () => void }) {
  const { ws, step, goStep, setReviewSel } = useWb();
  const [drawer, setDrawer] = useState<"export" | "trace" | null>(null);
  const open = ws.summary.open_decisions;
  const total = ws.decisions.length + ws.issues.filter((i) => i.fix_kind === "user_introduced").length;
  const decided = Math.max(0, total - open.length);

  const toNext = () => { goStep("review"); if (open.length) setReviewSel(open[0]); };
  const stepState = (s: Step): "done" | "need" | "" => {
    if (s === "materials") return ws.decisions.some((d) => d.value === null) ? "need" : "done";
    if (s === "insights") return ws.summary.insights_on > 0 ? "done" : "";
    if (s === "content") return ws.summary.sections_need.length ? "need" : "done";
    return ws.summary.ready ? "done" : open.length ? "need" : "";
  };
  const onStepKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const i = STEPS.findIndex(([s]) => s === step);
    const nx = STEPS[(i + (e.key === "ArrowRight" ? 1 : -1) + STEPS.length) % STEPS.length][0];
    goStep(nx);
    requestAnimationFrame(() => document.getElementById(`t-${nx}`)?.focus());
  };

  return (
    <div>
      <TopNav onHome={onHome} onNew={onHome} onRecent={onHome} onDemo={onDemo} current="project" />
      <main className="page">
        <nav className="crumbs" aria-label="位置">
          <button type="button" onClick={onHome}><Icon name="home" />首页</button><Icon name="chev" small />
          <button type="button" onClick={onHome}>项目</button><Icon name="chev" small />
          <b>{ws.name}</b><Icon name="chev" small />
          <span className="chip-now">{STEPS.find(([s]) => s === step)?.[1]}</span>
        </nav>

        <section className="glass phead">
          <ProductTile size="lg" />
          <div>
            <div className="pname">
              <h1>{ws.name}</h1>
              <span className={`tag ${open.length ? "t-need" : "t-ok"}`}><span className="dot-i" />{open.length ? "进行中" : "可以导出"}</span>
              {ws.is_demo && <span className="tag t-demo">{DEMO_TAG}</span>}
              {ws.llm_mode === "fake" && <span className="tag t-demo">{DEV_TAG}</span>}
            </div>
            <SettingsRow />
          </div>
          <div className="pstats">
            <Ring value={total ? decided / total : 1} label={`已决定 ${decided}/${total}`} />
            <div className="pstat"><b>{decided}/{total}</b><small>你的决定</small></div>
            <button type="button" className={`btn ${open.length ? "btn-outline-glow" : "btn-primary"}`} onClick={open.length ? toNext : () => setDrawer("export")}>
              {open.length ? <><Icon name="hand" small />还需你决定 {open.length} 件</> : <><Icon name="download" small />导出交付</>}
            </button>
          </div>
        </section>

        <div className="glass steps" role="tablist" aria-label="工作台步骤" onKeyDown={onStepKey}>
          {STEPS.map(([s, label, icon], i) => {
            const st = stepState(s);
            const sum = stepSummary(ws, s);
            return (
              <span key={s} style={{ display: "contents" }}>
                {i > 0 && <span className={`step-line${stepState(STEPS[i - 1][0]) === "done" ? "" : " dim"}`} />}
                <button type="button" className={`step ${st}`} role="tab" id={`t-${s}`} aria-selected={step === s} tabIndex={step === s ? 0 : -1} onClick={() => goStep(s)}>
                  <span className="num">{st === "done" && step !== s ? <Icon name="check" /> : <Icon name={icon} />}</span>
                  <span><b>{label}</b><small>{sum.text}{sum.tail && <span className={sum.tone}>{sum.tail}</span>}</small></span>
                </button>
              </span>
            );
          })}
          <span className="step-line dim" />
          <button type="button" className="step" onClick={() => setDrawer("export")}>
            <span className="num"><Icon name="download" /></span><span><b>导出交付</b><small>{open.length ? "未决定处写成 [待确认]" : "都确认好了"}</small></span>
          </button>
        </div>

        <section role="tabpanel" aria-labelledby={`t-${step}`}>
          {step === "materials" && <Materials />}
          {step === "insights" && <Insights />}
          {step === "content" && <Content />}
          {step === "review" && <Review onExport={() => setDrawer("export")} />}
        </section>
      </main>

      <footer className="foot">
        <span>AI 辅助撰写和检查，只覆盖列出的检查项，不构成法律意见，也不保证通过平台或监管审核。</span>
        <span style={{ flex: 1 }} />
        <button type="button" className="link quiet" onClick={() => setDrawer("trace")}>生成记录与数据来源</button>
      </footer>

      {drawer === "export" && <ExportDrawer onClose={() => setDrawer(null)} onDecide={() => { setDrawer(null); toNext(); }} />}
      {drawer === "trace" && <TraceDrawer onClose={() => setDrawer(null)} />}
    </div>
  );
}

function SettingsRow() {
  const { ws, run, openPop, closePop } = useWb();
  const chip = (key: "channel" | "audience" | "tone", icon: string, label: string) => {
    const opts = ws.settings_options[key];
    const current = opts.find((o) => o[0] === ws.settings[key])?.[1];
    return (
      <button type="button" className="mchip" aria-label={`${label}：${current}，点击修改`} onClick={(e) => openPop(e.currentTarget, (
        <div className="menu-list" role="menu">
          <div className="mhint">改了会自动重写受影响的段落</div>
          {opts.map(([v, l]) => (
            <button type="button" role="menuitemradio" aria-checked={ws.settings[key] === v} key={v}
              onClick={() => { closePop(); if (ws.settings[key] !== v) void run(() => api.setting(ws.id, key, v), key === "channel" ? ws.assets.map((a) => a.id) : ["headline"]); }}>{l}</button>
          ))}
        </div>), "menu-pop")}>
        <Icon name={icon} /><span><b>{current}</b><small>{label} · 可改</small></span><Icon name="down" className="caret" />
      </button>
    );
  };
  return (
    <div className="pmeta">
      <span className="mchip" title="当前版本只支持美国市场"><Icon name="map" /><span><b>美国市场</b><small>U.S. Market</small></span></span>
      <span className="mchip"><Icon name="type" /><span><b>英文</b><small>English (US)</small></span></span>
      {chip("channel", "box", "渠道")}{chip("audience", "users", "受众")}{chip("tone", "megaphone", "语气")}
    </div>
  );
}

function useDialog(onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (!d.open) d.showModal();
    const close = () => closeRef.current();
    d.addEventListener("close", close);
    return () => d.removeEventListener("close", close);
  }, []);
  return ref;
}

function ExportDrawer({ onClose, onDecide }: { onClose: () => void; onDecide: () => void }) {
  const { ws, toast } = useWb();
  const ref = useDialog(onClose);
  const [pack, setPack] = useState<ExportPack | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => { api.exportPack(ws.id).then(setPack, () => toast("导出内容没有生成成功，请再试一次")); }, [ws.id, toast]);
  const copy = (key: string, text: string) => navigator.clipboard?.writeText(text).then(() => { setCopied(key); setTimeout(() => setCopied(null), 1600); }, () => toast("浏览器不允许复制，请手动选择文字"));
  const open = pack?.open.length ?? 0;
  const draftText = pack?.draft ? [pack.draft.title, "", ...pack.draft.outline.map((o, i) => `${i + 1}. ${o}`)].join("\n") : "";
  return (
    <dialog className="drawer" ref={ref} aria-labelledby="exportTitle" onClick={(e) => { if (e.target === ref.current) ref.current?.close(); }}>
      <div className="dlg-h"><span className="itile sm"><Icon name="box" /></span><h2 id="exportTitle">最终交付 <small className="muted" style={{ fontSize: 13, fontWeight: 500 }}>/ Deliverables</small></h2>{ws.is_demo && <span className="tag t-demo">{DEMO_TAG}</span>}
        <button type="button" className="btn btn-ghost btn-sm" aria-label="关闭" onClick={() => ref.current?.close()}><Icon name="x" /></button></div>
      <div className="dlg-b">
        {!pack ? <p className="muted">正在整理…</p> : (
          <>
            {open ? (
              <div className="state need"><Icon name="hand" /><span className="grow">还有 {open} 件事没决定。现在导出也可以，这些地方会写成 <b>[待确认]</b>，其他内容不受影响。</span>
                <button type="button" className="btn btn-sm" onClick={onDecide}>先去决定</button></div>
            ) : (
              <div className="state ok"><Icon name="checkCircle" /><span className="grow">都确认好了，可以发布。检查报告和中英口径表会一起下载。</span></div>
            )}
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}><b style={{ fontSize: 15 }}>英文产品页面</b><span className="muted" style={{ fontSize: 12.5 }}>English Product Page · Markdown，可直接贴进 Kickstarter 编辑器</span></div>
              <pre className="md">{pack.markdown}</pre>
            </div>
            <div>
              <b style={{ fontSize: 15, display: "block", marginBottom: 8 }}>一起生成好的</b>
              <ul className="extras">
                <li><details><summary><span className="itile sm"><Icon name="doc" /></span><span><b>审校报告</b><small>Review Report · 系统改了什么、为什么、你决定了什么、还缺什么</small></span><Icon name="down" /></summary>
                  <div className="inner"><pre className="md">{pack.report}</pre></div></details></li>
                {pack.glossary && <li><details><summary><span className="itile sm teal"><Icon name="file" /></span><span><b>中英口径表</b><small>给客服、KOL 和海外代理商统一说法</small></span><Icon name="down" /></summary>
                  <div className="inner"><table className="tbl"><thead><tr><th>中文说法</th><th>对外英文说法</th><th>不要说</th></tr></thead>
                    <tbody>{ws.brief.glossary.map((g) => <tr key={g[0]}><td>{g[0]}</td><td className="en">{g[1]}</td><td>{g[2]}</td></tr>)}</tbody></table></div></details></li>}
                {pack.draft && <li><details><summary><span className="itile sm zhi">知</span><span><b>知乎知识回流草稿</b><small>Zhihu Knowledge Feedback Draft · 系统不会替你发布</small></span><Icon name="down" /></summary>
                  <div className="inner draft">
                    <h4>{pack.draft.title}</h4><p className="muted" style={{ margin: 0, fontSize: 13 }}>{pack.draft.meta}</p>
                    <ol>{pack.draft.outline.map((o) => <li key={o}>{o}</li>)}</ol>
                    <ul className="checks">{pack.draft.checks.map(([c, who], i) => who === "system"
                      ? <li key={c}><Icon name="check" small />{c}（系统已查）</li>
                      : <li key={c}><input type="checkbox" id={`ck${i}`} /><label htmlFor={`ck${i}`}>{c}（只有你能确认）</label></li>)}</ul>
                    <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                      <button type="button" className="btn btn-sm" onClick={() => copy("draft", draftText)}><Icon name={copied === "draft" ? "check" : "copy"} small />{copied === "draft" ? "已复制" : "复制草稿"}</button>
                      <a className="btn btn-sm" href="https://www.zhihu.com/" target="_blank" rel="noopener noreferrer"><Icon name="external" small />打开知乎，自己决定是否发布</a>
                    </div>
                  </div></details></li>}
              </ul>
            </div>
          </>
        )}
      </div>
      <div className="dlg-f">
        <button type="button" className="btn" disabled={!pack} onClick={() => pack && copy("md", pack.markdown)}><Icon name={copied === "md" ? "check" : "copy"} small />{copied === "md" ? "已复制" : "复制英文页"}</button>
        <button type="button" className="btn btn-primary" disabled={!pack} onClick={() => {
          if (!pack) return;
          downloadText(`${ws.name.split(" ")[0] || "zhihu-bridge"}-launch-pack.md`, [pack.markdown, pack.report, pack.glossary].filter(Boolean).join("\n\n---\n\n"));
          toast("已下载发布包（英文页 + 审校报告 + 中英口径表）");
        }}><Icon name="download" small />导出 Markdown（全部）</button>
      </div>
    </dialog>
  );
}

function TraceDrawer({ onClose }: { onClose: () => void }) {
  const { ws, toast } = useWb();
  const ref = useDialog(onClose);
  const [trace, setTrace] = useState<Trace | null>(null);
  useEffect(() => { api.trace(ws.id).then(setTrace, () => toast("生成记录读取失败")); }, [ws.id, toast]);
  return (
    <dialog className="drawer" ref={ref} aria-labelledby="traceTitle" onClick={(e) => { if (e.target === ref.current) ref.current?.close(); }}>
      <div className="dlg-h"><h2 id="traceTitle">生成记录与数据来源</h2><button type="button" className="btn btn-ghost btn-sm" aria-label="关闭" onClick={() => ref.current?.close()}><Icon name="x" /></button></div>
      <div className="dlg-b">
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>给评委和开发者看的：每一步用了什么、数据从哪来。日常使用不需要打开。</p>
        <table className="tbl"><thead><tr><th>步骤</th><th>生成方式</th><th>数据来源</th><th>知乎额度</th></tr></thead>
          <tbody>{trace?.steps.map((s) => <tr key={s.step}><td>{s.step}</td><td><span className="tag t-muted">{s.llm_mode}</span></td><td>{s.data}</td><td className="mono">{s.quota}</td></tr>)}</tbody></table>
        <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>知乎额度由系统管理：优先用缓存，额度不够时自动改用缓存或示例数据，并在相关依据旁标明，不会冒充实时结果。</p>
        {trace && trace.actions.length > 0 && (<>
          <h4 style={{ margin: "8px 0 0", fontSize: 14 }}>最近的操作</h4>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: "var(--text-secondary)" }}>{trace.actions.map((a) => <li key={a.id} style={a.undone ? { color: "var(--text-muted)", textDecoration: "line-through" } : undefined}>{a.label}</li>)}</ul>
        </>)}
      </div>
    </dialog>
  );
}
