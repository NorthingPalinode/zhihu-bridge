import { describe, expect, it } from "vitest";
import { parseHash } from "./App";
import { decisionDone, plainText, statusLabel, stepSummary } from "./copy";
import { reviewRows } from "./steps/Review";
import type { Workspace } from "./types";

const ws = (over: Partial<Workspace> = {}): Workspace => ({
  id: "p1", name: "PulseRing X1", is_demo: true, llm_mode: "fake", retrieval_mode: "curated_demo",
  settings: { channel: "ks", audience: "geek", tone: "pro", source: {} },
  settings_options: { channel: [["ks", "Kickstarter"]], audience: [["geek", "极客"]], tone: [["pro", "专业"]] },
  sources: [], facts: [], insights: [], brief: { priorities: [], faq: [], forbidden: [], glossary: [] },
  decisions: [
    { id: "facts", kind: "confirm_facts", value: null, fact_ids: ["F01", "F02"] },
    { id: "conflict:W1", kind: "conflict", subject: "机身重量", value: null, title: "机身重量写多少？", used_in: "详细介绍", options: [{ value: "3.6", label: "3.6 g", render: "3.6 g (size 9)", recommended: true }] },
  ],
  assets: [{ id: "specs", title: "技术参数", items: [], need: 1, stale: false }],
  issues: [{ id: "R01", asset: "features", item: "f2", type: "claim", severity: "high", fix_kind: "soften_claim", status: "auto_applied", title: "删掉了“全天续航”", loc: "核心卖点", why: "" }],
  blocked: [], gaps: [], run: { steps: [] },
  summary: { open_decisions: ["facts", "conflict:W1"], facts_total: 8, facts_need: 2, insights_total: 3, insights_on: 3, sections_need: ["specs"], auto_fixed: 3, kept: 0, blocked: 1, ready: false },
  ...over,
});

describe("workbench routing", () => {
  it("parses hash routes", () => {
    expect(parseHash("")).toEqual({ view: "home" });
    expect(parseHash("#/run/abc")).toEqual({ view: "run", id: "abc" });
    expect(parseHash("#/p/abc/review")).toEqual({ view: "project", id: "abc", step: "review" });
    expect(parseHash("#/p/abc/bogus")).toEqual({ view: "project", id: "abc", step: "materials" });
  });
});

describe("plain-language copy", () => {
  it("status pill speaks in human terms", () => {
    expect(statusLabel(ws())).toBe("还需你决定 2 件");
    expect(statusLabel(ws({ summary: { ...ws().summary, open_decisions: [] } }))).toBe("可以导出了");
  });
  it("step summaries never leak internal ids or versions", () => {
    for (const s of ["materials", "insights", "content", "review"] as const) {
      const t = stepSummary(ws(), s);
      expect(`${t.text}${t.tail ?? ""}`).not.toMatch(/F-\d|R-\d|W-\d|\bv\d|Brief|stale|curated_demo/);
    }
  });
  it("placeholders export as [待确认]", () => {
    expect(plainText([{ type: "text", text: "At " }, { type: "ph", decision: "conflict:W1", text: "重量等你决定" }])).toBe("At [待确认]");
  });
  it("describes a decided conflict with the chosen value", () => {
    expect(decisionDone({ ...ws().decisions[1], value: "3.6" })).toBe("机身重量写成 3.6 g (size 9)");
  });
});

describe("review grouping", () => {
  it("puts open decisions first and system fixes in their own group", () => {
    const rows = reviewRows(ws());
    expect(rows.filter((r) => r.group === "need").map((r) => r.key)).toEqual(["facts", "conflict:W1"]);
    expect(rows.find((r) => r.key === "R01")?.group).toBe("sys");
  });
});
