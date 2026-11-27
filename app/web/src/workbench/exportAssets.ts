import { hasStage, plainText } from "./copy";
import type { Workspace } from "./types";

export type PosterFormat = "portrait" | "landscape" | "square";
export type PosterTheme = "nebula" | "titanium" | "obsidian";

export interface PromoData {
  brand: string;
  shortBrand: string;
  channelLabel: string;
  channelBadge: string;
  ctaLabel: string;
  landingCtaLabel: string;
  headline: string;
  tagline: string;
  features: string[];
  story: string[];
  specs: { label: string; value: string }[];
  faq: { q: string; a: string }[];
  visualBadges: [string, string];
  disclaimer: string;
  isRingProduct: boolean;
  hasUnresolved: boolean;
  openCount: number;
  reviewed: boolean;
  isDemo: boolean;
}

export const FORMAT_META: Record<PosterFormat, { label: string; desc: string; w: number; h: number }> = {
  portrait: { label: "竖版海报 9:16", desc: "1080×1920 · 小红书 / 朋友圈 / IG Story / 展架", w: 1080, h: 1920 },
  landscape: { label: "众筹封面 16:9", desc: "1600×900 · Kickstarter / Product Hunt / 官网主图", w: 1600, h: 900 },
  square: { label: "社媒方图 1:1", desc: "1080×1080 · X / LinkedIn / Instagram 帖子", w: 1080, h: 1080 },
};

export const THEME_META: Record<PosterTheme, { label: string; swatch: string }> = {
  nebula: { label: "深空科技", swatch: "linear-gradient(135deg,#071A3E,#38E1FF)" },
  titanium: { label: "极简钛银", swatch: "linear-gradient(135deg,#F8FAFC,#3B82F6)" },
  obsidian: { label: "曜石暖金", swatch: "linear-gradient(135deg,#11131A,#E2B86B)" },
};

interface Palette {
  bg1: string; bg2: string; bg3: string;
  glow1: string; glow2: string;
  cardBg: string; cardStroke: string;
  ink: string; inkSub: string; inkMuted: string;
  accent: string; accent2: string; accentText: string;
  pillBg: string; pillStroke: string;
  ringOuter1: string; ringOuter2: string; ringInner: string;
  gridColor: string;
}

const PALETTES: Record<PosterTheme, Palette> = {
  nebula: {
    bg1: "#040D21", bg2: "#0B224D", bg3: "#071532",
    glow1: "rgba(56,225,255,0.34)", glow2: "rgba(47,107,255,0.28)",
    cardBg: "rgba(13,34,74,0.72)", cardStroke: "rgba(96,175,255,0.32)",
    ink: "#F0F7FF", inkSub: "#BCD2F2", inkMuted: "#86A4CE",
    accent: "#38E1FF", accent2: "#3AA0FF", accentText: "#03182F",
    pillBg: "rgba(56,225,255,0.13)", pillStroke: "rgba(56,225,255,0.45)",
    ringOuter1: "#C7E4FF", ringOuter2: "#3A6FA8", ringInner: "#071835",
    gridColor: "rgba(120,185,255,0.08)",
  },
  titanium: {
    bg1: "#F6F9FD", bg2: "#E7EFF9", bg3: "#F1F5FB",
    glow1: "rgba(37,99,235,0.16)", glow2: "rgba(14,165,233,0.14)",
    cardBg: "rgba(255,255,255,0.88)", cardStroke: "rgba(15,23,42,0.12)",
    ink: "#0F172A", inkSub: "#334155", inkMuted: "#64748B",
    accent: "#2563EB", accent2: "#0EA5E9", accentText: "#FFFFFF",
    pillBg: "rgba(37,99,235,0.09)", pillStroke: "rgba(37,99,235,0.3)",
    ringOuter1: "#E2E8F0", ringOuter2: "#64748B", ringInner: "#1E293B",
    gridColor: "rgba(15,23,42,0.05)",
  },
  obsidian: {
    bg1: "#0B0C10", bg2: "#191B24", bg3: "#0F1117",
    glow1: "rgba(226,184,107,0.28)", glow2: "rgba(180,126,52,0.20)",
    cardBg: "rgba(25,27,36,0.78)", cardStroke: "rgba(226,184,107,0.28)",
    ink: "#FAF6EE", inkSub: "#D6CBB8", inkMuted: "#9A8F7C",
    accent: "#E2B86B", accent2: "#C8923C", accentText: "#161108",
    pillBg: "rgba(226,184,107,0.12)", pillStroke: "rgba(226,184,107,0.45)",
    ringOuter1: "#F4DEB0", ringOuter2: "#8E6B32", ringInner: "#121318",
    gridColor: "rgba(226,184,107,0.06)",
  },
};

