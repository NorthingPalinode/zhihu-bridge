import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { DEMO_TAG, DEV_TAG, statusLabel, stepSummary } from "./copy";
import { useWb, type Step } from "./context";
import { BridgeMark, Icon } from "./icons";
import { Content } from "./steps/Content";
import { Insights } from "./steps/Insights";
import { Materials } from "./steps/Materials";
import { Review } from "./steps/Review";
import type { ExportPack, Trace } from "./types";

const STEPS: [Step, string][] = [["materials", "产品资料"], ["insights", "知乎认知洞察"], ["content", "海外内容"], ["review", "发布前检查"]];

export function Workbench({ onHome }: { onHome: () => void }) {
  const { ws, step, goStep, setReviewSel } = useWb();
  const [drawer, setDrawer] = useState<"export" | "trace" | null>(null);
  const n = ws.summary.open_decisions.length;

  const toNext = () => {
    goStep("review");
    if (n) setReviewSel(ws.summary.open_decisions[0]);
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
      <header className="chrome">
        <button type="button" className="brand" aria-label="返回首页" onClick={onHome}><BridgeMark /></button>
        <nav className="crumbs" aria-label="位置">
          <button type="button" className="hide-sm" onClick={onHome}>项目</button><span className="hide-sm">/</span>
          <b>{ws.name}</b>
          {ws.is_demo && <span className="tag tag-demo hide-sm">{DEMO_TAG}</span>}
          {ws.llm_mode === "fake" && <span className="tag tag-demo hide-sm">{DEV_TAG}</span>}
        </nav>
        <span className="spacer" />
        <button type="button" className={`pill ${n ? "need" : "ok"}`} onClick={toNext}><i /><span>{statusLabel(ws)}</span></button>
        <button type="button" className="btn btn-sm btn-primary" onClick={() => setDrawer("export")}><Icon name="download" small />导出交付</button>
      </header>

      <div className="wb-bar">
        <SettingsRow />
        <div className="stepper" role="tablist" aria-label="工作台步骤" onKeyDown={onStepKey}>
          {STEPS.map(([s, label], i) => {
            const sum = stepSummary(ws, s);
            return (
              <button key={s} type="button" className="step" role="tab" id={`t-${s}`} aria-selected={step === s} tabIndex={step === s ? 0 : -1} onClick={() => goStep(s)}>
                <span className="n">{i + 1}</span>
                <span><b>{label}</b><small>{sum.text}{sum.tail && <span className={sum.tone}>{sum.tail}</span>}</small></span>
              </button>
            );
          })}
        </div>
      </div>

      <section role="tabpanel" aria-labelledby={`t-${step}`}>
        {step === "materials" && <Materials />}
        {step === "insights" && <Insights />}
        {step === "content" && <Content />}
        {step === "review" && <Review />}
      </section>

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
  const chip = (key: "channel" | "audience" | "tone", label: string) => {
    const opts = ws.settings_options[key];
    const current = opts.find((o) => o[0] === ws.settings[key])?.[1];
    return (
      <span className="kv"><span>{label}</span>
        <button type="button" className="chip" onClick={(e) => openPop(e.currentTarget, (
          <div className="menu-list" role="menu">
            <div className="mhint">改了会自动重写受影响的段落</div>
            {opts.map(([v, l]) => (
              <button type="button" role="menuitemradio" aria-checked={ws.settings[key] === v} key={v}
                onClick={() => { closePop(); if (ws.settings[key] !== v) void run(() => api.setting(ws.id, key, v), key === "channel" ? ws.assets.map((a) => a.id) : ["headline"]); }}>{l}</button>
            ))}
          </div>), "menu-pop")}>
          <span>{current}</span><Icon name="down" />
        </button>
      </span>
    );
  };
  return (
    <div className="wb-meta">
      <span className="kv"><span>市场</span>美国 · English (US)</span>
      {chip("channel", "渠道")}{chip("audience", "受众")}{chip("tone", "语气")}
      <span className="hint">系统根据资料判断的，不对可以改</span>
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

function download(name: string, text: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
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
      <div className="dlg-h"><h2 id="exportTitle">导出交付</h2>{ws.is_demo && <span className="tag tag-demo">{DEMO_TAG}</span>}
        <button type="button" className="btn btn-ghost btn-sm" aria-label="关闭" onClick={() => ref.current?.close()}><Icon name="x" /></button></div>
      <div className="dlg-b" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {!pack ? <p className="muted">正在整理…</p> : (
          <>
            {open ? (
              <div className="state need"><Icon name="hand" /><span className="grow">还有 {open} 件事没决定。现在导出也可以，这些地方会写成 <b>[待确认]</b>，其他内容不受影响。</span>
                <button type="button" className="btn btn-sm" onClick={onDecide}>先去决定</button></div>
            ) : (
              <div className="state ok"><Icon name="check" /><span className="grow">都确认好了，可以发布。检查报告和中英口径表会一起下载。</span></div>
            )}
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}><b style={{ fontSize: 14 }}>英文新品页</b><span className="muted" style={{ fontSize: 12.5 }}>Markdown，可直接贴进 Kickstarter 编辑器</span></div>
              <pre className="md" style={{ margin: 0 }}>{pack.markdown}</pre>
            </div>
            <div>
              <b style={{ fontSize: 14, display: "block", marginBottom: 8 }}>一起生成好的</b>
              <ul className="extras">
                <li><details><summary><Icon name="shield" /><span><b>检查报告</b><small>给团队内部看：系统改了什么、为什么、你决定了什么、还缺什么</small></span><Icon name="down" /></summary>
                  <div className="inner"><pre className="md" style={{ margin: 0 }}>{pack.report}</pre></div></details></li>
                {pack.glossary && <li><details><summary><Icon name="file" /><span><b>中英口径表</b><small>给客服、KOL 和海外代理商统一说法</small></span><Icon name="down" /></summary>
                  <div className="inner"><div className="table-wrap"><table className="gloss"><thead><tr><th>中文说法</th><th>对外英文说法</th><th>不要说</th></tr></thead>
                    <tbody>{ws.brief.glossary.map((g) => <tr key={g[0]}><td>{g[0]}</td><td className="en">{g[1]}</td><td>{g[2]}</td></tr>)}</tbody></table></div></div></details></li>}
                {pack.draft && <li><details><summary><Icon name="external" /><span><b>知乎技术拆解草稿</b><small>同一份工作，顺手做一次国内预热。系统不会替你发布</small></span><Icon name="down" /></summary>
                  <div className="inner"><div className="draft" style={{ marginTop: 0 }}>
                    <h3>{pack.draft.title}</h3><p className="muted" style={{ margin: 0, fontSize: 13 }}>{pack.draft.meta}</p>
                    <ol>{pack.draft.outline.map((o) => <li key={o}>{o}</li>)}</ol>
                    <ul className="checks">{pack.draft.checks.map(([c, who], i) => who === "system"
                      ? <li key={c}><Icon name="check" />{c}（系统已查）</li>
                      : <li key={c}><input type="checkbox" id={`ck${i}`} /><label htmlFor={`ck${i}`}>{c}（只有你能确认）</label></li>)}</ul>
                    <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                      <button type="button" className="btn btn-sm" onClick={() => copy("draft", draftText)}><Icon name={copied === "draft" ? "check" : "copy"} small />{copied === "draft" ? "已复制" : "复制草稿"}</button>
                      <a className="btn btn-sm" href="https://www.zhihu.com/" target="_blank" rel="noopener noreferrer"><Icon name="external" small />打开知乎，自己决定是否发布</a>
                    </div>
                  </div></div></details></li>}
              </ul>
            </div>
          </>
        )}
      </div>
      <div className="dlg-f">
        <button type="button" className="btn" disabled={!pack} onClick={() => pack && copy("md", pack.markdown)}><Icon name={copied === "md" ? "check" : "copy"} small />{copied === "md" ? "已复制" : "复制英文页"}</button>
        <button type="button" className="btn btn-primary" disabled={!pack} onClick={() => {
          if (!pack) return;
          download(`${ws.name.split(" ")[0] || "zhihu-bridge"}-launch-pack.md`, [pack.markdown, pack.report, pack.glossary].filter(Boolean).join("\n\n---\n\n"));
          toast("已下载发布包（英文页 + 检查报告 + 中英口径表）");
        }}><Icon name="download" small />下载全部（.md）</button>
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
        <p className="muted" style={{ margin: "0 0 12px", fontSize: 13 }}>给评委和开发者看的：每一步用了什么、数据从哪来。日常使用不需要打开。</p>
        <div className="table-wrap"><table className="trace"><thead><tr><th>步骤</th><th>生成方式</th><th>数据来源</th><th>知乎额度</th></tr></thead>
          <tbody>{trace?.steps.map((s) => <tr key={s.step}><td>{s.step}</td><td><span className="tag st-neutral">{s.llm_mode}</span></td><td>{s.data}</td><td className="mono">{s.quota}</td></tr>)}</tbody></table></div>
        <p className="muted" style={{ margin: "12px 0", fontSize: 12.5 }}>知乎额度由系统管理：优先用缓存，额度不够时自动改用缓存或示例数据，并在相关依据旁标明，不会冒充实时结果。</p>
        {trace && trace.actions.length > 0 && (<>
          <h4 style={{ margin: "16px 0 6px", fontSize: 13 }}>最近的操作</h4>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>{trace.actions.map((a) => <li key={a.id} style={a.undone ? { color: "var(--text-muted)", textDecoration: "line-through" } : undefined}>{a.label}</li>)}</ul>
        </>)}
      </div>
    </dialog>
  );
}
