import type {
  Evidence,
  EvidenceSource,
  KeyPoint,
  Level,
  Mode,
  QuestionDraft,
  RunSnapshot,
  SourceSegment,
  SseEvent,
  TargetLanguageCode,
  Term,
  TestResult,
  Variant,
} from "./types";

export type Stage = "started" | "terms" | "evidence" | "ready";

export interface RunState {
  reqId: number; // 客户端请求序号：重置/新运行后旧请求的回包一律丢弃
  runId: string | null;
  lastSeq: number;
  status: "idle" | "running" | "ready" | "error";
  stage: Stage | null;
  mode: Mode | null;
  audienceId: string | null;
  audienceLabel: string | null;
  targetLanguage: TargetLanguageCode;
  sourceSegments: SourceSegment[];
  terms: Term[];
  keyPoints: KeyPoint[];
  evidence: Evidence[];
  evidenceSource: EvidenceSource | null;
  notices: string[];
  snapshot: RunSnapshot | null;
  error: { step: string; message: string; retryable: boolean } | null;
}

export interface TestState {
  reqId: number | null;
  status: "idle" | "running" | "done" | "error";
  result: TestResult | null;
  error: string | null;
}

export interface FlowState {
  reqId: number | null;
  status: "idle" | "loading" | "done" | "error";
  draft: QuestionDraft | null;
  error: string | null;
  title: string;
  body: string;
}

export const emptyRun = (reqId = 0): RunState => ({
  reqId,
  runId: null,
  lastSeq: 0,
  status: "idle",
  stage: null,
  mode: null,
  audienceId: null,
  audienceLabel: null,
  targetLanguage: "en",
  sourceSegments: [],
  terms: [],
  keyPoints: [],
  evidence: [],
  evidenceSource: null,
  notices: [],
  snapshot: null,
  error: null,
});

export interface State {
  run: RunState;
  prev: RunSnapshot | null; // 换受众时，新结果就绪前显示（变暗）上一受众的结果
  level: Level | null;
  test: TestState;
  flow: FlowState;
}

export const initialState: State = {
  run: emptyRun(),
  prev: null,
  level: null,
  test: { reqId: null, status: "idle", result: null, error: null },
  flow: { reqId: null, status: "idle", draft: null, error: null, title: "", body: "" },
};

export type Action =
  | { type: "run/start"; reqId: number; audienceId: string; audienceLabel: string; targetLanguage?: TargetLanguageCode; keepPrev: boolean; sourceText?: string }
  | { type: "run/event"; reqId: number; event: SseEvent }
  | { type: "run/failed"; reqId: number; message: string }
  | { type: "run/cancel"; reqId: number }
  | { type: "reset" }
  | { type: "level"; level: Level }
  | { type: "test/start"; reqId: number }
  | { type: "test/done"; reqId: number; result: TestResult }
  | { type: "test/error"; reqId: number; message: string }
  | { type: "flow/start"; reqId: number }
  | { type: "flow/done"; reqId: number; draft: QuestionDraft }
  | { type: "flow/error"; reqId: number; message: string }
  | { type: "flow/edit"; title?: string; body?: string }
  | { type: "flow/close" };

export function reduceRun(run: RunState, reqId: number, e: SseEvent): RunState {
  if (reqId !== run.reqId || run.status !== "running") return run;
  if (run.runId && e.runId !== run.runId) return run; // 旧运行的迟到回包
  if (e.seq <= run.lastSeq) return run; // 重复或乱序
  const base = { ...run, runId: e.runId, lastSeq: e.seq };
  const p = e.payload as Record<string, unknown>;
  switch (e.type) {
    case "started":
      return {
        ...base,
        stage: "started",
        status: "running",
        mode: (p.mode as Mode | undefined) ?? null,
        audienceLabel: (p.audienceLabel as string) ?? run.audienceLabel,
        targetLanguage: (p.targetLanguage as TargetLanguageCode | undefined) ?? run.targetLanguage,
      };
    case "terms":
      return {
        ...base,
        stage: "terms",
        sourceSegments: p.sourceSegments as SourceSegment[],
        terms: p.terms as Term[],
        keyPoints: p.keyPoints as KeyPoint[],
      };
    case "evidence":
      return {
        ...base,
        stage: "evidence",
        evidence: p.evidence as Evidence[],
        evidenceSource: p.evidenceSource as EvidenceSource,
        notices: (p.notices as string[]) ?? [],
      };
    case "ready": {
      const snap = p as unknown as RunSnapshot;
      return {
        ...base,
        stage: "ready",
        status: "ready",
        snapshot: snap,
        targetLanguage: snap.targetLanguage ?? run.targetLanguage,
        sourceSegments: snap.sourceSegments,
        terms: snap.terms,
        keyPoints: snap.keyPoints,
        evidence: snap.evidence,
        evidenceSource: snap.evidenceSource,
        notices: snap.notices,
      };
    }
    case "error":
      return {
        ...base,
        status: "error",
        error: { step: String(p.step ?? ""), message: String(p.message ?? "运行失败"), retryable: Boolean(p.retryable) },
      };
    default:
      return run;
  }
}

