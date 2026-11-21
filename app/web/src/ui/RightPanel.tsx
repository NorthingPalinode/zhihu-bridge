import { useEffect, useMemo, useState } from "react";
import { LEVEL_LABEL, MODE_LABEL, VERDICT_LABEL } from "../lib/labels";
import type { FlowState, TestState } from "../lib/state";
import type { CaseMeta, KeyPoint, Level, RunSnapshot, TestResult } from "../lib/types";
import { IconCheck, IconCopy, IconInfo, IconLoop, IconUser } from "./icons";

interface Misreading {
  key: string;
  version: "literal" | "selected";
  readerNo: number;
  personaLabel: string;
  keyPointId: string;
  verdict: "missing" | "contradicted";
  quote: string;
}

interface Props {
  snap: RunSnapshot | null;
  caseMeta: CaseMeta | undefined;
  level: Level | null;
  test: TestState;
  stale: boolean;
  flow: FlowState;
  copy: { enabled: boolean; text: string; reason: string };
  onRunTest: (kps: string[]) => void;
  onFlowFromMisreading: (m: { quote: string; keyPointId: string; testId: string }) => void;
  onFlowManual: (text: string) => void;
  onFlowEdit: (v: { title?: string; body?: string }) => void;
  onFlowClose: () => void;
  onCopied: (what: string) => void;
}

