import { describe, expect, it } from "vitest";
import { copyGate, initialState, reducer, testIsStale, type State } from "./state";
import { loadBundle, snapshotOf } from "./testdata";
import type { SseEvent, TestResult } from "./types";

const bundle = loadBundle();
const eventsA = bundle.runs["case_a|a_genre"];
const eventsC = bundle.runs["case_c|c_shopper"];

function play(events: SseEvent[], reqId = 1, base: State = initialState): State {
  let s = reducer(base, { type: "run/start", reqId, audienceId: "a_genre", audienceLabel: "北美 · 仙侠核心读者", keepPrev: false });
  for (const e of events) s = reducer(s, { type: "run/event", reqId, event: e });
  return s;
}

describe("运行状态机", () => {
  it("按 started → terms → evidence → ready 推进，并采用确定性推荐档", () => {
    const s = play(eventsA);
    expect(s.run.status).toBe("ready");
    expect(s.run.stage).toBe("ready");
    expect(s.level).toBe("genre");
    expect(s.run.snapshot?.mode).toBe("dev_stub");
  });

  it("丢弃旧请求、其他 runId 与重复/乱序的回包", () => {
    let s = reducer(initialState, { type: "run/start", reqId: 2, audienceId: "a_new", audienceLabel: "x", keepPrev: false });
    s = reducer(s, { type: "run/event", reqId: 1, event: eventsA[0] }); // 旧请求
    expect(s.run.runId).toBeNull();
    s = reducer(s, { type: "run/event", reqId: 2, event: eventsA[0] });
    s = reducer(s, { type: "run/event", reqId: 2, event: { ...eventsA[1], runId: "other" } }); // 其他运行
    expect(s.run.stage).toBe("started");
    s = reducer(s, { type: "run/event", reqId: 2, event: eventsA[1] });
    const again = reducer(s, { type: "run/event", reqId: 2, event: eventsA[1] }); // 重复 seq
    expect(again).toBe(s);
  });

  it("换受众时保留上一结果（变暗显示），新结果就绪后一次性替换", () => {
    const ready = play(eventsA);
    let s = reducer(ready, { type: "run/start", reqId: 9, audienceId: "a_new", audienceLabel: "北美 · 短剧新观众", keepPrev: true });
    expect(s.prev?.runId).toBe(ready.run.snapshot?.runId);
    expect(s.run.snapshot).toBeNull();
    for (const e of bundle.runs["case_a|a_new"]) s = reducer(s, { type: "run/event", reqId: 9, event: e });
    expect(s.prev).toBeNull();
    expect(s.level).toBe("plain");
  });

  it("error 事件进入降级态", () => {
    let s = reducer(initialState, { type: "run/start", reqId: 1, audienceId: "a_new", audienceLabel: "x", keepPrev: false });
    s = reducer(s, { type: "run/event", reqId: 1, event: { runId: "r", seq: 1, type: "error", payload: { step: "generate", message: "生成失败", retryable: true } } });
    expect(s.run.status).toBe("error");
    expect(s.run.error).toEqual({ step: "generate", message: "生成失败", retryable: true });
  });

  it("保留并同步 run/start 与 started/ready 的 targetLanguage", () => {
    let s = reducer(initialState, { type: "run/start", reqId: 5, audienceId: "a_new", audienceLabel: "x", targetLanguage: "ja", keepPrev: false });
    expect(s.run.targetLanguage).toBe("ja");
    s = reducer(s, { type: "run/event", reqId: 5, event: { runId: "r_ja", seq: 1, type: "started", payload: { targetLanguage: "ja", mode: "live" } } });
    expect(s.run.targetLanguage).toBe("ja");
  });
});

describe("复制终稿锁定（V6 P0-5）", () => {
  it("生成中锁定", () => {
    const s = reducer(initialState, { type: "run/start", reqId: 1, audienceId: "a_new", audienceLabel: "x", keepPrev: false });
    expect(copyGate(s)).toMatchObject({ enabled: false, reason: "生成中 · 复制已锁定" });
  });
  it("exportable 档可复制，内容与选中档一致", () => {
    const s = play(eventsA);
    const g = copyGate(s);
    expect(g.enabled).toBe(true);
    expect(g.text).toBe("This is the Heavenly Dao's reckoning. Fail the Ninefold Thunder Tribulation, and your soul will scatter.");
    const plain = copyGate(reducer(s, { type: "level", level: "plain" }));
    expect(plain.text).toContain("ninefold trial by lightning");
  });
  it("直译参照、草稿与待补材料不可复制", () => {
    const s = play(eventsA);
    expect(copyGate(reducer(s, { type: "level", level: "literal" })).enabled).toBe(false);
    const snap = snapshotOf(bundle, "case_a|a_genre");
    const draftSnap = { ...snap, variants: snap.variants.map((v) => ({ ...v, exportState: v.level === "genre" ? ("draft" as const) : v.exportState })) };
    const d = { ...s, run: { ...s.run, snapshot: draftSnap } };
    expect(copyGate(d)).toMatchObject({ enabled: false });
    const nd = { ...s, run: { ...s.run, snapshot: { ...snap, variants: snap.variants.map((v) => ({ ...v, exportState: "needs_data" as const })) } } };
    expect(copyGate(nd).reason).toContain("待补材料");
  });
  it("案例 C 完整转译正常广告词并通过法律与风俗守门", () => {
    let s = reducer(initialState, { type: "run/start", reqId: 1, audienceId: "c_shopper", audienceLabel: "x", keepPrev: false });
    for (const e of eventsC) s = reducer(s, { type: "run/event", reqId: 1, event: e });
    expect(copyGate(s)).toEqual({
      enabled: true,
      text: "A light, refreshing herbal tea for humid days — cooling and soothing to rescue you from late-night burnout.",
      reason: "可复制",
    });
  });
});

describe("测试结果时效", () => {
  it("换档后标记为针对上一版本", () => {
    const s = play(eventsA);
    const result = bundle.tests["case_a|a_genre|genre"] as TestResult;
    const pending = reducer(s, { type: "test/start", reqId: 1 });
    let t = reducer(pending, { type: "test/done", reqId: 1, result: { ...result, runId: s.run.snapshot!.runId } });
    expect(testIsStale(t)).toBe(false);
    t = reducer(t, { type: "level", level: "plain" });
    expect(testIsStale(t)).toBe(true);
  });

  it("切受众时释放旧测试的等待状态并丢弃旧回包", () => {
    const s = play(eventsA);
    const pending = reducer(s, { type: "test/start", reqId: 7 });
    const other = play(eventsC, 2, pending);
    const result = bundle.tests["case_a|a_genre|genre"];
    expect(other.test.status).toBe("idle");
    expect(reducer(other, { type: "test/done", reqId: 7, result })).toBe(other);
    expect(reducer(other, { type: "test/error", reqId: 7, message: "旧测试失败" })).toBe(other);
  });

  it("关闭后以及新草稿请求期间都丢弃旧草稿", () => {
    const draft = Object.values(bundle.drafts)[0];
    const first = reducer(play(eventsA), { type: "flow/start", reqId: 1 });
    const closed = reducer(first, { type: "flow/close" });
    const second = reducer(play(eventsC, 2, closed), { type: "flow/start", reqId: 2 });
    expect(reducer(closed, { type: "flow/done", reqId: 1, draft })).toBe(closed);
    expect(reducer(second, { type: "flow/done", reqId: 1, draft })).toBe(second);
    expect(reducer(second, { type: "flow/error", reqId: 1, message: "旧请求失败" })).toBe(second);
  });
});