export function reducer(state: State, a: Action): State {
  switch (a.type) {
    case "run/start":
      return {
        ...state,
        prev: a.keepPrev ? state.run.snapshot ?? state.prev : null,
        run: { ...emptyRun(a.reqId), status: "running", audienceId: a.audienceId, audienceLabel: a.audienceLabel,
          targetLanguage: a.targetLanguage ?? "en",
          sourceSegments: a.sourceText ? [{ text: a.sourceText, termId: null }] : [] },
        test: a.keepPrev && state.test.result
          ? { ...initialState.test, status: "done", result: state.test.result }
          : initialState.test,
        flow: initialState.flow,
      };
    case "run/event": {
      const run = reduceRun(state.run, a.reqId, a.event);
      if (run === state.run) return state;
      if (a.event.type === "ready" && run.snapshot) {
        // 新结果就绪：推荐档、译稿一次性更新（V6 §5.3 第 5 步）
        return { ...state, run, prev: null, level: run.snapshot.recommendedLevel };
      }
      if (a.event.type === "error") return { ...state, run, prev: null };
      return { ...state, run };
    }
    case "run/failed":
      if (a.reqId !== state.run.reqId || state.run.status !== "running") return state;
      return { ...state, prev: null, run: { ...state.run, status: "error", error: { step: "request", message: a.message, retryable: true } } };
    case "run/cancel":
      if (a.reqId !== state.run.reqId) return state;
      return { ...state, run: { ...state.run, status: state.run.snapshot ? "ready" : "idle" }, prev: null };
    case "reset":
      return { ...initialState, run: emptyRun(state.run.reqId + 1) };
    case "level":
      return { ...state, level: a.level }; // 两档切换是本地操作，不发请求
    case "test/start":
      return { ...state, test: { ...state.test, reqId: a.reqId, status: "running", error: null } };
    case "test/done":
      if (a.reqId !== state.test.reqId || a.result.runId !== state.run.snapshot?.runId ||
          a.result.revision !== state.run.snapshot.revision) return state;
      return { ...state, test: { reqId: null, status: "done", result: a.result, error: null } };
    case "test/error":
      if (a.reqId !== state.test.reqId) return state;
      return { ...state, test: { ...state.test, reqId: null, status: "error", error: a.message } };
    case "flow/start":
      return { ...state, flow: { ...initialState.flow, reqId: a.reqId, status: "loading" } };
    case "flow/done":
      if (a.reqId !== state.flow.reqId) return state;
      return { ...state, flow: { reqId: null, status: "done", draft: a.draft, error: null, title: a.draft.draft.title, body: a.draft.draft.body } };
    case "flow/error":
      if (a.reqId !== state.flow.reqId) return state;
      return { ...state, flow: { ...initialState.flow, status: "error", error: a.message } };
    case "flow/edit":
      return { ...state, flow: { ...state.flow, title: a.title ?? state.flow.title, body: a.body ?? state.flow.body } };
    case "flow/close":
      return { ...state, flow: initialState.flow };
  }
}

export function selectedVariant(state: State): Variant | null {
  const snap = state.run.snapshot;
  if (!snap || !state.level) return null;
  return snap.variants.find((v) => v.level === state.level) ?? null;
}

export function variantText(v: Variant | null | undefined): string {
  return v ? v.segments.map((s) => s.text).join("") : "";
}

/** 复制只取 ready 且 exportState === "exportable" 的选中档；生成中、草稿、待补材料一律锁定（V6 P0-5）。 */
export function copyGate(state: State): { enabled: boolean; text: string; reason: string } {
  if (state.run.status === "running") return { enabled: false, text: "", reason: "生成中 · 复制已锁定" };
  const v = selectedVariant(state);
  if (!v || state.run.status !== "ready") return { enabled: false, text: "", reason: "暂无可复制终稿" };
  if (v.level === "literal") return { enabled: false, text: "", reason: "直译参照不可复制" };
  if (v.exportState === "draft") return { enabled: false, text: "", reason: "草稿 · 检查未通过，不能复制" };
  if (v.exportState === "needs_data") return { enabled: false, text: "", reason: "待补材料 · 不能复制" };
  return { enabled: true, text: variantText(v), reason: "可复制" };
}

/** 测试结果是否针对上一版本（换档、换受众或重新运行后）。 */
export function testIsStale(state: State): boolean {
  const r = state.test.result;
  const snap = state.run.snapshot;
  if (!r || !snap) return false;
  return r.runId !== snap.runId || r.revision !== snap.revision || r.level !== state.level;
}
