import { Icon, Logo } from "./icons";

/** 顶部导航（复刻参考素材方案一）：只放真正可用的入口——新建项目、最近项目、示例项目。 */
export function TopNav({ onHome, onNew, onRecent, onDemo, current }: {
  onHome: () => void; onNew: () => void; onRecent: () => void; onDemo: () => void; current?: "home" | "project";
}) {
  return (
    <header className="nav">
      <Logo onClick={onHome} />
      <div className="nav-sub">
        <b>知乎知识增强的出海内容本地化与跨文化适配工作台</b>
        <small>A Zhihu-Knowledge-Powered Workbench for Global Content Localization</small>
      </div>
      <span className="grow" />
      <nav className="nav-links" aria-label="主导航">
        <button type="button" className="btn btn-primary" onClick={onNew}><Icon name="plus" small /><span>新建项目</span></button>
        <button type="button" className="nav-link" aria-current={current === "home" ? "page" : undefined} onClick={onRecent}><Icon name="folder" /><span>最近项目</span></button>
        <button type="button" className="nav-link" onClick={onDemo}><Icon name="play" /><span>Demo</span></button>
      </nav>
      <span className="avatar" aria-hidden="true"><Icon name="user" small /></span>
    </header>
  );
}
