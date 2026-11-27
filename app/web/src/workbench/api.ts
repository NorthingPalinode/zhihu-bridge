import type { ExportPack, Mutation, ProjectRow, Trace, Workspace } from "./types";

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("连不上服务，请检查网络后再试", 0);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(typeof data.detail === "string" ? data.detail : "操作没有成功，请再试一次", res.status);
  return data as T;
}

const P = (id: string) => `/api/projects/${encodeURIComponent(id)}`;

export const api = {
  list: () => call<{ projects: ProjectRow[] }>("GET", "/api/projects"),
  createDemo: () => call<{ id: string; staged?: boolean }>("POST", "/api/projects", { demo: true, staged: true }),
  create: (files: { name: string; content_b64: string }[], text?: string) => call<{ id: string; staged?: boolean }>("POST", "/api/projects", { files, text }),
  workspace: (id: string) => call<Workspace>("GET", `${P(id)}/workspace`),
  runStage: (id: string, stage: "facts" | "insights" | "content" | "review") =>
    call<Mutation>("POST", `${P(id)}/steps/${encodeURIComponent(stage)}`),
  addSources: (id: string, files: { name: string; content_b64: string }[], text?: string) =>
    call<Mutation>("POST", `${P(id)}/sources`, { files, text }),
  decide: (id: string, did: string, value: string | null, extra: { custom?: string; reason?: string } = {}) =>
    call<Mutation>("POST", `${P(id)}/decisions/${encodeURIComponent(did)}`, { value, ...extra }),
  editFact: (id: string, fid: string, text: string) => call<Mutation>("PATCH", `${P(id)}/facts/${fid}`, { text }),
  toggleInsight: (id: string, iid: string, enabled: boolean) => call<Mutation>("PATCH", `${P(id)}/insights/${iid}`, { enabled }),
  editContent: (id: string, aid: string, items: Record<string, string>) => call<Mutation>("PATCH", `${P(id)}/content/${aid}`, { items }),
  regenerate: (id: string, aid: string) => call<Mutation>("POST", `${P(id)}/content/${aid}/regenerate`),
  setting: (id: string, key: string, value: string) => call<Mutation>("PATCH", `${P(id)}/settings`, { key, value }),
  undoFix: (id: string, iid: string, reason?: string) => call<Mutation>("POST", `${P(id)}/issues/${iid}/undo-fix`, reason ? { reason } : {}),
  reapply: (id: string, iid: string) => call<Mutation>("POST", `${P(id)}/issues/${iid}/reapply`),
  undo: (id: string) => call<Mutation>("POST", `${P(id)}/actions/undo`),
  exportPack: (id: string) => call<ExportPack>("GET", `${P(id)}/export`),
  trace: (id: string) => call<Trace>("GET", `${P(id)}/trace`),
  runEventsUrl: (id: string) => `${P(id)}/run/events`,
};

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(new Error(`${file.name} 读取失败`));
    r.readAsDataURL(file);
  });
}

export function downloadBlob(name: string, blob: Blob) {
  const a = document.createElement("a");
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 800);
}

export function downloadText(name: string, text: string, mime = "text/markdown;charset=utf-8") {
  downloadBlob(name, new Blob([text], { type: mime }));
}
