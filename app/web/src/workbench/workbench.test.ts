import { describe, expect, it } from "vitest";
import { parseHash } from "./App";
import { decisionDone, plainText, statusLabel, stepSummary } from "./copy";
import { buildLandingPageHtml, buildPosterSvg, buildSocialKit, extractPromoData, wrapLines } from "./exportAssets";
import { reviewRows } from "./steps/Review";
import type { Workspace } from "./types";

const ws = (over: Partial<Workspace> = {}): Workspace => ({
  id: "p1", name: "PulseRing X1", is_demo: true, llm_mode: "fake", retrieval_mode: "curated_demo",
  completed_stages: ["materials", "facts", "insights", "content", "review"],
  settings: { channel: "ks", audience: "geek", tone: "pro", source: {} },
  settings_options: { channel: [["ks", "Kickstarter"]], audience: [["geek", "极客"]], tone: [["pro", "专业"]] },
  sources: [{ filename: "spec.pdf", kind: "pdf", status: "parsed", size: "1 页 · 800 字", note: "", preview: "FCC Part 15C" }],
  facts: [], insights: [], brief: { priorities: [], faq: [], forbidden: [], glossary: [] },
  decisions: [
    { id: "facts", kind: "confirm_facts", value: null, fact_ids: ["F01", "F02"] },
    { id: "conflict:W1", kind: "conflict", subject: "机身重量", value: null, title: "机身重量写多少？", used_in: "详细介绍", options: [{ value: "3.6", label: "3.6 g", render: "3.6 g (size 9)", recommended: true }] },
  ],
  assets: [
    { id: "headline", title: "标题与宣传语", need: 0, stale: false, items: [
      { id: "hl", kind: "title", label: null, note: null, facts: [], insights: [], user_edited: false, parts: [{ type: "text", text: "PulseRing X1 — Custom 6-Layer PCB" }] },
      { id: "tg", kind: "tagline", label: null, note: null, facts: [], insights: [], user_edited: false, parts: [{ type: "text", text: "High-grade components and power-optimized firmware." }] },
    ] },
    { id: "features", title: "核心卖点", need: 0, stale: false, items: [
      { id: "f1", kind: "li", label: null, note: null, facts: ["F01"], insights: [], user_edited: false, parts: [{ type: "text", text: "Custom 6-Layer In-House PCB" }] },
    ] },
    { id: "specs", title: "技术参数", need: 1, stale: false, items: [
      { id: "p1", kind: "row", label: "Weight", note: null, facts: [], insights: [], user_edited: false, parts: [{ type: "text", text: "3.6 g (size 9)" }] },
    ] },
  ],
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
    expect(statusLabel(ws({ completed_stages: ["materials"] }))).toBe("按步骤体验中");
  });
  it("step summaries handle both completed and staged states without leaking internal ids", () => {
    for (const s of ["materials", "insights", "content", "review"] as const) {
      const t = stepSummary(ws(), s);
      expect(`${t.text}${t.tail ?? ""}`).not.toMatch(/F-\d|R-\d|W-\d|\bv\d|Brief|stale|curated_demo/);
    }
    const staged = ws({ completed_stages: ["materials"], facts: [], decisions: [], insights: [], assets: [] });
    expect(stepSummary(staged, "materials").tail).toBe("待提取事实");
    expect(stepSummary(staged, "insights").text).toBe("待你启动分析");
    expect(stepSummary(staged, "content").text).toBe("待生成英文页");
    expect(stepSummary(staged, "review").text).toBe("待执行发布前审校");
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

describe("promotional deliverables export", () => {
  it("generates valid SVG posters for all formats and themes", () => {
    const data = extractPromoData(ws());
    for (const fmt of ["portrait", "landscape", "square"] as const) {
      for (const theme of ["nebula", "titanium", "obsidian"] as const) {
        const svg = buildPosterSvg(data, fmt, theme);
        expect(svg.startsWith("<svg")).toBe(true);
        expect(svg).toContain("PulseRing X1");
        expect(svg).toContain("3.6 g (size 9)");
        expect(svg).not.toContain("undefined");
      }
    }
  });
  it("builds self-contained landing page HTML and 3 social posts with valid X tweet lengths", () => {
    const data = extractPromoData(ws());
    const html = buildLandingPageHtml(data, "nebula");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("PulseRing X1");
    expect(html).toContain("Technical Specifications");
    expect(html).toContain("VIEW TECHNICAL SPECS");
    const social = buildSocialKit(data);
    expect(social).toHaveLength(3);
    expect(social[0].tweets?.length).toBe(4);
    for (const tw of social[0].tweets ?? []) {
      expect(tw.length).toBeLessThanOrEqual(280);
    }
  });
  it("does not leak PulseRing claims into unrelated product exports", () => {
    const unrelated = ws({
      name: "AeroBrew Mini Espresso Maker",
      is_demo: false,
      assets: [
        { id: "headline", title: "标题与宣传语", need: 0, stale: false, items: [
          { id: "hl", kind: "title", label: null, note: null, facts: [], insights: [], user_edited: false, parts: [{ type: "text", text: "AeroBrew Mini — Portable 15-Bar Espresso Maker" }] },
          { id: "tg", kind: "tagline", label: null, note: null, facts: [], insights: [], user_edited: false, parts: [{ type: "text", text: "Compact aluminum body designed for travel brewing." }] },
        ] },
        { id: "specs", title: "技术参数", need: 0, stale: false, items: [
          { id: "p1", kind: "row", label: "Pressure", note: null, facts: [], insights: [], user_edited: false, parts: [{ type: "text", text: "15 bar" }] },
          { id: "p2", kind: "row", label: "Weight", note: null, facts: [], insights: [], user_edited: false, parts: [{ type: "text", text: "420 g" }] },
        ] },
      ],
    });
    const data = extractPromoData(unrelated);
    const svg = buildPosterSvg(data, "portrait", "nebula");
    const html = buildLandingPageHtml(data, "nebula");
    const social = buildSocialKit(data).map((s) => s.content).join("\n");
    for (const bad of ["6-LAYER PCB", "5 ATM", "TITANIUM", "SmartRing", "medical device"]) {
      expect(svg).not.toContain(bad);
      expect(html).not.toContain(bad);
      expect(social).not.toContain(bad);
    }
    expect(svg).toContain("15 BAR");
    expect(svg).toContain("420 G");
  });
  it("labels unreviewed exports as draft", () => {
    const unreviewed = ws({ completed_stages: ["materials", "facts", "insights", "content"] });
    const data = extractPromoData(unreviewed);
    expect(data.reviewed).toBe(false);
    expect(buildPosterSvg(data, "portrait", "nebula")).toContain("UNREVIEWED DRAFT");
  });
  it("wraps long mixed text cleanly within max lines", () => {
    const lines = wrapLines("Custom 6-Layer In-House PCB with High-Grade Component Selection for Hardware Enthusiasts", 24, 2);
    expect(lines.length).toBe(2);
    expect(lines[1].endsWith("…")).toBe(true);
  });
});
