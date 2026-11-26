import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ApiError, api } from "./api";
import type { Mutation, Workspace } from "./types";

export type Step = "materials" | "insights" | "content" | "review";

interface ToastState { msg: string; undoable: boolean; key: number }
interface PopState { anchor: HTMLElement; node: ReactNode; key: number; className?: string }

export interface WbCtx {
  ws: Workspace;
  busy: Set<string>;
  /** 执行一个写操作：带“检查中…”反馈、成功后弹 Toast（可撤销），失败弹错误原因。 */
  run: (p: () => Promise<Mutation>, busy?: string[]) => Promise<boolean>;
  undo: () => Promise<void>;
  toast: (msg: string, undoable?: boolean) => void;
  openPop: (anchor: HTMLElement, node: ReactNode, className?: string) => void;
  closePop: () => void;
  step: Step;
  goStep: (s: Step) => void;
  reviewSel: string | null;
  setReviewSel: (k: string | null) => void;
  editing: string | null;
  setEditing: (k: string | null) => void;
}

const Ctx = createContext<WbCtx | null>(null);
export const useWb = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error("useWb outside provider");
  return c;
};

const MIN_BUSY_MS = 600;

export function WbProvider({ initial, step, goStep, children }: { initial: Workspace; step: Step; goStep: (s: Step) => void; children: ReactNode }) {
  const [ws, setWs] = useState(initial);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [toastState, setToast] = useState<ToastState | null>(null);
  const [pop, setPop] = useState<PopState | null>(null);
  const [reviewSel, setReviewSel] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const timer = useRef<number>(0);

  useEffect(() => setWs(initial), [initial]);

  const toast = useCallback((msg: string, undoable = false) => {
    window.clearTimeout(timer.current);
    setToast({ msg, undoable, key: Date.now() });
    timer.current = window.setTimeout(() => setToast(null), undoable ? 7000 : 3600);
  }, []);

  const run = useCallback(async (p: () => Promise<Mutation>, busyKeys: string[] = []) => {
    const start = performance.now();
    if (busyKeys.length) setBusy((b) => new Set([...b, ...busyKeys]));
    try {
      const res = await p();
      const wait = busyKeys.length ? Math.max(0, MIN_BUSY_MS - (performance.now() - start)) : 0;
      if (wait) await new Promise((r) => setTimeout(r, wait));
      setWs(res.workspace);
      toast(res.toast, res.undoable);
      return true;
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "操作没有成功，请再试一次");
      return false;
    } finally {
      if (busyKeys.length) setBusy((b) => { const n = new Set(b); busyKeys.forEach((k) => n.delete(k)); return n; });
    }
  }, [toast]);

  const undo = useCallback(async () => {
    try {
      const res = await api.undo(ws.id);
      setWs(res.workspace);
      toast(res.toast);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "撤销没有成功");
    }
  }, [ws.id, toast]);

  // Ctrl/Cmd+Z：输入框和编辑态里交给浏览器自己的撤销。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const inField = t?.closest?.("input,textarea,[contenteditable='true']");
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey && !inField && !editing) {
        e.preventDefault();
        void undo();
      }
      if (e.key === "Escape") setPop(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [undo, editing]);

  const openPop = useCallback((anchor: HTMLElement, node: ReactNode, className?: string) => setPop({ anchor, node, key: Date.now(), className }), []);
  const closePop = useCallback(() => setPop(null), []);

  const value: WbCtx = { ws, busy, run, undo, toast, openPop, closePop, step, goStep, reviewSel, setReviewSel, editing, setEditing };
  return (
    <Ctx.Provider value={value}>
      {children}
      {pop && <Popover key={pop.key} anchor={pop.anchor} className={pop.className} onClose={closePop}>{pop.node}</Popover>}
      {toastState && (
        <div className="toast" role="status" key={toastState.key}>
          <span>{toastState.msg}</span>
          {toastState.undoable && <button type="button" onClick={() => { setToast(null); void undo(); }}>撤销</button>}
          <button type="button" className="x" aria-label="关闭" onClick={() => setToast(null)}>×</button>
        </div>
      )}
    </Ctx.Provider>
  );
}

/** 弹层：空间不够时向上翻；默认焦点只落在推荐选项 / “好的” / 关闭上，永不落在风险动作（DESIGN.md §9）。 */
function Popover({ anchor, onClose, className, children }: { anchor: HTMLElement; onClose: () => void; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = anchor.getBoundingClientRect();
    const w = el.offsetWidth, h = el.offsetHeight;
    const vw = document.documentElement.clientWidth;
    let left = Math.min(r.left + window.scrollX, window.scrollX + vw - w - 12);
    left = Math.max(window.scrollX + 12, left);
    let top = r.bottom + window.scrollY + 8;
    if (r.bottom + h + 16 > window.innerHeight && r.top > h + 16) top = r.top + window.scrollY - h - 8;
    setPos({ left, top });
    anchor.classList.add("on");
    return () => anchor.classList.remove("on");
  }, [anchor]);

  useEffect(() => {
    if (!pos || !ref.current) return;
    const el = ref.current;
    const target = ["button.opt.primary", "[data-primary]", ".pop-f .btn-primary", "button.opt", "[data-pclose]"]
      .map((q) => el.querySelector<HTMLElement>(q)).find(Boolean);
    target?.focus({ preventScroll: true });
  }, [pos]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor.contains(t)) return;
      onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [anchor, onClose]);

  return (
    <div className={"pop" + (className ? " " + className : "")} role="dialog" ref={ref} style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: 0 }}>
      {children}
    </div>
  );
}