function misreadings(r: TestResult): Misreading[] {
  const order = Array.from(new Set(r.readers.map((x) => x.personaId)));
  const out: Misreading[] = [];
  for (const rd of r.readers) {
    if (rd.status !== "ok") continue;
    for (const j of rd.judgments) {
      if (j.verdict === "hit") continue;
      out.push({
        key: `${rd.personaId}|${rd.version}|${j.keyPointId}`,
        version: rd.version,
        readerNo: order.indexOf(rd.personaId) + 1,
        personaLabel: rd.personaLabel,
        keyPointId: j.keyPointId,
        verdict: j.verdict,
        quote: j.quote,
      });
    }
  }
  // 矛盾优先，其次缺失
  return out.sort((a, b) => (a.verdict === b.verdict ? 0 : a.verdict === "contradicted" ? -1 : 1));
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

export function RightPanel(p: Props) {
  const snap = p.snap;
  const kps: KeyPoint[] = snap?.keyPoints ?? [];
  const [picked, setPicked] = useState<string[]>([]);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [tab, setTab] = useState<"reader" | "manual">("reader");
  const [manual, setManual] = useState("");
  useEffect(() => setPicked(kps.map((k) => k.id)), [snap?.runId]); // eslint-disable-line react-hooks/exhaustive-deps
  const result = p.test.result;
  useEffect(() => {
    if (p.flow.status === "done" || p.flow.status === "loading") {
      const el = document.getElementById("flow-block");
      if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
    }
  }, [p.flow.status]);
  const mis = useMemo(() => (result ? misreadings(result) : []), [result]);
  const stale = p.stale || !!result && (
    result.keyPointIds.length !== picked.length || result.keyPointIds.some((id) => !picked.includes(id))
  );
  const judged = result ? result.summary.literal.valid + result.summary.selected.valid : 0;
  const expectedJudgments = result ? result.completed * result.keyPointIds.length : 0;
  const assessmentIncomplete = !!result && (result.completed < result.expected || judged < expectedJudgments);
  const testEnabled = p.caseMeta ? p.caseMeta.testEnabled : kps.length > 0;
  const selectedLabel = result ? LEVEL_LABEL[result.level] : p.level ? LEVEL_LABEL[p.level] : "选中档";

  return (
    <section className="panel" aria-labelledby="right-h">
      <div className="panel-h">
        <span className="icon"><IconCheck /></span>
        <span className="step">03</span>
        <h2 id="right-h">验证、交付与回流</h2>
      </div>

      {/* ---- 模拟读者测试 ---- */}
      <div className="block">
        <div className="block-h">
          <IconUser />
          <h3>模拟读者测试</h3>
          <span className="badge">模拟读者 · n=3</span>
          {result?.provenance === "dev_stub" && <span className="badge stub">开发占位 · 非评测结果</span>}
          {result?.mode === "replay" && <span className="badge">缓存回放</span>}
        </div>
        {!snap && <div className="muted">译稿就绪后可运行。</div>}
        {snap && !testEnabled && <div className="muted">{p.caseMeta?.testDisabledReason ?? "本案例不含模拟读者测试"}</div>}
        {snap && testEnabled && (
          <>
            <div className="muted">直译参照 vs {p.level ? LEVEL_LABEL[p.level] : "选中档"}；读者看不到信息点，评判与复述隔离。</div>
            <div className="kp-pick" role="group" aria-label="测试的信息点">
              {kps.map((k) => (
                <label key={k.id}>
                  <input
                    type="checkbox"
                    checked={picked.includes(k.id)}
                    onChange={(e) => {
                      const next = e.target.checked ? [...picked, k.id] : picked.filter((x) => x !== k.id);
                      if (next.length) setPicked(next); // 至少保留 1 项
                    }}
                  />{" "}
                  {k.id} {k.short}
                </label>
              ))}
            </div>
            <button className="btn" disabled={p.test.status === "running" || !picked.length || !p.level || p.level === "literal"} onClick={() => p.onRunTest(picked)}>
              {p.test.status === "running" ? "测试进行中…" : assessmentIncomplete ? "重新运行模拟读者测试" : "运行模拟读者测试"}
            </button>
            {p.test.error && <div className="notice">{p.test.error}</div>}
            {p.test.status === "running" && (
              <div className="reader-cards" style={{ marginTop: 8 }} aria-live="polite">
                {[1, 2, 3].map((n) => (
                  <div className="reader-card" key={n}>
                    <span>模拟读者 {n}</span>
                    <span className="muted"><span className="spinner" style={{ display: "inline-block", verticalAlign: "middle" }} /> 阅读中</span>
                  </div>
                ))}
              </div>
            )}
            {result && (
              <div style={{ marginTop: 10 }} className={p.test.status === "running" ? "dimmed" : undefined}>
                {stale && (
                  <div className="stale" role="status">
                    针对上一版本（{LEVEL_LABEL[result.level]}）· 受众、档位或信息点变化后请重新运行
                  </div>
                )}
                <div className="muted">
                  复述已完成 {result.completed}/{result.expected} · {MODE_LABEL[result.mode]}
                  {result.completed < result.expected && " · 按实际有效样本计算，未补造结果"}
                </div>
                <div className="muted">已评判 {judged}/{expectedJudgments} 项</div>
                {result.completed > 0 && judged < expectedJudgments && (
                  <div className="notice" role="status">{judged ? "评判未完成，请重新运行。" : "评判未成功，请重新运行。"}</div>
                )}
                <Matrix result={result} selectedLabel={selectedLabel} onCell={(k) => setFocusKey(k)} />
                {judged > 0 && <div className="tally">
                  <span>直译：命中 {result.summary.literal.hit}/{result.summary.literal.valid}</span>
                  <span>{selectedLabel}：命中 {result.summary.selected.hit}/{result.summary.selected.valid}</span>
                </div>}
                {result.provenance === "dev_stub" && <div className="fineprint">设计示意 · 非评测结果：复述为开发者手写的占位样例，判定由规则给出。</div>}
                <div className="sub">误解原句 <span className="muted">{mis.length ? `${mis.length} 处` : assessmentIncomplete ? "暂无可确认结果" : "无"}</span></div>
                {mis.map((m) => (
                  <div key={m.key} id={`mis-${m.key}`} className={`mis${focusKey === m.key ? " focus" : ""}`}>
                    <q lang="en">{m.quote}</q>
                    <div className="meta">
                      <span>{m.version === "literal" ? "直译" : selectedLabel} · 模拟读者 {m.readerNo}</span>
                      <span className="idtag">{m.keyPointId}</span>
                      <span className={`st ${m.verdict === "contradicted" ? "fail" : "warn"}`}>{VERDICT_LABEL[m.verdict]}</span>
                      <button className="btn small" disabled={stale || !m.quote.trim()} onClick={() => p.onFlowFromMisreading({ quote: m.quote, keyPointId: m.keyPointId, testId: result.testId })}>
                        带回知乎
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* ---- 交付 ---- */}
      <div className="block">
        <button
          className="btn primary block-btn"
          disabled={!p.copy.enabled}
          onClick={async () => {
            await copyText(p.copy.text);
            p.onCopied("终稿");
          }}
        >
          <IconCopy /> 复制终稿
        </button>
        <div className={`copy-state ${p.copy.enabled ? "ok" : "no"}`}>{p.copy.reason}</div>
      </div>

      {/* ---- 回流 ---- */}
      <div className="block flow" id="flow-block" aria-labelledby="flow-h">
        <div className="block-h">
          <IconLoop />
          <h3 id="flow-h">带回知乎</h3>
          {p.flow.draft?.provenance === "dev_stub" && <span className="badge stub">开发占位</span>}
          {p.flow.status !== "idle" && (
            <button className="btn small" style={{ marginLeft: "auto" }} onClick={p.onFlowClose}>
              关闭
            </button>
          )}
        </div>
        {p.flow.status === "idle" && (
          <>
            <div className="tabs" role="group" aria-label="回流来源">
              <button aria-pressed={tab === "reader"} onClick={() => setTab("reader")}>模拟读者误解</button>
              <button aria-pressed={tab === "manual"} onClick={() => setTab("manual")}>用户粘贴</button>
            </div>
            {tab === "reader" && <div className="muted">在“误解原句”旁点「带回知乎」，查询知乎已有讨论并生成提问草稿。</div>}
            {tab === "manual" && (
              <>
                <textarea aria-label="粘贴一条真实海外评论或提问" placeholder="粘贴一条真实的海外评论或提问" value={manual} maxLength={1000} onChange={(e) => setManual(e.target.value)} />
                <button className="btn small" style={{ marginTop: 6 }} disabled={!manual.trim() || !snap} onClick={() => p.onFlowManual(manual.trim())}>
                  查询已有讨论并生成草稿
                </button>
              </>
            )}
          </>
        )}
        {p.flow.status === "loading" && <div className="muted"><span className="spinner" style={{ display: "inline-block", verticalAlign: "middle" }} /> 正在查询知乎已有讨论并生成草稿…</div>}
        {p.flow.status === "error" && <div className="notice">{p.flow.error}</div>}
        {p.flow.draft && p.flow.status === "done" && (
          <FlowResult flow={p.flow} onEdit={p.onFlowEdit} onCopied={p.onCopied} />
        )}
        <div className="foot-note"><IconInfo /> 系统不发布，请遵守知乎社区规范自行决定</div>
      </div>
    </section>
  );
}

function Matrix({ result, selectedLabel, onCell }: { result: TestResult; selectedLabel: string; onCell: (key: string) => void }) {
  const personas = Array.from(new Set(result.readers.map((r) => r.personaId)));
  const cell = (version: "literal" | "selected", kp: string) =>
    personas.map((pid, i) => {
      const r = result.readers.find((x) => x.personaId === pid && x.version === version);
      const j = r?.judgments.find((x) => x.keyPointId === kp);
      if (!r || r.status !== "ok" || !j) return <span key={pid} className="mk none" title={`模拟读者 ${i + 1}：无结果`}>–</span>;
      const sym = j.verdict === "hit" ? "✓" : j.verdict === "contradicted" ? "✗" : "?";
      const key = `${pid}|${version}|${kp}`;
      const label = `模拟读者 ${i + 1}：${VERDICT_LABEL[j.verdict]}`;
      if (j.verdict === "hit") return <span key={pid} className="mk hit" title={label}>{sym}</span>;
      return (
        <button
          key={pid}
          className={`mk ${j.verdict}`}
          title={label}
          aria-label={`${label}，定位误解原句`}
          onClick={() => {
            onCell(key);
            document.getElementById(`mis-${key}`)?.scrollIntoView({ block: "nearest" });
          }}
        >
          {sym}
        </button>
      );
    });
  return (
    <table className="matrix">
      <caption className="sr-only">模拟读者命中矩阵</caption>
      <thead>
        <tr>
          <th scope="col">信息点</th>
          <th scope="col">直译</th>
          <th scope="col">{selectedLabel}</th>
        </tr>
      </thead>
      <tbody>
        {result.keyPointIds.map((kp) => (
          <tr key={kp}>
            <td className="kp">{kp}</td>
            <td><span className="cell">{cell("literal", kp)}</span></td>
            <td><span className="cell">{cell("selected", kp)}</span></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function FlowResult({ flow, onEdit, onCopied }: { flow: FlowState; onEdit: (v: { title?: string; body?: string }) => void; onCopied: (w: string) => void }) {
  const d = flow.draft!;
  const existingText =
    d.existingSource === "failed" ? "查询失败" : d.existing.length === 0 ? "暂未查询到" : `${d.existing.length} 条`;
  return (
    <div className="fade-in">
      <div className="row">
        <span>来源</span>
        <span><b>{d.sourceLabel}</b></span>
        <span>检索词</span>
        <span>{d.query}</span>
        <span>知乎已有讨论</span>
        <span>
          {existingText}
          {d.existingNote && <div className="muted">{d.existingNote}</div>}
        </span>
      </div>
      {d.existing.length > 0 && (
        <ul>
          {d.existing.map((e) => (
            <li key={e.url}>
              <a href={e.url} target="_blank" rel="noopener noreferrer">{e.title} ↗</a>
            </li>
          ))}
        </ul>
      )}
      <div className="row">
        <span>建议</span>
        <span>
          <span className="badge">建议</span> {d.recommendation === "answer_existing" ? "去已有问题下补充海外视角" : "新提问"}
          {d.recommendationReason && <span className="muted"> · {d.recommendationReason}</span>}
        </span>
      </div>
      <div className="sub" style={{ marginTop: 8 }}>提问草稿 · 可编辑</div>
      <input type="text" aria-label="提问标题" value={flow.title} onChange={(e) => onEdit({ title: e.target.value })} />
      <textarea aria-label="问题描述" style={{ marginTop: 6 }} value={flow.body} onChange={(e) => onEdit({ body: e.target.value })} />
      <button
        className="btn small"
        style={{ marginTop: 6 }}
        onClick={async () => {
          await copyText(`${flow.title}\n\n${flow.body}`);
          onCopied("提问草稿");
        }}
      >
        复制草稿
      </button>
    </div>
  );
}
