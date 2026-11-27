import { useEffect, useState } from "react";
import { api, downloadText } from "../api";
import { SECTION_NAMES, SEVERITY, decisionTitle, hasStage, isAutoFix } from "../copy";
import { useWb } from "../context";
import { BasisList, DecisionCard, Reasons } from "../Decision";
import { Icon } from "../icons";
import type { Basis, Workspace } from "../types";
import { Parts } from "./Content";

type Group = "need" | "sys" | "kept" | "done";
interface Row { key: string; group: Group; title: string; sub: string; issue?: string }

export function reviewRows(ws: Workspace): Row[] {
  const rows: Row[] = [];
  const open = new Set(ws.summary.open_decisions);
  for (const d of ws.decisions) {
    const t = decisionTitle(ws, d.id);
    rows.push({ key: d.id, group: open.has(d.id) ? "need" : "done", title: t.title, sub: t.sub });
  }
  for (const i of ws.issues.filter((x) => x.fix_kind === "user_introduced")) {
    const g: Group = i.status === "open" ? "need" : i.status === "kept" ? "kept" : "done";
    rows.push({ key: `x:${i.id}`, group: g, title: `你写的 “${i.term}”`, sub: SECTION_NAMES[i.asset] ?? i.asset, issue: i.id });
  }
  for (const i of ws.issues.filter(isAutoFix)) {
    rows.push({ key: i.id, group: i.status === "kept" ? "kept" : "sys", title: i.title, sub: i.loc, issue: i.id });
  }
  for (const b of ws.blocked) rows.push({ key: `b:${b.id}`, group: "sys", title: b.title, sub: "资料里没有任何证明" });
  return rows;
}

const GROUPS: [Group, string, string][] = [["need", "需要你决定", "need"], ["kept", "你保留了原句", ""], ["sys", "系统已替你处理", ""], ["done", "你已决定", ""]];
const PILL: Record<Group, [string, string]> = { need: ["待决定", "t-need"], kept: ["已保留", "t-risk"], sys: ["已处理", "t-ok"], done: ["已决定", "t-ok"] };
const ICO: Record<Group, [string, string]> = { need: ["alert", "need-ic"], kept: ["alert", "risk-ic"], sys: ["checkCircle", "ok-ic"], done: ["checkCircle", "ok-ic"] };