function shortPill(text: string): string {
  const clean = text.replace(/\[待确认\]|\[开发占位\]/g, "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const clipped = clean.split(/[—–(（,，]/)[0].trim() || clean;
  return clipped.length > 20 ? clipped.slice(0, 19).trim() + "…" : clipped;
}

export function extractPromoData(ws: Workspace): PromoData {
  const byId = Object.fromEntries(ws.assets.map((a) => [a.id, a]));
  const titleItem = byId.headline?.items.find((i) => i.kind === "title");
  const tagItem = byId.headline?.items.find((i) => i.kind === "tagline");
  const headline = titleItem ? plainText(titleItem.parts) : `${ws.name} — Global Launch`;
  const tagline = tagItem ? plainText(tagItem.parts) : "Engineered with verified product specs and cross-cultural clarity.";
  const features = (byId.features?.items ?? []).map((i) => plainText(i.parts)).filter(Boolean);
  const story = (byId.story?.items ?? []).map((i) => plainText(i.parts)).filter(Boolean);
  const specs = (byId.specs?.items ?? []).map((i) => ({ label: i.label ?? "Spec", value: plainText(i.parts) })).filter((s) => s.value);
  const faq = (byId.faq?.items ?? []).map((i) => ({ q: i.label ?? "", a: plainText(i.parts) })).filter((x) => x.q && x.a);
  const isKs = ws.settings.channel === "ks";
  const reviewed = hasStage(ws, "review");
  const allText = [headline, tagline, ...features, ...story, ...specs.map((s) => s.value)].join(" ");
  const faqText = faq.map((x) => `${x.q} ${x.a}`).join(" ");
  const isRingProduct = ws.is_demo || /\bring\b|指环|戒指/i.test(`${ws.name} ${headline}`);
  const hasMedicalDisclaimer = ws.is_demo || /medical device|diagnose/i.test(faqText);

  const specPills = specs
    .map((s) => shortPill(s.value))
    .filter((v) => v && !/testing in progress/i.test(v));
  const badge1 = (specPills[0] ?? (reviewed ? "VERIFIED SPECS" : "DRAFT PREVIEW")).toUpperCase();
  const badge2 = (specPills[1] ?? (isKs ? "U.S. LAUNCH" : "GLOBAL EDITION")).toUpperCase();

  const disclaimer = !reviewed
    ? "UNREVIEWED DRAFT — Complete pre-publish compliance review before external distribution."
    : hasMedicalDisclaimer
      ? "General wellness product. Not a medical device. Specifications reflect verified product documentation."
      : "Prepared with Zhihu Bridge. Specifications and claims are derived strictly from verified product documentation.";

  return {
    brand: ws.name,
    shortBrand: ws.name.split(" ")[0] || "Product",
    channelLabel: isKs ? "Kickstarter 众筹新品页" : "海外独立站新品页",
    channelBadge: !reviewed
      ? "UNREVIEWED DRAFT · PREVIEW ONLY"
      : isKs ? "KICKSTARTER LAUNCH · U.S. EDITION" : "GLOBAL LAUNCH · U.S. EDITION",
    ctaLabel: isKs ? "BACK ON KICKSTARTER" : "EXPLORE FULL SPECS",
    landingCtaLabel: "VIEW TECHNICAL SPECS",
    headline,
    tagline,
    features,
    story,
    specs,
    faq,
    visualBadges: [badge1, badge2],
    disclaimer,
    isRingProduct,
    hasUnresolved: allText.includes("[待确认]") || ws.summary.open_decisions.length > 0,
    openCount: ws.summary.open_decisions.length,
    reviewed,
    isDemo: ws.is_demo,
  };
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function charUnits(ch: string): number {
  return /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 1.85 : 1;
}

/** 按英文单词与中文字符混排折行，保证海报不溢界。 */
export function wrapLines(text: string, maxUnits: number, maxLines: number): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const tokens = clean.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]|[^\s\u4e00-\u9fff]+|\s+/g) ?? [clean];
  const lines: string[] = [];
  let cur = "";
  let units = 0;

  const push = () => {
    if (cur.trim()) lines.push(cur.trim());
    cur = "";
    units = 0;
  };

  for (const tok of tokens) {
    if (/^\s+$/.test(tok)) {
      if (!cur) continue;
      if (units + 0.55 <= maxUnits) { cur += " "; units += 0.55; }
      continue;
    }
    const tu = [...tok].reduce((acc, c) => acc + charUnits(c), 0);
    if (units > 0 && units + tu > maxUnits) {
      push();
      if (lines.length >= maxLines) break;
    }
    cur += tok;
    units += tu;
  }
  if (cur.trim() && lines.length < maxLines) lines.push(cur.trim());
  if (lines.length === maxLines && clean.length > lines.join(" ").length + 4) {
    lines[maxLines - 1] = lines[maxLines - 1].replace(/[.,;:\s]+$/, "") + "…";
  }
  return lines;
}

