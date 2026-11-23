import {
  zhihuCreatorAccountStats,
  zhihuCreatorComments,
  zhihuCreatorContent,
  zhihuCreatorContentStats,
  zhihuGlobalSearch,
  zhihuKnowledgeBases,
  zhihuKnowledgeItems,
  zhihuKnowledgeSearch,
  zhihuKnowledgeUpload,
  zhihuQuota,
  zhihuZhidaAsk,
} from "./lib/api";
import type {
  CreatorAccountStatsResponse,
  CreatorCommentsResponse,
  CreatorContentDetail,
  CreatorContentStatsResponse,
  GlobalSearchItem,
  KnowledgeBaseItem,
  KnowledgeContentItem,
  KnowledgeSearchHit,
  Term,
  ZhidaModel,
  ZhidaResponse,
  ZhihuQuotaResponse,
} from "./lib/types";

export type ZhihuToolTab = "quota" | "global" | "zhida" | "knowledge" | "creator";

export interface ZhihuToolsContext {
  getSourceText(): string;
  getTerms(): Term[];
  isPersonalMode(): boolean;
  openCredentialDialog(): void;
  getSelectedKbIds(): string[];
  setSelectedKbIds(ids: string[], labels: Record<string, string>): void;
  onImportToComposer(text: string, title?: string): void;
  toast(message: string): void;
  refreshCredentials(): void;
}

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const errMsg = (e: unknown) => (e instanceof Error ? e.message : "请求失败，请稍后重试");

function safeExternalLink(url: string | null | undefined, label: string): string {
  if (!url) return esc(label);
  try {
    const u = new URL(url);
    if (u.protocol === "https:" || u.protocol === "http:") {
      return '<a class="link-btn" href="' + esc(u.href) + '" target="_blank" rel="noopener noreferrer">' + esc(label) + "</a>";
    }
  } catch {
    /* ignore */
  }
  return esc(label);
}

const METRIC_LABELS: Record<string, string> = {
  ReadCount: "阅读数",
  ViewCount: "浏览数",
  UpvoteCount: "赞同数",
  VoteupCount: "赞同数",
  LikeCount: "喜欢/点赞",
  CommentCount: "评论数",
  CollectCount: "收藏数",
  ShareCount: "分享数",
  ThankCount: "感谢数",
  FollowerCount: "关注者",
  NewFollowerCount: "新增关注",
  AnswerCount: "回答数",
  ArticleCount: "文章数",
  PinCount: "想法数",
  ZvideoCount: "视频数",
};

function renderKvObject(obj: Record<string, unknown> | null | undefined, title: string): string {
  if (!obj || typeof obj !== "object") return "";
  const entries = Object.entries(obj).filter(([, v]) => v !== null && v !== undefined && v !== "");
  if (!entries.length) return "";
  const cells = entries.map(([k, v]) => {
    const label = METRIC_LABELS[k] ?? k;
    const val = typeof v === "object" ? JSON.stringify(v) : String(v);
    return '<div class="zt-kv-item"><span class="zt-kv-k">' + esc(label) + '</span><b class="zt-kv-v">' + esc(val) + "</b></div>";
  }).join("");
  return '<div class="zt-kv-section"><div class="zt-sub-h">' + esc(title) + '</div><div class="zt-kv-grid">' + cells + "</div></div>";
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const idx = result.indexOf(",");
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(new Error("读取本地文件失败"));
    reader.readAsDataURL(file);
  });
}

