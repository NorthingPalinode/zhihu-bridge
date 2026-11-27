import { useEffect, useRef, useState } from "react";
import { ApiError, api, fileToBase64 } from "./api";
import { DEMO_TAG } from "./copy";
import { Icon, ProductTile } from "./icons";
import { TopNav } from "./TopNav";
import type { ProjectRow } from "./types";
import kanshanWave from "./assets/kanshan-wave.gif";
import kanshanStill from "./assets/kanshan-still.png";

const ACCEPT = ".txt,.md,.csv,.docx,.pdf";
const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export function Home({ onOpen, onRun }: { onOpen: (id: string, toastMsg?: string) => void; onRun: (id: string, names: string[]) => void }) {
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [pasting, setPasting] = useState(false);
  const [text, setText] = useState("");
  const [over, setOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const recent = useRef<HTMLDivElement>(null);

  useEffect(() => { api.list().then((r) => setProjects(r.projects), () => setProjects([])); }, []);

  const start = async (files: File[], pasted?: string) => {
    setError(null);
    setWorking(true);
    try {
      const payload = await Promise.all(files.map(async (f) => ({ name: f.name, content_b64: await fileToBase64(f) })));
      const { id } = await api.create(payload, pasted);
      onRun(id, [...files.map((f) => f.name), ...(pasted ? ["粘贴的文字"] : [])]);
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : "没有开始成功，请再试一次");
    } finally {
      setWorking(false);
    }
  };

  const openDemo = async () => {
    setError(null);
    setWorking(true);
    try {
      const { id } = await api.createDemo();
      onOpen(id, "已预载 PulseRing X1 产品资料包（5 份，含 PDF），请按步骤体验完整流程");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "示例项目没有打开成功");
    } finally {
      setWorking(false);
    }
  };

  const pick = () => input.current?.click();
  const caps: [string, string, string, string, string][] = [
    ["box", "", "产品事实档案", "Product Fact Profile", "从说明书、规格表、工程笔记里提取可核对的事实，标出冲突和缺口；资料写得明确的，你一次确认。"],
    ["layers", "violet", "知乎认知洞察", "Zhihu Insights", "检索知乎讨论与英文同类产品的说法，找出直译会被误读的工程黑话，给出本地化写法。"],
    ["shield", "teal", "发布前审校", "Pre-publish Review", "逐句检查事实一致性、夸大声称与跨文化表达；没有依据的说法直接改掉，留痕可撤销。"],
  ];
  const flow: [string, string, string, string][] = [
    ["file", "", "产品资料", "说明书、规格表、工程笔记、中文文案"],
    ["layers", "zhi", "知乎洞察", "社区语境、出海经验、英文同类表达"],
    ["sparkle", "", "海外内容", "标题、卖点、详细介绍、技术参数、FAQ"],
    ["shield", "you", "审校交付", "逐句核对，你拍板几件事，一次导出"],
  ];

  return (
    <div>
      <TopNav onHome={() => window.scrollTo({ top: 0, behavior: "smooth" })} onNew={pick} onDemo={openDemo}
        onRecent={() => recent.current?.scrollIntoView({ behavior: "smooth", block: "start" })} current="home" />
      <main className="page">
        <div className="home-grid">
          <div>
            <section className={`hero${over ? " dropping" : ""}`}
              onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
              onDrop={(e) => { e.preventDefault(); setOver(false); const fs = [...e.dataTransfer.files]; if (fs.length) void start(fs); }}>
              <div>
                <span className="hero-badge"><b>AI × 出海</b><span>面向中国智能硬件团队的海外内容工作台</span></span>
                <h1><span className="nw">让知乎知识，</span><br /><span className="nw">成为出海内容的<span className="hl">认知桥梁</span></span></h1>
                <div className="bar" />
                <p className="lead">连接产品资料、知乎洞察、海外内容生成与发布前审校，帮助中国智能硬件品牌高效准备面向美国市场的英文上市内容。</p>
                <button type="button" className="btn btn-primary btn-xl" disabled={working} onClick={pick}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>{working ? <span className="spin" /> : null}创建新品出海项目 <Icon name="right" /></span>
                  <small>上传资料就开始 · Create a New Global Launch Project</small>
                </button>
                <input ref={input} type="file" multiple hidden accept={ACCEPT} onChange={(e) => { const fs = [...(e.target.files ?? [])]; e.target.value = ""; if (fs.length) void start(fs); }} />
                <p className="hero-hint">支持 .txt · .md · .csv · .docx · .pdf，可以一次放多份，也可以直接拖到这里，或 <button type="button" className="link" onClick={() => setPasting((v) => !v)}>粘贴文字</button>。不用填表。</p>
                {pasting && (
                  <div className="paste">
                    <textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="把产品介绍、参数或现有中文文案直接粘贴进来" maxLength={20000} />
                    <div className="row"><span className="muted" style={{ fontSize: 12 }}>{text.trim().length} 字</span>
                      <button type="button" className="btn btn-primary btn-sm" disabled={!text.trim() || working} onClick={() => start([], text)}>开始</button></div>
                  </div>
                )}
                {error && <div className="state need" role="alert" style={{ marginTop: 16 }}><Icon name="alert" /><span className="grow">{error}</span></div>}
              </div>
              <div className="hero-art" aria-hidden="true">
                <svg className="arcs" viewBox="0 0 600 400" preserveAspectRatio="none">
                  <path d="M60 330 C 160 180, 300 180, 380 300" /><path d="M200 340 C 300 150, 470 150, 560 300" /><path d="M120 360 C 240 260, 380 250, 500 340" />
                  <circle cx="380" cy="300" r="4" /><circle cx="560" cy="300" r="4" /><circle cx="60" cy="330" r="3" />
                </svg>
                <div className="globe" />
                <div className="zhi-badge">知</div>
                <img className="mascot" src={reducedMotion() ? kanshanStill : kanshanWave} alt="" />
              </div>
            </section>

            <div className="cap-grid">
              {caps.map(([icon, tone, zh, en, desc]) => (
                <div key={zh} className="glass cap">
                  <span className={`itile${tone ? " " + tone : ""}`}><Icon name={icon} /></span>
                  <b>{zh}</b><Icon name="right" />
                  <span className="en-sub">{en}</span>
                  <p>{desc}</p>
                </div>
              ))}
            </div>

            <div className="section-h" ref={recent}>
              <span className="itile sm"><Icon name="folder" /></span><h2>最近项目</h2><small>Recent Projects</small>
            </div>
            <div className="proj-grid">
              {projects === null && <div className="glass empty-card">正在读取…</div>}
              {projects?.length === 0 && <div className="glass empty-card">还没有项目。上传资料，或者先打开示例项目看看。</div>}
              {projects?.map((p) => (
                <button key={p.id} type="button" className="glass proj" onClick={() => onOpen(p.id)}>
                  <ProductTile />
                  <div>
                    <b>{p.name}</b>
                    <div className="row"><Icon name="shield" small />美国市场<span className="sep" />英文<span className="sep" />{p.channel === "ks" ? "Kickstarter" : "独立站"}</div>
                    <div className="row">
                      {p.staged ? <><span className="dot-i" style={{ color: "var(--accent-cyan)" }} /><b style={{ display: "inline", fontSize: 13, margin: 0, color: "var(--accent-cyan)" }}>分步体验进行中</b></>
                        : p.open ? <><span className="dot-i" style={{ color: "var(--need)" }} /><b style={{ display: "inline", fontSize: 13, margin: 0, color: "var(--need)" }}>还需你决定 {p.open} 件</b></>
                        : <><Icon name="checkCircle" small className="ok-ic" /><b style={{ display: "inline", fontSize: 13, margin: 0, color: "var(--status-success)" }}>可以导出</b></>}
                      {p.is_demo && <span className="tag t-demo">{DEMO_TAG}</span>}
                      <span className="go"><Icon name="right" small /></span>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>

          <aside className="glass flow-panel" aria-label="工作流程">
            <h2>出海内容工作流</h2>
            <p className="sub">From Product to Global Content</p>
            <ol className="flow">
              {flow.map(([icon, tone, zh, desc]) => (
                <li key={zh} className={tone === "you" ? "you" : undefined}>
                  {tone === "zhi" ? <span className="itile lg zhi">知</span> : <span className="itile lg"><Icon name={icon} /></span>}
                  <div><b>{zh}</b><small>{desc}</small></div>
                </li>
              ))}
            </ol>
          </aside>
        </div>
      </main>
    </div>
  );
}