function renderHeroVisual(cx: number, cy: number, scale: number, p: Palette, data: PromoData): string {
  const [b1, b2] = data.visualBadges;
  const centerArtwork = data.isRingProduct
    ? `
    <!-- 3D Titanium Smart Ring (PulseRing / Ring products only) -->
    <g transform="rotate(-14)">
      <ellipse cx="0" cy="12" rx="112" ry="72" fill="url(#ringMetal)" stroke="${p.ringOuter1}" stroke-width="2.5" />
      <ellipse cx="0" cy="0" rx="112" ry="72" fill="url(#ringTop)" stroke="${p.ringOuter1}" stroke-width="2" />
      <ellipse cx="0" cy="2" rx="76" ry="44" fill="${p.ringInner}" stroke="${p.accent}" stroke-opacity="0.55" stroke-width="2" />
      <path d="M-92 -12 A96 58 0 0 1 78 -30" fill="none" stroke="#FFFFFF" stroke-opacity="0.58" stroke-width="5" stroke-linecap="round" />
      <circle cx="-26" cy="40" r="5" fill="#34D399" />
      <circle cx="0" cy="44" r="6.5" fill="${p.accent}" />
      <circle cx="26" cy="40" r="5" fill="#34D399" />
      <circle cx="0" cy="44" r="13" fill="none" stroke="${p.accent}" stroke-opacity="0.45" stroke-width="1.5" />
    </g>`
    : `
    <!-- Generic precision hardware emblem for non-ring products -->
    <g>
      <rect x="-86" y="-86" width="172" height="172" rx="34" fill="url(#ringTop)" stroke="${p.ringOuter1}" stroke-width="2.5" />
      <rect x="-64" y="-64" width="128" height="128" rx="22" fill="${p.ringInner}" stroke="${p.accent}" stroke-opacity="0.65" stroke-width="2" />
      <polygon points="0,-38 34,-18 34,20 0,40 -34,20 -34,-18" fill="none" stroke="${p.accent}" stroke-width="2.5" />
      <circle cx="0" cy="0" r="10" fill="${p.accent}" />
    </g>`;

  const pillW1 = Math.max(126, Math.min(200, b1.length * 9 + 34));
  const pillW2 = Math.max(126, Math.min(200, b2.length * 9 + 34));

  return `
  <g transform="translate(${cx} ${cy}) scale(${scale})">
    <circle cx="0" cy="0" r="195" fill="url(#ringAura)" />
    <ellipse cx="0" cy="148" rx="145" ry="26" fill="rgba(0,0,0,0.38)" filter="url(#softBlur)" />
    <circle cx="0" cy="0" r="168" fill="none" stroke="${p.accent}" stroke-opacity="0.22" stroke-width="1.5" stroke-dasharray="6 10" />
    <circle cx="0" cy="0" r="138" fill="none" stroke="${p.accent2}" stroke-opacity="0.18" stroke-width="1" />
    <path d="M-158 -16 A162 58 0 0 1 158 -16" fill="none" stroke="${p.accent}" stroke-opacity="0.45" stroke-width="2" />
    <circle cx="-158" cy="-16" r="4" fill="${p.accent}" />
    <circle cx="158" cy="-16" r="4" fill="${p.accent}" />
    ${centerArtwork}
    <g transform="translate(-168 -114)">
      <rect x="0" y="0" width="${pillW1}" height="32" rx="16" fill="${p.cardBg}" stroke="${p.cardStroke}" />
      <text x="${pillW1 / 2}" y="21" text-anchor="middle" fill="${p.ink}" font-size="12" font-weight="700" font-family="Inter,system-ui,sans-serif">${esc(b1)}</text>
    </g>
    <g transform="translate(${172 - pillW2} 98)">
      <rect x="0" y="0" width="${pillW2}" height="32" rx="16" fill="${p.cardBg}" stroke="${p.cardStroke}" />
      <text x="${pillW2 / 2}" y="21" text-anchor="middle" fill="${p.accent}" font-size="12" font-weight="700" font-family="Inter,system-ui,sans-serif">${esc(b2)}</text>
    </g>
  </g>`;
}

