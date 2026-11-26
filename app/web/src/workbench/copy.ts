// 全站唯一叫法（DESIGN.md §0、PRODUCT.md §7）。界面文案中的状态与派生说法只从这里取。
import type { Asset, Decision, Issue, Part, Workspace } from "./types";

export const SECTION_NAMES: Record<string, string> = { headline: "标题与宣传语", features: "核心卖点", story: "详细介绍", specs: "技术参数", faq: "FAQ" };
export const KEEP_REASONS: [string, string][] = [["has_data_later", "已有实测数据，稍后补上"], ["owner_approved", "负责人确认保留"], ["will_revise", "上线前会再改"]];
export const SEVERITY: Record<string, string> = { high: "高", medium: "中", low: "低" };
export const LAYER_CLASS: Record<string, string> = { company: "ly-company", zhihu: "ly-zhihu", global: "ly-global", rule: "ly-rule", ai: "ly-ai" };
export const DEMO_TAG = "示例产品 · 虚构";
export const DEV_TAG = "开发占位 · 非真实运行";

export const plainText = (parts: Part[]) => parts.map((p) => (p.type === "ph" ? "[待确认]" : p.text)).join("");

export function statusLabel(ws: Workspace): string {
  const n = ws.summary.open_decisions.length;
  return n ? `还需你决定 ${n} 件` : "可以导出了";
}

export function stepSummary(ws: Workspace, step: "materials" | "insights" | "content" | "review"): { text: string; tone?: "need" | "ok"; tail?: string } {
  const s = ws.summary;
  if (step === "materials") {
    const n = ws.decisions.filter((d) => d.value === null).length;
    return { text: `${s.facts_total} 条事实 · `, tail: n ? `${n} 件等你决定` : "都已确认", tone: n ? "need" : "ok" };
  }
  if (step === "insights") return { text: s.insights_total ? `${s.insights_total} 条知乎建议 · ${s.insights_on} 条在用` : "骨架阶段只为示例资料提供" };
  if (step === "content") {
    const n = s.sections_need.length;
    return { text: `${ws.assets.length} 段 · `, tail: n ? `${n} 段有空位等你定` : "都已检查", tone: n ? "need" : "ok" };
  }
  return { text: `系统改了 ${s.auto_fixed} 处` + (s.blocked ? ` · 挡下 ${s.blocked} 处` : ""), tail: s.kept ? ` · 你保留 ${s.kept} 处` : undefined, tone: s.kept ? "need" : undefined };
}

export function decisionTitle(ws: Workspace, key: string): { title: string; sub: string } {
  if (key.startsWith("x:")) {
    const i = ws.issues.find((x) => x.id === key.slice(2));
    return { title: `你写的 “${i?.term ?? ""}”`, sub: SECTION_NAMES[i?.asset ?? ""] ?? "" };
  }
  const d = ws.decisions.find((x) => x.id === key);
  if (!d) return { title: key, sub: "" };
  if (d.kind === "confirm_facts") return { title: `确认 ${d.fact_ids?.length ?? 0} 条产品事实`, sub: "产品资料" };
  return { title: (d.title ?? "").replace(/？$/, ""), sub: d.used_in ?? "" };
}

export function decisionDone(d: Decision): string {
  if (d.kind === "confirm_facts") return `已确认 ${d.fact_ids?.length ?? 0} 条产品事实`;
  if (d.kind === "conflict") {
    const v = d.value === "custom" ? d.custom : d.options?.find((o) => o.value === d.value)?.render;
    return `机身重量写成 ${v}`;
  }
  return d.value === "mention" ? "照实写：上市可导出，双向同步计划中" : "先不提这个功能";
}

export const isAutoFix = (i: Issue) => ["remove_claim", "soften_claim", "terminology", "unit_boundary"].includes(i.fix_kind);
export const assetById = (ws: Workspace, id: string): Asset | undefined => ws.assets.find((a) => a.id === id);
