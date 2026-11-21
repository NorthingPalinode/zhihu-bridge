import { describe, expect, it } from "vitest";
import { buildBridgeRows, extractPhraseFromChoice } from "./bridge";
import type { Decision, Evidence, Term, Variant } from "./types";

const hwTerms: Term[] = [
  { id: "T1", surface: "堆料", start: 5, end: 7, keyPointIds: ["KP1"], kind: "context" },
  { id: "T2", surface: "极限压榨功耗", start: 10, end: 16, keyPointIds: ["KP2"], kind: "claim" },
  { id: "T3", surface: "底层协议调试", start: 19, end: 25, keyPointIds: ["KP3"], kind: "context" },
];

const hwDecisions: Decision[] = [
  {
    id: "DB1",
    termId: "T1",
    title: "堆料的表达",
    choice: "把堆料写成对元件用料的描述，避免 stacking materials",
    rationale: "原句表达对主板用料和选型的重视。",
    evidenceIds: [],
    attribution: "editor",
    levels: ["plain", "light", "genre"],
  },
  {
    id: "DB2",
    termId: "T2",
    title: "功耗声称的边界",
    choice: "写 optimized for power efficiency 或 power-optimized",
    rationale: "缺少实测数值。",
    evidenceIds: [],
    attribution: "editor",
    levels: ["plain", "light", "genre"],
  },
  {
    id: "DB3",
    termId: "T3",
    title: "调试功能的边界",
    choice: "写 supports low-level protocol debugging",
    rationale: "不承诺开源。",
    evidenceIds: [],
    attribution: "editor",
    levels: ["plain", "light", "genre"],
  },
];

