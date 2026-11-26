// 与 server/bridge/workbench/api.py::workspace() 一一对应（ADR-002）。
export type Layer = "company" | "zhihu" | "global" | "rule" | "ai";
export type Basis = [Layer, string, string, string]; // 层, 标签, 获取方式/定位, 内容

export interface Source { filename: string; kind: string; status: "parsed" | "unsupported" | "failed"; size: string; note: string }

export interface Fact {
  id: string; short: string; text: string;
  evidence_status: "supported" | "needs_confirmation" | "conflicting" | "unsupported";
  source: { file: string; locator: string; quote: string };
  user_decision: "pending" | "confirmed" | "edited" | "rejected";
  decided_via: string | null; user_text: string | null;
  group?: string; value?: string; render?: string;
}

export interface DecisionOption { value: string; label: string; render?: string; source?: string; preview?: string; note?: string; recommended: boolean; fact?: string }
export interface Decision {
  id: string; kind: "confirm_facts" | "conflict" | "roadmap_wording";
  value: string | null; custom?: string | null; title?: string; why?: string; used_in?: string;
  fact_ids?: string[]; options?: DecisionOption[]; allow_custom?: boolean;
}

export interface Insight {
  id: string; concept: string; fact: string; strategy: string; used_in: string; enabled: boolean;
  zhihu: string; zhihu_cite: string;
  english: { layer: Layer; label: string; mode: string; text: string; cite: string };
  risk: string; action: string; literal: string; localized: string;
}

export type Part =
  | { type: "text"; text: string }
  | { type: "fix" | "kept" | "risk"; issue: string; text: string }
  | { type: "ph"; decision: string; text: string };

export interface Item { id: string; kind: "title" | "tagline" | "li" | "p" | "row" | "qa"; label: string | null; note: string | null; facts: string[]; insights: string[]; user_edited: boolean; parts: Part[] }
export interface Asset { id: string; title: string; items: Item[]; need: number; stale: boolean }

export interface Issue {
  id: string; asset: string; item: string; type: string; severity: "high" | "medium" | "low";
  fix_kind: string; status: "auto_applied" | "kept" | "open" | "resolved";
  title: string; loc: string; why: string; keep_reason?: string | null;
  original?: string; applied?: string; basis?: Basis[];
  term?: string; suggestion?: string;
}

export interface Blocked { id: string; title: string; short: string; why: string; quote: { file: string; locator: string; quote: string }; basis: Basis[] }

export interface Summary {
  open_decisions: string[]; facts_total: number; facts_need: number; insights_total: number; insights_on: number;
  sections_need: string[]; auto_fixed: number; kept: number; blocked: number; ready: boolean;
}

export interface Workspace {
  id: string; name: string; is_demo: boolean; llm_mode: string; retrieval_mode: string;
  settings: { channel: string; audience: string; tone: string; source: Record<string, string> };
  settings_options: Record<"channel" | "audience" | "tone", [string, string][]>;
  sources: Source[]; facts: Fact[]; decisions: Decision[]; insights: Insight[];
  brief: { priorities: string[]; faq: string[]; forbidden: string[]; glossary: [string, string, string][] };
  assets: Asset[]; issues: Issue[]; blocked: Blocked[]; gaps: { id: string; title: string; why: string }[];
  run: { steps: [string, string][] }; summary: Summary;
}

export interface Mutation { workspace: Workspace; toast: string; undoable: boolean }
export interface ProjectRow { id: string; name: string; is_demo: boolean; channel: string; open: number; updated_at: number }
export interface ExportPack { markdown: string; report: string; glossary: string; draft: { title: string; meta: string; outline: string[]; checks: [string, "system" | "user"][] } | null; open: string[]; is_demo: boolean }
export interface Trace { steps: { step: string; llm_mode: string; data: string; quota: number }[]; actions: { id: number; label: string; undone: boolean }[] }
