import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/source-serif-4/400.css";
import "@fontsource/source-serif-4/600.css";
import kanshanStill from "./assets/liu-kanshan-still.png";
import kanshanWave from "./assets/liu-kanshan-wave.gif";
import { pickAdapter, zhihuQuestionAnswers, type Adapter } from "./lib/api";
import { buildBridgeRows } from "./lib/bridge";
import {
  ATTRIBUTION_LABEL, contentTypeLabel, DEFAULT_TARGET_LANGUAGE, evidenceSourceLabel, getTargetLanguage,
  isTargetLanguageCode, LEVEL_LABEL, levelHelpFor, MODE_LABEL, RISK_CATEGORY_LABEL, ROLE_LABEL, TARGET_LANGUAGES, TERM_KIND_LABEL, VERDICT_LABEL,
} from "./lib/labels";
import { copyGate, initialState, reducer, selectedVariant, testIsStale, variantText } from "./lib/state";
import type {
  AudienceMeta, CaseMeta, ComplianceRule, DraftTarget, Evidence, FlowbackDestination, Level, Mode, QuestionDraft, QuestionDraftRequest, Reader, RiskCategory, RunRequest, RunSnapshot,
  SourceSegment, SseEvent, TargetLanguageCode, TargetLanguageMeta, Term, TestResult, Variant,
} from "./lib/types";
import { closeAnyBridgePicker, createBridgePicker, type PickerOption } from "./bridgePicker";
import { mountZhihuCredentials, type ZhihuCredentialsHandle } from "./zhihuCredentials";
import { createZhihuTools, type ZhihuToolTab } from "./zhihuTools";
import "./connected.css";

const MAX_INPUT_CHARS = 400;
const GENERAL_AUDIENCE: AudienceMeta = {
  id: "general_overseas",
  label: "海外 · 通用目标受众",
  recommendedLevel: "plain",
  constraint: "面向目标市场的海外通用读者，用自然准确的目标语言传达核心信息，避免生硬直译和未经证实的宣传声称",
  personaSetId: null,
};

interface Layout {
  enter(): void;
  reset(): void;
  closeModal(): void;
  traceStart(): void;
  setStep(step: number): void;
  spotlight(ids: string[] | null): void;
  tlog(stage: string, detail: string, style?: "w" | "ok"): void;
  toast(message: string): void;
  gItem(item: { type: string; title: string; reason: string; code?: string; map?: string[]; ev?: number }, index: number, quick: boolean): string;
  install(handlers: {
    start(caseId: string | null, text?: string): void;
    setLevel(index: number): void;
    stepLevel?(delta: number): void;
    runTest(): void;
    reset(): void;
  }): void;
}

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const errorText = (e: unknown) => e instanceof Error ? e.message : "请求失败";
const wait = '<div class="waiting" aria-label="加载中"><i></i><i></i><i></i></div>';
const empty = (text: string) => '<div class="note-empty">' + esc(text) + '</div>';
const notice = (text: string) => '<div class="meta">' + esc(text) + '</div>';
const HIDDEN_NOTICE_RE = /候选条目|待人工审核|候选\s*[·,，]\s*待审核/;
const visibleNotices = (notices: string[]) => notices.filter((n) => n && !HIDDEN_NOTICE_RE.test(n));

function sourceLink(url: string, title: string) {
  try {
    const link = new URL(url);
    if (link.protocol === "https:" || link.protocol === "http:") {
      return '<a class="link-btn" href="' + esc(link.href) + '" target="_blank" rel="noopener noreferrer">' + esc(title) + '</a>';
    }
  } catch { /* Evidence may have no usable original URL. */ }
  return esc(title);
}

const AVATAR_COLORS = ["var(--brand)", "var(--violet)", "var(--teal)", "var(--amber)", "var(--green)"];

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function isInPanelView(node: HTMLElement): boolean {
  const scroller = node.closest<HTMLElement>(".panel-body");
  if (!scroller) return true;
  const sr = scroller.getBoundingClientRect();
  const nr = node.getBoundingClientRect();
  if (sr.height <= 0) return true;
  if (nr.height <= 0) return nr.top >= sr.top && nr.top <= sr.bottom;
  return nr.bottom > sr.top && nr.top < sr.bottom;
}

