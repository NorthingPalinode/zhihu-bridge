import type { Adapter } from "./api";
import { ApiError } from "./api";
import type {
  CaseMeta,
  ComplianceRule,
  ComplianceRulesResponse,
  Health,
  QuestionDraft,
  QuestionDraftRequest,
  RunRequest,
  SseEvent,
  TestResult,
} from "./types";

/** 从静态文件读取冻结快照。占位结果按其各自的运行来源显示。 */
export interface OfflineBundle {
  provenance: "dev_stub" | "real_run" | "mixed";
  generatedAt: string;
  note: string;
  cases: CaseMeta[];
  complianceRules?: ComplianceRule[];
  runs: Record<string, SseEvent[]>;
  tests: Record<string, TestResult>;
  drafts: Record<string, QuestionDraft>;
  replayDrafts?: Record<string, QuestionDraft>;
  replays?: number;
}

const norm = (s: string) => s.normalize("NFKC").replace(/[\p{White_Space}\u001c-\u001f]+/gu, " ").replace(/^ | $/g, "");
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res, rej) => {
    signal?.throwIfAborted();
    const abort = () => {
      clearTimeout(t);
      rej(signal?.reason);
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      res();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });

export class OfflineAdapter implements Adapter {
  kind = "offline" as const;
  private runIndex = new Map<string, { key: string; replay: boolean; revision: number }>();
  private counter = 0;
  constructor(private bundle: OfflineBundle, private delayMs = 300) {}

  static async load(url = "/offline/bundle.json"): Promise<OfflineAdapter> {
    const r = await fetch(url);
    if (!r.ok) throw new Error("离线包不可用");
    return new OfflineAdapter((await r.json()) as OfflineBundle);
  }

  async health(): Promise<Health> {
    const replayCount = this.bundle.replays ?? (this.bundle.provenance === "real_run" ? Object.keys(this.bundle.runs).length : 0);
    return {
      ok: true,
      zhihuBudgetLeft: {},
      llmBudgetLeft: null,
      replayAvailable: replayCount > 0,
      replayCount,
      generationMode: replayCount > 0 ? "replay" : "dev_stub",
      llmProvider: "offline-bundle",
      zhihuLive: false,
      zhihuSecretConfigured: false,
      llmKeyConfigured: false,
    };
  }

  async cases(): Promise<CaseMeta[]> {
    return this.bundle.cases;
  }

  async run(req: RunRequest, onEvent: (e: SseEvent) => void, signal: AbortSignal): Promise<void> {
    const c = this.bundle.cases.find((x) => x.caseId === req.caseId);
    if (!c || norm(c.text) !== norm(req.text)) {
      throw new ApiError(404, "离线包只包含两个预置案例；自定义输入需要连接后端");
    }
    const lang = req.targetLanguage ?? "en";
    const key = lang === "en" ? `${c.caseId}|${req.audienceId}` : `${c.caseId}|${req.audienceId}|${lang}`;
    const events = this.bundle.runs[key];
    if (!events) {
      if (lang !== "en") {
        throw new ApiError(404, "离线包目前仅包含英语预置案例；其他目标语言需要连接后端实时转译");
      }
      throw new ApiError(404, "离线包中没有该受众的结果");
    }
    const ready = events.find((e) => e.type === "ready");
    if (!ready) throw new ApiError(422, "离线包缺少完整的译稿快照");
    const runId = `off_${++this.counter}`;
    for (const e of events) {
      await sleep(this.delayMs, signal);
      signal.throwIfAborted();
      const payload = e.type === "ready" ? { ...e.payload, runId } : e.payload;
      if (e.type === "ready") {
        this.runIndex.set(runId, { key, replay: ready.payload.mode === "replay", revision: Number(ready.payload.revision) });
      }
      onEvent({ ...e, runId, payload });
    }
  }

  async test(runId: string, body: { revision: number; level: string; keyPointIds: string[] }, signal?: AbortSignal): Promise<TestResult> {
    const run = this.runIndex.get(runId);
    if (!run || run.revision !== body.revision) throw new ApiError(409, "测试版本与离线译稿不一致");
    const key = `${run.key}|${body.level}`;
    const subset = [...body.keyPointIds].sort().join(",");
    const res = this.bundle.tests[`${key}|${subset}`] ?? this.bundle.tests[key];
    if (!res) throw new ApiError(404, "离线包中没有该测试结果");
    const allKps = res.keyPointIds.length === body.keyPointIds.length && res.keyPointIds.every((k) => body.keyPointIds.includes(k));
    if (!allKps) throw new ApiError(404, "离线包中没有当前信息点组合的测试");
    await sleep(this.delayMs * 2, signal);
    return { ...res, runId };
  }

  async draft(body: QuestionDraftRequest, signal?: AbortSignal): Promise<QuestionDraft> {
    const run = body.runId ? this.runIndex.get(body.runId) : undefined;
    const text = norm(body.source.text);
    let d: QuestionDraft | undefined;
    if (run?.replay) {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
      const hash = Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, "0")).join("").slice(0, 32);
      const sourceLabel = { reader_misreading: "模拟读者误解（非真实用户）", manual: "用户粘贴", example: "示例输入", guard_gap: "守门待补材料" };
      const frozen = this.bundle.replayDrafts?.[`${run.key}|${hash}`];
      if (frozen?.sourceLabel === sourceLabel[body.source.kind]) d = frozen;
    } else {
      const key = `${body.source.keyPointId}|${text}`;
      // 早期占位包只按案例索引草稿。
      d = this.bundle.drafts[`${run?.key}|${key}`] ?? this.bundle.drafts[`${body.caseId}|${key}`];
    }
    if (!d) throw new ApiError(404, "离线包中没有该输入的回流结果；用户粘贴需要连接后端");
    await sleep(this.delayMs, signal);
    return d;
  }

  async complianceRules(market?: string): Promise<ComplianceRulesResponse> {
    const all = this.bundle.complianceRules ?? [];
    const m = market?.trim().toLowerCase();
    const filtered = m ? all.filter((r) => r.markets.includes("*") || r.markets.includes(m)) : all;
    return {
      rules: filtered,
      counts: {
        legal: filtered.filter((r) => r.category === "legal").length,
        custom: filtered.filter((r) => r.category === "custom").length,
        total: filtered.length,
      },
    };
  }
}
