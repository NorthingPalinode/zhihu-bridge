import { readSse } from "./sse";
import type {
  CaseMeta,
  ComplianceRule,
  ComplianceRuleCreate,
  ComplianceRulesResponse,
  CreatorAccountStatsResponse,
  CreatorCommentsResponse,
  CreatorContentDetail,
  CreatorContentStatsResponse,
  GlobalSearchResponse,
  Health,
  KnowledgeBaseItem,
  KnowledgeContentItem,
  KnowledgeSearchHit,
  QuestionAnswersResponse,
  QuestionDraft,
  QuestionDraftRequest,
  RunRequest,
  SseEvent,
  TestResult,
  ZhidaModel,
  ZhidaResponse,
  ZhihuQuotaResponse,
} from "./types";

export interface Adapter {
  kind: "backend" | "offline";
  health(): Promise<Health>;
  cases(): Promise<CaseMeta[]>;
  run(req: RunRequest, onEvent: (e: SseEvent) => void, signal: AbortSignal): Promise<void>;
  test(runId: string, body: { revision: number; level: string; keyPointIds: string[] }, signal?: AbortSignal): Promise<TestResult>;
  draft(body: QuestionDraftRequest, signal?: AbortSignal): Promise<QuestionDraft>;
  complianceRules(market?: string): Promise<ComplianceRulesResponse>;
  addComplianceRule?(rule: ComplianceRuleCreate): Promise<ComplianceRule>;
  deleteComplianceRule?(ruleId: string): Promise<void>;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const FIELD_LABELS: Record<string, string> = {
  text: "原文内容",
  audienceId: "目标受众",
  caseId: "案例编号",
  targetLanguage: "目标语言",
  keyPointIds: "信息点",
  level: "转译档位",
  revision: "译稿版本",
  source: "评论来源",
};

function formatDetail(detail: unknown): string | null {
  if (typeof detail === "string" && detail.trim()) return detail.trim();
  if (!Array.isArray(detail) || detail.length === 0) return null;
  const first = detail[0] as { type?: string; loc?: unknown[]; msg?: string; ctx?: { max_length?: number } } | null;
  if (!first || typeof first !== "object") return null;
  const loc = Array.isArray(first.loc) ? first.loc.map(String).filter((p) => p !== "body" && p !== "query" && p !== "path") : [];
  const field = loc[loc.length - 1] ?? "";
  const label = FIELD_LABELS[field] ?? (field || "请求参数");
  if (first.type === "extra_forbidden") {
    if (field === "targetLanguage") return "当前后端尚未加载多语言版本，请重启本地后端服务后重试";
    return `后端不识别参数「${label}」，请刷新页面或重启本地后端服务`;
  }
  if (first.type === "string_too_long") {
    const maxLen = first.ctx?.max_length;
    return `${label}超过长度上限${maxLen ? `（最多 ${maxLen} 字）` : ""}`;
  }
  if (first.type === "string_too_short" || first.type === "too_short") {
    if (field === "keyPointIds") return "请至少勾选一个要验证的信息点";
    return `请填写有效的${label}`;
  }
  if (first.type === "literal_error") return `${label}取值不支持，请重新选择`;
  if (first.type === "missing") return `缺少必填参数：${label}`;
  return first.msg ? `参数校验失败（${label}）：${first.msg}` : `参数校验失败（${label}）`;
}

async function json<T>(resp: Response): Promise<T> {
  if (!resp.ok) {
    let msg = `请求失败（HTTP ${resp.status}）`;
    try {
      const body = await resp.json();
      const parsed = body ? formatDetail(body.detail) : null;
      if (parsed) msg = parsed;
    } catch {
      /* ignore */
    }
    throw new ApiError(resp.status, msg);
  }
  return (await resp.json()) as T;
}

export interface ZhihuCredentialStatus {
  mode: "shared" | "personal" | "expired";
  sharedQuota: Record<string, number>;
  sharedAvailable: boolean;
  personalQuotaAtImport: Record<string, number> | null;
}

export async function zhihuCredentialStatus(): Promise<ZhihuCredentialStatus> {
  return json(await fetch("/api/zhihu/session", { cache: "no-store" }));
}

export async function importZhihuCredential(accessSecret: string): Promise<ZhihuCredentialStatus> {
  return json(await fetch("/api/zhihu/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accessSecret }),
  }));
}

export async function clearZhihuCredential(): Promise<ZhihuCredentialStatus> {
  return json(await fetch("/api/zhihu/session", { method: "DELETE" }));
}

export async function zhihuQuota(): Promise<ZhihuQuotaResponse> {
  return json(await fetch("/api/zhihu/quota", { cache: "no-store" }));
}

