// 与 server/bridge/contracts.py（导出见 app/contracts/*.schema.json）一一对应。

export type Level = "literal" | "plain" | "light" | "balanced" | "technical" | "genre" | "single";
export type Mode = "live" | "replay" | "degraded" | "dev_stub";
export type Provenance = "real_run" | "dev_stub";
export type EvidenceSource = "zhihu_live" | "zhihu_cached" | "zhihu_curated" | "other" | "none";
export type Attribution = "zhihu" | "other" | "model" | "editor";
export type ExportState = "exportable" | "draft" | "needs_data";
export type TargetLanguageCode = "en" | "ja" | "ko" | "es" | "pt" | "id" | "th" | "vi" | "de" | "fr" | "ar" | "ru";

export interface TargetLanguageMeta {
  code: TargetLanguageCode;
  label: string;
  nativeName: string;
  englishName: string;
  markets: string;
  bcp47: string;
  rtl: boolean;
  cjkLike: boolean;
  subtitleSingleMax: number;
  subtitleDoubleMax: number;
}

export interface Evidence {
  id: string;
  provider: "zhihu" | "other";
  sourceMode: EvidenceSource;
  contentType: "answer" | "article" | "question" | "glossary" | "other";
  title: string | null;
  author: string | null;
  url: string;
  summary: string;
  role: "setting" | "context" | "usage" | "counterexample" | "audience_insight";
  supports: string;
  limits: string;
  termIds: string[];
  fetchedAt: string | null;
  status: "reviewed" | "candidate" | "rejected";
}

export interface Term {
  id: string;
  surface: string;
  start: number;
  end: number;
  keyPointIds: string[];
  kind: "culture" | "claim" | "scene" | "context";
}

export interface SourceSegment {
  text: string;
  termId: string | null;
}

export interface KeyPoint {
  id: string;
  text: string;
  short: string;
}

export interface Decision {
  id: string;
  termId: string;
  title: string;
  choice: string;
  rationale: string;
  evidenceIds: string[];
  attribution: Attribution;
  levels: Level[];
}

export type RiskCategory = "legal" | "custom";

export interface Check {
  id: string;
  kind: "fidelity" | "claim";
  label: string | null;
  keyPointId: string | null;
  termId: string | null;
  rule: string | null;
  span: string | null;
  status: "pass" | "warn" | "fail";
  action: "none" | "remove" | "rewrite" | "needs_data" | "review";
  reason: string;
  evidenceIds: string[];
  finalText: string | null;
  riskCategory?: RiskCategory | null;
  jurisdiction?: string | null;
  suggestion?: string | null;
}

export interface ComplianceRule {
  ruleId: string;
  category: RiskCategory;
  subcategory: string;
  title: string;
  markets: string[];
  jurisdiction: string;
  severity: "block" | "warn";
  action: "rewrite" | "remove" | "review";
  patterns: string[];
  zhCues: string[];
  reason: string;
  suggestion: string;
  enabled: boolean;
  builtin: boolean;
}

export interface ComplianceRuleCreate {
  category: RiskCategory;
  title: string;
  markets: string[];
  jurisdiction: string;
  severity: "block" | "warn";
  patterns: string[];
  zhCues?: string[];
  reason: string;
  suggestion?: string;
}

export interface ComplianceRulesResponse {
  rules: ComplianceRule[];
  counts: { legal: number; custom: number; total: number };
}

export interface Segment {
  text: string;
  termIds: string[];
  evidenceIds: string[];
  decisionId: string | null;
}

export interface Note {
  text: string;
  evidenceIds: string[];
}

export interface Variant {
  level: Level;
  segments: Segment[];
  notes: Note[];
  checks: Check[];
  exportState: ExportState;
  candidateText: string | null;
}

export interface RunSnapshot {
  runId: string;
  revision: number;
  caseId: string | null;
  audienceId: string;
  targetLanguage?: TargetLanguageCode;
  mode: Mode;
  provenance: Provenance;
  degradedReason: string | null;
  evidenceSource: EvidenceSource;
  sourceSegments: SourceSegment[];
  terms: Term[];
  keyPoints: KeyPoint[];
  evidence: Evidence[];
  decisions: Decision[];
  recommendedLevel: Level;
  recommendationReason: string;
  variants: Variant[];
  modelVersion: string;
  promptVersion: string;
  corpusVersion: string;
  createdAt: string;
  frozenAt: string | null;
  notices: string[];
}

export interface Judgment {
  keyPointId: string;
  verdict: "hit" | "missing" | "contradicted";
  quote: string;
}

export interface Reader {
  personaId: string;
  personaLabel: string;
  simulated: true;
  version: "literal" | "selected";
  status: "ok" | "failed";
  retelling: string | null;
  judgments: Judgment[];
}

export interface TestResult {
  testId: string;
  runId: string;
  revision: number;
  level: Level;
  keyPointIds: string[];
  expected: number;
  completed: number;
  readers: Reader[];
  summary: { literal: { hit: number; valid: number }; selected: { hit: number; valid: number } };
  mode: Mode;
  provenance: Provenance;
  judgeError?: string | null;
}

export type SourceKind = "reader_misreading" | "manual" | "example" | "guard_gap";

export interface QuestionDraftRequest {
  source: { kind: SourceKind; text: string; testId?: string; keyPointId?: string };
  caseId?: string | null;
  runId?: string | null;
  termIds?: string[];
}

export interface QuestionDraft {
  draftId: string;
  query: string;
  existing: { title: string; url: string }[];
  existingSource: "zhihu_live" | "cache" | "replay" | "none" | "failed";
  existingNote: string;
  recommendation: "answer_existing" | "new_question";
  recommendationReason: string;
  draft: { title: string; body: string };
  sourceLabel: "模拟读者误解（非真实用户）" | "用户粘贴" | "示例输入" | "守门待补材料";
  mode: Mode;
  provenance: Provenance;
}

export interface Health {
  ok: boolean;
  zhihuBudgetLeft: Record<string, number>;
  llmBudgetLeft: number | null;
  replayAvailable: boolean;
  replayCount: number;
  generationMode: Mode;
  llmProvider: string;
  zhihuLive: boolean;
  zhihuSecretConfigured: boolean;
  llmKeyConfigured: boolean;
}

export interface AudienceMeta {
  id: string;
  label: string;
  recommendedLevel: Level;
  constraint: string;
  personaSetId: string | null;
}

export interface CaseMeta {
  caseId: string;
  label: string;
  industry: string;
  scene: string;
  text: string;
  defaultAudienceId: string;
  levels: Level[];
  audiences: AudienceMeta[];
  testEnabled: boolean;
  testDisabledReason: string | null;
}

export type EventType = "started" | "terms" | "evidence" | "ready" | "error";

export interface SseEvent {
  runId: string;
  seq: number;
  type: EventType;
  payload: Record<string, unknown>;
}

export interface RunRequest {
  text: string;
  audienceId: string;
  caseId: string | null;
  targetLanguage?: TargetLanguageCode;
  mode?: "auto" | "replay";
}
