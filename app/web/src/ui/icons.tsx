// 克制的单色线性图标（aria-hidden，语义由文字表达）。
const base = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };

export const IconDoc = () => (
  <svg {...base}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M9 13h6M9 17h4" /></svg>
);
export const IconBridge = () => (
  <svg {...base}><path d="M3 18V9M21 18V9M3 12c3-4 6-6 9-6s6 2 9 6M7 18v-5M12 18v-6M17 18v-5M2 18h20" /></svg>
);
export const IconCheck = () => (
  <svg {...base}><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></svg>
);
export const IconArrow = () => (
  <svg {...base} width={22}><path d="M4 12h15M14 7l5 5-5 5" /></svg>
);
export const IconShield = () => (
  <svg {...base}><path d="M12 3 5 6v6c0 4 3 7 7 9 4-2 7-5 7-9V6z" /><path d="m9 12 2 2 4-4" /></svg>
);
export const IconLoop = () => (
  <svg {...base}><path d="M4 12a8 8 0 0 1 14-5.3L20 9M20 4v5h-5M20 12a8 8 0 0 1-14 5.3L4 15M4 20v-5h5" /></svg>
);
export const IconInfo = () => (
  <svg {...base} width={14} height={14}><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.5" /></svg>
);
export const IconChevron = ({ open }: { open: boolean }) => (
  <svg {...base} width={14} height={14} style={{ transform: open ? "rotate(90deg)" : undefined }}><path d="m9 6 6 6-6 6" /></svg>
);
export const IconCopy = () => (
  <svg {...base}><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>
);
export const IconUser = () => (
  <svg {...base}><circle cx="12" cy="8" r="4" /><path d="M4 20c1.5-4 5-5 8-5s6.5 1 8 5" /></svg>
);
