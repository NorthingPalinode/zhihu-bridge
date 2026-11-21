import type { SseEvent } from "./types";

/** 增量解析 text/event-stream：返回已完整的事件和尚未结束的缓冲。 */
export function parseSseChunk(buffer: string): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = [];
  const normalized = buffer.replace(/\r\n/g, "\n");
  const blocks = normalized.split("\n\n");
  const rest = blocks.pop() ?? "";
  for (const block of blocks) {
    const data = block
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;
    try {
      const event = JSON.parse(data) as SseEvent | null;
      if (event && typeof event.runId === "string" && Number.isInteger(event.seq) && event.payload && typeof event.payload === "object") {
        events.push(event);
      }
    } catch {
      // 丢弃无法解析的帧
    }
  }
  return { events, rest };
}

/** 用 fetch 读取 POST 的 SSE 流（EventSource 不支持 POST）。 */
export async function readSse(resp: Response, onEvent: (e: SseEvent) => void, signal?: AbortSignal): Promise<void> {
  if (!resp.body) throw new Error("响应没有内容");
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let runId: string | undefined;
  let lastSeq = 0;
  let terminal = false;
  const deliver = (events: SseEvent[]) => {
    for (const event of events) {
      if (signal?.aborted || terminal) break;
      if ((runId && event.runId !== runId) || event.seq <= lastSeq) continue;
      runId = event.runId;
      lastSeq = event.seq;
      onEvent(event);
      terminal = event.type === "ready" || event.type === "error";
    }
  };
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    while (!signal?.aborted && !terminal) {
      const { value, done } = await reader.read();
      if (done) {
        deliver(parseSseChunk(buf + decoder.decode() + "\n\n").events);
        break;
      }
      const { events, rest } = parseSseChunk(buf + decoder.decode(value, { stream: true }));
      buf = rest;
      deliver(events);
    }
    if (!terminal && !signal?.aborted) {
      throw new Error("连接提前结束，未收到生成结果。请重试。");
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}
