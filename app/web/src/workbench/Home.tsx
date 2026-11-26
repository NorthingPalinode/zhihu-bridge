import { useEffect, useRef, useState } from "react";
import { ApiError, api, fileToBase64 } from "./api";
import { DEMO_TAG } from "./copy";
import { BridgeMark, Icon } from "./icons";
import type { ProjectRow } from "./types";

const ACCEPT = ".txt,.md,.csv,.docx,.pdf";

export function Home({ onOpen, onRun }: { onOpen: (id: string) => void; onRun: (id: string, names: string[]) => void }) {
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [pasting, setPasting] = useState(false);
  const [text, setText] = useState("");
  const [over, setOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const input = useRef<HTMLInputElement>(null);

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
    const existing = projects?.find((p) => p.is_demo);
    if (existing) return onOpen(existing.id);
    setWorking(true);
    try {
      const { id } = await api.createDemo();
      onRun(id, ["PulseRing X1 示例资料包（5 份）"]);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "示例项目没有打开成功");
    } finally {
      setWorking(false);
    }
  };

  return (
    <div>
      <header className="chrome">
        <span className="brand"><BridgeMark />Zhihu Bridge <small>出海内容工作台</small></span>
        <span className="spacer" />
        <button type="button" className="btn btn-sm" onClick={() => input.current?.click()} disabled={working}><Icon name="plus" small />新建项目</button>
      </header>
      <main className="home">
        <section className="hero">
          <div className={`hero-drop${over ? " over" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); const fs = [...e.dataTransfer.files]; if (fs.length) void start(fs); }}>
            <div className="eyebrow"><span>智能硬件出海</span><span>美国 · English (US)</span><span>知乎知识增强</span><span>发布前检查</span></div>
            <h1>把中国智能硬件的产品资料，变成海外团队敢直接发布的新品内容</h1>
            <p className="lead">把产品说明、规格表、工程笔记丢进来。系统借助知乎社区的工程语境看清认知差，写好面向美国市场的英文发布页，并在上线前逐句查过。你只需要拍板几件只有你知道的事。</p>
            <div className="cta-row">
              <button type="button" className="btn btn-primary btn-lg" disabled={working} onClick={() => input.current?.click()}><Icon name="upload" />上传产品资料，开始</button>
              <button type="button" className="btn btn-lg" disabled={working} onClick={openDemo}>打开示例项目（PulseRing X1）<Icon name="right" /></button>
            </div>
            <input ref={input} type="file" multiple hidden accept={ACCEPT} onChange={(e) => { const fs = [...(e.target.files ?? [])]; e.target.value = ""; if (fs.length) void start(fs); }} />
            <p className="formats">支持 .txt · .md · .csv · .docx，可以一次放多份，也可以直接拖到这里，或 <button type="button" className="link" onClick={() => setPasting((v) => !v)}>粘贴文字</button>。不用填表，产品名和渠道系统会自己判断。</p>
            {pasting && (
              <div className="paste">
                <textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="把产品介绍、参数或现有中文文案直接粘贴进来" maxLength={20000} />
                <div className="row"><span className="muted" style={{ fontSize: 12 }}>{text.trim().length} 字</span>
                  <button type="button" className="btn btn-primary btn-sm" disabled={!text.trim() || working} onClick={() => start([], text)}>开始</button></div>
              </div>
            )}
            {error && <div className="state need" role="alert" style={{ marginBottom: 20 }}><Icon name="alert" /><span className="grow">{error}</span></div>}
            <ul className="principles">
              <li><b>企业资料是唯一事实来源</b>参数、认证、续航只认你的资料，缺了就不写，绝不编造。</li>
              <li><b>知乎提供语境，不提供参数</b>用社区讨论解释黑话和出海经验，每条依据都标明出处。</li>
              <li><b>系统替你做，你说了算</b>系统改过的地方都能看、能撤销；冲突由你拍板，任何平台都不会自动发布。</li>
            </ul>
          </div>
          <aside className="pipeline" aria-label="工作流程">
            <h2><span>一个项目，四步到可交付</span><span className="mono">US · Kickstarter</span></h2>
            <ol className="pipe">
              <li><span className="n">01</span><div><b>产品资料 → 产品事实</b><p>系统提取事实、找出冲突和缺口。资料写得明确的，你一次确认。</p><div className="tags"><span className="ly ly-company">你的资料</span></div></div></li>
              <li className="hl"><span className="n">02</span><div><b>知乎认知洞察</b><p>“堆料”“极限压榨功耗”在知乎怎么讲、海外怎么说、直译会被怎样误解，系统默认全部用上。</p><div className="tags"><span className="ly ly-zhihu">知乎讨论</span><span className="ly ly-global">英文同类产品</span></div></div></li>
              <li><span className="n">03</span><div><b>五段英文内容</b><p>标题、核心卖点、详细介绍、技术参数、FAQ，每条卖点都能追溯到事实与洞察。</p></div></li>
              <li><span className="n">04</span><div><b>发布前检查</b><p>逐句检查。没有依据的夸大说法直接改掉，留痕可撤销。</p><div className="tags"><span className="ly ly-rule">官方规则提示</span><span className="ly ly-ai">AI 推断</span></div></div></li>
              <li className="you"><span className="n">→</span><div><b>你拍板几件事，导出</b><p>比如两份资料写的重量不一样，写哪个由你定。英文页、检查报告、中英口径表和知乎草稿一起交付。</p></div></li>
            </ol>
          </aside>
        </section>

        <div className="section-h"><h2>最近项目</h2></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>项目</th><th>渠道</th><th>状态</th><th>更新</th></tr></thead>
            <tbody>
              {projects === null && <tr><td colSpan={4} className="muted">正在读取…</td></tr>}
              {projects?.length === 0 && <tr><td colSpan={4} className="muted">还没有项目。上传资料，或者先打开示例项目看看。</td></tr>}
              {projects?.map((p) => (
                <tr key={p.id} className="proj-row" tabIndex={0} onClick={() => onOpen(p.id)} onKeyDown={(e) => e.key === "Enter" && onOpen(p.id)}>
                  <td className="proj-name"><b>{p.name}</b>{p.is_demo && <span className="tag tag-demo">{DEMO_TAG}</span>}</td>
                  <td>{p.channel === "ks" ? "美国 · Kickstarter 众筹新品页" : "美国 · 独立站新品页"}</td>
                  <td><span className={`tag ${p.open ? "st-warn" : "st-ok"}`}>{p.open ? `还需你决定 ${p.open} 件` : "可以导出"}</span></td>
                  <td className="muted">{ago(p.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  );
}

function ago(ts: number): string {
  const s = Date.now() / 1000 - ts;
  if (s < 90) return "刚刚";
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
  return `${Math.round(s / 86400)} 天前`;
}
