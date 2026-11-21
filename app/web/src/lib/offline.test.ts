// @vitest-environment node
import { describe, expect, it } from "vitest";
import { OfflineAdapter } from "./offline";
import { loadBundle } from "./testdata";
import type { SseEvent } from "./types";

const bundle = loadBundle();

describe("离线包", () => {
  it("整包标为开发占位，不含真实回放", () => {
    expect(bundle.provenance).toBe("dev_stub");
    for (const evs of Object.values(bundle.runs)) {
      const ready = evs.find((e) => e.type === "ready")!.payload as { mode: string; provenance: string };
      expect(ready.mode).toBe("dev_stub");
      expect(ready.provenance).toBe("dev_stub");
    }
  });

  it("按序播放并改写 runId；测试与回流按新 runId 取回", async () => {
    const a = new OfflineAdapter(bundle, 0);
    const got: SseEvent[] = [];
    const c = bundle.cases.find((x) => x.caseId === "case_a")!;
    await a.run({ text: c.text, audienceId: "a_new", caseId: "case_a" }, (e) => got.push(e), new AbortController().signal);
    expect(got.map((e) => e.type)).toEqual(["started", "terms", "evidence", "ready"]);
    const runId = got[0].runId;
    expect(runId.startsWith("off_")).toBe(true);
    expect((got[3].payload as { runId: string }).runId).toBe(runId);
    const res = await a.test(runId, { revision: 1, level: "plain", keyPointIds: ["KP1", "KP2", "KP3"] });
    expect(res.runId).toBe(runId);
    const mis = res.readers.flatMap((r) => r.judgments.map((j) => ({ j, r }))).find(({ j }) => j.verdict !== "hit")!;
    const d = await a.draft({ source: { kind: "reader_misreading", text: mis.j.quote, keyPointId: mis.j.keyPointId }, caseId: "case_a", runId });
    expect(d.sourceLabel).toBe("模拟读者误解（非真实用户）");
    expect(d.provenance).toBe("dev_stub");
  });

  it("自定义输入与用户粘贴在离线模式下如实拒绝", async () => {
    const a = new OfflineAdapter(bundle, 0);
    await expect(a.run({ text: "自定义一句话", audienceId: "a_new", caseId: null }, () => {}, new AbortController().signal)).rejects.toThrow("自定义输入需要连接后端");
    await expect(a.draft({ source: { kind: "manual", text: "anything" }, caseId: "case_a" })).rejects.toThrow("用户粘贴需要连接后端");
  });

  it("按同一受众快照读取冻结复述与草稿，缺失时不借用占位草稿", async () => {
    const mixed = loadBundle();
    const key = "case_a|a_new";
    const text = "A previous reader's note";
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    const hash = Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, "0")).join("").slice(0, 32);
    const stub = Object.values(mixed.drafts)[0];
    mixed.provenance = "mixed";
    mixed.replays = 1;
    mixed.replayDrafts = { [`${key}|${hash}`]: { ...stub, mode: "replay", provenance: "real_run" } };
    mixed.runs[key] = mixed.runs[key].map((e) => e.type === "ready" || e.type === "started"
      ? { ...e, payload: { ...e.payload, mode: "replay", provenance: "real_run" } } : e);
    mixed.tests[`${key}|plain|KP1,KP2,KP3`] = { ...mixed.tests[`${key}|plain`], mode: "replay", provenance: "real_run" };
    const offline = new OfflineAdapter(mixed, 0);
    expect(await offline.health()).toMatchObject({ replayAvailable: true, replayCount: 1 });
    const events: SseEvent[] = [];
    const c = mixed.cases.find((x) => x.caseId === "case_a")!;
    await offline.run({ text: c.text, caseId: c.caseId, audienceId: "a_new" }, (e) => events.push(e), new AbortController().signal);
    const runId = events[0].runId;
    const result = await offline.test(runId, { revision: 1, level: "plain", keyPointIds: ["KP3", "KP1", "KP2"] });
    expect(result).toMatchObject({ runId, mode: "replay", provenance: "real_run" });
    expect(await offline.draft({ runId, caseId: c.caseId, source: { kind: "reader_misreading", text, keyPointId: "KP1" } }))
      .toMatchObject({ mode: "replay", provenance: "real_run" });
    await expect(offline.draft({ runId, caseId: c.caseId, source: { kind: "reader_misreading", text: "unmatched", keyPointId: "KP1" } }))
      .rejects.toThrow("没有该输入的回流结果");
  });
});
