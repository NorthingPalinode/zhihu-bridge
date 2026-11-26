// 单一图标集：24 网格、线性描边、圆角端点（DESIGN.md §6）。不用 emoji。
const PATHS: Record<string, string> = {
  bridge: "M2 17h20M5 17v-5M19 17v-5M12 17v-7M2 12c3-5 17-5 20 0",
  right: "M5 12h14M12 5l7 7-7 7",
  left: "M19 12H5M12 19l-7-7 7-7",
  chev: "M9 18l6-6-6-6",
  down: "M6 9l6 6 6-6",
  upload: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12",
  download: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3",
  file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M9 13h6M9 17h6",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 10h18",
  alert: "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01",
  info: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v6M12 7.5h.01",
  check: "M20 6 9 17l-5-5",
  checkCircle: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM8 12.5l2.7 2.7L16.5 9",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2",
  x: "M18 6 6 18M6 6l12 12",
  link: "M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7",
  plus: "M12 5v14M5 12h14",
  external: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3",
  copy: "M9 9h12v12H9zM5 15V5a2 2 0 0 1 2-2h10",
  pencil: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z",
  shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zm-3-10 2 2 4-4",
  more: "M4 12a1 1 0 1 0 2 0a1 1 0 1 0-2 0M11 12a1 1 0 1 0 2 0a1 1 0 1 0-2 0M18 12a1 1 0 1 0 2 0a1 1 0 1 0-2 0",
  undo: "M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11",
  hand: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2",
  paste: "M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2M8 2h8v4H8z",
  home: "M3 10.5 12 3l9 7.5M5 9v11h5v-6h4v6h5V9",
  play: "M7 4v16l13-8z",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0",
  users: "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21a7 7 0 0 1 14 0M16 3.5a4 4 0 0 1 0 7.5M18 14a6 6 0 0 1 4 7",
  globe: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z",
  map: "M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21zM12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
  type: "M4 7V5h16v2M9 19h6M12 5v14",
  layers: "M12 3 2 8l10 5 10-5zM2 13l10 5 10-5M2 17.5l10 5 10-5",
  box: "M21 8 12 3 3 8v8l9 5 9-5zM3 8l9 5 9-5M12 13v8",
  sparkle: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z",
  chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  star: "M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z",
  doc: "M7 3h7l5 5v13H7zM14 3v5h5M10 12h6M10 16h6",
  gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  help: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.7M12 17h.01",
  reflow: "M4 12a8 8 0 0 1 13.7-5.6L20 9M20 4v5h-5M20 12a8 8 0 0 1-13.7 5.6L4 15M4 20v-5h5",
  target: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM12 11a1 1 0 1 0 0 2 1 1 0 0 0 0-2z",
  megaphone: "M3 11v2a1 1 0 0 0 1 1h3l6 4V6L7 10H4a1 1 0 0 0-1 1zM17 8.5a5 5 0 0 1 0 7M19.5 6a8.5 8.5 0 0 1 0 12",
  bulb: "M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-3.5-3.5",
  chat: "M4 5h16v11H9l-5 4zM8 9h8M8 12.5h5",
  battery: "M3 8h15v8H3zM21 11v2M7 10.5v3M10.5 10.5v3",
  chip: "M7 7h10v10H7zM10 10h4v4h-4zM9 3v4M15 3v4M9 17v4M15 17v4M3 9h4M3 15h4M17 9h4M17 15h4",
  bolt: "M13 2 4 14h7l-1 8 9-12h-7z",
  heart: "M12 20s-7.5-4.6-9.3-9.2C1.4 7.5 3.7 4 7.2 4c2 0 3.6 1.1 4.8 2.7C13.2 5.1 14.8 4 16.8 4c3.5 0 5.8 3.5 4.5 6.8C19.5 15.4 12 20 12 20z",
  drop: "M12 3s6 6.4 6 11a6 6 0 0 1-12 0c0-4.6 6-11 6-11z",
  lock: "M6 10h12v11H6zM8.5 10V7a3.5 3.5 0 0 1 7 0v3M12 14.5v3",
  eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  scale: "M12 3v18M7 21h10M5 7h14M5 7l-3 7a3.5 3.5 0 0 0 6 0zM19 7l-3 7a3.5 3.5 0 0 0 6 0z",
  save: "M5 3h11l3 3v15H5zM8 3v5h7M8 21v-7h8v7",
  bell: "M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0",
  ring: "M12 6c-4.4 0-8 2.7-8 6s3.6 6 8 6 8-2.7 8-6-3.6-6-8-6zM12 9c-2.8 0-5 1.3-5 3s2.2 3 5 3 5-1.3 5-3-2.2-3-5-3z",
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, small, large, className, style }: { name: string; small?: boolean; large?: boolean; className?: string; style?: React.CSSProperties }) {
  return (
    <svg className={`ic${small ? " ic-sm" : ""}${large ? " ic-lg" : ""}${className ? " " + className : ""}`} viewBox="0 0 24 24" aria-hidden="true" style={style}>
      <path d={PATHS[name] ?? ""} />
    </svg>
  );
}

/** 全局 SVG 渐变（地球连线、环形进度共用）。挂在 App 根部一次。 */
export function GradDefs() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
      <defs>
        <linearGradient id="arcGrad" x1="0" x2="1"><stop offset="0" stopColor="#38E1FF" stopOpacity=".1" /><stop offset=".5" stopColor="#7FEAFF" /><stop offset="1" stopColor="#3AA0FF" stopOpacity=".2" /></linearGradient>
        <linearGradient id="ringGrad" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stopColor="#45E6FF" /><stop offset="1" stopColor="#34D399" /></linearGradient>
        <linearGradient id="logoGrad" x1="0" x2="1"><stop offset="0" stopColor="#45E6FF" /><stop offset="1" stopColor="#3AA0FF" /></linearGradient>
      </defs>
    </svg>
  );
}

export function Logo({ onClick }: { onClick?: () => void }) {
  const inner = (
    <>
      <svg viewBox="0 0 44 28" aria-hidden="true">
        <path d="M2 24h40M8 24V13M36 24V13M22 24V8M2 15c6-11 34-11 40 0M14 24v-7M30 24v-7" fill="none" stroke="url(#logoGrad)" strokeWidth="2.6" strokeLinecap="round" />
      </svg>
      <b>Zhihu Bridge</b>
    </>
  );
  return onClick ? <button type="button" className="logo" onClick={onClick} aria-label="Zhihu Bridge 首页">{inner}</button> : <span className="logo">{inner}</span>;
}

/** 产品占位图：没有产品照片时用的线性器件图形（不伪造产品图）。 */
export function ProductTile({ size = "" }: { size?: "" | "sm" | "lg" }) {
  return (
    <span className={`ptile${size ? " " + size : ""}`} aria-hidden="true">
      <svg viewBox="0 0 24 24"><path d={PATHS.ring} /><path d="M12 6v3M6.5 8.5l1.8 1.6M17.5 8.5l-1.8 1.6" /></svg>
    </span>
  );
}

export function Ring({ value, label }: { value: number; label: string }) {
  const r = 26, c = 2 * Math.PI * r;
  return (
    <div className="ring" role="img" aria-label={label}>
      <svg viewBox="0 0 64 64"><circle className="track" cx="32" cy="32" r={r} /><circle className="val" cx="32" cy="32" r={r} strokeDasharray={`${c * value} ${c}`} /></svg>
      <span>{Math.round(value * 100)}%</span>
    </div>
  );
}
