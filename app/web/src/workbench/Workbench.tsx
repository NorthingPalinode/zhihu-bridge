import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { DEMO_TAG, DEV_TAG, hasStage, stepSummary } from "./copy";
import { useWb, type Step } from "./context";
import { Icon, ProductTile, Ring } from "./icons";
import { ExportDrawer } from "./PosterExport";
import { Content } from "./steps/Content";
import { Insights } from "./steps/Insights";
import { Materials } from "./steps/Materials";
import { Review } from "./steps/Review";
import { TopNav } from "./TopNav";
import type { Trace } from "./types";

const STEPS: [Step, string, string][] = [["materials", "产品资料", "box"], ["insights", "知乎认知洞察", "layers"], ["content", "海外内容", "globe"], ["review", "发布前审校", "shield"]];

export function Workbench({ onHome, onDemo }: { onHome: () => void; onDemo: () => void }) {
  const { ws, step, goStep, setReviewSel } = useWb();
  const [drawer, setDrawer] = useState<"export" | "export-landing" | "export-docs" | "trace" | null>(null);
  const open = ws.summary.open_decisions;
  const total = ws.decisions.length + ws.issues.filter((i) => i.fix_kind === "user_introduced").length;
  const decided = Math.max(0, total - open.length);
  const reviewed = hasStage(ws, "review");
  const hasContent = hasStage(ws, "content") && ws.assets.length > 0;

  const toNext = () => { goStep("review"); if (open.length) setReviewSel(open[0]); };
  const stepState = (s: Step): "done" | "need" | "" => {
    if (s === "materials") {
      if (!hasStage(ws, "facts")) return "need";
      return ws.decisions.some((d) => d.value === null) ? "need" : "done";
    }
    if (s === "insights") return hasStage(ws, "insights") ? "done" : "";
    if (s === "content") {
      if (!hasStage(ws, "content")) return "";
      return ws.summary.sections_need.length ? "need" : "done";
    }
    if (!hasStage(ws, "review")) return "";
    return ws.summary.ready ? "done" : open.length ? "need" : "";
  };
  const onStepKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const i = STEPS.findIndex(([s]) => s === step);
    const nx = STEPS[(i + (e.key === "ArrowRight" ? 1 : -1) + STEPS.length) % STEPS.length][0];
    goStep(nx);
    requestAnimationFrame(() => document.getElementById(`t-${nx}`)?.focus());
  };

  const nextMissingStep = (): Step => {
    if (!hasStage(ws, "facts")) return "materials";
    if (!hasStage(ws, "insights")) return "insights";
    if (!hasStage(ws, "content")) return "content";
    return "review";
  };

  const progressRatio = reviewed ? (total ? decided / total : 1) : (ws.completed_stages?.length ?? 1) / 5;

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
              <span className={`tag ${!reviewed ? "t-info" : open.length ? "t-need" : "t-ok"}`}>
                <span className="dot-i" />{!reviewed ? "分步体验中" : open.length ? "进行中" : "可以导出"}
              </span>
              {ws.is_demo && <span className="tag t-demo">{DEMO_TAG}</span>}
              {ws.llm_mode === "fake" && <span className="tag t-demo">{DEV_TAG}</span>}
            </div>
            <SettingsRow />
          </div>
          <div className="pstats">
            <Ring value={progressRatio} label={reviewed ? `已决定 ${decided}/${total}` : `流程进度 ${Math.round(progressRatio * 100)}%`} />
            {reviewed ? (
              <div className="pstat"><b>{decided}/{total}</b><small>你的决定</small></div>
            ) : (
              <div className="pstat"><b>{ws.completed_stages?.length ?? 1}/5</b><small>流程阶段</small></div>
            )}
            {!reviewed ? (
              <button type="button" className="btn btn-primary" onClick={() => goStep(nextMissingStep())}>
                <Icon name="play" small />继续下一步
              </button>
            ) : (
              <button type="button" className={`btn ${open.length ? "btn-outline-glow" : "btn-primary"}`} onClick={open.length ? toNext : () => setDrawer("export")}>
                {open.length ? <><Icon name="hand" small />还需你决定 {open.length} 件</> : <><Icon name="download" small />导出宣传物料</>}
              </button>
            )}
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
          <span className={`step-line${reviewed ? "" : " dim"}`} />
          <button type="button" className="step" onClick={() => setDrawer("export")}>
            <span className="num"><Icon name="download" /></span>
            <span><b>导出交付</b><small>{!hasContent ? "生成内容后可导出海报" : open.length ? "可导出海报 / 未定处标 [待确认]" : "海报 · 落地页 · 社媒 · MD"}</small></span>
          </button>
        </div>

        <section role="tabpanel" aria-labelledby={`t-${step}`}>
          {step === "materials" && <Materials />}
          {step === "insights" && <Insights />}
          {step === "content" && <Content />}
          {step === "review" && <Review onExport={(tab) => setDrawer(tab === "landing" ? "export-landing" : tab === "docs" ? "export-docs" : "export")} />}
        </section>
      </main>

      <footer className="foot">
        <span>AI 辅助撰写和检查，只覆盖列出的检查项，不构成法律意见，也不保证通过平台或监管审核。</span>
        <span style={{ flex: 1 }} />
        <button type="button" className="link quiet" onClick={() => setDrawer("trace")}>生成记录与数据来源</button>
      </footer>

      {(drawer === "export" || drawer === "export-landing" || drawer === "export-docs") && (
        <ExportDrawer
          initialTab={drawer === "export-landing" ? "landing" : drawer === "export-docs" ? "docs" : "poster"}
          onClose={() => setDrawer(null)}
          onDecide={() => { setDrawer(null); toNext(); }}
          onGoReview={() => { setDrawer(null); goStep("review"); }}
        />
      )}
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
