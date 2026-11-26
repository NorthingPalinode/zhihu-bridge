import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "./api";
import { WbProvider, useWb, type Step } from "./context";
import { Home } from "./Home";
import { GradDefs } from "./icons";
import { Run } from "./Run";
import type { Workspace } from "./types";
import { Workbench } from "./Workbench";

type Route = { view: "home" } | { view: "run"; id: string } | { view: "project"; id: string; step: Step };
const STEPS: Step[] = ["materials", "insights", "content", "review"];

export function parseHash(hash: string): Route {
  const m = hash.replace(/^#\/?/, "").split("/");
  if (m[0] === "run" && m[1]) return { view: "run", id: m[1] };
  if (m[0] === "p" && m[1]) return { view: "project", id: m[1], step: (STEPS as string[]).includes(m[2]) ? (m[2] as Step) : "materials" };
  return { view: "home" };
}

const go = (h: string) => { if (location.hash !== h) location.hash = h; };

export function App() {
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash));
  const [runNames, setRunNames] = useState<string[]>([]);
  const [ws, setWs] = useState<Workspace | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [arrivalToast, setArrivalToast] = useState<string | null>(null);

  useEffect(() => {
    const on = () => setRoute(parseHash(location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  const projectId = route.view === "project" ? route.id : null;
  useEffect(() => {
    if (!projectId) { setWs(null); return; }
    if (ws?.id === projectId) return;
    setLoadError(null);
    api.workspace(projectId).then(setWs, (e) => setLoadError(e instanceof ApiError ? e.message : "项目没有打开成功"));
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const onDone = useCallback((open: number) => {
    if (route.view !== "run") return;
    setWs(null);
    setArrivalToast(open > 0 ? `写好了。还有 ${open} 件事需要你决定，其余系统都处理了` : open === 0 ? "写好了，可以直接导出" : null);
    go(`#/p/${route.id}/materials`);
  }, [route]);

  useEffect(() => { window.scrollTo(0, 0); }, [route.view, projectId]);

  /** 顶部导航的 Demo：已有示例项目就直接打开，没有才创建（不重复建项目）。 */
  const openDemo = useCallback(async () => {
    try {
      const { projects } = await api.list();
      const demo = projects.find((p) => p.is_demo);
      if (demo) { go(`#/p/${demo.id}/materials`); return; }
      const { id } = await api.createDemo();
      setRunNames(["PulseRing X1 示例资料包（5 份）"]);
      go(`#/run/${id}`);
    } catch { go("#/"); }
  }, []);

  let view: React.ReactNode;
  if (route.view === "home") {
    view = <Home onOpen={(id) => go(`#/p/${id}/materials`)} onRun={(id, names) => { setRunNames(names); go(`#/run/${id}`); }} />;
  } else if (route.view === "run") {
    view = <Run id={route.id} names={runNames.length ? runNames : ["你的资料"]} onHome={() => go("#/")} onDemo={openDemo} onDone={onDone} />;
  } else if (loadError) {
    view = <main className="run"><h1>没有打开这个项目</h1><p className="sub">{loadError}</p><button type="button" className="btn btn-primary" onClick={() => go("#/")}>回首页</button></main>;
  } else if (!ws) {
    view = <main className="run" aria-busy="true"><p className="sub">正在打开…</p></main>;
  } else {
    view = (
      <WbProvider initial={ws} step={route.step} goStep={(s) => go(`#/p/${ws.id}/${s}`)}>
        <ArrivalToast message={arrivalToast} onShown={() => setArrivalToast(null)} />
        <Workbench onHome={() => go("#/")} onDemo={openDemo} />
      </WbProvider>
    );
  }
  return <><GradDefs />{view}</>;
}

function ArrivalToast({ message, onShown }: { message: string | null; onShown: () => void }) {
  const { toast } = useWb();
  useEffect(() => { if (message) { toast(message); onShown(); } }, [message, toast, onShown]);
  return null;
}
