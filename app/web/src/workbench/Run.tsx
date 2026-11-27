import { useEffect, useState } from "react";
import { api } from "./api";
import { Icon } from "./icons";
import { TopNav } from "./TopNav";
import kanshanIdle from "./assets/kanshan-idle.gif";
import kanshanStill from "./assets/kanshan-still.png";

interface StepState { title: string; status: "wait" | "running" | "done"; result?: string }
const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** 运行进度：按真实步骤推送；完成后自动进入工作台第 1 步（不需要用户再点）。 */
export function Run({ id, names, onHome, onDemo, onDone }: { id: string; names: string[]; onHome: () => void; onDemo: () => void; onDone: (open: number) => void }) {
  const [steps, setSteps] = useState<StepState[]>([]);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const es = new EventSource(api.runEventsUrl(id));
    es.addEventListener("step", (e) => {
      const d = JSON.parse((e as MessageEvent).data) as { index: number; title: string; status: "running" | "done"; result?: string };
      setSteps((prev) => { const n = [...prev]; n[d.index] = { title: d.title, status: d.status, result: d.result }; return n; });
    });
    es.addEventListener("done", (e) => {
      es.close();
      const d = JSON.parse((e as MessageEvent).data) as { open: number };
      setTimeout(() => onDone(d.open), 450);
    });
    es.addEventListener("failed", () => { es.close(); setFailed(true); });
    es.onerror = () => { es.close(); setFailed(true); };
    return () => es.close();
  }, [id, onDone]);
  const titles = ["读取资料", "找出产品事实", "查知乎上的行业说法", "写英文页", "发布前检查"];
  return (
    <div>
      <TopNav onHome={onHome} onNew={onHome} onRecent={onHome} onDemo={onDemo} />
      <main className="run" aria-live="polite">
        <img className="mascot-run" src={reducedMotion() ? kanshanStill : kanshanIdle} alt="" />
        <h1>正在写英文页</h1>
        <p className="sub">收到：{names.join("、")}。你可以先去做别的，写好后会停在结果页。</p>
        <ol className="glass runlist">
          {Array.from({ length: Math.max(titles.length, steps.length) }, (_, i) => titles[i] ?? "").map((t, i) => {
            const s = steps[i];
            return (
              <li key={i} className={s?.status === "done" ? "ok" : s?.status === "running" ? "on" : ""}>
                <span className="rdot" /><div><b>{s?.title || t}</b><small>{s?.status === "done" ? s.result : s?.status === "running" ? "进行中…" : " "}</small></div>
              </li>
            );
          })}
        </ol>
        {failed && <div className="state need" role="alert" style={{ marginTop: 16, textAlign: "left" }}><Icon name="alert" /><span className="grow">进度连接断开了。写完后结果会自动保存，可以稍后打开项目查看。</span><button type="button" className="btn btn-sm" onClick={() => onDone(-1)}>打开项目</button></div>}
      </main>
    </div>
  );
}