export function Review({ onExport }: { onExport: (tab?: "poster" | "landing" | "docs") => void }) {
  const { ws, run, goStep, reviewSel, setReviewSel, toast } = useWb();
  const [auditing, setAuditing] = useState(false);
  const reviewed = hasStage(ws, "review");
  const contentDone = hasStage(ws, "content") && ws.assets.length > 0;
  const rows = reviewed ? reviewRows(ws) : [];
  const sel = rows.find((r) => r.key === reviewSel) ?? rows.find((r) => r.group === "need") ?? rows[0];
  useEffect(() => { if (reviewed && sel && sel.key !== reviewSel) setReviewSel(sel.key); }, [reviewed, sel, reviewSel, setReviewSel]);

  const triggerReview = async () => {
    setAuditing(true);
    try {
      await run(() => api.runStage(ws.id, "review"));
    } finally {
      setAuditing(false);
    }
  };

  if (!reviewed) {
    return (
      <section className="glass stage-gate">
        <span className="itile lg teal"><Icon name="shield" /></span>
        <h3>尚未执行发布前合规审校</h3>
        <p>
          {contentDone
            ? "点击下方按钮后，系统将逐句检查英文内容（含你手动修改过的句子）：自动弱化无依据的续航与排名声称、将直译黑话改为工程表达、补全 5 ATM 防水边界，并汇总仍需你拍板的冲突与路线图事项。完成后可一键导出高清宣传海报（PNG/SVG）、独立站落地页（HTML）与社媒文案包。"
            : "请先完成第 3 步「海外内容」生成，再执行发布前合规审校。"}
        </p>
        <div className="meta-row">
          <span className="tag t-ok">保守自动修订 · 留痕可撤销</span>
          <span className="tag t-risk">拦截 FDA / 医疗级声称</span>
          <span className="tag t-info">解锁高清海报与落地页导出</span>
        </div>
        {contentDone ? (
          <button type="button" className="btn btn-primary btn-lg" disabled={auditing} onClick={triggerReview}>
            {auditing ? <><span className="spin" />正在逐句审校海外内容…</> : <><Icon name="shield" />执行发布前合规审校 <Icon name="right" /></>}
          </button>
        ) : (
          <button type="button" className="btn btn-primary btn-lg" onClick={() => goStep(hasStage(ws, "insights") ? "content" : hasStage(ws, "facts") ? "insights" : "materials")}>
            <Icon name="left" />先去完成上一步：{hasStage(ws, "insights") ? "生成海外内容" : hasStage(ws, "facts") ? "知乎认知洞察" : "提取产品事实"}
          </button>
        )}
      </section>
    );
  }

  const count = (g: Group) => rows.filter((r) => r.group === g).length;
  const ordered = GROUPS.flatMap(([g]) => rows.filter((r) => r.group === g));
  const numbers: Record<string, number> = {};
  ordered.forEach((r, i) => { if (r.issue) numbers[r.issue] = i + 1; });
  const total = rows.length || 1;
  const segs: [number, string][] = [[count("need"), "var(--need)"], [count("kept"), "var(--status-danger)"], [count("sys") + count("done"), "var(--status-success)"]];
  const C = 2 * Math.PI * 44;
  let acc = 0;
  const downloadReport = async () => {
    try {
      const p = await api.exportPack(ws.id);
      downloadText(`${ws.name.split(" ")[0] || "zhihu-bridge"}-review-report.md`, p.report);
      toast("已下载审校报告");
    } catch { toast("审校报告没有生成成功，请再试一次"); }
  };

  return (
    <>
      <div className="cols cols-review">
        <div className="stack">
          <section className="glass">
            <div className="ph-head"><span className="itile"><Icon name="alert" /></span><h2>审校问题 <small>（{rows.length} 项）</small></h2></div>
            <div className="ph-body">
              <ul className="ilist">
                {GROUPS.map(([g, label, cls]) => {
                  const list = rows.filter((r) => r.group === g);
                  if (!list.length) return null;
                  return [
                    <li key={`h-${g}`} className={`ig-h ${cls}`}>{label} · {list.length}</li>,
                    ...list.map((r) => (
                      <li key={r.key}>
                        <button type="button" className={`issue${r.key === sel?.key ? " is-current" : ""}`} onClick={() => setReviewSel(r.key)}>
                          <span className="ico"><Icon name={ICO[g][0]} className={ICO[g][1]} /></span>
                          <span className="q">{r.issue && numbers[r.issue] ? `${numbers[r.issue]}. ` : ""}{r.title}</span>
                          <span className={`tag ${PILL[g][1]}`}>{PILL[g][0]}</span>
                          <span className="meta">{r.sub}</span>
                        </button>
                      </li>
                    )),
                  ];
                })}
              </ul>
            </div>
            <div className="glass-inner donut-row" style={{ margin: "0 20px 20px" }}>
              <div className="donut" role="img" aria-label={`共 ${rows.length} 项`}>
                <svg viewBox="0 0 110 110"><circle cx="55" cy="55" r="44" stroke="rgba(120,180,255,.15)" />
                  {segs.map(([n, color], i) => { const len = (n / total) * C; const el = n ? <circle key={i} cx="55" cy="55" r="44" stroke={color} strokeDasharray={`${len} ${C}`} strokeDashoffset={-acc} /> : null; acc += len; return el; })}
                </svg>
                <span><b>{rows.length}</b><small>审校项</small></span>
              </div>
              <ul className="legend-list">
                <li><span className="dot-i" style={{ color: "var(--need)" }} />需要你决定<b>{count("need")}</b></li>
                <li><span className="dot-i" style={{ color: "var(--status-danger)" }} />你保留了原句<b>{count("kept")}</b></li>
                <li><span className="dot-i" style={{ color: "var(--status-success)" }} />已处理 / 已决定<b>{count("sys") + count("done")}</b></li>
              </ul>
            </div>
            <div style={{ padding: "0 20px 20px" }}>
              <div className={`verdict${ws.summary.ready ? "" : " need"}`}>
                <Icon name={ws.summary.ready ? "shield" : "hand"} large />
                <div><b>{ws.summary.ready ? "整体评估：可以进入发布准备" : `还需你决定 ${ws.summary.open_decisions.length} 件`}</b>
                  <small>{ws.summary.ready ? (count("kept") ? `你保留了 ${count("kept")} 处原句，审校报告里会写明` : "系统修改都可在内容里查看、撤销") : "决定后自动复查，不需要再点“复检”"}</small></div>
              </div>
            </div>
          </section>

          {ws.is_demo && (
            <section className="glass">
              <div className="ph-head"><span className="itile violet"><Icon name="scale" /></span><h3>普通翻译 vs Zhihu Bridge</h3></div>
              <div className="ph-body">
                <table className="cmp-table">
                  <thead><tr><th>对比维度</th><th>普通翻译</th><th className="zb">Zhihu Bridge<br /><small className="muted">知识增强</small></th></tr></thead>
                  <tbody>
                    <tr><td>准确与可信</td><td className="muted">直译出 stacking motherboard，夸大说法原样保留</td><td className="zb"><Icon name="check" small className="ok-ic" /> 识别夸大风险，补边界与依据</td></tr>
                    <tr><td>海外读者理解</td><td className="muted">保留“堆料”“极限压榨”等中文思维</td><td className="zb"><Icon name="check" small className="ok-ic" /> 结合知乎语境改写成工程事实</td></tr>
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>

        <section className="glass">
          <div className="ph-head"><span className="itile"><Icon name="doc" /></span><h2>内容预览 <small>（英文新品页）</small></h2><span className="grow" /><span className="tag t-info">编号对应左侧问题</span></div>
          <div className="glass-inner preview en" style={{ margin: "0 20px 20px" }}>
            {ws.assets.map((a) => a.items.map((it) => {
              const content = <Parts parts={it.parts} numbered={numbers} />;
              if (it.kind === "title") return <h2 key={it.id}>{content}</h2>;
              if (it.kind === "tagline") return <p key={it.id} className="tg">{content}</p>;
              if (it.kind === "li") return <ul key={it.id} style={{ margin: "0 0 4px" }}><li>{content}</li></ul>;
              if (it.kind === "row") return <p key={it.id} style={{ margin: "0 0 4px" }}><b>{it.label}:</b> {content}</p>;
              if (it.kind === "qa") return <p key={it.id}><b>{it.label}</b><br />{content}</p>;
              return <p key={it.id}>{content}</p>;
            }))}
          </div>
        </section>

        <aside className="glass detail-col review-detail" aria-live="polite">
          {sel && <Detail rowKey={sel.key} num={sel.issue ? numbers[sel.issue] : undefined} />}
        </aside>
      </div>

      <section className="glass deliver">
        <div className="lead" style={{ display: "flex", gap: 14, alignItems: "center" }}>
          <span className="itile lg"><Icon name="box" /></span>
          <div><b>最终交付：直接可用的宣传物料</b><small>{ws.summary.ready ? "都确认好了，可直接下载海报、落地页与文案包。" : "现在导出也可以，未决定的地方会写成 [待确认]。"}</small></div>
        </div>
        <button type="button" className="dtile" onClick={() => onExport("poster")}><span className="itile teal"><Icon name="sparkle" /></span><b>导出宣传海报</b><small>高清 PNG / 矢量 SVG · 3 种尺寸 × 3 套主题</small><Icon name="download" /></button>
        <button type="button" className="dtile" onClick={() => onExport("landing")}><span className="itile"><Icon name="globe" /></span><b>独立站落地页 & 社媒包</b><small>单文件 HTML 落地页 · X / Reddit 首发帖</small><Icon name="right" /></button>
        <button type="button" className="dtile" onClick={downloadReport}><span className="itile zhi">知</span><b>审校报告 & 口径表</b><small>留痕报告 · 也可点开看知乎回流草稿</small><Icon name="download" /></button>
      </section>
    </>
  );
}

const Sec = ({ icon, h, children, tone }: { icon: string; h: string; children: React.ReactNode; tone?: string }) => (
  <div className="detail-sec"><h4><span className={`itile sm${tone ? " " + tone : ""}`}><Icon name={icon} /></span>{h}</h4>{children}</div>
);

function Detail({ rowKey, num }: { rowKey: string; num?: number }) {
  const { ws, run, goStep, setReviewSel } = useWb();
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    setAsking(false);
    // 自动选中下一件后，焦点落到推荐选项上，但不滚动页面（DESIGN.md §9）。
    const target = document.querySelector<HTMLElement>(".review-detail .opt.primary, .review-detail [data-primary]");
    target?.focus({ preventScroll: true });
  }, [rowKey]);
  const next = () => { const n = ws.summary.open_decisions.find((k) => k !== rowKey); if (n) setReviewSel(n); };
  const head = (title: string, pill: React.ReactNode) => (
    <div className="ph-head"><span className="itile amber"><Icon name="alert" /></span><h3>问题详情 <small>{num ? `#${num} ` : ""}{title}</small></h3><span className="grow" />{pill}</div>
  );

  const fix = ws.issues.find((i) => i.id === rowKey && isAutoFix(i));
  if (fix) {
    const kept = fix.status === "kept";
    return (
      <>
        {head(fix.title, kept ? <span className="tag t-risk">你保留了原句</span> : <span className="tag t-ok">已处理 · {SEVERITY[fix.severity]}风险</span>)}
        <div className="ph-body">
          <Sec icon="file" h="问题原因"><p>{fix.why}</p></Sec>
          <Sec icon="layers" h="事实依据">{fix.basis ? <BasisList basis={fix.basis} /> : <p>—</p>}</Sec>
          <Sec icon="pencil" h={kept ? "系统建议" : "系统已改成"} tone="teal">
            <div className="suggest en"><del>{fix.original}</del>{fix.applied}</div>
          </Sec>
          <div className="detail-sec">
            {kept ? (
              <><div className="resolved" style={{ color: "var(--status-danger)", marginBottom: 10 }}><Icon name="alert" />你保留了原句 · 理由：{fix.keep_reason}</div>
                <div className="actions"><button type="button" className="btn btn-primary" onClick={() => run(() => api.reapply(ws.id, fix.id), [fix.asset])}><Icon name="check" small />按系统建议改</button></div></>
            ) : (
              <><div className="resolved" style={{ marginBottom: 10 }}><Icon name="checkCircle" />已按系统建议改写，内容里是绿色虚线</div>
                <div className="actions">
                  <button type="button" className="btn" onClick={() => goStep("content")}><Icon name="eye" small />在内容里看</button>
                  <button type="button" className="btn btn-ghost" onClick={() => (fix.severity === "high" ? setAsking(true) : run(() => api.undoFix(ws.id, fix.id), [fix.asset]))}><Icon name="undo" small />恢复原句…</button>
                </div>
                {asking && <Reasons intro="原句没有依据，恢复后会以红色标出，并写进审校报告。请选一个理由：" onPick={(r) => run(() => api.undoFix(ws.id, fix.id, r), [fix.asset])} />}</>
            )}
          </div>
        </div>
      </>
    );
  }

  if (rowKey.startsWith("b:")) {
    const b = ws.blocked.find((x) => `b:${x.id}` === rowKey)!;
    return (
      <>
        {head(b.title, <span className="tag t-muted">已挡下</span>)}
        <div className="ph-body">
          <Sec icon="file" h="资料原文"><div className="ctx"><span className="loc">{b.quote.file} · {b.quote.locator}</span><mark>{b.quote.quote}</mark></div></Sec>
          <Sec icon="alert" h="为什么挡下" tone="red"><p>{b.why}</p></Sec>
          <Sec icon="layers" h="事实依据"><BasisList basis={b.basis} /></Sec>
          <div className="detail-sec"><div className="actions"><button type="button" className="btn" onClick={() => goStep("materials")}>去「产品资料」补充证书</button></div></div>
        </div>
      </>
    );
  }

  const t = decisionTitle(ws, rowKey);
  const open = ws.summary.open_decisions.includes(rowKey);
  const facts = Object.fromEntries(ws.facts.map((f) => [f.id, f]));
  let reason = "";
  let basis: Basis[] = [];
  if (rowKey.startsWith("x:")) {
    const i = ws.issues.find((x) => `x:${x.id}` === rowKey)!;
    reason = `你在「${SECTION_NAMES[i.asset] ?? i.asset}」里写了 “${i.term}”：${i.why}。`;
    basis = [["company", "你的资料", `${ws.sources.filter((s) => s.status === "parsed").length} 份资料`, `${i.why}。`]];
  } else {
    const d = ws.decisions.find((x) => x.id === rowKey)!;
    if (d.kind === "confirm_facts") {
      reason = "这些事实英文页已经用上了。系统核对过原文，但只有你能确认它们对外说得出口。";
      basis = (d.fact_ids ?? []).map((id) => ["company", "你的资料", `${facts[id]?.source.file} · ${facts[id]?.source.locator}`, facts[id]?.user_text ?? facts[id]?.text ?? ""] as Basis);
    } else {
      reason = d.why ?? "";
      basis = (d.options ?? []).filter((o) => o.fact).map((o) => ["company", "你的资料", facts[o.fact!] ? `${facts[o.fact!].source.file} · ${facts[o.fact!].source.locator}` : "", facts[o.fact!]?.text ?? ""] as Basis);
    }
  }
  return (
    <>
      {head(t.title, open ? <span className="tag t-need">需要你决定</span> : <span className="tag t-ok">你已决定</span>)}
      <div className="ph-body">
        <Sec icon="file" h="问题原因"><p>{reason}</p>{t.sub && <p className="muted" style={{ marginTop: 6, fontSize: 12.5 }}>在英文页里：{t.sub}</p>}</Sec>
        <Sec icon="layers" h="事实依据"><BasisList basis={basis} /></Sec>
        <Sec icon="pencil" h={open ? "选一个" : "你的决定"} tone="teal"><DecisionCard dkey={rowKey} onDecided={next} /></Sec>
      </div>
    </>
  );
}