export async function zhihuGlobalSearch(body: {
  query: string;
  count?: number;
  filter?: string;
  searchDb?: "all" | "realtime" | "static";
}): Promise<GlobalSearchResponse> {
  return json(await fetch("/api/zhihu/global-search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

export async function zhihuQuestionAnswers(
  questionUrl: string,
  offset = 0,
  limit = 6,
): Promise<QuestionAnswersResponse> {
  const qs = new URLSearchParams({
    questionUrl,
    offset: String(offset),
    limit: String(limit),
  });
  return json(await fetch(`/api/zhihu/question-answers?${qs}`, { cache: "no-store" }));
}

export async function zhihuZhidaAsk(body: {
  query: string;
  model?: ZhidaModel;
  term?: string | null;
  sourceText?: string | null;
}): Promise<ZhidaResponse> {
  return json(await fetch("/api/zhihu/zhida", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

export async function zhihuKnowledgeBases(scope: "all" | "created" | "subscribed" = "all"): Promise<{
  scope: string;
  items: KnowledgeBaseItem[];
}> {
  return json(await fetch(`/api/zhihu/knowledge/bases?scope=${encodeURIComponent(scope)}`, { cache: "no-store" }));
}

export async function zhihuKnowledgeItems(
  kbId: string,
  cursor = "",
  limit = 20,
): Promise<{
  knowledgeBaseId: string;
  items: KnowledgeContentItem[];
  hasMore: boolean;
  nextCursor: string | null;
}> {
  const qs = new URLSearchParams({ limit: String(limit) });
  if (cursor) qs.set("cursor", cursor);
  return json(await fetch(`/api/zhihu/knowledge/bases/${encodeURIComponent(kbId)}/items?${qs}`, { cache: "no-store" }));
}

export async function zhihuKnowledgeSearch(body: {
  query: string;
  knowledgeBaseIds?: string[];
  recallScopes?: Array<"personal" | "subscription" | "public">;
  limit?: number;
}): Promise<{ query: string; items: KnowledgeSearchHit[] }> {
  return json(await fetch("/api/zhihu/knowledge/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

export async function zhihuKnowledgeUpload(body: {
  fileName: string;
  contentBase64: string;
  contentType?: string;
  knowledgeBaseId?: string | null;
}): Promise<{
  knowledgeBaseId: string;
  recallContentId: string;
  fileName: string;
  fileSize: number;
  title?: string | null;
  abstract?: string | null;
  originUrl?: string | null;
}> {
  return json(await fetch("/api/zhihu/knowledge/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

export async function zhihuCreatorContent(contentUrl: string): Promise<CreatorContentDetail> {
  const qs = new URLSearchParams({ contentUrl });
  return json(await fetch(`/api/zhihu/creator/content?${qs}`, { cache: "no-store" }));
}

export async function zhihuCreatorComments(
  contentUrl: string,
  offset = 0,
  limit = 20,
  order: "score" | "time" = "score",
): Promise<CreatorCommentsResponse> {
  const qs = new URLSearchParams({
    contentUrl,
    offset: String(offset),
    limit: String(limit),
    order,
  });
  return json(await fetch(`/api/zhihu/creator/comments?${qs}`, { cache: "no-store" }));
}

export async function zhihuCreatorAccountStats(params: {
  contentType?: "all" | "answer" | "article" | "pin" | "zvideo";
  startDate?: string;
  endDate?: string;
} = {}): Promise<CreatorAccountStatsResponse> {
  const qs = new URLSearchParams();
  if (params.contentType) qs.set("contentType", params.contentType);
  if (params.startDate) qs.set("startDate", params.startDate);
  if (params.endDate) qs.set("endDate", params.endDate);
  return json(await fetch(`/api/zhihu/creator/account-stats?${qs}`, { cache: "no-store" }));
}

export async function zhihuCreatorContentStats(params: {
  contentUrl: string;
  startDate?: string;
  endDate?: string;
}): Promise<CreatorContentStatsResponse> {
  const qs = new URLSearchParams({ contentUrl: params.contentUrl });
  if (params.startDate) qs.set("startDate", params.startDate);
  if (params.endDate) qs.set("endDate", params.endDate);
  return json(await fetch(`/api/zhihu/creator/content-stats?${qs}`, { cache: "no-store" }));
}

export class BackendAdapter implements Adapter {
  kind = "backend" as const;
  constructor(private base = "") {}

  async health(): Promise<Health> {
    return json<Health>(await fetch(`${this.base}/api/health`, { signal: AbortSignal.timeout(3500) }));
  }
  async cases(): Promise<CaseMeta[]> {
    return (await json<{ cases: CaseMeta[] }>(await fetch(`${this.base}/api/cases`))).cases;
  }
  async run(req: RunRequest, onEvent: (e: SseEvent) => void, signal: AbortSignal): Promise<void> {
    const resp = await fetch(`${this.base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(req),
      signal,
    });
    if (!resp.ok) await json(resp);
    await readSse(resp, onEvent, signal);
  }
  async test(runId: string, body: { revision: number; level: string; keyPointIds: string[] }, signal?: AbortSignal): Promise<TestResult> {
    return json<TestResult>(
      await fetch(`${this.base}/api/runs/${encodeURIComponent(runId)}/tests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      }),
    );
  }
  async draft(body: QuestionDraftRequest, signal?: AbortSignal): Promise<QuestionDraft> {
    return json<QuestionDraft>(
      await fetch(`${this.base}/api/questions/draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      }),
    );
  }
  async complianceRules(market?: string): Promise<ComplianceRulesResponse> {
    const qs = market ? `?market=${encodeURIComponent(market)}` : "";
    return json<ComplianceRulesResponse>(await fetch(`${this.base}/api/compliance/rules${qs}`, { cache: "no-store" }));
  }
  async addComplianceRule(rule: ComplianceRuleCreate): Promise<ComplianceRule> {
    const res = await json<{ rule: ComplianceRule }>(
      await fetch(`${this.base}/api/compliance/rules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rule),
      }),
    );
    return res.rule;
  }
  async deleteComplianceRule(ruleId: string): Promise<void> {
    await json(await fetch(`${this.base}/api/compliance/rules/${encodeURIComponent(ruleId)}`, { method: "DELETE" }));
  }
}

/** 离线包只在显式选择时加载，产品连接失败时报告真实状态。 */
export async function pickAdapter(): Promise<Adapter> {
  const params = new URLSearchParams(window.location.search);
  if (params.get("offline") === "1") {
    const { OfflineAdapter } = await import("./offline");
    return OfflineAdapter.load();
  }
  return new BackendAdapter();
}