describe("认知桥术语对齐（buildBridgeRows）", () => {
  it("跳过“避免 XXX”等否定子句，仅从正向决策抽取译文中的英文短语", () => {
    const sentence =
      "Our in-house high-density board uses carefully selected components and is power-optimized; it also supports low-level protocol debugging.";
    expect(extractPhraseFromChoice("把堆料写成对元件用料的描述，避免 stacking materials", sentence + " stacking materials")).toBeNull();
    expect(extractPhraseFromChoice("写 optimized for power efficiency 或 power-optimized", sentence)).toBe("power-optimized");
    expect(extractPhraseFromChoice("写 supports low-level protocol debugging", sentence)).toBe("supports low-level protocol debugging");
  });

  it("模型把整句放进单个多术语 segment 时，各行不再重复整句", () => {
    const wholeSentence =
      "Our in-house high-density board uses carefully selected components and is power-optimized; it also supports low-level protocol debugging.";
    const variant: Variant = {
      level: "light",
      segments: [{ text: wholeSentence, termIds: ["T1", "T2", "T3"], evidenceIds: [], decisionId: null }],
      notes: [],
      checks: [
        {
          id: "C1",
          kind: "claim",
          label: "性能声称",
          keyPointId: null,
          termId: "T2",
          rule: "性能声称",
          span: "power-optimized",
          status: "warn",
          action: "review",
          reason: "需实测数据",
          evidenceIds: [],
          finalText: null,
        },
      ],
      exportState: "exportable",
      candidateText: null,
    };

    const rows = buildBridgeRows(variant, hwTerms, hwDecisions, []);
    expect(rows[0].landing).toBe(hwDecisions[0].choice);
    expect(rows[0].landing).not.toBe(wholeSentence);
    expect(rows[1].landing).toBe("power-optimized");
    expect(rows[1].color).toBe("amber");
    expect(rows[1].marker).toBe("!");
    expect(rows[1].dashed).toBe(true);
    expect(rows[2].landing).toBe("supports low-level protocol debugging");
    expect(rows[2].color).toBe("slate");
    expect(rows[2].marker).toBe("?");
  });

  it("模型按短语拆分 segment 并附带证据时，按术语类型着色且区分文化考据与工程实践", () => {
    const terms: Term[] = [
      { id: "T1", surface: "九重雷劫", start: 0, end: 4, keyPointIds: ["KP1"], kind: "culture" },
      { id: "T2", surface: "底层协议调试", start: 5, end: 11, keyPointIds: ["KP2"], kind: "context" },
    ];
    const evidence: Evidence[] = [
      {
        id: "E1",
        provider: "zhihu",
        sourceMode: "zhihu_curated",
        contentType: "article",
        title: "雷劫考据",
        author: null,
        url: "https://zhuanlan.zhihu.com/p/1",
        summary: "说明",
        role: "setting",
        supports: "s",
        limits: "l",
        termIds: ["T1"],
        fetchedAt: null,
        status: "reviewed",
      },
      {
        id: "E2",
        provider: "zhihu",
        sourceMode: "zhihu_live",
        contentType: "answer",
        title: "协议调试",
        author: null,
        url: "https://www.zhihu.com/question/1",
        summary: "说明",
        role: "usage",
        supports: "s",
        limits: "l",
        termIds: ["T2"],
        fetchedAt: null,
        status: "reviewed",
      },
    ];
    const variant: Variant = {
      level: "genre",
      segments: [
        { text: "Ninefold Thunder Tribulation", termIds: ["T1"], evidenceIds: ["E1"], decisionId: null },
        { text: " and ", termIds: [], evidenceIds: [], decisionId: null },
        { text: "low-level protocol debugging", termIds: ["T2"], evidenceIds: [], decisionId: "D2" },
      ],
      notes: [],
      checks: [],
      exportState: "exportable",
      candidateText: null,
    };
    const decisions: Decision[] = [
      {
        id: "D2",
        termId: "T2",
        title: "调试",
        choice: "low-level protocol debugging",
        rationale: "依据社区讨论",
        evidenceIds: ["E2"],
        attribution: "zhihu",
        levels: ["genre"],
      },
    ];

    const rows = buildBridgeRows(variant, terms, decisions, evidence);
    expect(rows[0]).toMatchObject({ landing: "Ninefold Thunder Tribulation", supported: true, color: "violet", marker: "✓", dashed: false });
    expect(rows[1]).toMatchObject({ landing: "low-level protocol debugging", supported: true, color: "brand", marker: "✓", dashed: false });
  });

  it("被声称守门移除的术语标记为已拦截，不显示空白占位", () => {
    const terms: Term[] = [
      { id: "C2", surface: "祛湿", start: 0, end: 2, keyPointIds: ["KP1"], kind: "claim" },
    ];
    const variant: Variant = {
      level: "single",
      segments: [{ text: "Herbal tea for humid days.", termIds: [], evidenceIds: [], decisionId: null }],
      notes: [],
      checks: [
        {
          id: "CHK1",
          kind: "claim",
          label: "功效声称",
          keyPointId: null,
          termId: "C2",
          rule: "功效声称",
          span: "dampness-removing",
          status: "fail",
          action: "remove",
          reason: "缺少依据",
          evidenceIds: [],
          finalText: "Herbal tea for humid days.",
        },
      ],
      exportState: "exportable",
      candidateText: "Dampness-removing herbal tea for humid days.",
    };

    const rows = buildBridgeRows(variant, terms, [], []);
    expect(rows[0]).toMatchObject({
      removed: true,
      removedSpan: "dampness-removing",
      color: "red",
      marker: "✕",
      dashed: false,
    });
  });

  it("支持从多语种决策中抽取日语、韩语、阿拉伯语与俄语译文短语", () => {
    expect(extractPhraseFromChoice("译为「九重の雷劫」", "これは天道の因果、九重の雷劫を乗り越えねば魂は消え去る。")).toBe("九重の雷劫");
    expect(extractPhraseFromChoice("采用 아홉 겹의 뇌겁", "아홉 겹의 뇌겁을 견디지 못하면 영혼이 흩어집니다.")).toBe("아홉 겹의 뇌겁");
    expect(extractPhraseFromChoice("使用 محنة الرعد التساعية", "إذا لم تتحمل محنة الرعد التساعية فستتبدد روحك.")).toBe("محنة الرعد التساعية");
    expect(extractPhraseFromChoice("译为 «девятикратное испытание громом»", "Не выдержишь девятикратное испытание громом — душа рассеется.")).toBe("девятикратное испытание громом");
  });
});
