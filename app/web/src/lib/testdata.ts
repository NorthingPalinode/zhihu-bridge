// 测试用：从离线包（fake 适配器生成的开发占位数据）中取真实结构的快照，避免手写伪数据。
import raw from "../../public/offline/bundle.json";
import type { OfflineBundle } from "./offline";
import type { RunSnapshot } from "./types";

export function loadBundle(): OfflineBundle {
  return structuredClone(raw) as unknown as OfflineBundle;
}

export function snapshotOf(bundle: OfflineBundle, key: string): RunSnapshot {
  const ev = bundle.runs[key].find((e) => e.type === "ready")!;
  return ev.payload as unknown as RunSnapshot;
}