export function buildPosterSvg(data: PromoData, format: PosterFormat, theme: PosterTheme): string {
  const { w, h } = FORMAT_META[format];
  const p = PALETTES[theme];
  const font = "Inter, 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif";
  const features = data.features.slice(0, format === "landscape" ? 3 : 4);
  const specs = data.specs.slice(0, 4);
  const trustTitle = data.reviewed ? "Fact-Checked Launch Copy" : "Unreviewed Launch Draft";
  const trustSub = data.reviewed ? "Derived strictly from verified product specs · Zhihu Bridge" : "Run pre-publish review before external release";

  const defs = `
  <defs>
    <linearGradient id="bgGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${p.bg1}" />
      <stop offset="55%" stop-color="${p.bg2}" />
      <stop offset="100%" stop-color="${p.bg3}" />
    </linearGradient>
    <radialGradient id="glow1" cx="78%" cy="18%" r="55%">
      <stop offset="0%" stop-color="${p.glow1}" />
      <stop offset="100%" stop-color="rgba(0,0,0,0)" />
    </radialGradient>
    <radialGradient id="glow2" cx="15%" cy="85%" r="55%">
      <stop offset="0%" stop-color="${p.glow2}" />
      <stop offset="100%" stop-color="rgba(0,0,0,0)" />
    </radialGradient>
    <radialGradient id="ringAura" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${p.glow1}" />
      <stop offset="100%" stop-color="rgba(0,0,0,0)" />
    </radialGradient>
    <linearGradient id="ringMetal" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${p.ringOuter1}" />
      <stop offset="50%" stop-color="${p.ringOuter2}" />
      <stop offset="100%" stop-color="${p.ringOuter1}" />
    </linearGradient>
    <linearGradient id="ringTop" x1="0" y1="0" x2="1" y2="0.8">
      <stop offset="0%" stop-color="${p.ringOuter1}" />
      <stop offset="65%" stop-color="${p.ringOuter2}" />
      <stop offset="100%" stop-color="${p.ringOuter1}" />
    </linearGradient>
    <linearGradient id="accentBtn" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${p.accent}" />
      <stop offset="100%" stop-color="${p.accent2}" />
    </linearGradient>
    <pattern id="dotGrid" width="36" height="36" patternUnits="userSpaceOnUse">
      <circle cx="1.5" cy="1.5" r="1.3" fill="${p.gridColor}" />
    </pattern>
    <filter id="softBlur" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="10" />
    </filter>
  </defs>`;

  const bg = `
  <rect width="${w}" height="${h}" fill="url(#bgGrad)" />
  <rect width="${w}" height="${h}" fill="url(#glow1)" />
  <rect width="${w}" height="${h}" fill="url(#glow2)" />
  <rect width="${w}" height="${h}" fill="url(#dotGrid)" />`;

  let body = "";

  if (format === "portrait") {
    const hlLines = wrapLines(data.headline, 26, 3);
    const tgLines = wrapLines(data.tagline, 46, 3);
    const hlStartY = 232;
    const tgStartY = hlStartY + hlLines.length * 64 + 18;
    const featStartY = 930;

    body = `
    <g transform="translate(76 76)">
      <rect width="430" height="44" rx="22" fill="${p.pillBg}" stroke="${p.pillStroke}" stroke-width="1.5" />
      <circle cx="24" cy="22" r="5" fill="${p.accent}" />
      <text x="42" y="28" fill="${p.accent}" font-size="16" font-weight="700" letter-spacing="1.6" font-family="${font}">${esc(data.channelBadge)}</text>
    </g>
    <text x="${w - 76}" y="106" text-anchor="end" fill="${p.inkMuted}" font-size="18" font-weight="700" letter-spacing="2" font-family="${font}">ZHIHU BRIDGE</text>

    ${hlLines.map((l, i) => `<text x="76" y="${hlStartY + i * 64}" fill="${p.ink}" font-size="52" font-weight="800" font-family="${font}">${esc(l)}</text>`).join("")}
    <rect x="76" y="${tgStartY - 26}" width="84" height="5" rx="2.5" fill="url(#accentBtn)" />
    ${tgLines.map((l, i) => `<text x="76" y="${tgStartY + 14 + i * 34}" fill="${p.inkSub}" font-size="24" font-weight="500" font-family="${font}">${esc(l)}</text>`).join("")}

    ${renderHeroVisual(w / 2, 685, 1.18, p, data)}

    <text x="76" y="${featStartY}" fill="${p.accent}" font-size="17" font-weight="700" letter-spacing="2" font-family="${font}">KEY HIGHLIGHTS</text>
    ${features.map((f, idx) => {
      const y = featStartY + 26 + idx * 118;
      const lines = wrapLines(f, 52, 2);
      return `
      <g transform="translate(76 ${y})">
        <rect width="${w - 152}" height="102" rx="18" fill="${p.cardBg}" stroke="${p.cardStroke}" stroke-width="1.5" />
        <rect x="20" y="24" width="54" height="54" rx="14" fill="${p.pillBg}" stroke="${p.pillStroke}" />
        <text x="47" y="59" text-anchor="middle" fill="${p.accent}" font-size="22" font-weight="800" font-family="${font}">0${idx + 1}</text>
        ${lines.map((ln, li) => `<text x="94" y="${lines.length === 1 ? 58 : 44 + li * 30}" fill="${p.ink}" font-size="22" font-weight="600" font-family="${font}">${esc(ln)}</text>`).join("")}
      </g>`;
    }).join("")}

    <g transform="translate(76 1445)">
      <rect width="${w - 152}" height="240" rx="22" fill="${p.cardBg}" stroke="${p.cardStroke}" stroke-width="1.5" />
      <text x="28" y="40" fill="${p.inkMuted}" font-size="15" font-weight="700" letter-spacing="1.6" font-family="${font}">KEY SPECIFICATIONS</text>
      ${specs.map((sp, i) => {
        const col = i % 2;
        const row = Math.floor(i / 2);
        const x = 28 + col * 448;
        const y = 78 + row * 78;
        const valLines = wrapLines(sp.value, 32, 2);
        return `
        <text x="${x}" y="${y}" fill="${p.inkMuted}" font-size="15" font-weight="600" font-family="${font}">${esc(sp.label.toUpperCase())}</text>
        ${valLines.map((vl, vi) => `<text x="${x}" y="${y + 26 + vi * 22}" fill="${p.ink}" font-size="19" font-weight="700" font-family="${font}">${esc(vl)}</text>`).join("")}`;
      }).join("")}
    </g>

    <g transform="translate(76 1738)">
      <rect width="380" height="72" rx="16" fill="url(#accentBtn)" />
      <text x="190" y="45" text-anchor="middle" fill="${p.accentText}" font-size="22" font-weight="800" letter-spacing="1.2" font-family="${font}">${esc(data.ctaLabel)} →</text>
      <text x="412" y="31" fill="${p.ink}" font-size="18" font-weight="700" font-family="${font}">${esc(trustTitle)}</text>
      <text x="412" y="58" fill="${p.inkMuted}" font-size="15" font-family="${font}">${esc(trustSub)}</text>
    </g>
    <text x="76" y="1868" fill="${p.inkMuted}" font-size="14" font-family="${font}">${esc(data.disclaimer)}</text>`;
  } else if (format === "landscape") {
    const hlLines = wrapLines(data.headline, 32, 2);
    const tgLines = wrapLines(data.tagline, 56, 2);
    const hlY = 198;
    const tgY = hlY + hlLines.length * 58 + 16;

    body = `
    <g transform="translate(76 58)">
      <rect width="410" height="40" rx="20" fill="${p.pillBg}" stroke="${p.pillStroke}" stroke-width="1.5" />
      <circle cx="22" cy="20" r="4.5" fill="${p.accent}" />
      <text x="38" y="25" fill="${p.accent}" font-size="14.5" font-weight="700" letter-spacing="1.4" font-family="${font}">${esc(data.channelBadge)}</text>
    </g>
    <text x="${w - 76}" y="84" text-anchor="end" fill="${p.inkMuted}" font-size="16" font-weight="700" letter-spacing="2" font-family="${font}">ZHIHU BRIDGE · LAUNCH KIT</text>

    ${hlLines.map((l, i) => `<text x="76" y="${hlY + i * 58}" fill="${p.ink}" font-size="48" font-weight="800" font-family="${font}">${esc(l)}</text>`).join("")}
    <rect x="76" y="${tgY - 22}" width="76" height="5" rx="2.5" fill="url(#accentBtn)" />
    ${tgLines.map((l, i) => `<text x="76" y="${tgY + 12 + i * 30}" fill="${p.inkSub}" font-size="21" font-weight="500" font-family="${font}">${esc(l)}</text>`).join("")}

    ${features.map((f, idx) => {
      const y = 412 + idx * 88;
      const lines = wrapLines(f, 56, 2);
      return `
      <g transform="translate(76 ${y})">
        <rect width="840" height="74" rx="14" fill="${p.cardBg}" stroke="${p.cardStroke}" stroke-width="1.3" />
        <rect x="16" y="17" width="40" height="40" rx="10" fill="${p.pillBg}" stroke="${p.pillStroke}" />
        <text x="36" y="43" text-anchor="middle" fill="${p.accent}" font-size="17" font-weight="800" font-family="${font}">0${idx + 1}</text>
        ${lines.map((ln, li) => `<text x="74" y="${lines.length === 1 ? 43 : 33 + li * 23}" fill="${p.ink}" font-size="18" font-weight="600" font-family="${font}">${esc(ln)}</text>`).join("")}
      </g>`;
    }).join("")}

    ${renderHeroVisual(1245, 340, 1.15, p, data)}

    <g transform="translate(76 708)">
      <rect width="${w - 152}" height="128" rx="18" fill="${p.cardBg}" stroke="${p.cardStroke}" stroke-width="1.5" />
      ${specs.slice(0, 3).map((sp, i) => {
        const x = 28 + i * 335;
        const valLines = wrapLines(sp.value, 26, 2);
        return `
        <text x="${x}" y="38" fill="${p.inkMuted}" font-size="13.5" font-weight="700" letter-spacing="1" font-family="${font}">${esc(sp.label.toUpperCase())}</text>
        ${valLines.map((vl, vi) => `<text x="${x}" y="${66 + vi * 22}" fill="${p.ink}" font-size="17.5" font-weight="700" font-family="${font}">${esc(vl)}</text>`).join("")}`;
      }).join("")}
      <g transform="translate(${w - 152 - 310} 30)">
        <rect width="284" height="66" rx="14" fill="url(#accentBtn)" />
        <text x="142" y="40" text-anchor="middle" fill="${p.accentText}" font-size="18" font-weight="800" letter-spacing="1" font-family="${font}">${esc(data.ctaLabel)} →</text>
      </g>
    </g>
    <text x="76" y="872" fill="${p.inkMuted}" font-size="13" font-family="${font}">${esc(data.disclaimer)}</text>`;
  } else {
    const hlLines = wrapLines(data.headline, 28, 2);
    const tgLines = wrapLines(data.tagline, 48, 2);
    const hlY = 186;
    const tgY = hlY + hlLines.length * 52 + 12;

    body = `
    <g transform="translate(64 56)">
      <rect width="400" height="38" rx="19" fill="${p.pillBg}" stroke="${p.pillStroke}" stroke-width="1.4" />
      <circle cx="20" cy="19" r="4.5" fill="${p.accent}" />
      <text x="36" y="24" fill="${p.accent}" font-size="14" font-weight="700" letter-spacing="1.4" font-family="${font}">${esc(data.channelBadge)}</text>
    </g>
    <text x="${w - 64}" y="80" text-anchor="end" fill="${p.inkMuted}" font-size="15" font-weight="700" letter-spacing="1.8" font-family="${font}">ZHIHU BRIDGE</text>

    ${hlLines.map((l, i) => `<text x="64" y="${hlY + i * 52}" fill="${p.ink}" font-size="42" font-weight="800" font-family="${font}">${esc(l)}</text>`).join("")}
    <rect x="64" y="${tgY - 18}" width="70" height="4" rx="2" fill="url(#accentBtn)" />
    ${tgLines.map((l, i) => `<text x="64" y="${tgY + 12 + i * 28}" fill="${p.inkSub}" font-size="19" font-weight="500" font-family="${font}">${esc(l)}</text>`).join("")}

    ${features.slice(0, 3).map((f, idx) => {
      const y = 370 + idx * 108;
      const lines = wrapLines(f, 32, 3);
      return `
      <g transform="translate(64 ${y})">
        <rect width="540" height="92" rx="14" fill="${p.cardBg}" stroke="${p.cardStroke}" stroke-width="1.3" />
        <rect x="14" y="24" width="36" height="36" rx="9" fill="${p.pillBg}" stroke="${p.pillStroke}" />
        <text x="32" y="48" text-anchor="middle" fill="${p.accent}" font-size="15" font-weight="800" font-family="${font}">0${idx + 1}</text>
        ${lines.map((ln, li) => `<text x="64" y="${lines.length === 1 ? 51 : 34 + li * 21}" fill="${p.ink}" font-size="16" font-weight="600" font-family="${font}">${esc(ln)}</text>`).join("")}
      </g>`;
    }).join("")}
    ${renderHeroVisual(820, 520, 0.96, p, data)}

    <g transform="translate(64 730)">
      <rect width="${w - 128}" height="196" rx="18" fill="${p.cardBg}" stroke="${p.cardStroke}" stroke-width="1.4" />
      ${specs.map((sp, i) => {
        const col = i % 2;
        const row = Math.floor(i / 2);
        const x = 26 + col * 462;
        const y = 42 + row * 78;
        const valLines = wrapLines(sp.value, 32, 2);
        return `
        <text x="${x}" y="${y}" fill="${p.inkMuted}" font-size="13.5" font-weight="700" font-family="${font}">${esc(sp.label.toUpperCase())}</text>
        ${valLines.map((vl, vi) => `<text x="${x}" y="${y + 24 + vi * 20}" fill="${p.ink}" font-size="17" font-weight="700" font-family="${font}">${esc(vl)}</text>`).join("")}`;
      }).join("")}
    </g>

    <g transform="translate(64 958)">
      <rect width="310" height="62" rx="14" fill="url(#accentBtn)" />
      <text x="155" y="38" text-anchor="middle" fill="${p.accentText}" font-size="18" font-weight="800" letter-spacing="1" font-family="${font}">${esc(data.ctaLabel)} →</text>
      <text x="338" y="28" fill="${p.ink}" font-size="16" font-weight="700" font-family="${font}">${esc(trustTitle)}</text>
      <text x="338" y="52" fill="${p.inkMuted}" font-size="13.5" font-family="${font}">${esc(data.disclaimer.slice(0, 74))}</text>
    </g>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${defs}${bg}${body}</svg>`;
}

export async function svgToPngBlob(svg: string, width: number, height: number): Promise<Blob> {
  const svgBlob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(svgBlob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("海报图像渲染失败"));
      el.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("浏览器不支持 Canvas 导出");
    ctx.drawImage(img, 0, 0, width, height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG 编码失败"))), "image/png");
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function buildLandingPageHtml(data: PromoData, theme: PosterTheme): string {
  const p = PALETTES[theme];
  const heroSvg = `<svg viewBox="0 0 380 340" width="340" height="304" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <radialGradient id="ringAura" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="${p.glow1}"/><stop offset="100%" stop-color="rgba(0,0,0,0)"/></radialGradient>
      <linearGradient id="ringMetal" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="${p.ringOuter1}"/><stop offset="50%" stop-color="${p.ringOuter2}"/><stop offset="100%" stop-color="${p.ringOuter1}"/></linearGradient>
      <linearGradient id="ringTop" x1="0" y1="0" x2="1" y2="0.8"><stop offset="0%" stop-color="${p.ringOuter1}"/><stop offset="65%" stop-color="${p.ringOuter2}"/><stop offset="100%" stop-color="${p.ringOuter1}"/></linearGradient>
      <filter id="softBlur" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="8"/></filter>
    </defs>
    ${renderHeroVisual(190, 170, 0.85, p, data)}
  </svg>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${esc(data.headline)}</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:linear-gradient(145deg,${p.bg1},${p.bg2} 55%,${p.bg3});color:${p.ink};line-height:1.65;min-height:100vh}
  .wrap{max-width:1080px;margin:0 auto;padding:40px 24px 72px}
  .badge{display:inline-flex;align-items:center;gap:8px;padding:7px 16px;border-radius:999px;background:${p.pillBg};border:1px solid ${p.pillStroke};color:${p.accent};font-size:12px;font-weight:700;letter-spacing:1.4px}
  .hero{display:grid;grid-template-columns:1.15fr .85fr;gap:36px;align-items:center;padding:28px 0 48px}
  h1{font-size:clamp(30px,4vw,48px);line-height:1.14;margin:18px 0 16px;font-weight:800}
  .tagline{font-size:18px;color:${p.inkSub};margin:0 0 28px}
  .cta{display:inline-flex;align-items:center;gap:10px;padding:15px 28px;border-radius:14px;background:linear-gradient(90deg,${p.accent},${p.accent2});color:${p.accentText};font-weight:800;text-decoration:none;letter-spacing:.6px}
  .hero-art{display:grid;place-items:center}
  h2{font-size:26px;margin:48px 0 18px;font-weight:800}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px}
  .card{background:${p.cardBg};border:1px solid ${p.cardStroke};border-radius:16px;padding:20px}
  .num{display:inline-grid;place-items:center;width:36px;height:36px;border-radius:10px;background:${p.pillBg};border:1px solid ${p.pillStroke};color:${p.accent};font-weight:800;font-size:14px;margin-bottom:12px}
  .story p{color:${p.inkSub};font-size:16px;margin:0 0 14px}
  table{width:100%;border-collapse:collapse;background:${p.cardBg};border:1px solid ${p.cardStroke};border-radius:16px;overflow:hidden}
  th,td{padding:14px 18px;text-align:left;border-bottom:1px solid ${p.cardStroke}}
  th{color:${p.inkMuted};font-size:13px;text-transform:uppercase;letter-spacing:.8px;width:34%}
  details{background:${p.cardBg};border:1px solid ${p.cardStroke};border-radius:14px;padding:14px 18px;margin-bottom:10px}
  summary{cursor:pointer;font-weight:700;font-size:16px}
  details p{margin:10px 0 0;color:${p.inkSub}}
  footer{margin-top:56px;padding-top:20px;border-top:1px solid ${p.cardStroke};color:${p.inkMuted};font-size:13px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px}
  @media (max-width:780px){.hero{grid-template-columns:1fr}}
</style>
</head>
<body>
  <div class="wrap">
    <section class="hero">
      <div>
        <span class="badge">${esc(data.channelBadge)}</span>
        <h1>${esc(data.headline)}</h1>
        <p class="tagline">${esc(data.tagline)}</p>
        <a class="cta" href="#specs">${esc(data.landingCtaLabel)} →</a>
      </div>
      <div class="hero-art">${heroSvg}</div>
    </section>

    <h2>Key Highlights</h2>
    <div class="grid">
      ${data.features.map((f, i) => `<div class="card"><div class="num">0${i + 1}</div><div>${esc(f)}</div></div>`).join("")}
    </div>

    ${data.story.length ? `<h2>The Story</h2><div class="card story">${data.story.map((pText) => `<p>${esc(pText)}</p>`).join("")}</div>` : ""}

    <h2 id="specs">Technical Specifications</h2>
    <table>
      <tbody>
        ${data.specs.map((s) => `<tr><th>${esc(s.label)}</th><td>${esc(s.value)}</td></tr>`).join("")}
      </tbody>
    </table>

    ${data.faq.length ? `<h2>Frequently Asked Questions</h2>${data.faq.map((q) => `<details><summary>${esc(q.q)}</summary><p>${esc(q.a)}</p></details>`).join("")}` : ""}

    <footer>
      <span>${esc(data.brand)} · Prepared with Zhihu Bridge</span>
      <span>${esc(data.disclaimer)}</span>
    </footer>
  </div>
</body>
</html>`;
}

export interface SocialPost {
  id: string;
  platform: string;
  subtitle: string;
  content: string;
  tweets?: string[];
}

function clampTweet(text: string, max = 280): string {
  const clean = text.trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 1).replace(/\s+\S*$/, "") + "…";
}

export function buildSocialKit(data: PromoData): SocialPost[] {
  const hashtags = data.isRingProduct ? "#SmartRing #Hardware" : "#Hardware #ProductLaunch";
  const topFeats = data.features.slice(0, 3).map((f) => `• ${f}`).join("\n");
  const topSpecs = data.specs.slice(0, 4).map((s) => `${s.label}: ${s.value}`).join("\n");

  const tweets = [
    clampTweet(`1/4 ${data.headline}\n\n${data.tagline}`),
    clampTweet(`2/4 Key verified highlights:\n${topFeats || "• Derived directly from product documentation"}`),
    clampTweet(`3/4 Technical specs:\n${topSpecs || "• See full specification sheet"}`),
    clampTweet(`4/4 Launching transparently for the U.S. market. Ask us anything about the specs or testing details below. ${hashtags}`),
  ];

  const redditCommunity = data.isRingProduct ? "r/gadgets & r/smartring" : "r/gadgets";
  const redditPost = [
    `Title: ${data.headline} — Specs & Transparent Boundaries`,
    "",
    `Hey ${redditCommunity},`,
    "",
    data.story[0] ?? data.tagline,
    "",
    "**Highlights:**",
    ...data.features.map((f) => `- ${f}`),
    "",
    "**Key Specs:**",
    ...data.specs.map((s) => `- **${s.label}:** ${s.value}`),
    ...(data.faq.length ? ["", "**FAQ & Boundaries:**", ...data.faq.slice(0, 2).map((q) => `- *${q.q}* ${q.a}`)] : []),
    "",
    "Happy to answer technical questions from the product team!",
  ].join("\n");

  const ksBlurb = [
    data.headline,
    "",
    data.tagline,
    "",
    "Highlights:",
    ...data.features.map((f) => `✓ ${f}`),
    "",
    data.story.join("\n\n"),
  ].join("\n");

  return [
    { id: "x", platform: "X (Twitter) 首发串推 Thread", subtitle: "每条均严格 ≤ 280 字符，支持逐条一键复制", content: tweets.join("\n\n"), tweets },
    { id: "reddit", platform: "Reddit 科技社区首发帖", subtitle: `适配 ${redditCommunity} 工程克制语境`, content: redditPost },
    { id: "ks", platform: "众筹 / 邮件预热卡片", subtitle: "适合众筹预热页、EDM 与海外 KOL Brief", content: ksBlurb },
  ];
}
