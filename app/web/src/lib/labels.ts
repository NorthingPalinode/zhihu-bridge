import type { Attribution, Evidence, EvidenceSource, ExportState, Level, Mode, TargetLanguageCode, TargetLanguageMeta } from "./types";

export const DEFAULT_TARGET_LANGUAGE: TargetLanguageCode = "en";

export const TARGET_LANGUAGES: TargetLanguageMeta[] = [
  { code: "en", label: "英语", nativeName: "English", englishName: "English", markets: "美 / 英 / 加 / 澳 / 新", bcp47: "en", rtl: false, cjkLike: false, subtitleSingleMax: 42, subtitleDoubleMax: 84 },
  { code: "ja", label: "日语", nativeName: "日本語", englishName: "Japanese", markets: "日本", bcp47: "ja", rtl: false, cjkLike: true, subtitleSingleMax: 20, subtitleDoubleMax: 40 },
  { code: "ko", label: "韩语", nativeName: "한국어", englishName: "Korean", markets: "韩国", bcp47: "ko", rtl: false, cjkLike: true, subtitleSingleMax: 22, subtitleDoubleMax: 44 },
  { code: "es", label: "西班牙语", nativeName: "Español", englishName: "Spanish", markets: "墨西哥 / 西班牙 / 拉美", bcp47: "es", rtl: false, cjkLike: false, subtitleSingleMax: 42, subtitleDoubleMax: 84 },
  { code: "pt", label: "葡萄牙语", nativeName: "Português", englishName: "Portuguese", markets: "巴西 / 葡萄牙", bcp47: "pt", rtl: false, cjkLike: false, subtitleSingleMax: 42, subtitleDoubleMax: 84 },
  { code: "id", label: "印尼语", nativeName: "Bahasa Indonesia", englishName: "Indonesian", markets: "印度尼西亚", bcp47: "id", rtl: false, cjkLike: false, subtitleSingleMax: 42, subtitleDoubleMax: 84 },
  { code: "th", label: "泰语", nativeName: "ไทย", englishName: "Thai", markets: "泰国", bcp47: "th", rtl: false, cjkLike: true, subtitleSingleMax: 34, subtitleDoubleMax: 68 },
  { code: "vi", label: "越南语", nativeName: "Tiếng Việt", englishName: "Vietnamese", markets: "越南", bcp47: "vi", rtl: false, cjkLike: false, subtitleSingleMax: 42, subtitleDoubleMax: 84 },
  { code: "de", label: "德语", nativeName: "Deutsch", englishName: "German", markets: "德国 / 奥地利 / 瑞士", bcp47: "de", rtl: false, cjkLike: false, subtitleSingleMax: 42, subtitleDoubleMax: 84 },
  { code: "fr", label: "法语", nativeName: "Français", englishName: "French", markets: "法国 / 比利时 / 魁北克", bcp47: "fr", rtl: false, cjkLike: false, subtitleSingleMax: 42, subtitleDoubleMax: 84 },
  { code: "ar", label: "阿拉伯语", nativeName: "العربية", englishName: "Arabic", markets: "沙特 / 阿联酋 / 中东", bcp47: "ar", rtl: true, cjkLike: false, subtitleSingleMax: 38, subtitleDoubleMax: 76 },
  { code: "ru", label: "俄语", nativeName: "Русский", englishName: "Russian", markets: "俄罗斯 / 独联体", bcp47: "ru", rtl: false, cjkLike: false, subtitleSingleMax: 42, subtitleDoubleMax: 84 },
];

const TARGET_LANGUAGE_MAP = new Map<string, TargetLanguageMeta>(TARGET_LANGUAGES.map((l) => [l.code, l]));

export function isTargetLanguageCode(code: string | null | undefined): code is TargetLanguageCode {
  return Boolean(code && TARGET_LANGUAGE_MAP.has(code));
}

export function getTargetLanguage(code?: string | null): TargetLanguageMeta {
  return (code && TARGET_LANGUAGE_MAP.get(code)) || TARGET_LANGUAGES[0];
}

export function levelHelpFor(level: Level, lang: TargetLanguageMeta): string {
  const base = LEVEL_HELP[level];
  return lang.code === "en" ? base : base.replace(/英文/g, lang.label);
}

// 文案以 V6 §5.4 为准；dev_stub 必须显示“开发占位 · 非真实运行”，严禁显示为回放或实时。
export const MODE_LABEL: Record<Mode, string> = {
  live: "实时生成",
  replay: "缓存回放",
  degraded: "已降级",
  dev_stub: "开发占位 · 非真实运行",
};

export const EVIDENCE_SOURCE_LABEL: Record<EvidenceSource, string> = {
  zhihu_live: "知乎实时",
  zhihu_cached: "知乎检索缓存",
  zhihu_curated: "知乎精选",
  other: "站外资料",
  none: "无证据",
};

export const LEVEL_LABEL: Record<Level, string> = {
  literal: "直译参照",
  plain: "通俗版",
  light: "少量术语",
  balanced: "读感平衡",
  technical: "术语优先",
  genre: "保留术语",
  single: "单一终稿",
};

export const LEVEL_HELP: Record<Level, string> = {
  literal: "按原句词义直译，用于比较。",
  plain: "用常见英文解释原意，适合第一次接触这个题材的读者。",
  light: "保留一个辨识度高的术语，其余换成容易读懂的表达。",
  balanced: "正文保留关键术语，把次要解释放到注释。",
  technical: "优先使用题材或行业惯用词，并给难词加一句短释义。",
  genre: "保留题材或行业惯用术语和原文语气，适合对这个领域已有了解的读者。",
  single: "完整保留商品卖点，按目标市场广告法与当地风俗习惯合规转译。",
};

export const RISK_CATEGORY_LABEL = {
  legal: "法律法规",
  custom: "风俗习惯",
} as const;

export const EXPORT_LABEL: Record<ExportState, string> = {
  exportable: "可复制",
  draft: "草稿",
  needs_data: "待补材料",
};

export const ATTRIBUTION_LABEL: Record<Attribution, string> = {
  zhihu: "知乎",
  other: "站外资料",
  model: "模型判断",
  editor: "编辑确认",
};

export const ROLE_LABEL: Record<Evidence["role"], string> = {
  setting: "作品设定",
  context: "语境解释",
  usage: "译法用例",
  counterexample: "反例",
  audience_insight: "受众洞察",
};

export const TERM_KIND_LABEL = {
  culture: "文化概念",
  claim: "功效声称",
  scene: "生活场景",
  context: "语境",
} as const;

/** 作者为空时按内容类型显示，禁止编造署名（V6 §4.4）。 */
export function contentTypeLabel(e: Evidence): string {
  if (e.provider === "other") return "站外资料";
  switch (e.contentType) {
    case "article":
      return "知乎专栏";
    case "answer":
      return "知乎回答";
    case "question":
      return "知乎问题";
    default:
      return "知乎内容";
  }
}

export function evidenceSourceLabel(e: Evidence): string {
  if (e.provider === "other") return "站外资料";
  return EVIDENCE_SOURCE_LABEL[e.sourceMode];
}

export const VERDICT_LABEL = { hit: "命中", missing: "缺失", contradicted: "矛盾" } as const;