export function createZhihuTools(ctx: ZhihuToolsContext) {
  const dialog = document.createElement("dialog");
  dialog.className = "zt-dialog";
  dialog.setAttribute("aria-labelledby", "ztDialogTitle");
  document.body.append(dialog);

  let activeTab: ZhihuToolTab = "quota";
  let loading = false;
  let errorText = "";

  // Quota state
  let quotaData: ZhihuQuotaResponse | null = null;

  // Global search state
  let globalQuery = "";
  let globalDb: "all" | "realtime" | "static" = "all";
  let globalFilter = "";
  let globalResults: GlobalSearchItem[] = [];
  let globalSource = "";
  let globalSearched = false;

  // Zhida state
  let zhidaQuery = "";
  let zhidaModel: ZhidaModel = "zhida-fast-1p5";
  let zhidaTerm = "";
  let zhidaAnswer: ZhidaResponse | null = null;

  // Knowledge base state
  let kbList: KnowledgeBaseItem[] = [];
  let kbLoaded = false;
  let kbInspectId = "";
  let kbInspectItems: KnowledgeContentItem[] = [];
  let kbSearchQuery = "";
  let kbSearchScope: "selected" | "personal" | "subscription" | "public" = "selected";
  let kbSearchHits: KnowledgeSearchHit[] = [];
  let kbSearched = false;
  let kbUploadNote = "";

  // Creator state
  let creatorSub: "content" | "stats" = "content";
  let creatorUrl = "";
  let creatorDetail: CreatorContentDetail | null = null;
  let creatorComments: CreatorCommentsResponse | null = null;
  let creatorStatsType: "all" | "answer" | "article" | "pin" | "zvideo" = "all";
  let creatorStartDate = "";
  let creatorEndDate = "";
  let creatorAccountStats: CreatorAccountStatsResponse | null = null;
  let creatorContentStats: CreatorContentStatsResponse | null = null;

  function kbLabelsMap(): Record<string, string> {
    const map: Record<string, string> = {};
    for (const kb of kbList) map[kb.knowledgeBaseId] = kb.name;
    return map;
  }

  function defaultQuery(): string {
    const terms = ctx.getTerms();
    if (terms.length) return terms.slice(0, 3).map((t) => t.surface).join(" ") + " 英文 语境";
    const src = ctx.getSourceText().trim();
    return src ? src.slice(0, 28) : "";
  }

  function renderTabs(): string {
    const tabs: Array<{ id: ZhihuToolTab; label: string; tag?: string }> = [
      { id: "quota", label: "能力与额度" },
      { id: "global", label: "全网对照" },
      { id: "zhida", label: "知乎直答" },
      { id: "knowledge", label: "知识库", tag: ctx.getSelectedKbIds().length ? String(ctx.getSelectedKbIds().length) : undefined },
      { id: "creator", label: "本人创作", tag: ctx.isPersonalMode() ? "已解锁" : "个人密钥" },
    ];
    return '<div class="zt-tabs" role="tablist">' +
      tabs.map((t) =>
        '<button type="button" role="tab" aria-selected="' + String(activeTab === t.id) +
        '" class="zt-tab' + (activeTab === t.id ? " on" : "") + '" data-zt-tab="' + t.id + '">' +
        esc(t.label) + (t.tag ? '<span class="zt-tab-badge">' + esc(t.tag) + "</span>" : "") + "</button>",
      ).join("") +
      "</div>";
  }

  function renderQuotaTab(): string {
    if (loading && !quotaData) return '<div class="zt-loading">正在查询知乎开放平台各能力组额度…</div>';
    if (!quotaData) {
      return '<div class="zt-empty">暂未获取额度信息。<button type="button" class="btn btn-ghost" data-zt-action="loadQuota">重新查询</button></div>';
    }
    const q = quotaData;
    const modeLabel = q.mode === "personal" ? "个人 Access Secret" : "项目共享凭据";
    const rows = q.items.map((it) => {
      const personalLock = it.personalOnly && q.mode !== "personal";
      const remain = it.remainingQuota !== null
        ? '<b>' + it.remainingQuota + "</b>" + (it.totalQuota !== null ? " / " + it.totalQuota : "")
        : personalLock ? '<span class="zt-pill-muted">需个人密钥</span>' : '<span class="zt-pill-muted">未返回</span>';
      return '<div class="zt-quota-card">' +
        '<div class="zt-quota-head"><b>' + esc(it.apiName) + '</b><code>' + esc(it.apiId) + "</code></div>" +
        '<div class="zt-quota-val">' + remain + "</div></div>";
    }).join("");
    return '<div class="zt-bar">' +
      '<span class="zt-chip-info">当前身份：<b>' + esc(modeLabel) + "</b>" + (q.live ? " · 实时查询" : " · 本地配置视图") + "</span>" +
      '<button type="button" class="btn btn-ghost zt-sm" data-zt-action="loadQuota">刷新额度</button>' +
      "</div>" +
      (q.note ? '<p class="zt-note">' + esc(q.note) + "</p>" : "") +
      '<div class="zt-quota-grid">' + rows + "</div>" +
      '<p class="zt-footnote">说明：已接入知乎搜索、全网搜索、问题发现（含回答摘要）、知乎直答、知识库与本人创作能力；热榜与知乎用户数据能力暂未启用。单一能力组额度耗尽时会自动降级，不阻断主转译流程。</p>';
  }

  function renderGlobalTab(): string {
    const terms = ctx.getTerms();
    const termChips = terms.length
      ? '<div class="zt-chip-row"><span class="zt-muted">按术语速查：</span>' +
        terms.slice(0, 6).map((t) =>
          '<button type="button" class="zt-quick-chip" data-zt-global-term="' + esc(t.surface) + '">#' + esc(t.surface) + "</button>",
        ).join("") + "</div>"
      : "";
    const resultsHtml = loading
      ? '<div class="zt-loading">正在执行全网对照检索…</div>'
      : globalResults.length
        ? '<div class="zt-list">' + globalResults.map((it) =>
            '<article class="zt-card">' +
            '<div class="zt-card-top"><span class="zt-badge">' + esc(it.host || "全网来源") + '</span>' +
            (it.author ? '<span class="zt-muted">' + esc(it.author) + "</span>" : "") + "</div>" +
            '<div class="zt-card-title">' + safeExternalLink(it.url, it.title + " ↗") + "</div>" +
            (it.contentText ? '<p class="zt-card-body">' + esc(it.contentText.slice(0, 260)) + (it.contentText.length > 260 ? "…" : "") + "</p>" : "") +
            "</article>",
          ).join("") + "</div>"
        : globalSearched
          ? '<div class="zt-empty">未检索到匹配的全网对照结果，可调整关键词或过滤条件后重试。</div>'
          : '<div class="zt-empty">输入关键词查询海外站外语境或行业规范（例如搭配 <code>site:reddit.com</code> 或 <code>site:fda.gov</code>），与知乎站内循证形成双视角对照。</div>';

    return termChips +
      '<form class="zt-form" data-zt-form="global">' +
        '<div class="zt-input-row">' +
          '<input type="text" id="ztGlobalQuery" placeholder="输入全网检索词，如：雷劫 wuxia tribulation 或 FDA claims" value="' + esc(globalQuery) + '" maxlength="200" required>' +
          '<button type="submit" class="btn btn-primary zt-sm"' + (loading ? " disabled" : "") + ">全网检索</button>" +
        "</div>" +
        '<div class="zt-sub-row">' +
          '<label>库范围 <select id="ztGlobalDb">' +
            '<option value="all"' + (globalDb === "all" ? " selected" : "") + ">全部（all）</option>" +
            '<option value="realtime"' + (globalDb === "realtime" ? " selected" : "") + ">实时（realtime）</option>" +
            '<option value="static"' + (globalDb === "static" ? " selected" : "") + ">静态（static）</option>" +
          "</select></label>" +
          '<label class="zt-grow">高级过滤（可选）<input type="text" id="ztGlobalFilter" placeholder="如 site:reddit.com OR site:fda.gov" value="' + esc(globalFilter) + '" maxlength="200"></label>' +
        "</div>" +
      "</form>" +
      (globalSource ? '<div class="zt-meta-line">来源：' + esc(globalSource === "cache" ? "缓存命中" : "知乎开放平台实时全网搜索") + " · " + globalResults.length + " 条</div>" : "") +
      resultsHtml;
  }

  function renderZhidaTab(): string {
    const terms = ctx.getTerms();
    const termChips = terms.length
      ? '<div class="zt-chip-row"><span class="zt-muted">点词追问：</span>' +
        terms.slice(0, 6).map((t) =>
          '<button type="button" class="zt-quick-chip' + (zhidaTerm === t.surface ? " on" : "") +
          '" data-zt-zhida-term="' + esc(t.surface) + '">追问「' + esc(t.surface) + "」</button>",
        ).join("") + "</div>"
      : "";
    const answerHtml = loading
      ? '<div class="zt-loading">知乎直答思考中，请稍候…</div>'
      : zhidaAnswer
        ? '<div class="zt-answer">' +
            '<div class="zt-answer-meta"><span>模型：<b>' + esc(zhidaAnswer.model) + "</b></span><span>" + esc(zhidaAnswer.disclaimer) + "</span></div>" +
            (zhidaAnswer.reasoningContent
              ? '<details class="zt-reasoning"><summary>查看思考过程</summary><pre>' + esc(zhidaAnswer.reasoningContent) + "</pre></details>"
              : "") +
            '<div class="zt-answer-body">' + esc(zhidaAnswer.content).replace(/\n/g, "<br>") + "</div>" +
          "</div>"
        : '<div class="zt-empty">对当前原文中的文化专有词、方言或合规边界有疑问时，可按需向知乎直答发起追问。直答结果作为背景参考，不替代原始知乎回答证据。</div>';

    return termChips +
      '<form class="zt-form" data-zt-form="zhida">' +
        '<div class="zt-sub-row">' +
          '<label>模型档位 <select id="ztZhidaModel">' +
            '<option value="zhida-fast-1p5"' + (zhidaModel === "zhida-fast-1p5" ? " selected" : "") + ">快速回答（zhida-fast-1p5）</option>" +
            '<option value="zhida-thinking-1p5"' + (zhidaModel === "zhida-thinking-1p5" ? " selected" : "") + ">深度思考（zhida-thinking-1p5）</option>" +
            '<option value="zhida-agent"' + (zhidaModel === "zhida-agent" ? " selected" : "") + ">智能思考（zhida-agent）</option>" +
          "</select></label>" +
        "</div>" +
        '<div class="zt-input-row">' +
          '<input type="text" id="ztZhidaQuery" placeholder="例如：「回南天」在英语国家有没有对应的生活化说法？" value="' + esc(zhidaQuery) + '" maxlength="500" required>' +
          '<button type="submit" class="btn btn-primary zt-sm"' + (loading ? " disabled" : "") + ">发起追问</button>" +
        "</div>" +
      "</form>" +
      answerHtml;
  }

  function renderKnowledgeTab(): string {
    const selected = new Set(ctx.getSelectedKbIds());
    const kbCards = kbList.length
      ? '<div class="zt-kb-grid">' + kbList.map((kb) => {
          const checked = selected.has(kb.knowledgeBaseId);
          return '<div class="zt-kb-card' + (checked ? " on" : "") + '">' +
            '<label class="zt-kb-pick"><input type="checkbox" data-zt-kb-toggle="' + esc(kb.knowledgeBaseId) + '"' + (checked ? " checked" : "") + '>' +
            '<span><b>' + esc(kb.name) + '</b><small>' + esc(kb.relation || "知识库") + " · " + kb.contentCount + " 项" + (kb.isDefault ? " · 默认" : "") + "</small></span></label>" +
            (kb.description ? '<p class="zt-kb-desc">' + esc(kb.description) + "</p>" : "") +
            '<button type="button" class="link-btn" data-zt-kb-items="' + esc(kb.knowledgeBaseId) + '">查看条目</button>' +
          "</div>";
        }).join("") + "</div>"
      : kbLoaded
        ? '<div class="zt-empty">当前账号下暂未发现知乎知识库，或未开启实时知识库权限。</div>'
        : '<div class="zt-loading">正在读取知乎知识库列表…</div>';

    const inspectHtml = kbInspectId
      ? '<div class="zt-subbox"><div class="zt-sub-h">知识库内容预览（ID: ' + esc(kbInspectId) + "）</div>" +
        (kbInspectItems.length
          ? '<ul class="zt-compact-list">' + kbInspectItems.map((it) =>
              '<li>' + safeExternalLink(it.originUrl, it.title + (it.originUrl ? " ↗" : "")) +
              (it.abstract ? '<div class="zt-muted">' + esc(it.abstract.slice(0, 120)) + "</div>" : "") + "</li>",
            ).join("") + "</ul>"
          : '<div class="zt-muted">该知识库暂无内容条目。</div>') +
        "</div>"
      : "";

    const uploadHtml = ctx.isPersonalMode()
      ? '<div class="zt-subbox"><div class="zt-sub-h">上传术语表 / 合规手册到知乎知识库</div>' +
        '<div class="zt-input-row">' +
          '<input type="file" id="ztKbFile" accept=".txt,.md,.pdf,.doc,.docx,.csv,.json">' +
          '<button type="button" class="btn btn-ghost zt-sm" data-zt-action="uploadKb"' + (loading ? " disabled" : "") + ">上传至默认/首个选中知识库</button>" +
        "</div>" +
        (kbUploadNote ? '<p class="zt-note">' + esc(kbUploadNote) + "</p>" : "") +
        "</div>"
      : '<div class="zt-subbox zt-muted">提示：上传私有术语表到知识库需先在首页底部导入个人 Access Secret。</div>';

    const hitsHtml = kbSearchHits.length
      ? '<div class="zt-list">' + kbSearchHits.map((h) =>
          '<article class="zt-card">' +
          '<div class="zt-card-title">' + safeExternalLink(h.originUrl, (h.title || "知识库片段") + (h.originUrl ? " ↗" : "")) + "</div>" +
          '<div class="zt-chunks">' + h.content.map((c) => "<p>" + esc(c) + "</p>").join("") + "</div>" +
          "</article>",
        ).join("") + "</div>"
      : kbSearched
        ? '<div class="zt-empty">未召回匹配的知识库片段。</div>'
        : "";

    return '<div class="zt-bar">' +
      '<span class="zt-muted">勾选的知识库会在「开始转译」时自动参与 RAG 术语/设定约束（已选 ' + selected.size + " 个）</span>" +
      '<button type="button" class="btn btn-ghost zt-sm" data-zt-action="loadKb">刷新知识库</button>' +
      "</div>" +
      kbCards +
      inspectHtml +
      '<form class="zt-form" data-zt-form="kbSearch">' +
        '<div class="zt-sub-h">知识库 RAG 语义检索</div>' +
        '<div class="zt-input-row">' +
          '<input type="text" id="ztKbQuery" placeholder="输入术语、品牌设定或合规条款关键词" value="' + esc(kbSearchQuery) + '" maxlength="200" required>' +
          '<select id="ztKbScope">' +
            '<option value="selected"' + (kbSearchScope === "selected" ? " selected" : "") + ">已勾选知识库</option>" +
            '<option value="personal"' + (kbSearchScope === "personal" ? " selected" : "") + ">个人知识库（personal）</option>" +
            '<option value="subscription"' + (kbSearchScope === "subscription" ? " selected" : "") + ">订阅知识库（subscription）</option>" +
            '<option value="public"' + (kbSearchScope === "public" ? " selected" : "") + ">公共知识库（public）</option>" +
          "</select>" +
          '<button type="submit" class="btn btn-primary zt-sm"' + (loading ? " disabled" : "") + ">检索片段</button>" +
        "</div>" +
      "</form>" +
      hitsHtml +
      uploadHtml;
  }

  function renderCreatorTab(): string {
    if (!ctx.isPersonalMode()) {
      return '<div class="zt-gate">' +
        '<h4>本人创作能力仅支持个人 Access Secret</h4>' +
        '<p>导入你的个人知乎 Access Secret 后，可读取本人回答/文章/想法/视频全文与评论（一键导入转译舱），以及追踪本人账号与单篇内容数据表现。</p>' +
        '<button type="button" class="btn btn-primary" data-zt-action="openCredential">导入个人 Access Secret</button>' +
        "</div>";
    }
    const subTabs = '<div class="zt-subtabs">' +
      '<button type="button" class="zt-pill' + (creatorSub === "content" ? " on" : "") + '" data-zt-creator-sub="content">导入本人内容与评论</button>' +
      '<button type="button" class="zt-pill' + (creatorSub === "stats" ? " on" : "") + '" data-zt-creator-sub="stats">创作数据统计</button>' +
      '<button type="button" class="zt-pill" data-zt-action="openCredential">管理个人密钥</button>' +
      "</div>";

    if (creatorSub === "content") {
      const detailHtml = creatorDetail
        ? '<div class="zt-card">' +
            '<div class="zt-card-top"><span class="zt-badge">' + esc(creatorDetail.contentType) + "</span>" +
            safeExternalLink(creatorDetail.url, "知乎原链接 ↗") + "</div>" +
            '<div class="zt-card-title">' + esc(creatorDetail.title || creatorDetail.questionTitle || "本人知乎内容") + "</div>" +
            '<p class="zt-card-body">' + esc(creatorDetail.plainText.slice(0, 420)) + (creatorDetail.plainText.length > 420 ? "…" : "") + "</p>" +
            '<div class="zt-actions-row">' +
              '<button type="button" class="btn btn-primary zt-sm" data-zt-action="importCreatorText">导入节选到转译舱（≤400字）</button>' +
              '<button type="button" class="btn btn-ghost zt-sm" data-zt-action="loadCreatorComments">查看评论洞察</button>' +
            "</div>" +
          "</div>"
        : "";
      const commentsHtml = creatorComments
        ? '<div class="zt-subbox"><div class="zt-sub-h">评论洞察（' + creatorComments.items.length + " 条）</div>" +
          (creatorComments.items.length
            ? '<ul class="zt-compact-list">' + creatorComments.items.map((entry) =>
                '<li><b>' + esc(entry.comment.content || "（空评论）") + "</b>" +
                (typeof entry.comment.likeCount === "number" ? ' <span class="zt-muted">赞 ' + entry.comment.likeCount + "</span>" : "") +
                (entry.children.length
                  ? '<div class="zt-muted">回复：' + entry.children.slice(0, 2).map((ch) => esc(ch.content)).join(" / ") + "</div>"
                  : "") + "</li>",
              ).join("") + "</ul>"
            : '<div class="zt-muted">暂无评论记录。</div>') +
          "</div>"
        : "";
      return subTabs +
        '<form class="zt-form" data-zt-form="creatorContent">' +
          '<label>本人知乎内容链接（支持回答、专栏文章、想法、视频）</label>' +
          '<div class="zt-input-row">' +
            '<input type="url" id="ztCreatorUrl" placeholder="https://www.zhihu.com/question/.../answer/... 或 https://zhuanlan.zhihu.com/p/..." value="' + esc(creatorUrl) + '" required>' +
            '<button type="submit" class="btn btn-primary zt-sm"' + (loading ? " disabled" : "") + ">读取全文</button>" +
          "</div>" +
        "</form>" +
        (loading ? '<div class="zt-loading">正在读取本人知乎内容…</div>' : "") +
        detailHtml + commentsHtml;
    }

    const accountHtml = creatorAccountStats
      ? '<div class="zt-card">' +
          '<div class="zt-card-top"><span class="zt-badge">账号汇总 · ' + esc(creatorAccountStats.contentType) + "</span>" +
          (creatorAccountStats.status ? '<span class="zt-muted">状态：' + esc(creatorAccountStats.status) + "</span>" : "") + "</div>" +
          (creatorAccountStats.reason ? '<p class="zt-note">' + esc(creatorAccountStats.reason) + "</p>" : "") +
          renderKvObject(creatorAccountStats.metrics, "核心指标") +
          renderKvObject(creatorAccountStats.creationCounts, "创作数量") +
          renderKvObject(creatorAccountStats.followers, "粉丝概览") +
          renderKvObject(creatorAccountStats.audience, "受众概况") +
        "</div>"
      : "";

    const contentStatsHtml = creatorContentStats
      ? '<div class="zt-card"><div class="zt-sub-h">单篇内容统计</div>' +
        (creatorContentStats.items.length
          ? creatorContentStats.items.map((it) =>
              '<div class="zt-stat-item"><div class="zt-card-title">' + safeExternalLink(it.url, (it.title || it.contentToken || "单篇内容") + " ↗") + "</div>" +
              (it.reason ? '<p class="zt-note">' + esc(it.reason) + "</p>" : "") +
              renderKvObject(it.metrics, "单篇表现") +
              renderKvObject(it.audience, "单篇受众") + "</div>",
            ).join("")
          : '<div class="zt-muted">接口未返回该内容的统计项。</div>') +
        "</div>"
      : "";

    return subTabs +
      '<form class="zt-form" data-zt-form="creatorStats">' +
        '<div class="zt-sub-row">' +
          '<label>体裁 <select id="ztStatsType">' +
            '<option value="all"' + (creatorStatsType === "all" ? " selected" : "") + ">全部（all）</option>" +
            '<option value="answer"' + (creatorStatsType === "answer" ? " selected" : "") + ">回答（answer）</option>" +
            '<option value="article"' + (creatorStatsType === "article" ? " selected" : "") + ">文章（article）</option>" +
            '<option value="pin"' + (creatorStatsType === "pin" ? " selected" : "") + ">想法（pin）</option>" +
            '<option value="zvideo"' + (creatorStatsType === "zvideo" ? " selected" : "") + ">视频（zvideo）</option>" +
          "</select></label>" +
          '<label>开始日期 <input type="date" id="ztStatsStart" value="' + esc(creatorStartDate) + '"></label>' +
          '<label>结束日期 <input type="date" id="ztStatsEnd" value="' + esc(creatorEndDate) + '"></label>' +
          '<button type="submit" class="btn btn-primary zt-sm"' + (loading ? " disabled" : "") + ">查账号统计</button>" +
        "</div>" +
        '<div class="zt-input-row">' +
          '<input type="url" id="ztStatsUrl" placeholder="可选：输入本人单篇内容链接查单篇表现" value="' + esc(creatorUrl) + '">' +
          '<button type="button" class="btn btn-ghost zt-sm" data-zt-action="loadContentStats"' + (loading ? " disabled" : "") + ">查单篇统计</button>" +
        "</div>" +
      "</form>" +
      (loading ? '<div class="zt-loading">正在查询本人创作统计…</div>' : "") +
      accountHtml + contentStatsHtml;
  }

  function render() {
    let body = "";
    if (activeTab === "quota") body = renderQuotaTab();
    else if (activeTab === "global") body = renderGlobalTab();
    else if (activeTab === "zhida") body = renderZhidaTab();
    else if (activeTab === "knowledge") body = renderKnowledgeTab();
    else body = renderCreatorTab();

    dialog.innerHTML =
      '<div class="zt-head">' +
        '<div><h3 id="ztDialogTitle">知乎开放平台能力工作台</h3>' +
        '<p class="zt-subtitle">全网对照 · 知乎直答 · 知识库 RAG · 本人创作能力 · 额度管理</p></div>' +
        '<button type="button" class="btn btn-ghost zt-sm" data-zt-action="close">关闭</button>' +
      "</div>" +
      renderTabs() +
      (errorText ? '<div class="zt-error" role="alert">' + esc(errorText) + "</div>" : "") +
      '<div class="zt-body">' + body + "</div>";
  }

  async function loadQuota() {
    loading = true;
    errorText = "";
    render();
    try {
      quotaData = await zhihuQuota();
    } catch (e) {
      errorText = errMsg(e);
    } finally {
      loading = false;
      render();
    }
  }

  async function loadKnowledgeBases() {
    loading = true;
    errorText = "";
    render();
    try {
      const res = await zhihuKnowledgeBases("all");
      kbList = res.items;
      kbLoaded = true;
    } catch (e) {
      kbLoaded = true;
      errorText = errMsg(e);
    } finally {
      loading = false;
      render();
    }
  }

  async function runGlobalSearch() {
    if (!globalQuery.trim()) return;
    loading = true;
    errorText = "";
    render();
    try {
      const res = await zhihuGlobalSearch({
        query: globalQuery.trim(),
        count: 6,
        searchDb: globalDb,
        filter: globalFilter.trim(),
      });
      globalResults = res.items;
      globalSource = res.source;
      globalSearched = true;
      ctx.refreshCredentials();
    } catch (e) {
      errorText = errMsg(e);
    } finally {
      loading = false;
      render();
    }
  }

  async function runZhidaAsk() {
    if (!zhidaQuery.trim()) return;
    loading = true;
    errorText = "";
    render();
    try {
      zhidaAnswer = await zhihuZhidaAsk({
        query: zhidaQuery.trim(),
        model: zhidaModel,
        term: zhidaTerm || null,
        sourceText: ctx.getSourceText().trim().slice(0, 400) || null,
      });
      ctx.refreshCredentials();
    } catch (e) {
      errorText = errMsg(e);
    } finally {
      loading = false;
      render();
    }
  }

  async function runKbSearch() {
    if (!kbSearchQuery.trim()) return;
    loading = true;
    errorText = "";
    render();
    try {
      const selected = ctx.getSelectedKbIds();
      const body = kbSearchScope === "selected" && selected.length
        ? { query: kbSearchQuery.trim(), knowledgeBaseIds: selected, limit: 5 }
        : {
            query: kbSearchQuery.trim(),
            recallScopes: [kbSearchScope === "selected" ? "personal" : kbSearchScope] as Array<"personal" | "subscription" | "public">,
            limit: 5,
          };
      const res = await zhihuKnowledgeSearch(body);
      kbSearchHits = res.items;
      kbSearched = true;
      ctx.refreshCredentials();
    } catch (e) {
      errorText = errMsg(e);
    } finally {
      loading = false;
      render();
    }
  }

  dialog.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") dialog.close();
  });

  dialog.addEventListener("change", (e) => {
    const t = e.target as HTMLElement;
    const kbToggle = t.closest<HTMLInputElement>("[data-zt-kb-toggle]");
    if (kbToggle) {
      const id = kbToggle.dataset.ztKbToggle!;
      const next = new Set(ctx.getSelectedKbIds());
      if (kbToggle.checked) next.add(id);
      else next.delete(id);
      ctx.setSelectedKbIds([...next], kbLabelsMap());
      render();
    }
  });

  dialog.addEventListener("submit", (e) => {
    const form = (e.target as HTMLElement).closest<HTMLFormElement>("[data-zt-form]");
    if (!form) return;
    e.preventDefault();
    const kind = form.dataset.ztForm;
    if (kind === "global") {
      globalQuery = (dialog.querySelector<HTMLInputElement>("#ztGlobalQuery")?.value ?? "").trim();
      globalDb = (dialog.querySelector<HTMLSelectElement>("#ztGlobalDb")?.value as "all" | "realtime" | "static") || "all";
      globalFilter = (dialog.querySelector<HTMLInputElement>("#ztGlobalFilter")?.value ?? "").trim();
      void runGlobalSearch();
    } else if (kind === "zhida") {
      zhidaQuery = (dialog.querySelector<HTMLInputElement>("#ztZhidaQuery")?.value ?? "").trim();
      zhidaModel = (dialog.querySelector<HTMLSelectElement>("#ztZhidaModel")?.value as ZhidaModel) || "zhida-fast-1p5";
      void runZhidaAsk();
    } else if (kind === "kbSearch") {
      kbSearchQuery = (dialog.querySelector<HTMLInputElement>("#ztKbQuery")?.value ?? "").trim();
      kbSearchScope = (dialog.querySelector<HTMLSelectElement>("#ztKbScope")?.value as typeof kbSearchScope) || "selected";
      void runKbSearch();
    } else if (kind === "creatorContent") {
      creatorUrl = (dialog.querySelector<HTMLInputElement>("#ztCreatorUrl")?.value ?? "").trim();
      void (async () => {
        loading = true;
        errorText = "";
        creatorComments = null;
        render();
        try {
          creatorDetail = await zhihuCreatorContent(creatorUrl);
        } catch (err) {
          errorText = errMsg(err);
        } finally {
          loading = false;
          render();
        }
      })();
    } else if (kind === "creatorStats") {
      creatorStatsType = (dialog.querySelector<HTMLSelectElement>("#ztStatsType")?.value as typeof creatorStatsType) || "all";
      creatorStartDate = dialog.querySelector<HTMLInputElement>("#ztStatsStart")?.value ?? "";
      creatorEndDate = dialog.querySelector<HTMLInputElement>("#ztStatsEnd")?.value ?? "";
      void (async () => {
        loading = true;
        errorText = "";
        render();
        try {
          creatorAccountStats = await zhihuCreatorAccountStats({
            contentType: creatorStatsType,
            startDate: creatorStartDate || undefined,
            endDate: creatorEndDate || undefined,
          });
        } catch (err) {
          errorText = errMsg(err);
        } finally {
          loading = false;
          render();
        }
      })();
    }
  });

  dialog.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const tabBtn = target.closest<HTMLElement>("[data-zt-tab]");
    if (tabBtn) {
      const next = tabBtn.dataset.ztTab as ZhihuToolTab;
      switchTab(next);
      return;
    }
    const creatorSubBtn = target.closest<HTMLElement>("[data-zt-creator-sub]");
    if (creatorSubBtn) {
      creatorSub = creatorSubBtn.dataset.ztCreatorSub === "stats" ? "stats" : "content";
      errorText = "";
      render();
      return;
    }
    const globalTerm = target.closest<HTMLElement>("[data-zt-global-term]")?.dataset.ztGlobalTerm;
    if (globalTerm) {
      globalQuery = `${globalTerm} English meaning usage`;
      void runGlobalSearch();
      return;
    }
    const zhidaTermBtn = target.closest<HTMLElement>("[data-zt-zhida-term]")?.dataset.ztZhidaTerm;
    if (zhidaTermBtn) {
      zhidaTerm = zhidaTermBtn;
      zhidaQuery = `在出海本地化语境下，中文「${zhidaTermBtn}」的核心含义是什么？海外读者最容易产生哪些误解，建议如何转译？`;
      void runZhidaAsk();
      return;
    }
    const kbItemsId = target.closest<HTMLElement>("[data-zt-kb-items]")?.dataset.ztKbItems;
    if (kbItemsId) {
      void (async () => {
        loading = true;
        errorText = "";
        render();
        try {
          const res = await zhihuKnowledgeItems(kbItemsId);
          kbInspectId = kbItemsId;
          kbInspectItems = res.items;
        } catch (err) {
          errorText = errMsg(err);
        } finally {
          loading = false;
          render();
        }
      })();
      return;
    }
    const action = target.closest<HTMLElement>("[data-zt-action]")?.dataset.ztAction;
    if (!action) return;
    if (action === "close") {
      dialog.close();
    } else if (action === "loadQuota") {
      void loadQuota();
    } else if (action === "loadKb") {
      void loadKnowledgeBases();
    } else if (action === "openCredential") {
      dialog.close();
      ctx.openCredentialDialog();
    } else if (action === "uploadKb") {
      const fileInput = dialog.querySelector<HTMLInputElement>("#ztKbFile");
      const file = fileInput?.files?.[0];
      if (!file) {
        ctx.toast("请先选择要上传的本地文件");
        return;
      }
      if (file.size > 10 * 1024 * 1024) {
        ctx.toast("文件大小不能超过 10 MiB");
        return;
      }
      void (async () => {
        loading = true;
        errorText = "";
        kbUploadNote = "";
        render();
        try {
          const b64 = await readFileAsBase64(file);
          const selected = ctx.getSelectedKbIds();
          const res = await zhihuKnowledgeUpload({
            fileName: file.name,
            contentBase64: b64,
            contentType: file.type || "application/octet-stream",
            knowledgeBaseId: selected[0] ?? null,
          });
          kbUploadNote = `已上传「${res.fileName}」到知识库 ${res.knowledgeBaseId}（条目 ID: ${res.recallContentId}）`;
          ctx.toast("文件已上传至知乎知识库");
          await loadKnowledgeBases();
        } catch (err) {
          errorText = errMsg(err);
          loading = false;
          render();
        }
      })();
    } else if (action === "importCreatorText" && creatorDetail) {
      const text = (creatorDetail.excerpt || creatorDetail.plainText).trim().slice(0, 400);
      if (!text) {
        ctx.toast("该内容暂无可导入的正文文本");
        return;
      }
      dialog.close();
      ctx.onImportToComposer(text, creatorDetail.title);
    } else if (action === "loadCreatorComments" && creatorDetail) {
      void (async () => {
        loading = true;
        errorText = "";
        render();
        try {
          creatorComments = await zhihuCreatorComments(creatorDetail!.url, 0, 20, "score");
        } catch (err) {
          errorText = errMsg(err);
        } finally {
          loading = false;
          render();
        }
      })();
    } else if (action === "loadContentStats") {
      creatorUrl = (dialog.querySelector<HTMLInputElement>("#ztStatsUrl")?.value ?? "").trim();
      creatorStartDate = dialog.querySelector<HTMLInputElement>("#ztStatsStart")?.value ?? "";
      creatorEndDate = dialog.querySelector<HTMLInputElement>("#ztStatsEnd")?.value ?? "";
      if (!creatorUrl) {
        ctx.toast("请输入本人知乎内容链接");
        return;
      }
      void (async () => {
        loading = true;
        errorText = "";
        render();
        try {
          creatorContentStats = await zhihuCreatorContentStats({
            contentUrl: creatorUrl,
            startDate: creatorStartDate || undefined,
            endDate: creatorEndDate || undefined,
          });
        } catch (err) {
          errorText = errMsg(err);
        } finally {
          loading = false;
          render();
        }
      })();
    }
  });

  function switchTab(tab: ZhihuToolTab) {
    activeTab = tab;
    errorText = "";
    if (tab === "global" && !globalQuery) globalQuery = defaultQuery();
    if (tab === "knowledge" && !kbSearchQuery) kbSearchQuery = defaultQuery();
    if (tab === "zhida" && !zhidaQuery) {
      const firstTerm = ctx.getTerms()[0]?.surface;
      if (firstTerm) {
        zhidaTerm = firstTerm;
        zhidaQuery = `中文「${firstTerm}」在知乎社区里通常如何解释？面向海外读者转译时要注意什么？`;
      }
    }
    render();
    if (tab === "quota") void loadQuota();
    if (tab === "knowledge" && !kbLoaded) void loadKnowledgeBases();
  }

  function open(tab: ZhihuToolTab = "quota", presetTerm?: string) {
    if (presetTerm) {
      if (tab === "zhida") {
        zhidaTerm = presetTerm;
        zhidaQuery = `在出海本地化语境下，中文「${presetTerm}」的核心含义是什么？海外读者最容易产生哪些误解，建议如何转译？`;
      } else if (tab === "global") {
        globalQuery = `${presetTerm} English meaning usage`;
      }
    }
    switchTab(tab);
    if (!dialog.open) dialog.showModal();
  }

  return { open, close: () => dialog.close() };
}
