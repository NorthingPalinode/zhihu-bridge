import { EVIDENCE_SOURCE_LABEL, MODE_LABEL } from "../lib/labels";
import type { CaseMeta, EvidenceSource, Mode } from "../lib/types";

interface Props {
  cases: CaseMeta[];
  caseId: string | null;
  audienceId: string;
  audiences: { id: string; label: string }[];
  mode: Mode | null;
  offline: boolean;
  evidenceSource: EvidenceSource | null;
  evidencePending: boolean;
  present: boolean;
  onHome: () => void;
  onCase: (caseId: string) => void;
  onAudience: (id: string) => void;
  onPresent: (v: boolean) => void;
  onReset: () => void;
}

/** 顶栏：品牌/返回 · 案例 · 受众 · 生成模式标签 · 证据来源标签 · 演示模式 · 重置（V6 §5.2）。
 *  生成模式与证据来源两个标签常驻且相互独立（V6 §5.4）。 */
export function TopBar(p: Props) {
  const modeText = (p.mode ? MODE_LABEL[p.mode] : "待运行") + (p.offline ? " · 离线包" : "");
  const evText = p.evidenceSource ? EVIDENCE_SOURCE_LABEL[p.evidenceSource] : "证据：待加载";
  return (
    <header className="topbar">
      <button className="brand" onClick={p.onHome} title="返回首页">
        <b>Zhihu Bridge</b>
        <span>知乎跨文化认知转译舱</span>
      </button>
      <span className="sep" aria-hidden />
      <label className="tb-field">
        案例
        <select className="tb-select" value={p.caseId ?? ""} onChange={(e) => e.target.value && p.onCase(e.target.value)}>
          {p.caseId === null && <option value="">自定义输入</option>}
          {p.cases.map((c) => (
            <option key={c.caseId} value={c.caseId}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <label className="tb-field">
        受众
        <select className="tb-select" value={p.audienceId} onChange={(e) => p.onAudience(e.target.value)}>
          {p.audiences.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
      </label>
      <span className="tb-spacer" />
      <span className="tb-label">生成</span>
      <span className={`tag mode-${p.mode ?? "pending"}`} data-testid="mode-tag">
        <span className="dot" aria-hidden />
        {modeText}
      </span>
      <span className="tb-label">证据</span>
      <span className="tag ev" data-testid="evidence-tag">
        <span className="dot" aria-hidden />
        {evText}
      </span>
      <button className="tb-btn" aria-pressed={p.present} onClick={() => p.onPresent(!p.present)}>
        演示模式
      </button>
      <button className="tb-btn" onClick={p.onReset}>
        重置
      </button>
    </header>
  );
}
