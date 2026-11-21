import type { AudienceMeta, CaseMeta, Health } from "../lib/types";

export interface InputState {
  text: string;
  caseId: string | null;
  audienceId: string;
}

interface Props {
  cases: CaseMeta[];
  health: Health | null;
  offline: boolean;
  input: InputState;
  onInput: (v: InputState) => void;
  onStart: () => void;
  present: boolean;
  onPresent: (v: boolean) => void;
}

export const MAX_CHARS = 400;

export function allAudiences(cases: CaseMeta[]): AudienceMeta[] {
  return cases.flatMap((c) => c.audiences);
}

export function startBlockReason(input: InputState, offline: boolean): string | null {
  const len = [...input.text.trim()].length;
  if (len === 0) return "请输入原文后再开始";
  if (len > MAX_CHARS) return `原文超过 ${MAX_CHARS} 字符，请删减`;
  if (offline && !input.caseId) return "离线包只包含两个预置案例；自定义输入需要连接后端";
  return null;
}

export function Home(p: Props) {
  const len = [...p.input.text].length;
  const caseMeta = p.cases.find((c) => c.caseId === p.input.caseId);
  const audiences = caseMeta ? caseMeta.audiences : allAudiences(p.cases);
  const reason = startBlockReason(p.input, p.offline);
  const mode = p.health?.generationMode;

  const loadCase = (c: CaseMeta) => p.onInput({ text: c.text, caseId: c.caseId, audienceId: c.defaultAudienceId });

  return (
    <div className="home">
      <header className="topbar">
        <span className="brand">
          <b>Zhihu Bridge</b>
          <span>知乎跨文化认知转译舱</span>
        </span>
        <span className="tb-spacer" />
        <button className="tb-btn" aria-pressed={p.present} onClick={() => p.onPresent(!p.present)}>
          演示模式
        </button>
      </header>
      <main>
        <h1>知乎跨文化认知转译舱</h1>
        <p className="lede">
          面向大湾区出海内容团队的本地化编辑：发布英文文案或字幕前，用知乎社区的解释核对译法、拦截缺依据的声称、用模拟海外读者找出误解，再把误解带回知乎形成提问草稿。
        </p>
        {mode === "dev_stub" && (
          <div className="mode-banner" role="status">
            当前为<b>开发占位</b>模式{p.offline ? "（离线包）" : ""}：未接入真实模型与知乎开放平台，译稿、复述与草稿均为开发占位、非真实运行、非评测结果。知乎证据与已有讨论来自 Day 0 实测样本。
          </div>
        )}
        {p.offline && mode === "replay" && (
          <div className="mode-banner" role="status">
            离线包包含已冻结的运行。载入案例后可查看该受众的来源标签，缺少对应快照的组合会明确标为开发占位。
          </div>
        )}
        {p.health && p.health.generationMode !== "dev_stub" && !p.offline && !p.health.replayAvailable && (
          <div className="hint">暂无可用的真实回放：实时生成失败时将无法切换回放。</div>
        )}
        <div className="composer">
          <textarea
            aria-label="中文原文"
            placeholder="输入不超过 400 字的中文短文本，或选择下方案例"
            value={p.input.text}
            onChange={(e) => {
              const text = e.target.value;
              // 编辑原文后案例标记消失，按自定义输入处理（V6 §5.1）
              p.onInput({ ...p.input, text, caseId: caseMeta && text === caseMeta.text ? caseMeta.caseId : null });
            }}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !reason) p.onStart();
            }}
          />
          <div className={`counter${len > MAX_CHARS ? " over" : ""}`}>{len} / {MAX_CHARS}</div>
          <div className="composer-foot">
            {p.cases.map((c) => (
              <button key={c.caseId} className="chip" aria-pressed={p.input.caseId === c.caseId} onClick={() => loadCase(c)}>
                {c.label}
              </button>
            ))}
            <span className="grow" />
            <label className="muted">
              受众{" "}
              <select
                value={audiences.some((a) => a.id === p.input.audienceId) ? p.input.audienceId : audiences[0]?.id}
                onChange={(e) => p.onInput({ ...p.input, audienceId: e.target.value })}
              >
                {audiences.map((a) => (
                  <option key={a.id} value={a.id}>{a.label}</option>
                ))}
              </select>
            </label>
            <button className="btn primary" disabled={!!reason} onClick={p.onStart} aria-describedby="start-reason">
              开始转译
            </button>
          </div>
        </div>
        <div id="start-reason" className={`hint${reason && len > 0 ? " warn" : ""}`}>
          {reason ?? (p.input.caseId ? `已载入案例：${caseMeta?.label}` : "自定义输入：没有回放兜底，结果以实时检索与生成为准")}
        </div>

        <section className="steps" aria-labelledby="steps-h">
          <h2 id="steps-h">评委三步体验</h2>
          <ol>
            <li><b>①</b>载入仙侠案例</li>
            <li><b>②</b>切换到“仙侠核心读者”，点“雷劫”看依据</li>
            <li><b>③</b>运行模拟读者测试，把误解带回知乎</li>
          </ol>
        </section>
      </main>
      <footer>
        模式标签：实时生成 / 缓存回放 / 已降级 / 开发占位 · 非真实运行；证据来源：知乎实时 / 知乎精选 / 站外资料 / 无证据。
        <br />
        模拟读者由模型模拟，不代表真实用户。系统只生成知乎提问草稿，不代为发布。
      </footer>
    </div>
  );
}
