import { useState } from "react";
import { api } from "../api";
import { LAYER_CLASS, hasStage, plainText } from "../copy";
import { useWb } from "../context";
import { Icon } from "../icons";
import { factIcon } from "./Materials";
import kanshanLaptop from "../assets/kanshan-laptop.gif";
import kanshanStill from "../assets/kanshan-still.png";

const CATEGORY: Record<string, [string, string, string]> = {
  "转化为具体工程价值": ["术语语境", "layers", ""],
  "补充边界条件": ["潜在误解", "alert", "red"],
  "保留并解释": ["社区关注点", "chart", "violet"],
  "删除夸张说法": ["本地化建议", "globe", "teal"],
};
const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export function Insights() {
  const { ws, run, goStep } = useWb();
  const [running, setRunning] = useState(false);
  const insightsDone = hasStage(ws, "insights");
  const factsDone = hasStage(ws, "facts");
  const facts = Object.fromEntries(ws.facts.map((f) => [f.id, f]));
  const audience = ws.settings_options.audience.find((o) => o[0] === ws.settings.audience)?.[1];
  const tone = ws.settings_options.tone.find((o) => o[0] === ws.settings.tone)?.[1];
  const headline = ws.assets.find((a) => a.id === "headline")?.items.find((i) => i.kind === "tagline");
  const live = ws.retrieval_mode === "live";

  const trigger = async () => {
    setRunning(true);
    try {
      await run(() => api.runStage(ws.id, "insights"));
    } finally {
      setRunning(false);
    }
  };

  return (
    <>
      <section className="ins-hero">
        <div>
          <h1>{ws.name}</h1>
          <p>基于知乎社区的认知洞察，把中国用户与工程师的真实讨论，转化为可执行的跨文化出海写法。</p>
          <div className="ins-flow" style={{ marginTop: 16 }}>
            <span className="node"><span className="itile sm zhi">知</span><span><b>知乎知识</b><small>{live ? "实时检索 · 原文可查" : "示例数据 · 未实时检索"}</small></span></span>
            <span className="chev">»</span>
            <span className="node"><span className="itile sm"><Icon name="sparkle" /></span><span><b>结构化洞察</b><small>风险 · 机会 · 语境</small></span></span>
            <span className="chev">»</span>
            <span className="node"><span className="itile sm teal"><Icon name="globe" /></span><span><b>跨文化行动</b><small>本地化写法 · 内容指引</small></span></span>
          </div>
        </div>
        <img className="ins-mascot" src={reducedMotion() ? kanshanStill : kanshanLaptop} alt="" />
      </section>

      {!insightsDone ? (
        <section className="glass stage-gate">
          <span className="itile lg zhi">知</span>
          <h3>尚未执行知乎认知洞察分析</h3>
          <p>
            {factsDone
              ? `系统已提取 ${ws.facts.length} 条产品事实。点击下方按钮，将针对资料中的中文工程黑话（如“堆料”“极限压榨功耗”“底层协议调试”）检索知乎语境与英文同类表达，识别直译误读风险并生成内容策略 Brief。`
              : "请先在第 1 步「产品资料」中提取产品事实档案，再启动知乎认知洞察分析。"}
          </p>
          <div className="meta-row">
            <span className="tag t-info">识别直译踩坑术语</span>
            <span className="tag t-ok">对照英文同类众筹表达</span>
            <span className="tag t-need">自动生成内容策略 Brief</span>
          </div>
          {factsDone ? (
            <button type="button" className="btn btn-primary btn-lg" disabled={running} onClick={trigger}>
              {running ? <><span className="spin" />正在分析知乎社区洞察…</> : <><Icon name="layers" />启动知乎认知洞察分析 <Icon name="right" /></>}
            </button>
          ) : (
            <button type="button" className="btn btn-primary btn-lg" onClick={() => goStep("materials")}>
              <Icon name="left" />先去第 1 步：提取产品事实
            </button>
          )}
        </section>
      ) : !ws.insights.length ? (
        <section className="glass" style={{ padding: 24 }}>
          <p style={{ margin: 0 }}>这次没有找到直译容易被误读的说法，或者知乎检索没有开启。英文页按产品事实直接写成，发布前检查照常进行。</p>
          <button type="button" className="btn btn-primary" style={{ marginTop: 14 }} onClick={() => goStep("content")}>进入下一步：海外内容 <Icon name="right" small /></button>
        </section>
      ) : (
        <div className="cols cols-ins main-first">
          <div className="stack main">
            <div className="key-h"><Icon name="sparkle" />核心洞察：从知乎讨论中提炼的出海关键认知</div>
            <div className="ins-grid">
              {ws.insights.map((i) => {
                const [cat, catIcon, tone2] = CATEGORY[i.strategy] ?? ["跨文化洞察", "layers", ""];
                return (
                  <article key={i.id} className={`glass icard${i.enabled ? "" : " off"}`}>
                    <div className="icard-cat"><span className={`itile sm${tone2 ? " " + tone2 : ""}`}><Icon name={catIcon} /></span>{cat}<span className="muted" style={{ fontWeight: 500, fontSize: 12.5 }}>· {i.strategy}</span></div>
                    <div className="icard-main">
                      <div className="icard-art"><Icon name={factIcon(`${i.concept} ${facts[i.fact]?.text ?? ""}`)} /></div>
                      <div>
                        <h3>{i.concept}</h3>
                        <div className="lbl"><Icon name="chat" small />知乎讨论摘要</div>
                        <p className="sum">{i.zhihu}</p>
                      </div>
                      <div className="callout"><b><Icon name="target" small />关键洞察 / 风险</b>{i.risk}</div>
                    </div>
                    <div className="loc-bar">
                      <span className="k"><Icon name="globe" small />英文本地化策略</span>
                      <b className="en">{i.localized}</b>
                      <small>{i.action}</small>
                    </div>
                    <div className="cmp-line"><span className="k">直译</span><del className="en">{i.literal}</del></div>
                    <div className="icard-foot">
                      <span><Icon name="chat" small /> {i.zhihu_url ? <a href={i.zhihu_url} target="_blank" rel="noopener noreferrer">{i.zhihu_cite}</a> : i.zhihu_cite}</span>
                      <span><span className={`ly ${LAYER_CLASS[i.english.layer]}`}>{i.english.label}</span> {i.english.url ? <a href={i.english.url} target="_blank" rel="noopener noreferrer">{i.english.cite}</a> : <span>{i.english.mode}</span>}</span>
                      <label className="switch">
                        <input type="checkbox" role="switch" checked={i.enabled} aria-label={`${i.concept} 这条建议`}
                          onChange={(e) => run(() => api.toggleInsight(ws.id, i.id, e.target.checked), ["features", "story", "faq"])} />
                        {i.enabled ? "在用" : "没用"}
                      </label>
                    </div>
                  </article>
                );
              })}
            </div>
          </div>

          <aside className="glass brief" aria-label="内容策略 Brief">
            <div className="ph-head"><span className="itile"><Icon name="doc" /></span><h2>内容策略 Brief <small>写作要点</small></h2></div>
            <div className="ph-body">
              <p className="muted" style={{ margin: "-6px 0 12px", fontSize: 12.5 }}>系统根据事实和在用的知乎建议自动整理，不需要你单独确认。</p>
              <div className="bsec"><h4><span className="itile sm"><Icon name="users" /></span>目标受众 <small>(Audience)</small></h4><p>{audience}</p></div>
              <div className="bsec"><h4><span className="itile sm"><Icon name="megaphone" /></span>内容语气 <small>(Tone)</small></h4><p>{tone}</p></div>
              {ws.brief.faq.length > 0 && <div className="bsec"><h4><span className="itile sm"><Icon name="help" /></span>FAQ 优先级 <small>(FAQ Priorities)</small></h4><ol>{ws.brief.faq.map((q) => <li key={q} className="en">{q}</li>)}</ol></div>}
              <div className="bsec"><h4><span className="itile sm"><Icon name="target" /></span>核心传达策略 <small>(Messaging)</small></h4>
                {headline && <div className="quote-card en">“{plainText(headline.parts)}”</div>}
                {ws.brief.priorities.length > 0 && <ul className="checks">{ws.brief.priorities.map((p) => <li key={p}><Icon name="check" small />{p}</li>)}</ul>}
              </div>
              {ws.brief.forbidden.length > 0 && <div className="bsec"><h4><span className="itile sm red"><Icon name="x" /></span>不会出现的说法</h4><div className="forbid">{ws.brief.forbidden.map((p) => <span key={p}>{p}</span>)}</div></div>}
              <button type="button" className="btn btn-primary" style={{ width: "100%", marginTop: 14 }} onClick={() => goStep("content")}>
                {hasStage(ws, "content") ? "看这些要点写成的英文页" : "下一步：生成海外内容"} <Icon name="right" small />
              </button>
            </div>
          </aside>
        </div>
      )}

      <section className="glass banner-line">
        <span className="itile lg zhi">知</span>
        <b>从知乎知识到全球市场：让真实的中国用户洞察，成为可执行的跨文化内容策略</b>
        <span className="chips"><span><Icon name="checkCircle" small />理解真实认知</span><span><Icon name="checkCircle" small />识别风险与机会</span><span><Icon name="checkCircle" small />产出本地化表达</span><span><Icon name="checkCircle" small />指导内容生成</span></span>
      </section>
    </>
  );
}
