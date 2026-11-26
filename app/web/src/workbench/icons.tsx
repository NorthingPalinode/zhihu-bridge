// 单一图标集：24 网格、描边 1.6、圆角端点（DESIGN.md §6）。不用 emoji。
const PATHS: Record<string, string> = {
  bridge: "M2 17h20M5 17v-5M19 17v-5M12 17v-7M2 12c3-5 17-5 20 0",
  right: "M5 12h14M12 5l7 7-7 7",
  down: "M6 9l6 6 6-6",
  upload: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12",
  download: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3",
  file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6",
  alert: "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01",
  check: "M20 6 9 17l-5-5",
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
};

export function Icon({ name, small, className, style }: { name: keyof typeof PATHS | string; small?: boolean; className?: string; style?: React.CSSProperties }) {
  return (
    <svg className={`ic${small ? " ic-sm" : ""}${className ? " " + className : ""}`} viewBox="0 0 24 24" aria-hidden="true" style={style}>
      <path d={PATHS[name] ?? ""} />
    </svg>
  );
}

export function BridgeMark() {
  return (
    <span className="brand-mark">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d={PATHS.bridge} /></svg>
    </span>
  );
}
