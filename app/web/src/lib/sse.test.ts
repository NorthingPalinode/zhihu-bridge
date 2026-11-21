// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseSseChunk, readSse } from "./sse";

describe("parseSseChunk", () => {
  it("拆出完整事件并保留半截缓冲", () => {
    const a = 'data: {"runId":"r1","seq":1,"type":"started","payload":{}}\n\n';
    const b = 'data: {"runId":"r1","seq":2,"type":"terms","pay';
    const { events, rest } = parseSseChunk(a + b);
    expect(events.map((e) => e.seq)).toEqual([1]);
    expect(rest).toBe(b);
  });
  it("兼容 CRLF 并丢弃坏帧", () => {
    const { events } = parseSseChunk('data: {"runId":"r","seq":1,"type":"ready","payload":{}}\r\n\r\ndata: not-json\n\n');
    expect(events).toHaveLength(1);
  });
  it("忽略 SSE 心跳注释帧", () => {
    const { events } = parseSseChunk(': keep-alive\n\ndata: {"runId":"r","seq":1,"type":"ready","payload":{}}\n\n');
    expect(events.map((e) => e.type)).toEqual(["ready"]);
  });
});

describe("readSse", () => {
  it("跨 chunk 读取 POST 流", async () => {
    const enc = new TextEncoder();
    const parts = ['data: {"runId":"r","seq":1,"type":"started","pay', 'load":{}}\n\ndata: {"runId":"r","seq":2,"type":"ready","payload":{}}\n\n'];
    const body = new ReadableStream({
      start(c) {
        parts.forEach((p) => c.enqueue(enc.encode(p)));
        c.close();
      },
    });
    const got: number[] = [];
    await readSse(new Response(body), (e) => got.push(e.seq));
    expect(got).toEqual([1, 2]);
  });

  it("提前结束时拒绝成功，即使收到其他运行的终止帧", async () => {
    const body = [
      'data: {"runId":"r","seq":1,"type":"started","payload":{}}',
      'data: {"runId":"other","seq":2,"type":"ready","payload":{}}',
      "",
    ].join("\n\n");
    const got: string[] = [];
    await expect(readSse(new Response(body), (e) => got.push(e.type))).rejects.toThrow("连接提前结束");
    expect(got).toEqual(["started"]);
  });

  it("主动取消等待中的流时不当作接收失败", async () => {
    const ac = new AbortController();
    const body = new ReadableStream();
    const reading = readSse(new Response(body), () => { throw new Error("unexpected event"); }, ac.signal);
    ac.abort();
    await expect(reading).resolves.toBeUndefined();
  });
});
