import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { Adapter } from "./lib/api";
import { pickAdapter } from "./lib/api";
import { copyGate, initialState, reducer, selectedVariant, testIsStale } from "./lib/state";
import type { CaseMeta, Health, Level, Mode } from "./lib/types";
import { CenterPanel } from "./ui/CenterPanel";
import { Home, allAudiences, startBlockReason, type InputState } from "./ui/Home";
import { LeftPanel } from "./ui/LeftPanel";
import { RightPanel } from "./ui/RightPanel";
import { TopBar } from "./ui/TopBar";

// 启动时的查询串：必须在任何 effect 改写 URL 之前捕获
const INITIAL_QUERY = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : new URLSearchParams();

const STAGE_TEXT = { started: "已开始", terms: "术语已标注", evidence: "证据已载入，正在生成译稿", ready: "就绪" } as const;

export default function App() {
  const [adapter, setAdapter] = useState<Adapter | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [cases, setCases] = useState<CaseMeta[]>([]);
  const [bootError, setBootError] = useState<string | null>(null);
  const [view, setView] = useState<"home" | "workbench">("home");
  const [input, setInput] = useState<InputState>({ text: "", caseId: null, audienceId: "a_new" });
  const [present, setPresent] = useState(false);
  const [state, dispatch] = useReducer(reducer, initialState);
  const [activeTermId, setActiveTermId] = useState<string | null>(null);
  const [activeCheckId, setActiveCheckId] = useState<string | null>(null);
  const [openEvidenceId, setOpenEvidenceId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [live, setLive] = useState("");
  const reqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const auxiliaryReqRef = useRef(0);
  const testAbortRef = useRef<AbortController | null>(null);
  const draftAbortRef = useRef<AbortController | null>(null);
  const restoredRef = useRef(false);
  const pendingLevelRef = useRef<Level | null>(null); // 只在刷新后的第一次结果上恢复 URL 中的档位

  useEffect(() => {
    document.documentElement.dataset.present = String(present);
  }, [present]);

  const cancelAuxiliary = useCallback(() => {
    testAbortRef.current?.abort();
    draftAbortRef.current?.abort();
  }, []);
  const closeFlow = useCallback(() => {
    draftAbortRef.current?.abort();
    dispatch({ type: "flow/close" });
  }, []);

  const startRun = useCallback(
    (inp: InputState, keepPrev: boolean, a: Adapter | null = adapter, cs: CaseMeta[] = cases) => {
      if (!a) return;
      abortRef.current?.abort(); // 新运行或重置时取消旧请求
      cancelAuxiliary();
      const ac = new AbortController();
      abortRef.current = ac;
      const reqId = ++reqRef.current;
      const label = allAudiences(cs).find((x) => x.id === inp.audienceId)?.label ?? inp.audienceId;
      dispatch({ type: "run/start", reqId, audienceId: inp.audienceId, audienceLabel: label, keepPrev, sourceText: inp.text });
      setActiveCheckId(null);
      setView("workbench");
      a.run({ text: inp.text, audienceId: inp.audienceId, caseId: inp.caseId }, (e) => dispatch({ type: "run/event", reqId, event: e }), ac.signal).catch(
        (err: unknown) => {
          if (ac.signal.aborted) return;
          dispatch({ type: "run/failed", reqId, message: err instanceof Error ? err.message : "请求失败" });
        },
      );
    },
    [adapter, cases, cancelAuxiliary],
  );

  // 启动：选择适配器、读取健康状态与案例；URL 只保存案例、受众和档位（不含原文）
  useEffect(() => {
    (async () => {
      try {
        const a = await pickAdapter();
        const [h, cs] = await Promise.all([a.health(), a.cases()]);
        setAdapter(a);
        setHealth(h);
        setCases(cs);
        const q = INITIAL_QUERY;
        const c = cs.find((x) => x.caseId === q.get("case"));
        if (c && !restoredRef.current) {
          restoredRef.current = true;
          pendingLevelRef.current = (q.get("level") as Level | null) ?? null;
          const aud = c.audiences.some((x) => x.id === q.get("aud")) ? (q.get("aud") as string) : c.defaultAudienceId;
          const inp = { text: c.text, caseId: c.caseId, audienceId: aud };
          setInput(inp);
          startRun(inp, false, a, cs);
        }
      } catch (e) {
        setBootError(e instanceof Error ? e.message : "无法连接后端，也没有离线包");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 就绪后恢复 URL 中的档位（仅限刷新后的第一次结果；之后一律采用确定性推荐档）
  useEffect(() => {
    const snap = state.run.snapshot;
    if (!snap) return;
    const lv = pendingLevelRef.current;
    pendingLevelRef.current = null;
    if (lv && lv !== "literal" && snap.variants.some((v) => v.level === lv)) {
      dispatch({ type: "level", level: lv });
    }
    setLive(`译稿就绪：${state.run.audienceLabel ?? ""}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.run.snapshot?.runId]);

  useEffect(() => {
    if (view !== "workbench" || !input.caseId) {
      if (view === "home" && adapter) window.history.replaceState(null, "", window.location.pathname + (INITIAL_QUERY.get("offline") ? "?offline=1" : ""));
      return;
    }
    const q = new URLSearchParams();
    if (INITIAL_QUERY.get("offline")) q.set("offline", "1");
    q.set("case", input.caseId);
    q.set("aud", input.audienceId);
    if (state.level) q.set("level", state.level);
    window.history.replaceState(null, "", `?${q.toString()}`);
  }, [view, input.caseId, input.audienceId, state.level, adapter]);

  // Esc 关闭展开的面板（V6 §5.6）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (state.flow.status !== "idle") closeFlow();
      else if (openEvidenceId) setOpenEvidenceId(null);
      else if (activeCheckId) setActiveCheckId(null);
      else setActiveTermId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.flow.status, openEvidenceId, activeCheckId, closeFlow]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 1800);
    return () => clearTimeout(t);
  }, [toast]);

  const offline = adapter?.kind === "offline";
  const caseMeta = cases.find((c) => c.caseId === input.caseId);
  const audiences = caseMeta ? caseMeta.audiences : allAudiences(cases);
  const snap = state.run.snapshot;
  const shownSnap = snap ?? state.prev;
  const mode: Mode | null = snap?.mode ?? (state.run.status === "error" ? "degraded" : state.run.mode);
  const evidenceSource = state.run.evidenceSource ?? shownSnap?.evidenceSource ?? null;
  const evidence = state.run.evidence.length ? state.run.evidence : shownSnap?.evidence ?? [];
  const variant = selectedVariant(state);
  const claimChecks = (variant ?? shownSnap?.variants.find((v) => v.level !== "literal"))?.checks.filter((c) => c.kind === "claim") ?? [];

  const goHome = () => {
    abortRef.current?.abort();
    cancelAuxiliary();
    setView("home");
  };
  const reset = () => {
    abortRef.current?.abort();
    cancelAuxiliary();
    dispatch({ type: "reset" });
    setActiveTermId(null);
    setActiveCheckId(null);
    setOpenEvidenceId(null);
    setInput({ text: "", caseId: null, audienceId: input.audienceId });
    setView("home");
  };
  const onTerm = (id: string) => {
    const next = activeTermId === id ? null : id;
    setActiveTermId(next);
    setActiveCheckId(null);
    const linked = next ? evidence.find((e) => e.termIds.includes(next)) : undefined;
    // 点击术语：原词、英文落点、决策卡和证据卡同时高亮；证据卡展开显示能支撑 / 不能支撑
    setOpenEvidenceId(linked ? linked.id : null);
    const chk = claimChecks.find((c) => c.termId === id);
    if (next && chk && chk.status !== "pass") setActiveCheckId(chk.id);
  };
  const onAudience = (id: string) => {
    const inp = { ...input, audienceId: id };
    setInput(inp);
    if (view === "workbench") startRun(inp, true);
  };
  const onCase = (caseId: string) => {
    const c = cases.find((x) => x.caseId === caseId);
    if (!c) return;
    const inp = { text: c.text, caseId, audienceId: c.defaultAudienceId };
    setInput(inp);
    setActiveTermId(null);
    setOpenEvidenceId(null);
    startRun(inp, false);
  };
  const runTest = async (kps: string[]) => {
    if (!adapter || !snap || !state.level) return;
    testAbortRef.current?.abort();
    const controller = new AbortController();
    testAbortRef.current = controller;
    const reqId = ++auxiliaryReqRef.current;
    dispatch({ type: "test/start", reqId });
    setLive("模拟读者测试进行中");
    try {
      const result = await adapter.test(snap.runId, { revision: snap.revision, level: state.level, keyPointIds: kps }, controller.signal);
      if (controller.signal.aborted) return;
      if (result.runId !== snap.runId || result.revision !== snap.revision || result.level !== state.level) {
        throw new Error("测试结果与发起时的译稿版本不一致，请重试");
      }
      dispatch({ type: "test/done", reqId, result });
      const judged = result.summary.literal.valid + result.summary.selected.valid;
      setLive(`复述已完成 ${result.completed}/${result.expected}，已评判 ${judged} 项`);
    } catch (e) {
      if (!controller.signal.aborted) dispatch({ type: "test/error", reqId, message: e instanceof Error ? e.message : "测试失败" });
    }
  };
  const draft = async (source: { kind: "reader_misreading" | "manual"; text: string; testId?: string; keyPointId?: string }) => {
    if (!adapter || !snap) return;
    draftAbortRef.current?.abort();
    const controller = new AbortController();
    draftAbortRef.current = controller;
    const reqId = ++auxiliaryReqRef.current;
    dispatch({ type: "flow/start", reqId });
    const termIds =
      source.keyPointId ? snap.terms.filter((t) => t.keyPointIds.includes(source.keyPointId as string)).map((t) => t.id) : activeTermId ? [activeTermId] : [];
    try {
      const d = await adapter.draft({ source, caseId: snap.caseId, runId: snap.runId, termIds }, controller.signal);
      if (controller.signal.aborted) return;
      dispatch({ type: "flow/done", reqId, draft: d });
      setLive("提问草稿已生成，可编辑后复制");
    } catch (e) {
      if (!controller.signal.aborted) dispatch({ type: "flow/error", reqId, message: e instanceof Error ? e.message : "生成草稿失败" });
    }
  };

  if (bootError) {
    return <div className="empty" style={{ margin: 40 }}>启动失败：{bootError}</div>;
  }

  if (view === "home") {
    return (
      <Home
        cases={cases}
        health={health}
        offline={offline}
        input={input}
        onInput={setInput}
        onStart={() => !startBlockReason(input, offline) && startRun(input, false)}
        present={present}
        onPresent={setPresent}
      />
    );
  }

  const running = state.run.status === "running";
  const err = state.run.status === "error" ? state.run.error : null;
  return (
    <div className="wb">
      <TopBar
        cases={cases}
        caseId={input.caseId}
        audienceId={input.audienceId}
        audiences={audiences}
        mode={mode}
        offline={offline}
        evidenceSource={evidenceSource}
        evidencePending={evidence.some((e) => e.status === "candidate")}
        present={present}
        onHome={goHome}
        onCase={onCase}
        onAudience={onAudience}
        onPresent={setPresent}
        onReset={reset}
      />
      {running && (
        <div className="strip running" role="status">
          <span className="spinner" aria-hidden />
          <span className="grow">
            正在为{state.run.audienceLabel}生成 · {state.run.stage ? STAGE_TEXT[state.run.stage] : "准备中"}
          </span>
          <button
            className="btn small"
            onClick={() => {
              abortRef.current?.abort();
              dispatch({ type: "run/cancel", reqId: state.run.reqId });
            }}
          >
            取消
          </button>
        </div>
      )}
      {err && (
        <div className="strip error" role="alert">
          <span className="grow">
            <b>已降级</b> · {err.message}
          </span>
          {err.retryable && (
            <button className="btn small" onClick={() => startRun(input, false)}>
              重试
            </button>
          )}
        </div>
      )}
      {snap?.mode === "replay" && (
        <div className="strip offline" role="status">
          <span className="grow">缓存回放{snap.degradedReason ? `：${snap.degradedReason}，已切换到同一输入的真实运行回放` : ""} · 冻结于 {snap.frozenAt ?? "未知"} · {snap.modelVersion}</span>
        </div>
      )}
      {offline && !running && mode === "dev_stub" && (
        <div className="strip offline" role="status">
          <span className="grow">离线包：后端不可用，正在读取打包的开发占位数据（非真实运行）。自定义输入和用户粘贴需要连接后端。</span>
        </div>
      )}
      <div className="sr-only" aria-live="polite">{live}</div>
      <div className="grid">
        <LeftPanel
          segments={state.run.sourceSegments.length ? state.run.sourceSegments : shownSnap?.sourceSegments ?? []}
          terms={state.run.terms.length ? state.run.terms : shownSnap?.terms ?? []}
          keyPoints={state.run.keyPoints.length ? state.run.keyPoints : shownSnap?.keyPoints ?? []}
          evidence={evidence}
          claimChecks={claimChecks}
          activeTermId={activeTermId}
          activeCheckId={activeCheckId}
          openEvidenceId={openEvidenceId}
          notices={state.run.notices}
          loading={running}
          onTerm={onTerm}
          onEvidence={setOpenEvidenceId}
        />
        <CenterPanel
          snap={shownSnap}
          dimmed={!snap && !!state.prev}
          level={snap ? state.level : state.prev?.recommendedLevel ?? null}
          audience={allAudiences(cases).find((a) => a.id === (shownSnap?.audienceId ?? input.audienceId))}
          activeTermId={activeTermId}
          activeCheckId={activeCheckId}
          onLevel={(l) => dispatch({ type: "level", level: l })}
          onTerm={onTerm}
          onCheck={setActiveCheckId}
          onEvidence={(id) => {
            setOpenEvidenceId(id);
            document.getElementById(`ev-${id}`)?.scrollIntoView({ block: "nearest" });
          }}
          running={running}
          errorText={err?.message ?? null}
          onRetry={() => startRun(input, false)}
        />
        <RightPanel
          snap={snap}
          caseMeta={snap?.caseId ? cases.find((c) => c.caseId === snap.caseId) : undefined}
          level={state.level}
          test={state.test}
          stale={testIsStale(state)}
          flow={state.flow}
          copy={copyGate(state)}
          onRunTest={runTest}
          onFlowFromMisreading={(m) => draft({ kind: "reader_misreading", text: m.quote, testId: m.testId, keyPointId: m.keyPointId })}
          onFlowManual={(text) => draft({ kind: "manual", text })}
          onFlowEdit={(v) => dispatch({ type: "flow/edit", ...v })}
          onFlowClose={closeFlow}
          onCopied={(what) => setToast(`已复制${what}`)}
        />
      </div>
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