function settleOffscreen(container: HTMLElement, selector: string, cls = "settled") {
  container.querySelectorAll<HTMLElement>(selector).forEach((node) => {
    if (!isInPanelView(node)) {
      node.classList.add(cls);
      node.style.animationDelay = "";
    }
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted || prefersReducedMotion()) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function lcsKeep(a: string[], b: string[]): Set<number> {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const keep = new Set<number>();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { keep.add(j); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return keep;
}

async function typeInto(target: HTMLElement, text: string, signal?: AbortSignal): Promise<void> {
  if (prefersReducedMotion() || signal?.aborted || !text) {
    target.textContent = text;
    return;
  }
  const step = Math.max(3, Math.ceil(text.length / 42));
  for (let i = 0; i <= text.length; i += step) {
    if (signal?.aborted || !target.isConnected) return;
    target.textContent = text.slice(0, i);
    await sleep(16, signal);
  }
  if (!signal?.aborted && target.isConnected) target.textContent = text;
}

function countUpTally(target: HTMLElement | null, hit: number, valid: number, signal?: AbortSignal) {
  if (!target || valid <= 0) return;
  if (prefersReducedMotion() || signal?.aborted || typeof requestAnimationFrame !== "function") {
    target.textContent = hit + "/" + valid;
    return;
  }
  const t0 = performance.now();
  const duration = 700;
  const tick = (now: number) => {
    if (signal?.aborted || !target.isConnected) return;
    const p = Math.min(1, (now - t0) / duration);
    const eased = 1 - Math.pow(1 - p, 3);
    target.textContent = Math.round(hit * eased) + "/" + valid;
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function termClass(kind: Term["kind"] | undefined): string {
  if (kind === "claim") return "t-claim";
  if (kind === "context") return "t-jargon";
  if (kind === "scene") return "t-perf";
  return "t-culture";
}

function tagHtml(t: Term, index: number): string {
  return '<span class="tag ' + termClass(t.kind) + '" data-terms="' + index + '"><b>#' +
    esc(t.surface) + "</b><span>" + TERM_KIND_LABEL[t.kind] + "</span></span>";
}

function avatarColorFor(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

function highlightMisreadings(text: string, judgments: Reader["judgments"], keyPoints: { id: string }[]): string {
  if (!text) return "";
  const lower = text.toLowerCase();
  const matches: { start: number; end: number; label: string }[] = [];
  for (const j of judgments) {
    if (j.verdict === "hit") continue;
    const quote = j.quote.trim();
    if (quote.length < 3) continue;
    const idx = lower.indexOf(quote.toLowerCase());
    if (idx < 0) continue;
    const end = idx + quote.length;
    if (matches.some((m) => idx < m.end && end > m.start)) continue;
    const point = keyPoints.findIndex((p) => p.id === j.keyPointId) + 1;
    matches.push({ start: idx, end, label: VERDICT_LABEL[j.verdict] + (point > 0 ? " · P" + point : "") });
  }
  if (!matches.length) return esc(text);
  matches.sort((a, b) => a.start - b.start);
  let html = "";
  let pos = 0;
  for (const m of matches) {
    html += esc(text.slice(pos, m.start));
    html += '<mark class="mis">' + esc(text.slice(m.start, m.end)) + '</mark><span class="mis-tag">' + esc(m.label) + "</span>";
    pos = m.end;
  }
  return html + esc(text.slice(pos));
}

interface PersonaGroup {
  key: string;
  label: string;
  literal: Reader[];
  selected: Reader[];
}

function groupReaders(readers: Reader[]): PersonaGroup[] {
  const order: PersonaGroup[] = [];
  const byKey = new Map<string, PersonaGroup>();
  for (const r of readers) {
    const key = r.personaId || r.personaLabel;
    let group = byKey.get(key);
    if (!group) {
      group = { key, label: r.personaLabel, literal: [], selected: [] };
      byKey.set(key, group);
      order.push(group);
    }
    if (r.version === "literal") group.literal.push(r);
    else group.selected.push(r);
  }
  return order;
}

function evidenceCard(e: Evidence, index: number, terms: string, animate: boolean) {
  const title = esc(e.title ?? "来源未注明标题");
  const roleOrStatus = e.status === "rejected" ? "已拒绝" : ROLE_LABEL[e.role];
  const delay = animate ? Math.min(index, 5) * 260 : 0;
  return '<div class="ev" id="ev-' + index + '" data-terms="' + terms + '" style="--evc:var(--brand);animation-delay:' + delay + 'ms"><div class="ev-inner">' +
    '<div class="ev-face"><div class="ev-top"><i class="dot"></i><span class="lvl">' + evidenceSourceLabel(e) +
    '</span><span class="votes">' + esc(roleOrStatus) + '</span></div><div class="ev-title">' + title + '</div><div class="ev-sum">' +
    esc(e.summary) + '</div><div class="ev-author"><span>' + esc(e.author ?? contentTypeLabel(e)) + '</span><span class="ev-flip">翻转 ↻</span></div></div>' +
    '<div class="ev-face ev-back"><div class="ev-title">' + title + '</div><div class="ev-sum">' +
    '<div class="ev-scope"><b>能支撑 · 可参考的范围</b>' + esc(e.supports) + '</div>' +
    '<div class="ev-scope"><b>不能支撑 · 不能据此下的结论</b>' + esc(e.limits) + '</div></div><div class="ev-author">' +
    ROLE_LABEL[e.role] + " · " + sourceLink(e.url, "打开原文 ↗") +
    '<span class="ev-flip">返回 ↺</span></div></div></div></div>';
}

export function mountConnected(layout: Layout) {
  const query = new URLSearchParams(location.search);
  const allowStub = query.get("dev") === "1" || query.get("offline") === "1";
  document.body.classList.add("connected");
  document.title = "Zhihu Bridge · 知乎跨文化认知转译舱";
  document.querySelector("#brand small")!.textContent = "知乎跨文化认知转译舱";
  const hero = el("hero");
  const intro = document.createElement("div");
  intro.className = "home-intro";
  const introCopy = document.createElement("div");
  introCopy.className = "home-intro-copy";
  introCopy.append(...hero.querySelectorAll(":scope > .eyebrow, :scope > h1, :scope > .lead"));
  const stage = document.createElement("div");
  stage.className = "home-mascot";
  const greetButton = document.createElement("button");
  greetButton.type = "button";
  greetButton.className = "home-mascot-button";
  greetButton.setAttribute("aria-label", "和刘看山打招呼");
  const greeting = document.createElement("span");
  greeting.className = "home-mascot-greeting";
  greeting.setAttribute("role", "status");
  const mascot = new Image(320, 320);
  mascot.alt = "";
  let waveId = 0;
  let waveTimer: number | undefined;
  let greetingTimer: number | undefined;
  async function playWave() {
    const id = ++waveId;
    window.clearTimeout(waveTimer);
    if (prefersReducedMotion()) {
      mascot.src = kanshanStill;
      return;
    }
    mascot.src = kanshanWave;
    try {
      await mascot.decode();
    } catch {
      if (id === waveId) mascot.src = kanshanStill;
      return;
    }
    if (id === waveId) waveTimer = window.setTimeout(() => { mascot.src = kanshanStill; }, 4000);
  }

  greetButton.addEventListener("click", () => {
    greeting.textContent = "嗨，我是刘看山！";
    window.clearTimeout(greetingTimer);
    greetingTimer = window.setTimeout(() => { greeting.textContent = ""; }, 4000);
    void playWave();
  });
  greetButton.append(mascot);
  stage.append(greetButton, greeting);
  void playWave();
  intro.append(introCopy, stage);
  hero.prepend(intro);
  let adapter: Adapter | undefined;
  let credentials: ZhihuCredentialsHandle | undefined;
  let zhihuTools: ReturnType<typeof createZhihuTools> | undefined;
  let useGlobalSearch = false;
  let selectedKbIds: string[] = [];
  let selectedKbLabels: Record<string, string> = {};
  let activeDraftSource: QuestionDraftRequest["source"] | null = null;
  let activeDraftTarget: DraftTarget = "question";
  let cases: CaseMeta[] = [];
  let current = initialState;
  let serial = 0;
  let runController: AbortController | undefined;
  let revealController: AbortController | undefined;
  let testRevealController: AbortController | undefined;
  let draftController: AbortController | undefined;
  let stageChain: Promise<void> = Promise.resolve();
  let termsPresented = false;
  let evidencePresented = false;
  let readyFinalized = false;
  let prevWords: string[] = [];
  let request: RunRequest | undefined;
  let enabledPoints = new Set<string>();
  let draftAction: QuestionDraftRequest["source"][] = [];
  let sourceMarkup = "";
  let evidenceMarkup = "";
  const input = el<HTMLTextAreaElement>("input");
  const startBtn = el<HTMLButtonElement>("startBtn");
  const slider = el<HTMLInputElement>("lvl");
  const workbench = el("wb");
  const draftDialog = el("modal");
  draftDialog.inert = true;
  draftDialog.setAttribute("role", "dialog");
  draftDialog.setAttribute("aria-label", "回流知乎");
  const languageOptions: PickerOption[] = TARGET_LANGUAGES.map((l) => ({
    value: l.code,
    label: l.label,
    sublabel: l.nativeName,
    description: l.markets,
    rtl: l.rtl,
  }));
  const audienceOptionsOf = (list: AudienceMeta[]): PickerOption[] =>
    list.map((a) => ({
      value: a.id,
      label: a.label,
      description: a.constraint,
    }));

  const queryLang = query.get("lang");
  const initialLang: TargetLanguageCode = isTargetLanguageCode(queryLang)
    ? queryLang
    : DEFAULT_TARGET_LANGUAGE;

  input.insertAdjacentHTML(
    "afterend",
    '<div class="composer-count-row"><span id="charCount" class="char-count" aria-live="polite">0 / ' + MAX_INPUT_CHARS + "</span></div>" +
    '<div class="composer-meta"><div class="home-controls" id="homeControls"></div>' +
    '<div class="home-zhihu-bar" id="homeZhihuBar" hidden>' +
      '<span class="hz-label">知乎增强</span>' +
      '<button type="button" class="hz-chip" id="toggleGlobalSearch" aria-pressed="false" title="开启后在转译循证中自动补充全网搜索对照资料">全网对照</button>' +
      '<button type="button" class="hz-chip" id="openKbPicker" data-open-zt="knowledge" title="关联知乎知识库参与术语与设定 RAG 检索">关联知识库</button>' +
      '<button type="button" class="hz-chip" id="openZhidaHome" data-open-zt="zhida" title="用知乎直答提前追问文化背景或术语差异">知乎直答</button>' +
      '<button type="button" class="hz-chip" id="openCreatorHome" data-open-zt="creator" title="导入本人知乎回答/文章/想法全文到转译舱（需个人密钥）">导入本人内容</button>' +
    "</div></div>",
  );
  const homeControls = el("homeControls");
  const syncHomeZhihuBar = () => {
    const gBtn = document.getElementById("toggleGlobalSearch");
    if (gBtn) {
      gBtn.classList.toggle("on", useGlobalSearch);
      gBtn.setAttribute("aria-pressed", String(useGlobalSearch));
      gBtn.textContent = useGlobalSearch ? "✓ 全网对照已开" : "全网对照";
    }
    const kbBtn = document.getElementById("openKbPicker");
    if (kbBtn) {
      kbBtn.classList.toggle("on", selectedKbIds.length > 0);
      if (selectedKbIds.length > 0) {
        const first = selectedKbLabels[selectedKbIds[0]];
        kbBtn.textContent = selectedKbIds.length === 1 && first
          ? "知识库：" + first.slice(0, 10)
          : "已关联 " + selectedKbIds.length + " 个知识库";
      } else {
        kbBtn.textContent = "关联知识库";
      }
    }
  };
  const homeLang = createBridgePicker({
    id: "homeLang",
    ariaLabel: "目标转译语言",
    variant: "card",
    layout: "grid",
    icon: "globe",
    kicker: "目标语言",
    popoverTitle: "选择目标出海语言",
    popoverHint: TARGET_LANGUAGES.length + " 种主流出海语言",
    onChange(val) {
      const code = isTargetLanguageCode(val) ? val : DEFAULT_TARGET_LANGUAGE;
      langSelect.setValue(code);
      updateUrl();
    },
  });
  homeLang.setOptions(languageOptions, initialLang);

  const homeAudience = createBridgePicker({
    id: "homeAudience",
    ariaLabel: "目标受众",
    variant: "card",
    layout: "list",
    icon: "users",
    kicker: "目标受众",
    popoverTitle: "选择目标受众与语境",
    popoverHint: "决定术语保留度与表达风格",
    align: "right",
  });
  homeAudience.setOptions(audienceOptionsOf([GENERAL_AUDIENCE]), GENERAL_AUDIENCE.id);
  homeControls.append(homeLang.element, homeAudience.element);

  const charCount = el("charCount");
  const syncHomeChips = () => {
    const trimmed = input.value.trim();
    document.querySelectorAll<HTMLButtonElement>("#heroChips [data-fill]").forEach((btn) => {
      const c = cases.find((item) => item.caseId === "case_" + btn.dataset.fill);
      btn.classList.toggle("on", Boolean(c && trimmed && c.text.trim() === trimmed));
    });
  };
  const updateComposerMeta = () => {
    const count = [...input.value.trim()].length;
    const over = count > MAX_INPUT_CHARS;
    charCount.textContent = count + " / " + MAX_INPUT_CHARS + (over ? "（超出上限）" : "");
    charCount.classList.toggle("over", over);
    syncHomeChips();
    if (adapter) startBtn.disabled = over;
  };
  input.addEventListener("input", updateComposerMeta);
  updateComposerMeta();
  const stops = el("stops");
  const strategy = slider.closest<HTMLElement>(".strategy")!;
  const status = document.querySelector<HTMLElement>(".livechip")!;
  const homeStatus = document.querySelector<HTMLElement>(".hero-foot span:last-child")!;
  homeStatus.setAttribute("role", "status");
  const brand = el("brand");
  brand.setAttribute("role", "button");
  brand.setAttribute("tabindex", "0");
  brand.setAttribute("aria-label", "返回首页");
  const backHomeBtn = document.createElement("button");
  backHomeBtn.type = "button";
  backHomeBtn.id = "backHomeBtn";
  backHomeBtn.className = "tool work-only back-home-btn";
  backHomeBtn.title = "返回首页重新输入文案（快捷键 R）";
  backHomeBtn.innerHTML = '<span aria-hidden="true">←</span> 返回首页 <kbd>R</kbd>';
  el("caseSeg").before(backHomeBtn);
  el("tags").insertAdjacentHTML(
    "afterend",
    '<div class="source-home-bar"><button type="button" class="link-btn" id="sourceBackHome">← 返回首页，输入新文案或更换案例</button></div>',
  );
  const langSelect = createBridgePicker({
    id: "workLang",
    ariaLabel: "目标语言",
    variant: "compact",
    layout: "grid",
    icon: "globe",
    kicker: "目标语言",
    popoverTitle: "切换目标出海语言",
    popoverHint: TARGET_LANGUAGES.length + " 种主流出海语言",
    align: "right",
    triggerClass: "tool work-only lang-select",
    title: "切换目标出海语言",
    onChange(val) {
      const code = isTargetLanguageCode(val) ? val : DEFAULT_TARGET_LANGUAGE;
      homeLang.setValue(code);
      if (request) void startRequest({ ...request, targetLanguage: code });
    },
  });
  langSelect.setOptions(languageOptions, initialLang);

  const workAudience = createBridgePicker({
    id: "workAudience",
    ariaLabel: "目标受众",
    variant: "compact",
    layout: "list",
    icon: "users",
    kicker: "目标受众",
    popoverTitle: "切换目标受众与语境",
    popoverHint: "重新按该受众偏好生成译稿",
    align: "right",
    triggerClass: "tool work-only aud-select",
    title: "切换目标受众",
    onChange(val) {
      homeAudience.setValue(val);
      if (request) void startRequest({ ...request, audienceId: val });
    },
  });
  workAudience.setOptions(audienceOptionsOf([GENERAL_AUDIENCE]), GENERAL_AUDIENCE.id);
  const workZhihuToolsBtn = document.createElement("button");
  workZhihuToolsBtn.type = "button";
  workZhihuToolsBtn.id = "workZhihuTools";
  workZhihuToolsBtn.className = "tool work-only zhihu-tools-btn";
  workZhihuToolsBtn.title = "打开知乎开放平台能力工作台（全网对照 / 直答 / 知识库 / 本人创作 / 额度）";
  workZhihuToolsBtn.dataset.openZt = "quota";
  workZhihuToolsBtn.textContent = "知乎能力";
  status.before(langSelect.element, workAudience.element, workZhihuToolsBtn);
  for (const id of ["tDuel", "tSheet"]) el(id).style.setProperty("display", "none", "important");
  const demoEvidence = document.querySelector<HTMLElement>("#pEvidence .meta")!;
  demoEvidence.textContent = "点击卡片翻转";
  el("evidence").insertAdjacentHTML("beforebegin",
    '<div class="evidence-tools" id="evidenceTools" hidden>' +
      '<button type="button" class="ev-tool-btn" data-open-zt="global">全网对照</button>' +
      '<button type="button" class="ev-tool-btn" data-open-zt="zhida">直答追问</button>' +
      '<button type="button" class="ev-tool-btn" data-open-zt="knowledge">知识库 RAG</button>' +
      '<button type="button" class="ev-tool-btn" data-open-zt="quota">能力与额度</button>' +
    '</div>' +
    '<details class="guide evidence-guide"><summary>如何读证据卡？</summary>' +
    '<p>能支撑是这条资料可以帮助解释的含义或译法。不能支撑是证据到不了的结论。例如，天气讨论可以解释「回南天」的潮湿语境，产品功效需要另外的证明。</p></details>');
  el("guard").insertAdjacentHTML("beforebegin", '<div class="guard-bar" id="guardBar"></div>');
  el("guardSum").insertAdjacentHTML("beforebegin", '<button type="button" class="guard-db-btn" id="openRulesDb" title="查看本地法律法规与风俗习惯风险数据库">风险规则库</button>');
  el("guardSum").className = "meta guard-gate";
  el("pDeliver").insertAdjacentHTML("afterend", '<section class="panel" id="pCommunity" aria-labelledby="communityHeading">' +
    '<div class="panel-h"><span class="step-no">07</span><h3 id="communityHeading">回流知乎</h3></div>' +
    '<ol class="flow-path"><li>选取复述误解或粘贴海外评论，按需选择反哺体裁。</li>' +
    '<li>检索已有讨论与回答摘要，生成回答 / 提问 / 专栏文章 / 想法草稿。</li>' +
    '<li>一键复制并直达对应知乎板块，人工审核后发布。</li></ol>' +
    '<div class="run-row" id="flowActions"></div>' +
    '<div class="flow-targets" id="flowTargets" aria-label="按需选择反哺知乎板块"></div></section>');
  el("delTitle").insertAdjacentHTML("afterend", '<span class="meta deliver-gate" id="deliverGate"></span>');
  workbench.querySelectorAll<HTMLElement>(".panel").forEach((panel) => {
    const header = panel.querySelector<HTMLElement>(":scope > .panel-h");
    if (!header || panel.querySelector(":scope > .panel-body")) return;
    const body = document.createElement("div");
    body.className = "panel-body";
    while (header.nextSibling) body.appendChild(header.nextSibling);
    panel.appendChild(body);
  });
  const resetPanelScroll = () => {
    workbench.querySelectorAll<HTMLElement>(".panel-body").forEach((body) => {
      body.scrollTop = 0;
    });
  };
  const statusText = (mode: Mode) => MODE_LABEL[mode] + (adapter?.kind === "offline" ? " · 离线包" : "");
  const setStatus = (text: string) => { status.innerHTML = "<i></i>" + esc(text); };
  const activeCase = () => cases.find((c) => c.caseId === request?.caseId);
  const activeLang = (): TargetLanguageMeta =>
    getTargetLanguage(current.run.snapshot?.targetLanguage ?? current.run.targetLanguage ?? request?.targetLanguage ?? homeLang.value);
  const availableLevels = () => (current.run.snapshot?.variants ?? []).map((v) => v.level).filter((level) => level !== "literal");
  const termsFor = (ids: string[]) => current.run.terms.flatMap((t, i) => ids.includes(t.id) ? [i] : []).join(" ");
  const invalidateDraft = () => {
    draftController?.abort();
    draftDialog.inert = true;
    layout.closeModal();
  };

  function updateUrl() {
    const q = new URLSearchParams();
    if (query.get("offline") === "1") q.set("offline", "1");
    else if (query.get("dev") === "1") q.set("dev", "1");
    if (request?.caseId) {
      q.set("case", request.caseId);
      q.set("aud", request.audienceId);
      if (current.run.status === "ready" && current.level) q.set("level", current.level);
    }
    const langCode = request?.targetLanguage ?? (isTargetLanguageCode(homeLang.value) ? homeLang.value : DEFAULT_TARGET_LANGUAGE);
    if (langCode !== DEFAULT_TARGET_LANGUAGE) q.set("lang", langCode);
    history.replaceState(null, "", q.size ? "?" + q : location.pathname);
  }

  function buildSourceMarkup(sourceSegments: SourceSegment[], terms: Term[], highlightAll: boolean) {
    const idxOf = (id: string) => terms.findIndex((t) => t.id === id);
    const sourceHtml = sourceSegments.map((s) => {
      if (!s.termId) return esc(s.text);
      const ti = idxOf(s.termId);
      const cls = termClass(terms[ti]?.kind);
      return '<span class="src-term ' + cls + (highlightAll ? " on" : "") + '" data-terms="' + (ti >= 0 ? ti : "") + '">' + esc(s.text) + "</span>";
    }).join("");
    const tagsHtml = highlightAll ? terms.map((t, i) => tagHtml(t, i)).join("") : "";
    return { sourceHtml, tagsHtml, combined: sourceHtml + "\0" + tagsHtml + "\0" + (highlightAll ? "1" : "0") };
  }

  function renderSource(
    sourceSegments: SourceSegment[] = current.run.sourceSegments,
    terms: Term[] = current.run.terms,
    highlightAll = true,
  ) {
    const { sourceHtml, tagsHtml, combined } = buildSourceMarkup(sourceSegments, terms, highlightAll);
    if (combined !== sourceMarkup) {
      el("sourceText").innerHTML = sourceHtml;
      el("tags").innerHTML = tagsHtml;
      sourceMarkup = combined;
    }
  }

  function renderEvidence(
    evidence: Evidence[] = current.run.evidence,
    notices: string[] = current.run.notices,
    terms: Term[] = current.run.terms,
    animate = true,
  ) {
    const termsIdx = (ids: string[]) => terms.flatMap((t, i) => ids.includes(t.id) ? [i] : []).join(" ");
    const key = evidence.length
      ? evidence.map((e) => [e.id, e.status, e.title ?? "", e.summary, termsIdx(e.termIds)].join("\u0001")).join("\0")
      : "__empty__";
    if (key !== evidenceMarkup) {
      const cards = evidence.length
        ? evidence.map((e, i) => evidenceCard(e, i, termsIdx(e.termIds), animate)).join("")
        : '<div class="ev-none">没有可用证据。</div>';
      el("evidence").innerHTML = cards + '<div id="evidenceNotices"></div>';
      if (animate) settleOffscreen(el("evidence"), ".ev");
      evidenceMarkup = key;
    }
    el("evidenceNotices").innerHTML = visibleNotices(notices).map(notice).join("");
  }

  function renderCommunity(animate = false) {
    const ready = current.run.status === "ready";
    const fromTest = ready && draftAction.length
      ? '<button class="btn btn-primary" data-service-misreading="0">用本次误解生成草稿</button>' : "";
    const actions = el("flowActions");
    actions.innerHTML = fromTest + '<button class="btn btn-ghost" id="manualDraft"' +
      (ready ? "" : " disabled") + ">粘贴海外评论</button>";
    const targetsEl = document.getElementById("flowTargets");
    if (targetsEl) {
      const targetItems: Array<{ id: DraftTarget; label: string; hint: string }> = [
        { id: "answer", label: "写回答", hint: "到已有问题补充海外视角" },
        { id: "question", label: "提问题", hint: "发起新的跨文化求解问题" },
        { id: "article", label: "发文章", hint: "在知乎专栏写深度复盘" },
        { id: "pin", label: "发想法", hint: "分享轻量跨文化速记" },
      ];
      targetsEl.innerHTML =
        '<span class="flow-targets-lbl">直达板块：</span>' +
        targetItems.map((it) =>
          '<button type="button" class="flow-target-chip" data-flow-quick="' + it.id + '" title="' + esc(it.hint) + '"' +
          (ready ? "" : " disabled") + ">" + esc(it.label) + " ↗</button>",
        ).join("");
    }
    actions.classList.remove("panel-body-pop");
    if (animate && !prefersReducedMotion()) {
      actions.style.setProperty("--reveal-delay", "180ms");
      void actions.offsetWidth;
      actions.classList.add("panel-body-pop");
    }
  }

  function deliveryMeta(caseId: string | null | undefined, lang: TargetLanguageMeta): {
    title: string;
    format: string;
    isSubtitle: boolean;
    theme?: "xianxia" | "hardware" | "herbal";
  } {
    if (caseId === "case_a") return { title: "海外交付 · " + lang.label + "双语字幕稿", format: lang.label + "字幕", isSubtitle: true, theme: "xianxia" };
    if (caseId === "case_b") return { title: "海外交付 · " + lang.label + "众筹卖点文案", format: lang.label + "众筹文案", isSubtitle: false, theme: "hardware" };
    if (caseId === "case_c") return { title: "海外交付 · " + lang.label + "商品页文案", format: lang.label + "商品文案", isSubtitle: false, theme: "herbal" };
    return { title: "海外交付 · " + lang.label + "终稿交付", format: lang.label + "终稿", isSubtitle: false };
  }

  function wrapSubtitleLine(text: string, lang: TargetLanguageMeta): string {
    const clean = text.trim().replace(/\s+/g, " ");
    const maxChars = lang.subtitleSingleMax;
    if ([...clean].length <= maxChars) return clean;
    const chars = [...clean];
    const mid = Math.floor(chars.length / 2);
    let split = -1;
    let best = Infinity;
    if (lang.cjkLike) {
      for (let i = 1; i < chars.length - 1; i++) {
        if (/[、。，！？,!? ]/.test(chars[i])) {
          const dist = Math.abs(i - mid);
          if (dist < best) { best = dist; split = i + 1; }
        }
      }
      if (split <= 0) split = mid;
      return chars.slice(0, split).join("").trim() + "\n" + chars.slice(split).join("").trim();
    }
    for (let i = 0; i < clean.length; i++) {
      if (clean[i] === " ") {
        const dist = Math.abs(i - mid);
        if (dist < best) { best = dist; split = i; }
      }
    }
    return split > 0 ? clean.slice(0, split) + "\n" + clean.slice(split + 1) : clean;
  }

  function buildSrtSnippet(targetText: string, zhText: string, lang: TargetLanguageMeta): string {
    const trimmed = targetText.trim();
    const sec = lang.cjkLike
      ? Math.max(3, Math.min(8, Math.ceil([...trimmed].length / 6.5)))
      : Math.max(3, Math.min(8, Math.ceil((trimmed ? trimmed.split(/\s+/).length : 0) / 2.8)));
    const endTime = "00:00:" + String(sec).padStart(2, "0") + ",000";
    const lines = [wrapSubtitleLine(targetText, lang)];
    if (zhText.trim()) lines.push(zhText.trim());
    return "1\n00:00:00,000 --> " + endTime + "\n" + lines.join("\n") + "\n";
  }

  function renderDelivery(animate = false) {
    const gate = copyGate(current);
    const lang = activeLang();
    const meta = deliveryMeta(request?.caseId, lang);
    const sourceRaw = current.run.sourceSegments.map((s) => s.text).join("").trim();
    const variant = selectedVariant(current);
    const snap = current.run.snapshot;
    el("delTitle").textContent = meta.title;
    const gateBadge = el("deliverGate");
    if (current.run.status === "running") {
      gateBadge.textContent = "生成中";
      gateBadge.className = "meta deliver-gate is-wait";
    } else if (gate.enabled) {
      gateBadge.textContent = "✓ 守门通过 · 可交付";
      gateBadge.className = "meta deliver-gate is-ok";
    } else {
      gateBadge.textContent = "已锁定";
      gateBadge.className = "meta deliver-gate is-lock";
    }

    const wrap = animate && !prefersReducedMotion() ? '<div class="panel-body-pop" style="--reveal-delay:90ms">' : "<div>";
    if (current.run.status === "running") {
      el("deliver").innerHTML = wrap + wait + "</div>";
      return;
    }

    if (!gate.enabled) {
      const noExport = current.run.status === "ready" && !snap?.variants.some((v) => v.exportState === "exportable");
      const retry = noExport ? '<button class="btn btn-ghost" id="retryRun">重新生成</button>' : "";
      const hint = variant?.exportState === "needs_data"
        ? "当前档位包含待补充材料，请先在「04 合规守门」补齐依据，或切换到其他可交付档位。"
        : variant?.exportState === "draft"
          ? "当前档位尚未通过「04 合规守门」核验，请先查看拦截原因或切换档位。"
          : "等待转译完成并通过合规守门后，将在此解锁终稿复制。";
      el("deliver").innerHTML = wrap +
        '<div class="deliver-lock"><div class="deliver-lock-h">' + esc(gate.reason) + "</div>" +
        '<p class="deliver-lock-p">' + esc(hint) + "</p>" +
        '<div class="deliver-actions"><button class="btn btn-primary" id="copyFinal" disabled>复制' + esc(lang.label) + "终稿</button>" + retry + "</div></div></div>";
      return;
    }

    const finalText = gate.text.trim();
    const words = finalText ? finalText.split(/\s+/).length : 0;
    const chars = [...finalText].length;
    const subtitleChip = meta.isSubtitle
      ? (chars <= lang.subtitleSingleMax
        ? '<span class="d-chip ok">单行字幕适配 · ' + chars + " 字符</span>"
        : chars <= lang.subtitleDoubleMax
          ? '<span class="d-chip">建议双行字幕 · ' + chars + " 字符</span>"
          : '<span class="d-chip warn">字幕偏长 · ' + chars + " 字符</span>")
      : (lang.cjkLike
        ? '<span class="d-chip">' + chars + " 字符</span>"
        : '<span class="d-chip">' + words + " 词 · " + chars + " 字符</span>");
    const chips = [
      '<span class="d-chip hi">' + esc(lang.label + " · " + lang.nativeName) + "</span>",
      variant ? '<span class="d-chip hi">' + esc(LEVEL_LABEL[variant.level]) + "</span>" : "",
      current.run.audienceLabel ? '<span class="d-chip">' + esc(current.run.audienceLabel) + "</span>" : "",
      subtitleChip,
    ].filter(Boolean).join("");
    const deliveryTheme = meta.theme ? ' data-delivery-theme="' + meta.theme + '"' : "";
    const deliveryBox = meta.isSubtitle
      ? '<div class="deliver-box deliver-subtitles"' + deliveryTheme + ' role="group" aria-label="双语字幕预览">'
      : '<div class="deliver-box"' + deliveryTheme + ">";
    const targetLabel = meta.isSubtitle ? "" : '<span class="deliver-lbl">' + esc(meta.format) + "</span>";
    const sourceLabel = meta.isSubtitle ? "" : '<span class="deliver-lbl">原文</span>';
    const sourceBlock = sourceRaw
      ? '<div class="deliver-src">' + sourceLabel + '<p lang="zh-CN">' + esc(sourceRaw) + "</p></div>"
      : "";
    const srtBtn = meta.isSubtitle
      ? '<button class="btn btn-ghost" id="copySrt">复制 SRT 字幕</button>'
      : "";
    el("deliver").innerHTML = wrap +
      '<div class="deliver-meta">' + chips + "</div>" +
      deliveryBox +
        '<div class="deliver-en">' + targetLabel + '<p lang="' + esc(lang.bcp47) + '" dir="' + (lang.rtl ? "rtl" : "ltr") + '">' + esc(finalText) + "</p></div>" +
        sourceBlock +
      "</div>" +
      '<div class="deliver-actions">' +
        '<button class="btn btn-primary" id="copyFinal">复制' + esc(lang.label) + "终稿</button>" +
        '<button class="btn btn-ghost" id="copyBilingual">复制双语对照</button>' +
        srtBtn +
      "</div></div>";
  }

  function renderStrategyControls(variant: Variant, snap: RunSnapshot) {
    const levels = availableLevels();
    slider.disabled = levels.length <= 1;
    slider.hidden = slider.disabled;
    slider.max = String(Math.max(2, levels.length));
    const selectedIndex = levels.findIndex((level) => level === variant.level);
    slider.value = String(selectedIndex + 1);
    slider.setAttribute("aria-label", "转译策略，从通俗表达到保留术语");
    slider.setAttribute("aria-valuetext", LEVEL_LABEL[variant.level]);
    strategy.style.setProperty("--strategy-count", String(levels.length));
    strategy.style.setProperty("--strategy-inset", 50 / levels.length + "%");
    const order = levels.join(" ");
    if (stops.dataset.levels !== order || !stops.children.length) {
      stops.dataset.levels = order;
      stops.innerHTML = levels.map((level, i) => '<button data-l="' + (i + 1) + '">' + LEVEL_LABEL[level] + "</button>").join("");
    }
    Array.from(stops.children).forEach((button, i) => {
      button.classList.toggle("on", i === selectedIndex);
      button.setAttribute("aria-pressed", String(i === selectedIndex));
    });
    const lang = activeLang();
    el("lvlName").textContent = LEVEL_LABEL[variant.level];
    el("lvlFit").textContent = levelHelpFor(variant.level, lang);
    el("lvlName").title = variant.level === snap.recommendedLevel ? snap.recommendationReason : "";
    el("txLvl").textContent = "· " + lang.label + " · " + LEVEL_LABEL[variant.level] + " · " + statusText(snap.mode);
  }

  function renderBridge(variant: Variant, snap: RunSnapshot, mode: "draw" | "update" | "instant") {
    const lang = activeLang();
    const bridgeRows = buildBridgeRows(variant, snap.terms, snap.decisions, snap.evidence);
    const bridgeEl = el("bridge");
    if (!bridgeRows.length) {
      bridgeEl.innerHTML = empty("当前结果没有可对齐的认知壁垒。");
      return;
    }
    const rightHtmlFor = (row: ReturnType<typeof buildBridgeRows>[number]) =>
      row.removed
        ? '<span class="b-blocked"><s>' + esc(row.removedSpan || row.term.surface) + "</s><small>已由声称守门移除</small></span>"
        : esc(row.landing || "—");

    if (mode === "update") {
      const existing = bridgeEl.querySelectorAll<HTMLElement>(".b-row");
      if (existing.length === bridgeRows.length) {
        bridgeRows.forEach((row, i) => {
          const node = existing[i];
          node.style.setProperty("--arc", "var(--" + row.color + ")");
          const path = node.querySelector("path");
          if (path) path.setAttribute("class", row.dashed ? "dashed" : "");
          const mk = node.querySelector(".mk");
          if (mk) mk.textContent = row.marker;
          const en = node.querySelector<HTMLElement>(".b-en");
          const html = rightHtmlFor(row);
          if (en && en.innerHTML !== html) {
            en.innerHTML = html;
            if (!prefersReducedMotion()) {
              en.classList.remove("swap");
              void en.offsetWidth;
              en.classList.add("swap");
            }
          }
        });
        return;
      }
    }

    const draw = mode === "draw" && !prefersReducedMotion();
    bridgeEl.innerHTML = bridgeRows.map((row, i) => {
      const stepDelay = Math.min(i, 5) * 180;
      const svgAttrs = draw ? ' class="draw" style="animation-delay:' + stepDelay + 'ms"' : "";
      const mkStyle = draw ? ' style="animation-delay:' + (700 + stepDelay) + 'ms"' : "";
      return '<div class="b-row' + (draw ? "" : " settled") + '" data-terms="' + i + '" style="--arc:var(--' + row.color + ')">' +
        '<div class="b-zh" data-terms="' + i + '">' + esc(row.term.surface) + "</div>" +
        '<div class="b-arc" aria-hidden="true">' +
          '<svg viewBox="0 0 100 60" preserveAspectRatio="none"' + svgAttrs + ">" +
            '<path class="' + (row.dashed ? "dashed" : "") + '" d="M0,51 C28,6 72,6 100,51"/>' +
          "</svg>" +
          '<i class="end l"></i><i class="end r"></i>' +
          '<span class="mk"' + mkStyle + ">" + row.marker + "</span>" +
        "</div>" +
        '<div class="b-en" data-terms="' + i + '" lang="' + esc(lang.bcp47) + '" dir="' + (lang.rtl ? "rtl" : "ltr") + '">' + rightHtmlFor(row) + "</div>" +
      "</div>";
    }).join("");
  }

  function renderTranslation(variant: Variant, mode: "type" | "diff" | "instant") {
    const lang = activeLang();
    const words: string[] = [];
    variant.segments.forEach((s) => {
      s.text.split(/(\s+)/).forEach((p) => {
        if (p && !/^\s+$/.test(p)) words.push(p);
      });
    });
    const effective = prefersReducedMotion() ? "instant" : mode;
    const keep = effective === "diff" ? lcsKeep(prevWords, words) : new Set<number>();
    let wi = 0;
    let fresh = 0;
    const html = variant.segments.map((s) => {
      let inner = "";
      s.text.split(/(\s+)/).forEach((p) => {
        if (!p) return;
        if (/^\s+$/.test(p)) { inner += p; return; }
        const isNew = effective === "type" || (effective === "diff" && !keep.has(wi));
        if (isNew) {
          const delay = Math.min(fresh++, 40) * (effective === "type" ? 45 : 28);
          inner += '<span class="w fresh" style="animation-delay:' + delay + 'ms">' + esc(p) + "</span>";
        } else {
          inner += '<span class="w">' + esc(p) + "</span>";
        }
        wi++;
      });
      return s.termIds.length
        ? '<span class="tterm" data-terms="' + termsFor(s.termIds) + '">' + inner + "</span>"
        : inner;
    }).join("");
    const txEl = el("txText");
    txEl.setAttribute("lang", lang.bcp47);
    txEl.setAttribute("dir", lang.rtl ? "rtl" : "ltr");
    txEl.innerHTML = html;
    prevWords = words;
  }

  function renderAnnos(variant: Variant, snap: RunSnapshot, animate: boolean) {
    const lang = activeLang();
    const anim = animate && !prefersReducedMotion();
    const decisions = snap.decisions.filter((d) => d.levels.includes(variant.level)).map((d, i) =>
      '<div class="anno' + (anim ? "" : " settled") + '" data-terms="' + termsFor([d.termId]) + '"' +
      (anim ? ' style="animation-delay:' + Math.min(i, 6) * 100 + 'ms"' : "") +
      "><h4>" + esc(d.id + " · " + d.title) + '</h4><div class="zh">' +
      esc(d.choice) + "</div><p>" + esc(d.rationale) + '</p><div class="src">归因：' + ATTRIBUTION_LABEL[d.attribution] +
      " · 依据 " + esc(d.evidenceIds.join("、") || "未引用") + "</div></div>");
    const notes = variant.notes.map((note, i) =>
      '<div class="anno' + (anim ? "" : " settled") + '"' +
      (anim ? ' style="animation-delay:' + Math.min(decisions.length + i, 6) * 100 + 'ms"' : "") +
      "><p>" + esc(note.text) + '</p><div class="src">' +
      esc(note.evidenceIds.join(" · ")) + "</div></div>");
    el("annos").innerHTML = [...decisions, ...notes, ...visibleNotices(snap.notices).map(notice)].join("");
    if (anim) settleOffscreen(el("annos"), ".anno");
    el("literal").innerHTML = "<b>" + esc(lang.label) + '机翻直译（对照）</b><span lang="' + esc(lang.bcp47) + '" dir="' + (lang.rtl ? "rtl" : "ltr") + '">' + esc(variantText(snap.variants.find((v) => v.level === "literal"))) + "</span>";
  }

  function cleanGuardSpan(span: string, title: string): string {
    const trimmed = span.trim();
    if (!trimmed) return "";
    const parts = trimmed.split(/\s*→\s*/);
    if (parts.length === 2 && parts[0].trim() === title.trim() && parts[1].trim()) {
      return parts[1].trim();
    }
    return trimmed;
  }

  function renderGuard(variant: Variant, snap: RunSnapshot, quick: boolean) {
    const fast = quick || prefersReducedMotion();
    const lang = activeLang();
    const hasDetFidelity = variant.checks.some((c) => c.kind === "fidelity" && c.id.startsWith("F-"));
    const checks = variant.checks.filter(
      (c) => !(hasDetFidelity && /^S\d+$/.test(c.id) && c.status === "pass"),
    );
    const nb = checks.filter((c) => c.status === "fail").length;
    const nw = checks.filter((c) => c.status === "warn").length;
    const np = checks.filter((c) => c.status === "pass").length;
    const fidelityChecks = checks.filter((c) => c.kind === "fidelity");
    const fidelityPass = fidelityChecks.filter((c) => c.status === "pass").length;
    const claimChecks = checks.filter((c) => c.kind === "claim");
    const legalChecks = claimChecks.filter((c) => c.riskCategory === "legal");
    const customChecks = claimChecks.filter((c) => c.riskCategory === "custom");
    const uncatChecks = claimChecks.filter((c) => !c.riskCategory);
    const legalFail = legalChecks.filter((c) => c.status === "fail").length;
    const legalWarn = legalChecks.filter((c) => c.status === "warn").length;
    const customFail = customChecks.filter((c) => c.status === "fail").length;
    const customWarn = customChecks.filter((c) => c.status === "warn").length;
    const otherFail = uncatChecks.filter((c) => c.status === "fail").length;
    const otherWarn = uncatChecks.filter((c) => c.status === "warn").length;
    const rewrittenCount = checks.filter((c) => Boolean(c.finalText)).length;

    const sumChips: string[] = [];
    if (fidelityChecks.length) {
      const allFidOk = fidelityPass === fidelityChecks.length;
      sumChips.push('<span class="d-chip ' + (allFidOk ? "hi" : "warn") + '">信息保真 ' + fidelityPass + "/" + fidelityChecks.length + "</span>");
    }
    if (legalChecks.length) {
      if (legalFail > 0) sumChips.push('<span class="d-chip err">广告法拦截 ' + legalFail + " 处</span>");
      else if (legalWarn > 0) sumChips.push('<span class="d-chip warn">广告法提醒 ' + legalWarn + " 项</span>");
      else sumChips.push('<span class="d-chip hi">广告法合规 通过</span>');
    }
    if (customChecks.length) {
      if (customFail > 0) sumChips.push('<span class="d-chip err">风俗禁忌 ' + customFail + " 处</span>");
      else if (customWarn > 0) sumChips.push('<span class="d-chip warn">风俗提醒 ' + customWarn + " 项</span>");
      else sumChips.push('<span class="d-chip hi">风俗习惯 通过</span>');
    }
    if (otherFail > 0) sumChips.push('<span class="d-chip err">声称拦截 ' + otherFail + " 处</span>");
    if (otherWarn > 0) sumChips.push('<span class="d-chip warn">边界提醒 ' + otherWarn + " 项</span>");
    if (!legalChecks.length && !customChecks.length && otherFail === 0 && otherWarn === 0 && claimChecks.length) {
      sumChips.push('<span class="d-chip hi">合规扫描 通过</span>');
    }
    if (rewrittenCount > 0) {
      sumChips.push('<span class="d-chip hi">已合规改写 ' + rewrittenCount + " 处</span>");
    }

    el("guardBar").innerHTML = sumChips.length
      ? '<div class="guard-chips">' + sumChips.join("") + "</div>"
      : "";

    el("guard").innerHTML = checks.map((c, i) => {
      const source = snap.evidence.findIndex((e) => c.evidenceIds.includes(e.id));
      const point = c.kind === "fidelity" && c.keyPointId && c.label === c.keyPointId
        ? snap.keyPoints.find((item) => item.id === c.keyPointId)
        : undefined;
      const term = snap.terms.find((item) => item.id === c.termId);
      const termAttr = c.termId ? ' data-terms="' + termsFor([c.termId]) + '"' : "";
      const generalClaim = c.id === "G0" || c.id === "L0" || c.id === "C0";
      const label = c.id === "G0" ? "合规措辞扫描" : c.label;
      const title = point?.short || point?.text ||
        (label && label !== c.id ? label : undefined) || term?.surface || c.rule || "合规检查";
      const type = c.status === "pass" ? "ok" : c.status === "warn" ? "warn" : "block";
      const icon = type === "ok" ? "✓" : type === "warn" ? "!" : "✕";
      const statusBadge = type === "ok"
        ? "通过"
        : type === "warn"
          ? (c.action === "needs_data" ? "待补材料" : "风险提醒")
          : (c.finalText ? "已拦截并改写" : "已拦截");
      const riskCat = c.riskCategory === "legal" || c.riskCategory === "custom" ? c.riskCategory : null;
      const kindLabel = c.kind === "fidelity"
        ? "信息保真"
        : riskCat
          ? RISK_CATEGORY_LABEL[riskCat]
          : (generalClaim ? "合规排查" : (c.rule || "合规排查"));
      const cleanSpan = c.span ? cleanGuardSpan(c.span, title) : "";
      const rawReason = point && c.reason === "已保留" ? "" : c.reason.trim();
      const reason = rawReason.replace(/^功效声称[：:]\s*/, "");
      const hasRich = type !== "ok" || Boolean(cleanSpan || c.finalText || source >= 0);
      const delayStyle = fast ? "" : ' style="animation-delay:' + (Math.min(i, 6) * 0.08) + 's"';

      if (!hasRich) {
        const subNote = c.id === "L0" || c.id === "C0"
          ? (c.rule || "未检出风险项")
          : (reason && reason !== "未发现功效声称" ? reason : (generalClaim ? "未检出违规词" : ""));
        const catChip = riskCat
          ? '<span class="g-cat-tag is-' + riskCat + '">' + esc(RISK_CATEGORY_LABEL[riskCat]) + "</span>"
          : '<span class="g-kind">' + esc(kindLabel) + "</span>";
        return '<div class="g-item g-card g-ok is-compact' + (fast ? " settled" : "") + '"' + termAttr + delayStyle + ">" +
          '<div class="g-icon" aria-hidden="true">' + icon + "</div>" +
          '<div class="g-main">' +
            '<div class="g-head"><span class="g-title">' + esc(title) + '</span><span class="g-status">' + statusBadge + "</span></div>" +
            '<div class="g-sub">' + catChip + "<code>" + esc(c.id) + "</code>" +
            (subNote ? '<span class="g-note">' + esc(subNote) + "</span>" : "") + "</div>" +
          "</div></div>";
      }

      const diffRows: string[] = [];
      if (cleanSpan && !(type === "warn" && cleanSpan === title)) {
        diffRows.push(
          '<div class="g-diff-row ' + (type === "block" ? "is-removed" : "is-warn") + '">' +
          '<span class="g-diff-lbl">' + (type === "block" ? "命中词" : "关注词") + "</span>" +
          '<span class="' + (type === "block" ? "g-strike" : "g-span-val") + '">' + esc(cleanSpan) + "</span></div>",
        );
      }
      if (c.finalText) {
        diffRows.push(
          '<div class="g-diff-row is-final">' +
          '<span class="g-diff-lbl">已改写</span>' +
          '<span class="g-span-val" lang="' + esc(lang.bcp47) + '" dir="' + (lang.rtl ? "rtl" : "ltr") + '">' + esc(c.finalText) + "</span></div>",
        );
      }
      const diffHtml = diffRows.length ? '<div class="g-diff">' + diffRows.join("") + "</div>" : "";
      const reasonHtml = reason ? '<p class="g-reason">' + esc(reason) + "</p>" : "";
      const suggestionHtml = c.suggestion
        ? '<p class="g-suggestion"><b>改写建议：</b>' + esc(c.suggestion) + "</p>"
        : "";
      const footItems: string[] = [];
      if (riskCat) footItems.push('<span class="g-cat-tag is-' + riskCat + '">' + esc(RISK_CATEGORY_LABEL[riskCat]) + "</span>");
      if (c.jurisdiction) footItems.push('<span class="g-jurisdiction">' + esc(c.jurisdiction) + "</span>");
      else if (c.rule && c.rule !== title) footItems.push('<span class="g-rule-chip">' + esc(c.rule) + "</span>");
      footItems.push('<code class="g-code">' + esc(c.id) + "</code>");
      if (source >= 0) footItems.push('<button type="button" class="g-ev" data-ev="' + source + '">查看知乎证据 →</button>');

      return '<div class="g-item g-card g-' + type + ' is-rich' + (fast ? " settled" : "") + '"' + termAttr + delayStyle + ">" +
        '<div class="g-icon" aria-hidden="true">' + icon + "</div>" +
        '<div class="g-main">' +
          '<div class="g-head"><span class="g-title">' + esc(title) + '</span><span class="g-status">' + statusBadge + "</span></div>" +
          diffHtml + reasonHtml + suggestionHtml +
          '<div class="g-card-foot">' + footItems.join("") + "</div>" +
        "</div></div>";
    }).join("") || empty("当前档位没有检查记录。");

    if (!fast) settleOffscreen(el("guard"), ".g-item");

    const sumEl = el("guardSum");
    if (nb > 0) {
      sumEl.className = "meta guard-gate is-block";
      sumEl.textContent = nw > 0 ? "✕ " + nb + " 处拦截 · " + nw + " 项待核对" : "✕ " + nb + " 处已拦截";
    } else if (nw > 0) {
      sumEl.className = "meta guard-gate is-warn";
      sumEl.textContent = "! " + nw + " 项待核对";
    } else if (np > 0) {
      sumEl.className = "meta guard-gate is-ok";
      sumEl.textContent = "✓ " + np + " 项全部通过";
    } else {
      sumEl.className = "meta guard-gate is-wait";
      sumEl.textContent = "0 项检查";
    }
  }

  function renderBridgePanel(mode: "type" | "diff" | "instant") {
    const variant = selectedVariant(current);
    const snap = current.run.snapshot;
    if (!variant || !snap) return;
    renderStrategyControls(variant, snap);
    renderBridge(variant, snap, mode === "type" ? "draw" : mode === "diff" ? "update" : "instant");
    renderTranslation(variant, mode);
    renderAnnos(variant, snap, mode === "type");
  }

  function renderTest(animate = false) {
    const audience = cases.flatMap((c) => c.audiences).find((a) => a.id === request?.audienceId);
    const canTest = (activeCase()?.testEnabled ?? Boolean(audience?.personaSetId)) && current.run.keyPoints.length > 0;
    const flowLink = '<a class="link-btn" href="#pCommunity">查看回流流程 ↓</a>';
    const checks = canTest ? '<p class="guide">模型扮演海外读者，分别读直译和当前档位并复述。系统再核对下列信息点，帮你找出哪一版更容易读懂，以及哪些地方容易误解。</p>' +
      '<div class="sub-h">要读懂的信息点</div><div class="kps">' +
      current.run.keyPoints.map((p, i) => '<label class="kp"><input type="checkbox" data-service-kp="' + i +
        (enabledPoints.has(p.id) ? '" checked' : '"') + '><span class="kp-box"></span><span class="kp-n">P' + (i + 1) +
        '</span><span class="kp-t">' + esc(p.text) + "</span></label>").join("") +
      '</div><div class="run-row"><button class="btn btn-primary" id="runTest">运行测试</button>' + flowLink + "</div>"
      : empty("当前受众暂无复述测试。可在「回流知乎」粘贴真实评论。") + flowLink;
    const wrap = animate && !prefersReducedMotion() ? '<div class="panel-body-pop" style="--reveal-delay:0ms">' : "<div>";
    el("testBody").innerHTML = wrap + checks + '</div><div id="stale"></div><div id="results" aria-live="polite"></div>';
  }

  function renderTestSkeletons() {
    const count = 3;
    el("results").innerHTML = Array.from({ length: count }, (_, i) =>
      '<div class="p-skeleton reading" style="animation-delay:' + (i * 100) + 'ms">' +
      '<div class="p-head"><div class="avatar" style="background:' + AVATAR_COLORS[i % AVATAR_COLORS.length] + '">' + (i + 1) + "</div>" +
      '<div class="p-who"><b>模拟读者 ' + (i + 1) + "</b><small>正在隔离阅读直译与转译版…</small></div></div>" +
      '<div class="p-line lit"><span class="vtag">直译</span><span class="rt">　</span></div>' +
      '<div class="p-line tr"><span class="vtag">转译</span><span class="rt">　</span></div></div>',
    ).join("");
  }

  async function renderTestResult(result: TestResult, animate = true, signal?: AbortSignal) {
    draftAction = [];
    const stale = testIsStale(current) || result.keyPointIds.length !== enabledPoints.size || result.keyPointIds.some((id) => !enabledPoints.has(id));
    el("stale").innerHTML = stale ? '<div class="stale"><span>结果对应上一档位或信息点组合</span><button id="rerun">重新测试</button></div>' : "";
    const count = (tally: { hit: number; valid: number }) => tally.valid ? tally.hit + "/" + tally.valid : "待判定";
    const judgeWarn = result.judgeError
      ? '<div class="judge-warn" role="alert">' + esc(result.judgeError) + "</div>"
      : (result.completed > 0 && result.summary.literal.valid === 0 && result.summary.selected.valid === 0
        ? '<div class="judge-warn" role="alert">信息点自动评判未完成，以下仅保留读者复述。</div>'
        : "");
    const groups = groupReaders(result.readers);
    const keyPoints = current.run.keyPoints;

    const buildBadge = (g: PersonaGroup, pop = true) => {
      const target = g.selected.length ? g.selected : g.literal;
      const settledCls = pop ? "" : " settled";
      if (target.every((r) => r.status === "failed")) return '<span class="react r-neg' + settledCls + '">复述失败</span>';
      const allJ = target.flatMap((r) => r.judgments);
      if (!allJ.length) return "";
      const hits = allJ.filter((j) => j.verdict === "hit").length;
      const cls = hits === allJ.length ? "r-pos" : hits > 0 ? "r-mid" : "r-neg";
      return '<span class="react ' + cls + settledCls + '">' + hits + "/" + allJ.length + " 命中</span>";
    };

    const buildJudgments = (g: PersonaGroup, popIn: boolean) => {
      const rows: string[] = [];
      const append = (readers: Reader[], prefix: string) => {
        for (const r of readers) {
          for (const j of r.judgments) {
            const point = keyPoints.findIndex((p) => p.id === j.keyPointId) + 1;
            const misread = j.verdict !== "hit" && j.quote.trim() && !stale;
            const action = misread ? '<button class="link-btn" data-service-misreading="' + (draftAction.push({
              kind: "reader_misreading", text: j.quote, testId: result.testId, keyPointId: j.keyPointId,
            }) - 1) + '">带回知乎 →</button>' : "";
            const verdictCls = j.verdict === "hit" ? "v-hit" : j.verdict === "contradicted" ? "v-contra" : "v-miss";
            rows.push('<div class="p-judgment">' + (prefix ? prefix + " · " : "") + "P" + point +
              ' · <span class="' + verdictCls + '">' + VERDICT_LABEL[j.verdict] + "</span>" +
              (j.quote ? " · " + esc(j.quote) : "") + (action ? " " + action : "") + "</div>");
          }
        }
      };
      if (g.literal.length && g.selected.length) {
        append(g.literal, "直译");
        append(g.selected, "转译");
      } else {
        append(g.literal.length ? g.literal : g.selected, "");
      }
      return rows.length ? '<div class="p-judgments' + (popIn ? " pop-in" : "") + '">' + rows.join("") + "</div>" : "";
    };

    const buildScoreBox = (anim: boolean) => {
      const scoreCls = anim ? "score" : "score settled";
      const mxCls = anim ? "mx" : "mx settled";
      const verdictCell = (readers: Reader[], kpId: string) => {
        const j = readers.flatMap((r) => r.judgments).find((x) => x.keyPointId === kpId);
        if (!j) return { cls: "u", sym: "–" };
        return j.verdict === "hit" ? { cls: "y", sym: "✓" } : { cls: "n", sym: "✗" };
      };
      const hasMatrix = groups.length > 0 && keyPoints.length > 0 && result.readers.some((r) => r.judgments.length > 0);
      const head = keyPoints.map((kp, i) => '<th class="' + (enabledPoints.has(kp.id) ? "" : "off") + '" title="' + esc(kp.text) + '">P' + (i + 1) + "</th>").join("");
      const matrixRows = groups.map((g, pi) =>
        "<tr><td>" + esc(g.label) + "</td>" + keyPoints.map((kp, ki) => {
          const litCell = verdictCell(g.literal, kp.id);
          const selCell = verdictCell(g.selected, kp.id);
          const d1 = anim ? ((pi * keyPoints.length + ki) * 50) + "ms" : "0ms";
          const d2 = anim ? ((pi * keyPoints.length + ki) * 50 + 220) + "ms" : "0ms";
          return '<td class="' + (enabledPoints.has(kp.id) ? "" : "off") + '"><span class="mxc">' +
            '<span class="' + litCell.cls + '" style="animation-delay:' + d1 + '">' + litCell.sym + "</span><em>→</em>" +
            '<span class="' + selCell.cls + '" style="animation-delay:' + d2 + '">' + selCell.sym + "</span></span></td>";
        }).join("") + "</tr>",
      ).join("");
      return '<div class="' + scoreCls + '"><div class="s-col"><small>直译 · 读懂的信息点</small><b id="scoreLit">' + count(result.summary.literal) + "</b></div>" +
        '<div class="s-arrow">→</div><div class="s-col hi"><small>' + LEVEL_LABEL[result.level] +
        ' · 读懂的信息点</small><b id="scoreSel">' + count(result.summary.selected) + "</b></div></div>" +
        (hasMatrix ? '<div class="mx-wrap"><table class="' + mxCls + '"><thead><tr><th>读者</th>' + head + "</tr></thead><tbody>" + matrixRows + "</tbody></table></div>" : "");
    };

    const headerHtml = notice(statusText(result.mode) + " · 模拟复述 " + result.completed + "/" + result.expected + " 次") +
      (result.provenance === "dev_stub" ? notice("开发占位 · 非评测结果") : "") + judgeWarn;

    const doAnimate = animate && !prefersReducedMotion();
    const lang = activeLang();
    const rtAttr = 'lang="' + esc(lang.bcp47) + '" dir="' + (lang.rtl ? "rtl" : "ltr") + '"';

    if (!doAnimate) {
      const cardsHtml = groups.map((g) => {
        const initial = Array.from(g.label.trim())[0] ?? "读";
        const lines = [
          ...g.literal.map((r) => '<div class="p-line lit"><span class="vtag">直译</span><span class="rt" ' + rtAttr + ">" +
            highlightMisreadings(r.retelling ?? "本次复述未完成", r.judgments, keyPoints) + "</span></div>"),
          ...g.selected.map((r) => '<div class="p-line tr"><span class="vtag">转译</span><span class="rt" ' + rtAttr + ">" +
            highlightMisreadings(r.retelling ?? "本次复述未完成", r.judgments, keyPoints) + "</span></div>"),
        ].join("");
        const sub = g.literal.length && g.selected.length ? "直译 vs 转译" : g.literal.length ? "直译版本" : "转译版本";
        return '<div class="p-card settled"><div class="p-head">' +
          '<div class="avatar" style="background:' + avatarColorFor(g.key) + '">' + esc(initial) + "</div>" +
          '<div class="p-who"><b>' + esc(g.label) + "</b><small>" + sub + "</small></div>" +
          buildBadge(g) + "</div>" + lines + buildJudgments(g, false) + "</div>";
      }).join("");
      el("results").innerHTML = headerHtml + cardsHtml + '<div id="scoreBox">' + buildScoreBox(false) + "</div>";
      renderCommunity(false);
      return;
    }

    // Animated prototype-style reveal: reading shimmer cards -> staggered typewriter -> inline misread highlight -> badge pop -> score count-up & matrix
    const readingCards = groups.map((g, i) => {
      const initial = Array.from(g.label.trim())[0] ?? "读";
      const sub = g.literal.length && g.selected.length ? "直译 vs 转译" : g.literal.length ? "直译版本" : "转译版本";
      const lines = [
        ...g.literal.map(() => '<div class="p-line lit"><span class="vtag">直译</span><span class="rt" ' + rtAttr + ">　</span></div>"),
        ...g.selected.map(() => '<div class="p-line tr"><span class="vtag">转译</span><span class="rt" ' + rtAttr + ">　</span></div>"),
      ].join("");
      return '<div class="p-card reading" id="pc-' + i + '" style="animation-delay:' + (i * 110) + 'ms"><div class="p-head">' +
        '<div class="avatar" style="background:' + avatarColorFor(g.key) + '">' + esc(initial) + "</div>" +
        '<div class="p-who"><b>' + esc(g.label) + "</b><small>" + sub + "</small></div>" +
        '<span class="react-slot"></span></div>' + lines + '<div class="judgments-slot"></div></div>';
    }).join("");

    el("results").innerHTML = headerHtml + readingCards + '<div id="scoreBox"></div>';
    // Offscreen `.p-card`s inside `#pTest > .panel-body` skip `fadeUp` so Chromium's
    // compositor cannot leave their parent layer unpainted while child layers paint.
    settleOffscreen(el("results"), ".p-card", "no-enter");
    el("results").querySelectorAll<HTMLElement>(".p-card:not(.no-enter)").forEach((card) => {
      card.addEventListener("animationend", (ev) => {
        if (ev.target !== card) return;
        card.classList.add("no-enter");
        card.style.animationDelay = "";
      }, { once: true });
    });
    await sleep(280, signal);
    if (signal?.aborted) return;

    await Promise.all(groups.map(async (g, i) => {
      await sleep(i * 220, signal);
      if (signal?.aborted) return;
      const card = document.getElementById("pc-" + i);
      if (!card) return;
      card.classList.remove("reading");
      const allReaders = [...g.literal, ...g.selected];
      const rtNodes = Array.from(card.querySelectorAll<HTMLElement>(".rt"));
      await Promise.all(allReaders.map((r, ri) => {
        const node = rtNodes[ri];
        return node ? typeInto(node, r.retelling ?? "本次复述未完成", signal) : Promise.resolve();
      }));
      if (signal?.aborted || !card.isConnected) return;
      card.classList.add("no-enter");
      card.style.animationDelay = "";
      allReaders.forEach((r, ri) => {
        const node = rtNodes[ri];
        if (node) node.innerHTML = highlightMisreadings(r.retelling ?? "本次复述未完成", r.judgments, keyPoints);
      });
      const visible = isInPanelView(card);
      const badgeSlot = card.querySelector(".react-slot");
      if (badgeSlot) badgeSlot.outerHTML = buildBadge(g, visible);
      const jSlot = card.querySelector(".judgments-slot");
      if (jSlot) jSlot.outerHTML = buildJudgments(g, visible);
    }));

    if (signal?.aborted) return;
    const scoreBox = document.getElementById("scoreBox");
    if (scoreBox) {
      const scoreVisible = isInPanelView(scoreBox);
      scoreBox.innerHTML = buildScoreBox(scoreVisible);
      if (scoreVisible) {
        countUpTally(document.getElementById("scoreLit"), result.summary.literal.hit, result.summary.literal.valid, signal);
        countUpTally(document.getElementById("scoreSel"), result.summary.selected.hit, result.summary.selected.valid, signal);
      }
    }
    renderCommunity(false);
  }

  function finalizeReady(animate: boolean) {
    if (readyFinalized) return;
    readyFinalized = true;
    layout.spotlight(null);
    layout.setStep(5);
    renderTest(animate);
    renderDelivery(animate);
    renderCommunity(animate);
    updateUrl();
  }

  function enqueueStage(signal: AbortSignal, fn: () => Promise<void> | void) {
    stageChain = stageChain.then(async () => {
      if (signal.aborted) return;
      await fn();
    });
  }

  async function presentTerms(sourceSegments: SourceSegment[], terms: Term[], signal: AbortSignal, revealSignal: AbortSignal) {
    if (signal.aborted) return;
    termsPresented = true;
    layout.setStep(1);
    layout.spotlight(["pSource"]);
    if (prefersReducedMotion() || revealSignal.aborted) {
      renderSource(sourceSegments, terms, true);
      layout.setStep(2);
      layout.spotlight(["pEvidence"]);
      return;
    }
    renderSource(sourceSegments, terms, false);
    await sleep(300, revealSignal);
    if (signal.aborted) return;
    if (revealSignal.aborted) {
      renderSource(sourceSegments, terms, true);
      return;
    }
    for (let i = 0; i < terms.length; i++) {
      if (signal.aborted) return;
      if (revealSignal.aborted) {
        renderSource(sourceSegments, terms, true);
        return;
      }
      document.querySelectorAll('#sourceText [data-terms~="' + i + '"]').forEach((node) => node.classList.add("on"));
      el("tags").insertAdjacentHTML("beforeend", tagHtml(terms[i], i));
      await sleep(340, revealSignal);
    }
    sourceMarkup = buildSourceMarkup(sourceSegments, terms, true).combined;
    await sleep(360, revealSignal);
    if (signal.aborted || revealSignal.aborted) return;
    layout.setStep(2);
    layout.spotlight(["pEvidence"]);
  }

  async function presentEvidence(evidence: Evidence[], notices: string[], terms: Term[], signal: AbortSignal, revealSignal: AbortSignal) {
    if (signal.aborted) return;
    evidencePresented = true;
    layout.setStep(2);
    layout.spotlight(["pEvidence"]);
    const anim = !prefersReducedMotion() && !revealSignal.aborted;
    renderEvidence(evidence, notices, terms, anim);
    if (anim) {
      const waitMs = evidence.length ? Math.min(evidence.length, 5) * 260 + 500 : 500;
      await sleep(waitMs, revealSignal);
    }
    if (signal.aborted || revealSignal.aborted) return;
    layout.setStep(3);
    layout.spotlight(["pBridge"]);
  }

  function onEvent(reqId: number, event: SseEvent, level: string | null | undefined, signal: AbortSignal, revealSignal: AbortSignal) {
    const previous = current;
    current = reducer(current, { type: "run/event", reqId, event });
    if (previous === current) return;
    switch (event.type) {
      case "started":
        setStatus(current.run.mode === "degraded" ? "检索证据中" : statusText(current.run.mode ?? "degraded"));
        break;
      case "terms": {
        const segs = current.run.sourceSegments;
        const terms = current.run.terms;
        enqueueStage(signal, () => presentTerms(segs, terms, signal, revealSignal));
        break;
      }
      case "evidence": {
        const ev = current.run.evidence;
        const notices = current.run.notices;
        const terms = current.run.terms;
        enqueueStage(signal, () => presentEvidence(ev, notices, terms, signal, revealSignal));
        break;
      }
      case "ready": {
        if (availableLevels().some((l) => l === level)) current = reducer(current, { type: "level", level: level as Level });
        const snap = current.run.snapshot!;
        setStatus(statusText(snap.mode));
        enabledPoints = new Set(current.run.keyPoints.map((p) => p.id));
        enqueueStage(signal, async () => {
          if (signal.aborted) return;
          if (!termsPresented) {
            await presentTerms(snap.sourceSegments, snap.terms, signal, revealSignal);
          } else {
            renderSource(snap.sourceSegments, snap.terms, true);
          }
          if (signal.aborted) return;
          if (!evidencePresented) {
            await presentEvidence(snap.evidence, snap.notices, snap.terms, signal, revealSignal);
          } else {
            renderEvidence(snap.evidence, snap.notices, snap.terms, false);
          }
          if (signal.aborted) return;

          const activeVariant = selectedVariant(current);
          if (!activeVariant) return;

          // Step 3: Spotlight Cognitive Bridge + Strategy Translation
          if (!revealSignal.aborted && !prefersReducedMotion()) {
            layout.setStep(3);
            layout.spotlight(["pBridge"]);
            renderBridgePanel("type");
            await sleep(1450, revealSignal);
          } else {
            renderBridgePanel("instant");
          }
          if (signal.aborted) return;

          // Step 4: Spotlight Claim Guard
          if (!revealSignal.aborted && !prefersReducedMotion()) {
            layout.setStep(4);
            layout.spotlight(["pGuard"]);
            const vNow = selectedVariant(current) ?? activeVariant;
            renderGuard(vNow, snap, false);
            await sleep(Math.min(1300, Math.max(950, vNow.checks.length * 180 + 550)), revealSignal);
          } else {
            renderGuard(selectedVariant(current) ?? activeVariant, snap, true);
          }
          if (signal.aborted) return;

          // Step 5: Release spotlight & reveal Test / Delivery / Community
          finalizeReady(!prefersReducedMotion() && !revealSignal.aborted);
        });
        break;
      }
    }
    layout.tlog(event.type, current.run.error?.message ?? event.runId, event.type === "error" ? "w" : undefined);
  }

  async function startRequest(next: RunRequest, level?: string | null) {
    if (!adapter) return;
    runController?.abort();
    revealController?.abort();
    testRevealController?.abort();
    invalidateDraft();
    const controller = new AbortController();
    const rController = new AbortController();
    runController = controller;
    revealController = rController;
    const { signal } = controller;
    const revealSignal = rController.signal;
    const reqId = ++serial;
    const targetLanguage: TargetLanguageCode = isTargetLanguageCode(next.targetLanguage)
      ? next.targetLanguage
      : (isTargetLanguageCode(homeLang.value) ? homeLang.value : DEFAULT_TARGET_LANGUAGE);
    const trimmedText = next.text.trim();
    const matchedCase = cases.find((c) => c.caseId === next.caseId && c.text.trim() === trimmedText);
    const customAudiences = () => {
      const seen = new Set<string>([GENERAL_AUDIENCE.id]);
      const list: AudienceMeta[] = [GENERAL_AUDIENCE];
      for (const a of cases.flatMap((c) => c.audiences)) {
        if (!seen.has(a.id)) { seen.add(a.id); list.push(a); }
      }
      return list;
    };
    const audiences = matchedCase?.audiences ?? customAudiences();
    const validAudienceId = audiences.some((a) => a.id === next.audienceId)
      ? next.audienceId
      : (matchedCase?.defaultAudienceId ?? GENERAL_AUDIENCE.id);
    const reqWithLang: RunRequest = {
      ...next,
      caseId: matchedCase?.caseId ?? null,
      text: trimmedText,
      audienceId: validAudienceId,
      targetLanguage,
      useGlobalSearch: next.useGlobalSearch ?? useGlobalSearch,
      knowledgeBaseIds: next.knowledgeBaseIds ?? (selectedKbIds.length ? [...selectedKbIds] : undefined),
    };
    request = reqWithLang;
    closeAnyBridgePicker();
    homeLang.setValue(targetLanguage);
    langSelect.setValue(targetLanguage);
    stageChain = Promise.resolve();
    termsPresented = false;
    evidencePresented = false;
    readyFinalized = false;
    prevWords = [];
    sourceMarkup = "";
    evidenceMarkup = "";
    draftAction = [];
    workAudience.setOptions(audienceOptionsOf(audiences), reqWithLang.audienceId);
    const activeAudienceLabel = audiences.find((a) => a.id === reqWithLang.audienceId)?.label ?? "";
    const key = reqWithLang.caseId?.replace(/^case_/, "");
    document.querySelectorAll<HTMLButtonElement>("#caseSeg button").forEach((b) => b.classList.toggle("on", b.dataset.case === key));
    current = reducer(current, {
      type: "run/start",
      reqId,
      audienceId: reqWithLang.audienceId,
      audienceLabel: activeAudienceLabel,
      targetLanguage,
      keepPrev: false,
      sourceText: reqWithLang.text,
    });
    updateUrl();
    setStatus("生成中");
    el("industry").textContent = activeCase()?.industry ?? "自定义输入";
    for (const id of ["evidence", "bridge", "guard", "testBody"]) el(id).innerHTML = wait;
    for (const id of ["guardBar", "annos", "literal", "txLvl", "txText", "stops", "lvlFit"]) el(id).textContent = "";
    el("guardSum").className = "meta guard-gate is-wait";
    el("guardSum").textContent = "校验中";
    el("lvlName").textContent = "生成中";
    slider.disabled = true;
    slider.hidden = true;
    renderSource(current.run.sourceSegments, [], false);
    renderDelivery(false);
    renderCommunity(false);
    resetPanelScroll();

    const enteringFromHero = !document.body.classList.contains("state-work");
    if (enteringFromHero && !prefersReducedMotion()) {
      const hero = el("hero");
      hero.classList.add("leaving");
      enqueueStage(signal, async () => {
        await sleep(380, revealSignal);
        hero.classList.remove("leaving");
        if (signal.aborted) return;
        layout.enter();
        layout.traceStart();
        layout.setStep(1);
        layout.spotlight(["pSource"]);
        await sleep(620, revealSignal);
      });
    } else {
      el("hero").classList.remove("leaving");
      layout.enter();
      layout.traceStart();
      layout.setStep(1);
      layout.spotlight(["pSource"]);
    }

    try {
      await adapter.run(reqWithLang, (event) => onEvent(reqId, event, level, signal, revealSignal), signal);
    } catch (e) {
      if (signal.aborted) return;
      current = reducer(current, { type: "run/failed", reqId, message: errorText(e) });
      layout.tlog("error", errorText(e), "w");
    } finally {
      if (!signal.aborted) void credentials?.refresh();
    }
    if (signal.aborted || !current.run.error) return;
    rController.abort();
    enqueueStage(signal, () => {
      if (signal.aborted || !current.run.error) return;
      setStatus(current.run.error.retryable ? statusText("degraded") : "证据查看");
      layout.spotlight(null);
      renderSource(current.run.sourceSegments, current.run.terms, true);
      renderEvidence(current.run.evidence, current.run.notices, current.run.terms, false);
      el("bridge").innerHTML = empty("暂无可用译稿");
      el("guardBar").innerHTML = "";
      el("guardSum").className = "meta guard-gate is-wait";
      el("guardSum").textContent = "未检查";
      el("guard").innerHTML = empty("本次未完成守门检查");
      el("testBody").innerHTML = empty("完成模型转译后可运行复述测试。");
      el("txText").innerHTML = '<div role="alert">' + esc(current.run.error.message) + "</div>" +
        (current.run.error.retryable ? '<button id="retryRun" class="btn btn-ghost" style="margin-top:10px">重试</button>' : "");
      el("lvlName").textContent = "未就绪";
      renderDelivery(false);
      renderCommunity(false);
    });
  }

  async function runTest() {
    const snap = current.run.snapshot;
    const level = current.level;
    const button = el<HTMLButtonElement>("runTest");
    if (!adapter || !snap || !level || !button || current.test.status === "running" || !runController) return;
    const { signal } = runController;
    testRevealController?.abort();
    const tReveal = new AbortController();
    testRevealController = tReveal;
    signal.addEventListener("abort", () => tReveal.abort(), { once: true });
    const keyPointIds = [...enabledPoints];
    if (!keyPointIds.length) {
      layout.toast("请至少勾选一个要验证的信息点");
      return;
    }
    const reqId = ++serial;
    current = reducer(current, { type: "test/start", reqId });
    button.disabled = true;
    layout.spotlight(["pTest"]);
    layout.setStep(5);
    el("pTest").scrollIntoView({ behavior: "smooth", block: "nearest" });
    el("stale").textContent = "";
    renderTestSkeletons();
    const testBodyPanel = el("pTest").querySelector<HTMLElement>(":scope > .panel-body");
    const resultsEl = el("results");
    if (testBodyPanel && resultsEl) {
      const top = Math.max(0, resultsEl.offsetTop - 12);
      testBodyPanel.scrollTo({ top, behavior: prefersReducedMotion() ? "auto" : "smooth" });
    }
    draftAction = [];
    renderCommunity(false);
    invalidateDraft();
    try {
      const result = await adapter.test(snap.runId, { revision: snap.revision, level, keyPointIds }, signal);
      if (signal.aborted) return;
      if (result.runId !== snap.runId || result.revision !== snap.revision || result.level !== level) {
        throw new Error("测试结果与发起时的译稿版本不一致，请重试");
      }
      current = reducer(current, { type: "test/done", reqId, result });
      await renderTestResult(result, true, tReveal.signal);
      if (!signal.aborted) layout.tlog("test.done", "已完成 " + result.completed + "/" + result.expected, "ok");
    } catch (e) {
      if (signal.aborted) return;
      current = reducer(current, { type: "test/error", reqId, message: errorText(e) });
      el("results").innerHTML = empty(errorText(e));
      layout.tlog("test.error", errorText(e), "w");
    } finally {
      layout.spotlight(null);
      if (!signal.aborted) button.disabled = false;
    }
  }

  let rulesModalState: { category: RiskCategory; scope: "market" | "all"; rules: ComplianceRule[]; showForm: boolean } = {
    category: "legal",
    scope: "market",
    rules: [],
    showForm: false,
  };

  function marketLabelList(markets: string[]): string {
    if (markets.includes("*")) return "全球通用";
    return markets.map((code) => getTargetLanguage(code).label).join(" / ");
  }

  function renderComplianceDbModal() {
    const lang = activeLang();
    const { category, scope, rules, showForm } = rulesModalState;
    const legalCount = rules.filter((r) => r.category === "legal").length;
    const customCount = rules.filter((r) => r.category === "custom").length;
    const shown = rules.filter((r) => r.category === category);
    const canEdit = adapter?.kind === "backend" && Boolean(adapter.addComplianceRule);

    const listHtml = shown.length
      ? shown.map((r) => {
          const sevCls = r.severity === "block" ? "is-block" : "is-warn";
          const sevTxt = r.severity === "block" ? "拦截改写" : "风险提醒";
          const delBtn = !r.builtin && canEdit
            ? '<button type="button" class="cdb-del" data-del-rule="' + esc(r.ruleId) + '">删除</button>'
            : "";
          return '<div class="cdb-rule">' +
            '<div class="cdb-rule-head">' +
              '<span class="cdb-rule-title">' + esc(r.title) + "</span>" +
              '<span class="cdb-sev ' + sevCls + '">' + sevTxt + "</span>" +
              delBtn +
            "</div>" +
            '<div class="cdb-rule-meta">' +
              '<code>' + esc(r.ruleId) + "</code>" +
              '<span class="cdb-mkt">' + esc(marketLabelList(r.markets)) + "</span>" +
              '<span class="cdb-jur">' + esc(r.jurisdiction) + "</span>" +
            "</div>" +
            '<p class="cdb-rule-reason">' + esc(r.reason) + "</p>" +
            (r.suggestion ? '<p class="cdb-rule-sug"><b>合规改写建议：</b>' + esc(r.suggestion) + "</p>" : "") +
          "</div>";
        }).join("")
      : empty("当前筛选条件下暂无规则。");

    const formHtml = showForm && canEdit
      ? '<form class="cdb-form" id="cdbAddForm">' +
          '<div class="cdb-form-grid">' +
            '<label>风险分类<select id="cdbCat">' +
              '<option value="legal"' + (category === "legal" ? " selected" : "") + ">当地法律法规（广告法）</option>" +
              '<option value="custom"' + (category === "custom" ? " selected" : "") + ">当地风俗习惯（文化禁忌）</option>" +
            "</select></label>" +
            '<label>处理级别<select id="cdbSev">' +
              '<option value="block">拦截并合规改写</option>' +
              '<option value="warn">风险提醒（不锁定）</option>' +
            "</select></label>" +
          "</div>" +
          '<div class="cdb-form-grid">' +
            '<label>规则名称<input id="cdbTitle" required maxlength="60" placeholder="例如：禁止绝对化功效词"></label>' +
            '<label>适用市场<select id="cdbMkt">' +
              '<option value="' + esc(lang.code) + '">仅当前市场（' + esc(lang.label) + " · " + esc(lang.markets) + "）</option>" +
              '<option value="*">全球全部市场通用</option>' +
            "</select></label>" +
          "</div>" +
          '<label>法规或风俗依据<input id="cdbJur" required maxlength="100" placeholder="例如：US FTC · 欧盟广告法规 / 当地宗教礼俗"></label>' +
          '<label>风险匹配词（逗号分隔，支持英文/目标语关键词或正则）<input id="cdbPat" required placeholder="例如：miracle cure, 100% guaranteed"></label>' +
          '<label>风险说明<input id="cdbReason" required maxlength="300" placeholder="说明触发该规则的法律或风俗原因"></label>' +
          '<label>合规改写建议（选填）<input id="cdbSug" maxlength="300" placeholder="指导模型如何保留卖点并合规改写"></label>' +
          '<div class="cdb-form-actions">' +
            '<button type="submit" class="btn btn-primary">保存到数据库</button>' +
            '<button type="button" class="btn btn-ghost" id="cdbCancelAdd">取消</button>' +
          "</div>" +
        "</form>"
      : "";

    draftDialog.innerHTML =
      '<div class="cdb-head"><div><h3>海外合规与风俗风险数据库</h3>' +
      '<p class="cdb-sub">SQLite 本地风险库按「当地法律法规」与「当地风俗习惯」两块自动排查，命中后优先合规改写而非中途掐断。</p></div></div>' +
      '<div class="cdb-toolbar">' +
        '<div class="cdb-tabs" role="tablist">' +
          '<button type="button" class="cdb-tab' + (category === "legal" ? " on" : "") + '" data-cdb-cat="legal">当地法律法规 <span class="cdb-cnt">' + legalCount + "</span></button>" +
          '<button type="button" class="cdb-tab' + (category === "custom" ? " on" : "") + '" data-cdb-cat="custom">当地风俗习惯 <span class="cdb-cnt">' + customCount + "</span></button>" +
        "</div>" +
        '<div class="cdb-scope">' +
          '<button type="button" class="cdb-pill' + (scope === "market" ? " on" : "") + '" data-cdb-scope="market">当前市场 · ' + esc(lang.label) + "</button>" +
          '<button type="button" class="cdb-pill' + (scope === "all" ? " on" : "") + '" data-cdb-scope="all">全部市场</button>' +
        "</div>" +
      "</div>" +
      formHtml +
      '<div class="cdb-list">' + listHtml + "</div>" +
      '<div class="modal-foot">' +
        (canEdit
          ? '<button type="button" class="btn btn-ghost" id="cdbToggleAdd">' + (showForm ? "收起新增" : "+ 新增风险规则") + "</button>"
          : '<span class="meta">离线包只读预览 · 连接本地后端后可新增自定义规则</span>') +
        '<button type="button" class="btn btn-primary" id="closeModal">关闭</button>' +
      "</div>";
  }

  async function openComplianceDbModal(scope: "market" | "all" = "market") {
    if (!adapter) return;
    invalidateDraft();
    rulesModalState.scope = scope;
    rulesModalState.showForm = false;
    draftDialog.innerHTML = '<h3>海外合规与风俗风险数据库</h3><p class="guide">正在读取风险规则库…</p>' + wait +
      '<div class="modal-foot"><button class="btn btn-ghost" id="closeModal">关闭</button></div>';
    draftDialog.inert = false;
    draftDialog.classList.add("on");
    try {
      const market = scope === "market" ? activeLang().code : undefined;
      const res = await adapter.complianceRules(market);
      if (!draftDialog.classList.contains("on")) return;
      rulesModalState.rules = res.rules;
      renderComplianceDbModal();
    } catch (e) {
      if (draftDialog.classList.contains("on")) {
        draftDialog.innerHTML = '<h3>海外合规与风俗风险数据库</h3>' + empty(errorText(e)) +
          '<div class="modal-foot"><button class="btn btn-ghost" id="closeModal">关闭</button></div>';
      }
    }
  }

  const DRAFT_TARGET_META: Record<DraftTarget, {
    label: string;
    heading: string;
    titleLabel: string;
    bodyLabel: string;
    ctaLabel: string;
    fallbackUrl: string;
    fallbackDesc: string;
  }> = {
    answer: {
      label: "写回答",
      heading: "补充回答草稿",
      titleLabel: "回答切入点 / 对应问题",
      bodyLabel: "补充回答正文",
      ctaLabel: "去知乎写回答",
      fallbackUrl: "https://www.zhihu.com/question/waiting",
      fallbackDesc: "前往知乎对应问题页或「等你来答」补充海外视角",
    },
    question: {
      label: "提问题",
      heading: "提问草稿",
      titleLabel: "提问标题",
      bodyLabel: "问题描述",
      ctaLabel: "去知乎提问题",
      fallbackUrl: "https://www.zhihu.com/search?type=content&q=",
      fallbackDesc: "核对同类讨论后从知乎顶部「提问」发起新问题",
    },
    article: {
      label: "发文章",
      heading: "知乎专栏文章草稿",
      titleLabel: "文章标题",
      bodyLabel: "专栏正文初稿",
      ctaLabel: "去知乎发文章",
      fallbackUrl: "https://zhuanlan.zhihu.com/write",
      fallbackDesc: "直达知乎专栏写作页，发布深度本地化复盘",
    },
    pin: {
      label: "发想法",
      heading: "知乎想法草稿",
      titleLabel: "想法主题",
      bodyLabel: "想法正文（含 #话题标签）",
      ctaLabel: "去知乎发想法",
      fallbackUrl: "https://www.zhihu.com/pins",
      fallbackDesc: "直达知乎想法板块，分享轻量跨文化速记",
    },
  };

  function resolveDestinations(d: QuestionDraft): FlowbackDestination[] {
    if (d.destinations && d.destinations.length) return d.destinations;
    const firstQ = d.existing.find((x) => /^https:\/\/www\.zhihu\.com\/question\/[0-9]+/.test(x.url))?.url;
    const qUrl = "https://www.zhihu.com/search?type=content&q=" + encodeURIComponent(d.query || "跨文化翻译");
    const rec: DraftTarget = d.recommendedTarget ?? (d.recommendation === "answer_existing" && d.existing.length ? "answer" : "question");
    return [
      {
        targetType: "answer",
        label: "去知乎写回答",
        description: firstQ ? "直达命中的知乎相关问题页，补充海外读者视角" : DRAFT_TARGET_META.answer.fallbackDesc,
        url: firstQ || DRAFT_TARGET_META.answer.fallbackUrl,
        primary: rec === "answer",
      },
      {
        targetType: "question",
        label: "去知乎提问题",
        description: DRAFT_TARGET_META.question.fallbackDesc,
        url: qUrl,
        primary: rec === "question",
      },
      {
        targetType: "article",
        label: "去知乎发文章",
        description: DRAFT_TARGET_META.article.fallbackDesc,
        url: DRAFT_TARGET_META.article.fallbackUrl,
        primary: rec === "article",
      },
      {
        targetType: "pin",
        label: "去知乎发想法",
        description: DRAFT_TARGET_META.pin.fallbackDesc,
        url: DRAFT_TARGET_META.pin.fallbackUrl,
        primary: rec === "pin",
      },
    ];
  }

  function buildContextPrefill(): string {
    const snap = current.run.snapshot;
    if (!snap) return "";
    const terms = snap.terms.slice(0, 3).map((t) => `「${t.surface}」`).join("、");
    const src = snap.sourceSegments.map((s) => s.text).join("").trim().slice(0, 120);
    return terms
      ? `面向海外读者转译「${src}」时，${terms}容易因为文化或背景差异产生理解落差，希望结合知乎社区经验整理更贴切的跨文化表达。`
      : `面向海外读者转译「${src}」时出现理解偏差，希望补充跨文化背景说明。`;
  }

  function openDraft(initialTarget: DraftTarget = "question") {
    invalidateDraft();
    activeDraftTarget = initialTarget;
    const pills = (["answer", "question", "article", "pin"] as DraftTarget[]).map((t) =>
      '<button type="button" class="flow-mode-pill' + (t === activeDraftTarget ? " on" : "") +
      '" data-pick-draft-target="' + t + '">' + esc(DRAFT_TARGET_META[t].label) + "</button>",
    ).join("");
    draftDialog.innerHTML = '<h3>回流知乎 · 按需生成草稿</h3>' +
      '<div class="flow-mode-row"><span class="meta">反哺板块：</span>' + pills + "</div>" +
      '<div class="draft"><label for="comment">粘贴一条海外评论、读者困惑，或点击下方一键带入当前转译语境</label>' +
      '<textarea id="comment" rows="4" maxlength="1000" placeholder="例如：海外评论看不懂某个中文专有词，或想把本次跨文化拆解整理成知乎文章/想法…"></textarea>' +
      '<div class="draft-helper-row"><button type="button" class="link-btn" id="fillDraftContext">一键填入当前转译语境</button></div></div>' +
      '<div class="modal-foot"><button class="btn btn-primary" id="generateDraft">查讨论并生成草稿</button><button class="btn btn-ghost" id="closeModal">关闭</button></div>';
    draftDialog.inert = false;
    draftDialog.classList.add("on");
    el("comment").focus();
  }

  async function fetchDraft(source: QuestionDraftRequest["source"], targetType?: DraftTarget) {
    const snap = current.run.snapshot;
    if (!adapter || !snap) return;
    const cleanedText = source.text.trim().slice(0, 1000);
    if (!cleanedText) {
      layout.toast("请先提供有效的评论内容");
      return;
    }
    const safeSource: QuestionDraftRequest["source"] = { ...source, text: cleanedText };
    activeDraftSource = safeSource;
    if (targetType) activeDraftTarget = targetType;
    draftController?.abort();
    const controller = new AbortController();
    draftController = controller;
    const modal = draftDialog;
    const footer = '<div class="modal-foot"><button class="btn btn-ghost" id="closeModal">关闭</button></div>';
    const loadingTitle = targetType ? `回流知乎 · ${DRAFT_TARGET_META[targetType].heading}` : "回流知乎";
    modal.innerHTML = "<h3>" + esc(loadingTitle) + '</h3><p class="guide">正在查找知乎已有讨论并按所选板块生成草稿…</p>' + wait + footer;
    modal.inert = false;
    modal.classList.add("on");
    try {
      const termIds = snap.terms.filter((t) => safeSource.keyPointId && t.keyPointIds.includes(safeSource.keyPointId)).map((t) => t.id);
      const d = await adapter.draft(
        { source: safeSource, runId: snap.runId, caseId: snap.caseId, termIds, targetType: targetType ?? null },
        controller.signal,
      );
      if (controller.signal.aborted || !modal.classList.contains("on")) return;
      const effectiveTarget: DraftTarget = d.targetType ?? targetType ?? "question";
      const recommendedTarget: DraftTarget = d.recommendedTarget ?? (d.recommendation === "answer_existing" && d.existing.length > 0 ? "answer" : "question");
      activeDraftTarget = effectiveTarget;
      const meta = DRAFT_TARGET_META[effectiveTarget];
      const destinations = resolveDestinations(d);
      const activeDest = destinations.find((x) => x.targetType === effectiveTarget) ?? destinations[0];
      const recommendExisting = d.recommendation === "answer_existing" && d.existing.length > 0;
      const recommendation = ["failed", "none"].includes(d.existingSource)
        ? "请先在知乎核对相似讨论，再选择对应板块发布。"
        : recommendExisting ? "建议优先在已有讨论下写回答，也可按需切换为文章或想法" : "建议核对相关讨论后发起新问题，或整理为专栏文章/想法";
      const targetTabs = (["answer", "question", "article", "pin"] as DraftTarget[]).map((t) => {
        const isRec = t === recommendedTarget;
        return '<button type="button" class="flow-mode-pill' + (t === effectiveTarget ? " on" : "") +
          '" data-switch-draft-target="' + t + '">' + esc(DRAFT_TARGET_META[t].label) +
          (isRec ? '<span class="flow-rec-dot">推荐</span>' : "") + "</button>";
      }).join("");
      const existingList = d.existing.length
        ? '<ul class="flow-existing-list">' + d.existing.map((x, idx) => {
            const canPreviewAnswers = adapter?.kind === "backend" && /^https:\/\/www\.zhihu\.com\/question\/[0-9]+/.test(x.url);
            return '<li class="flow-existing-item"><div class="flow-existing-row">' +
              sourceLink(x.url, x.title + " ↗") +
              (canPreviewAnswers
                ? '<button type="button" class="flow-qa-btn" data-qa-url="' + esc(x.url) + '" data-qa-slot="qaSlot' + idx + '">看回答摘要</button>'
                : "") +
              '</div><div class="flow-qa-slot" id="qaSlot' + idx + '" hidden></div></li>';
          }).join("") + "</ul>"
        : "";
      const otherDestLinks = destinations
        .filter((dest) => dest.targetType !== effectiveTarget)
        .map((dest) => sourceLink(dest.url, dest.label + " ↗"))
        .join('<span class="flow-sep">·</span>');

      modal.innerHTML = "<h3>回流知乎 · " + esc(meta.heading) + "</h3>" +
        notice(d.sourceLabel + " · " + statusText(d.mode)) +
        '<div class="flow-mode-row" role="tablist" aria-label="切换反哺知乎体裁">' + targetTabs + "</div>" +
        '<div class="flow-summary"><b>' + esc(recommendation) + "</b>" +
        (["failed", "none"].includes(d.existingSource) ? "" : notice(d.recommendationReason)) + "</div>" +
        '<details open class="guide"><summary>已有讨论 · ' + d.existing.length + " 条</summary>" + notice(d.existingNote) +
        existingList +
        '</details><div class="draft"><label for="draftTitle">' + esc(meta.titleLabel) + '</label><input id="draftTitle">' +
        '<label for="draftText">' + esc(meta.bodyLabel) + '</label><textarea id="draftText" rows="5"></textarea></div>' +
        '<div class="flow-dest-card">' +
          '<div class="flow-dest-info"><b>' + esc(activeDest.label) + '</b><span>' + esc(activeDest.description) + "</span></div>" +
          '<div class="flow-dest-actions">' +
            '<button type="button" class="btn btn-primary" id="copyAndGoZhihu" data-dest-url="' + esc(activeDest.url) + '" data-dest-label="' + esc(activeDest.label) + '">复制并' + esc(activeDest.label) + " ↗</button>" +
            '<button type="button" class="btn btn-ghost" id="copyDraft">仅复制草稿</button>' +
          "</div>" +
        "</div>" +
        '<div class="modal-foot flow-other-bar"><span class="meta">其他板块直达：</span>' + otherDestLinks +
        '<span class="spacer"></span><button class="btn btn-ghost" id="closeModal">完成</button></div>';
      el<HTMLInputElement>("draftTitle").value = d.draft.title;
      el<HTMLTextAreaElement>("draftText").value = d.draft.body;
      layout.tlog("question.draft", `${d.sourceLabel} · ${meta.label}`, "ok");
    } catch (e) {
      if (!controller.signal.aborted && modal.classList.contains("on")) modal.innerHTML = '<h3>回流知乎</h3>' + empty(errorText(e)) + footer;
    } finally {
      if (!controller.signal.aborted) void credentials?.refresh();
    }
  }

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      layout.toast("已复制" + label);
    } catch {
      layout.toast("复制失败，请检查浏览器的剪贴板权限");
    }
  }

  function resetWorkbench() {
    runController?.abort();
    revealController?.abort();
    testRevealController?.abort();
    closeAnyBridgePicker();
    invalidateDraft();
    request = undefined;
    termsPresented = false;
    evidencePresented = false;
    readyFinalized = false;
    prevWords = [];
    sourceMarkup = "";
    evidenceMarkup = "";
    el("hero").classList.remove("leaving");
    workbench.classList.remove("enter");
    el("delTitle").textContent = "海外交付";
    el("deliverGate").textContent = "";
    el("deliverGate").className = "meta deliver-gate";
    el("guardBar").textContent = "";
    el("guardSum").textContent = "";
    el("guardSum").className = "meta guard-gate";
    resetPanelScroll();
    current = reducer(current, { type: "reset" });
    layout.reset();
    void credentials?.refresh();
    updateUrl();
  }

  function applyLevel(index: number) {
    const level = availableLevels()[index - 1];
    if (!level || current.level === level) return;
    revealController?.abort();
    testRevealController?.abort();
    current = reducer(current, { type: "level", level });
    invalidateDraft();
    const variant = selectedVariant(current);
    const snap = current.run.snapshot;
    if (variant && snap) {
      renderBridgePanel("diff");
      renderGuard(variant, snap, true);
      if (!readyFinalized) finalizeReady(false);
      else renderDelivery(false);
    }
    if (current.test.status === "done" && current.test.result) {
      void renderTestResult(current.test.result, false);
    }
    updateUrl();
    layout.tlog("translate.switch", LEVEL_LABEL[level]);
  }

  layout.install({
    start(caseId, rawText) {
      if (!adapter) { layout.toast("正在载入后端配置，请稍候或刷新"); return; }
      const trimmedRaw = rawText?.trim();
      const c = cases.find((x) => x.caseId === "case_" + caseId || (trimmedRaw !== undefined && x.text.trim() === trimmedRaw));
      const text = (trimmedRaw ?? c?.text ?? "").trim();
      if (!text || [...text].length > MAX_INPUT_CHARS) { layout.toast("请输入 1–400 字的原文"); return; }
      if (adapter.kind === "offline" && !c) { layout.toast("离线包只包含预置案例"); return; }
      const pickedAud = homeAudience.value;
      const audienceId = c
        ? (c.audiences.some((a) => a.id === pickedAud) ? pickedAud : c.defaultAudienceId)
        : (pickedAud || GENERAL_AUDIENCE.id);
      const targetLanguage: TargetLanguageCode = isTargetLanguageCode(homeLang.value) ? homeLang.value : DEFAULT_TARGET_LANGUAGE;
      if (audienceId) void startRequest({ caseId: c?.caseId ?? null, text, audienceId, targetLanguage });
    },
    setLevel: applyLevel,
    stepLevel(delta) {
      const levels = availableLevels();
      if (levels.length <= 1 || !current.level || current.level === "literal") return;
      const idx = levels.indexOf(current.level);
      if (idx < 0) return;
      const nextIdx = Math.max(0, Math.min(levels.length - 1, idx + delta));
      if (nextIdx !== idx) applyLevel(nextIdx + 1);
    },
    runTest,
    reset: resetWorkbench,
  });
  backHomeBtn.onclick = () => resetWorkbench();
  brand.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      resetWorkbench();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && draftDialog.classList.contains("on")) invalidateDraft();
  }, true);
  document.addEventListener("change", (e) => {
    const box = (e.target as HTMLElement).closest<HTMLInputElement>("[data-service-kp]");
    if (!box) return;
    const key = current.run.keyPoints[Number(box.dataset.serviceKp)]?.id;
    if (!key) return;
    if (box.checked) enabledPoints.add(key);
    else if (enabledPoints.size > 1) enabledPoints.delete(key);
    else { box.checked = true; layout.toast("至少保留一个信息点"); }
    if (current.test.status === "done" && current.test.result) {
      testRevealController?.abort();
      void renderTestResult(current.test.result, false);
    }
  });
  document.addEventListener("submit", (e) => {
    const form = (e.target as HTMLElement).closest<HTMLFormElement>("#cdbAddForm");
    if (!form || !adapter?.addComplianceRule) return;
    e.preventDefault();
    const cat = el<HTMLSelectElement>("cdbCat").value === "custom" ? "custom" : "legal";
    const sev = el<HTMLSelectElement>("cdbSev").value === "warn" ? "warn" : "block";
    const title = el<HTMLInputElement>("cdbTitle").value.trim();
    const mkt = el<HTMLSelectElement>("cdbMkt").value;
    const jurisdiction = el<HTMLInputElement>("cdbJur").value.trim();
    const patterns = el<HTMLInputElement>("cdbPat").value.split(/[,，\n]+/).map((s) => s.trim()).filter(Boolean);
    const reason = el<HTMLInputElement>("cdbReason").value.trim();
    const suggestion = el<HTMLInputElement>("cdbSug").value.trim();
    if (!title || !jurisdiction || !patterns.length || !reason) {
      layout.toast("请填写规则名称、依据、匹配词与风险说明");
      return;
    }
    void (async () => {
      try {
        await adapter!.addComplianceRule!({
          category: cat,
          title,
          markets: [mkt],
          jurisdiction,
          severity: sev,
          patterns,
          reason,
          suggestion,
        });
        rulesModalState.category = cat;
        rulesModalState.showForm = false;
        layout.toast("已写入本地风险数据库");
        await openComplianceDbModal(rulesModalState.scope);
      } catch (err) {
        layout.toast(errorText(err));
      }
    })();
  });
  document.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (target.closest("#sourceBackHome")) { resetWorkbench(); return; }
    if (target.closest(".ev a")) { e.stopPropagation(); return; }
    const term = target.closest<HTMLElement>("#sourceText .src-term, #tags .tag")?.dataset.terms;
    if (term && /^[0-9]+$/.test(term)) {
      const ev = document.querySelector<HTMLElement>('.ev[data-terms~="' + term + '"]');
      if (ev) {
        ev.classList.add("flipped");
        ev.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "nearest" });
      }
    }
    if (target.closest("#retryRun") && request) void startRequest(request);
    if (target.closest("#copyFinal")) {
      const gate = copyGate(current);
      if (gate.enabled) void copy(gate.text.trim(), activeLang().label + "终稿");
    }
    if (target.closest("#copyBilingual")) {
      const gate = copyGate(current);
      if (gate.enabled) {
        const zh = current.run.sourceSegments.map((s) => s.text).join("").trim();
        const text = zh ? zh + "\n" + gate.text.trim() : gate.text.trim();
        void copy(text, "双语对照");
      }
    }
    if (target.closest("#copySrt")) {
      const gate = copyGate(current);
      if (gate.enabled) {
        const zh = current.run.sourceSegments.map((s) => s.text).join("").trim();
        void copy(buildSrtSnippet(gate.text, zh, activeLang()), "SRT 双语字幕");
      }
    }
    if (target.closest("#openRulesDb")) {
      void openComplianceDbModal("market");
      return;
    }
    const cdbCat = target.closest<HTMLElement>("[data-cdb-cat]")?.dataset.cdbCat;
    if (cdbCat === "legal" || cdbCat === "custom") {
      rulesModalState.category = cdbCat;
      renderComplianceDbModal();
      return;
    }
    const cdbScope = target.closest<HTMLElement>("[data-cdb-scope]")?.dataset.cdbScope;
    if (cdbScope === "market" || cdbScope === "all") {
      void openComplianceDbModal(cdbScope);
      return;
    }
    if (target.closest("#cdbToggleAdd")) {
      rulesModalState.showForm = !rulesModalState.showForm;
      renderComplianceDbModal();
      return;
    }
    if (target.closest("#cdbCancelAdd")) {
      rulesModalState.showForm = false;
      renderComplianceDbModal();
      return;
    }
    const delRuleId = target.closest<HTMLElement>("[data-del-rule]")?.dataset.delRule;
    if (delRuleId && adapter?.deleteComplianceRule) {
      void (async () => {
        try {
          await adapter!.deleteComplianceRule!(delRuleId);
          layout.toast("已删除自定义规则");
          await openComplianceDbModal(rulesModalState.scope);
        } catch (err) {
          layout.toast(errorText(err));
        }
      })();
      return;
    }
    if (target.closest("#toggleGlobalSearch")) {
      useGlobalSearch = !useGlobalSearch;
      syncHomeZhihuBar();
      layout.toast(useGlobalSearch ? "已开启全网对照检索，转译时将补充站外语境资料" : "已关闭全网对照检索");
      return;
    }
    const openZtTab = target.closest<HTMLElement>("[data-open-zt]")?.dataset.openZt as ZhihuToolTab | undefined;
    if (openZtTab && zhihuTools) {
      zhihuTools.open(openZtTab);
      return;
    }
    if (target.closest("#manualDraft")) {
      openDraft("question");
      return;
    }
    const quickTarget = target.closest<HTMLElement>("[data-flow-quick]")?.dataset.flowQuick as DraftTarget | undefined;
    if (quickTarget) {
      if (draftAction.length > 0) void fetchDraft(draftAction[0], quickTarget);
      else openDraft(quickTarget);
      return;
    }
    const pickDraftTarget = target.closest<HTMLElement>("[data-pick-draft-target]")?.dataset.pickDraftTarget as DraftTarget | undefined;
    if (pickDraftTarget) {
      activeDraftTarget = pickDraftTarget;
      draftDialog.querySelectorAll<HTMLElement>("[data-pick-draft-target]").forEach((btn) => {
        btn.classList.toggle("on", btn.dataset.pickDraftTarget === pickDraftTarget);
      });
      return;
    }
    if (target.closest("#fillDraftContext")) {
      const ta = document.getElementById("comment") as HTMLTextAreaElement | null;
      if (ta) {
        ta.value = buildContextPrefill();
        ta.focus();
      }
      return;
    }
    const switchTarget = target.closest<HTMLElement>("[data-switch-draft-target]")?.dataset.switchDraftTarget as DraftTarget | undefined;
    if (switchTarget && activeDraftSource && switchTarget !== activeDraftTarget) {
      void fetchDraft(activeDraftSource, switchTarget);
      return;
    }
    const qaBtn = target.closest<HTMLButtonElement>("[data-qa-url]");
    if (qaBtn) {
      const qUrl = qaBtn.dataset.qaUrl!;
      const slotId = qaBtn.dataset.qaSlot!;
      const slot = document.getElementById(slotId);
      if (slot) {
        if (!slot.hidden && slot.dataset.loaded === "1") {
          slot.hidden = true;
          qaBtn.textContent = "看回答摘要";
          return;
        }
        slot.hidden = false;
        if (slot.dataset.loaded === "1") {
          qaBtn.textContent = "收起摘要";
          return;
        }
        qaBtn.disabled = true;
        qaBtn.textContent = "加载中…";
        slot.innerHTML = '<div class="meta">正在拉取知乎已有回答摘要…</div>';
        void (async () => {
          try {
            const res = await zhihuQuestionAnswers(qUrl, 0, 4);
            slot.dataset.loaded = "1";
            if (!res.items.length) {
              slot.innerHTML = '<div class="meta">该问题暂未返回可展示的回答摘要。</div>';
            } else {
              const totalHint = typeof res.paging.totals === "number" ? `（共约 ${res.paging.totals} 条回答，展示前 ${res.items.length} 条）` : "";
              slot.innerHTML =
                '<div class="meta">已有回答摘要' + esc(totalHint) + "</div>" +
                '<ul class="qa-summary-list">' +
                res.items.map((ans) =>
                  '<li><p>' + esc(ans.summary.slice(0, 180)) + (ans.summary.length > 180 ? "…" : "") + "</p>" +
                  sourceLink(ans.url, "查看原回答 ↗") + "</li>",
                ).join("") +
                "</ul>";
            }
            qaBtn.textContent = "收起摘要";
            void credentials?.refresh();
          } catch (err) {
            slot.innerHTML = '<div class="meta">' + esc(errorText(err)) + "</div>";
            qaBtn.textContent = "重试摘要";
          } finally {
            qaBtn.disabled = false;
          }
        })();
      }
      return;
    }
    const button = target.closest<HTMLElement>("[data-service-misreading]");
    if (button) {
      const source = draftAction[Number(button.dataset.serviceMisreading)];
      if (source) void fetchDraft(source);
    }
    if (target.closest("#generateDraft")) {
      const text = el<HTMLTextAreaElement>("comment").value.trim();
      if (text) void fetchDraft({ kind: "manual", text }, activeDraftTarget);
      else layout.toast("请先粘贴评论或点击填入当前转译语境");
    }
    const copyGo = target.closest<HTMLButtonElement>("#copyAndGoZhihu");
    if (copyGo) {
      const destUrl = copyGo.dataset.destUrl || "https://www.zhihu.com/";
      const destLabel = copyGo.dataset.destLabel || "知乎";
      const content = el<HTMLInputElement>("draftTitle").value + "\n\n" + el<HTMLTextAreaElement>("draftText").value;
      void copy(content, "草稿，正在打开" + destLabel);
      window.open(destUrl, "_blank", "noopener,noreferrer");
      return;
    }
    if (target.closest("#copyDraft")) {
      void copy(el<HTMLInputElement>("draftTitle").value + "\n\n" + el<HTMLTextAreaElement>("draftText").value, "草稿");
    }
    if (target.closest("#closeModal")) invalidateDraft();
  }, true);

  homeStatus.textContent = "正在载入后端配置…";
  void (async () => {
    try {
      const service = await pickAdapter();
      const [health, available] = await Promise.all([service.health(), service.cases()]);
      if (!allowStub && health.generationMode === "dev_stub") {
        throw new Error("当前后端是开发占位服务，请启动产品服务");
      }
      adapter = service;
      cases = available;
      const allHomeAudiences: AudienceMeta[] = [GENERAL_AUDIENCE];
      const seenAud = new Set<string>([GENERAL_AUDIENCE.id]);
      for (const a of cases.flatMap((item) => item.audiences)) {
        if (!seenAud.has(a.id)) { seenAud.add(a.id); allHomeAudiences.push(a); }
      }
      const matchedInitial = cases.find((item) => item.text.trim() === input.value.trim());
      homeAudience.setOptions(
        audienceOptionsOf(allHomeAudiences),
        matchedInitial?.defaultAudienceId ?? GENERAL_AUDIENCE.id,
      );
      if (service.kind === "backend") {
        credentials = mountZhihuCredentials();
        zhihuTools = createZhihuTools({
          getSourceText: () =>
            document.body.classList.contains("state-work")
              ? current.run.sourceSegments.map((s) => s.text).join("")
              : input.value,
          getTerms: () => current.run.terms,
          isPersonalMode: () => credentials?.getMode() === "personal",
          openCredentialDialog: () => credentials?.openDialog(),
          getSelectedKbIds: () => selectedKbIds,
          setSelectedKbIds: (ids, labels) => {
            selectedKbIds = ids;
            selectedKbLabels = { ...selectedKbLabels, ...labels };
            syncHomeZhihuBar();
          },
          onImportToComposer: (text, title) => {
            if (document.body.classList.contains("state-work")) resetWorkbench();
            input.value = text;
            updateComposerMeta();
            input.focus();
            layout.toast(title ? `已导入「${title.slice(0, 18)}」至输入框` : "已导入本人知乎内容至输入框");
          },
          toast: (msg) => layout.toast(msg),
          refreshCredentials: () => { void credentials?.refresh(); },
        });
        el("homeZhihuBar").hidden = false;
        el("evidenceTools").hidden = false;
        syncHomeZhihuBar();
      } else {
        workZhihuToolsBtn.style.setProperty("display", "none", "important");
      }
      homeStatus.textContent = allowStub ? statusText(health.generationMode) :
        (health.zhihuLive ? "知乎实时检索已配置" : "知乎来源库可用") +
        (health.generationMode === "live" ? " · 转译模型已配置" : " · 转译模型待配置");
      for (const key of ["a", "b", "c"]) {
        const c = cases.find((item) => item.caseId === "case_" + key);
        const fill = document.querySelector<HTMLButtonElement>('[data-fill="' + key + '"]')!;
        const work = document.querySelector<HTMLButtonElement>('[data-case="' + key + '"]')!;
        if (!c) {
          fill.remove();
          work.remove();
          document.querySelectorAll(".hero-foot kbd").forEach((kbd) => {
            if (kbd.textContent === String(["a", "b", "c"].indexOf(key) + 1)) kbd.remove();
          });
        } else {
          fill.onclick = (e) => {
            e.stopPropagation();
            input.value = c.text;
            homeAudience.setValue(c.defaultAudienceId);
            updateComposerMeta();
            input.focus();
          };
        }
      }
      el("heroChips").style.removeProperty("display");
      updateComposerMeta();
      const c = cases.find((item) => item.caseId === query.get("case"));
      if (c) {
        const audience = c.audiences.find((a) => a.id === query.get("aud"));
        void startRequest(
          { caseId: c.caseId, text: c.text, audienceId: audience?.id ?? c.defaultAudienceId, targetLanguage: initialLang },
          query.get("level"),
        );
      }
    } catch (e) {
      homeStatus.textContent = "后端视图未能载入 · " + errorText(e);
    }
  })();
}
