import { api } from "../api";
import { LAYER_CLASS } from "../copy";
import { useWb } from "../context";
import { Icon } from "../icons";

export function Insights() {
  const { ws, run, goStep } = useWb();
  const facts = Object.fromEntries(ws.facts.map((f) => [f.id, f]));
  if (!ws.insights.length) {
    return (
      <div className="panelset main-right"><div className="col" style={{ gridColumn: "1/-1" }}>
        <div className="panel"><div className="panel-b">
          <p style={{ margin: 0 }}>骨架阶段只为示例资料提供知乎建议。正式版会从你的资料里找出直译容易被误读的说法，查知乎上的行业语境，再给出英文写法。</p>
        </div></div>
      </div></div>
    );
  }
  return (
    <div className="panelset main-right">
      <div className="col">
        <div className="panel">
          <div className="panel-h"><h3>分析了哪些说法</h3><span className="meta">来自你的资料</span></div>
          <ul className="concepts">
            {ws.insights.map((i) => (
              <li key={i.id}><div><b>{i.concept}</b><small>{facts[i.fact]?.short} · 直译会被误读</small></div>
                <span className={`tag ${i.enabled ? "st-ok" : "st-outline"}`}>{i.enabled ? "在用" : "没用"}</span></li>
            ))}
          </ul>
          <div className="quiet-note"><Icon name="alert" small style={{ marginTop: 3 }} />
            <span>知乎内容目前是示例数据，未实时检索。额度由系统管理，优先用缓存；需要时可以在页面底部「生成记录与数据来源」里连接知乎账号。</span></div>
        </div>
        <div className="panel">
          <div className="panel-h"><h3>写作要点</h3><span className="meta">系统根据事实和在用的建议自动整理</span></div>
          <div className="brief-grid">
            <section><h4>美国读者最关心（按优先级）</h4><ol>{ws.brief.priorities.map((p) => <li key={p}>{p}</li>)}</ol></section>
            <section><h4>必须回答的质疑（直通 FAQ）</h4><ul>{ws.brief.faq.map((p) => <li key={p} className="en">{p}</li>)}</ul></section>
            <section style={{ gridColumn: "1/-1", borderRight: 0 }}><h4>不会出现在英文页里的说法</h4><div className="forbid">{ws.brief.forbidden.map((p) => <span key={p}>{p}</span>)}</div></section>
          </div>
          <div className="panel-f"><button type="button" className="btn btn-sm" onClick={() => goStep("content")}>看这些要点写成的英文页<Icon name="right" small /></button></div>
        </div>
      </div>
      <div className="col">
        {ws.insights.map((i) => (
          <article key={i.id} className={`icard${i.enabled ? " is-adopted" : ""}`}>
            <div className="icard-h"><h3>{i.concept}</h3><span className="tag st-neutral">{facts[i.fact]?.short}</span><span className="grow" /><span className="tag st-info">策略：{i.strategy}</span></div>
            <div className="bridge">
              <div className="side">
                <h4><span className="ly ly-zhihu">知乎讨论</span><span className="mode">示例数据</span></h4>
                <p>{i.zhihu}</p>
                <div className="cite"><Icon name="link" /><span>{i.zhihu_cite}</span></div>
              </div>
              <div className="connector" aria-hidden="true"><svg viewBox="0 0 40 40"><path d="M4 26c6-12 26-12 32 0" /><path d="M4 26h32M12 26v-6M28 26v-6" /></svg></div>
              <div className={`side${i.english.layer === "ai" ? " ai" : ""}`}>
                <h4><span className={`ly ${LAYER_CLASS[i.english.layer]}`}>{i.english.label}</span><span className="mode">{i.english.mode}</span></h4>
                <p className="en-quote en">{i.english.text}</p>
                <div className="cite">{i.english.layer !== "ai" && <Icon name="link" />}<span>{i.english.cite}</span></div>
              </div>
            </div>
            <div className="icard-b">
              <div><h5>直译可能引起的误解（AI 分析，非调研结论）</h5><p>{i.risk}</p></div>
              <div><h5>系统怎么写</h5><p>{i.action}</p></div>
            </div>
            <div className="compare"><span className="k">直译</span><del className="en">{i.literal}</del><span className="k">本地化</span><ins className="en">{i.localized}</ins></div>
            <div className="icard-f">
              <label className="switch">
                <input type="checkbox" role="switch" checked={i.enabled} aria-label={`${i.concept} 这条建议`}
                  onChange={(e) => run(() => api.toggleInsight(ws.id, i.id, e.target.checked), ["features", "story", "faq"])} />
                {i.enabled ? "在用" : "没用"}
              </label>
              <span className="muted" style={{ fontSize: 12.5 }}>{i.enabled ? `用在：${i.used_in}` : "已关掉，相关句子改回了普通写法"}</span>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
