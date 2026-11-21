"""目标出海语言注册表与文字脚本校验。

按中国产品出海（短剧/游戏/硬件众筹/跨境电商/消费品）核心目标市场及其官方语言排序。
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional

DEFAULT_LANGUAGE = "en"

HAN_RE = re.compile(r"[㐀-鿿]")
KANA_RE = re.compile(r"[぀-ゟ゠-ヿ]")
HANGUL_RE = re.compile(r"[가-힯]")
THAI_RE = re.compile(r"[฀-๿]")
ARABIC_RE = re.compile(r"[؀-ۿ]")
CYRILLIC_RE = re.compile(r"[Ѐ-ӿ]")


@dataclass(frozen=True)
class TargetLanguage:
    code: str
    label: str
    nativeName: str
    englishName: str
    markets: str
    bcp47: str
    rtl: bool = False
    cjkLike: bool = False
    subtitleSingleMax: int = 42
    subtitleDoubleMax: int = 84
    promptHint: str = ""

    def public(self) -> dict:
        return {
            "code": self.code,
            "label": self.label,
            "nativeName": self.nativeName,
            "englishName": self.englishName,
            "markets": self.markets,
            "bcp47": self.bcp47,
            "rtl": self.rtl,
            "cjkLike": self.cjkLike,
            "subtitleSingleMax": self.subtitleSingleMax,
            "subtitleDoubleMax": self.subtitleDoubleMax,
        }


LANGUAGES: tuple[TargetLanguage, ...] = (
    TargetLanguage(
        code="en",
        label="英语",
        nativeName="English",
        englishName="English",
        markets="美 / 英 / 加 / 澳 / 新",
        bcp47="en",
        promptHint="使用自然、地道、面向国际英语受众的英文表达。",
    ),
    TargetLanguage(
        code="ja",
        label="日语",
        nativeName="日本語",
        englishName="Japanese",
        markets="日本",
        bcp47="ja",
        cjkLike=True,
        subtitleSingleMax=20,
        subtitleDoubleMax=40,
        promptHint="使用自然地道的日语（合理搭配汉字与假名），根据题材与受众选用恰当敬体或叙事体，遵守日本市场对功效宣传的谨慎表达。",
    ),
    TargetLanguage(
        code="ko",
        label="韩语",
        nativeName="한국어",
        englishName="Korean",
        markets="韩国",
        bcp47="ko",
        cjkLike=True,
        subtitleSingleMax=22,
        subtitleDoubleMax=44,
        promptHint="使用自然地道的现代韩语（谚文书写，不要夹杂中文汉字），语气符合韩国目标受众习惯。",
    ),
    TargetLanguage(
        code="es",
        label="西班牙语",
        nativeName="Español",
        englishName="Spanish",
        markets="墨西哥 / 西班牙 / 拉美",
        bcp47="es",
        promptHint="使用通用、自然的拉美及国际西班牙语表达，避免生硬直译。",
    ),
    TargetLanguage(
        code="pt",
        label="葡萄牙语",
        nativeName="Português",
        englishName="Portuguese",
        markets="巴西 / 葡萄牙",
        bcp47="pt",
        promptHint="优先使用自然地道的巴西葡萄牙语（Português Brasileiro），贴合拉美最大消费与内容市场习惯。",
    ),
    TargetLanguage(
        code="id",
        label="印尼语",
        nativeName="Bahasa Indonesia",
        englishName="Indonesian",
        markets="印度尼西亚",
        bcp47="id",
        promptHint="使用自然流畅的标准印尼语（Bahasa Indonesia），贴合东南亚年轻受众及电商/文娱语境。",
    ),
    TargetLanguage(
        code="th",
        label="泰语",
        nativeName="ไทย",
        englishName="Thai",
        markets="泰国",
        bcp47="th",
        cjkLike=True,
        subtitleSingleMax=34,
        subtitleDoubleMax=68,
        promptHint="使用自然地道的泰语（ภาษาไทย），符合泰国观众与消费者习惯，保留原文核心意象与准确分寸。",
    ),
    TargetLanguage(
        code="vi",
        label="越南语",
        nativeName="Tiếng Việt",
        englishName="Vietnamese",
        markets="越南",
        bcp47="vi",
        promptHint="使用自然地道的越南语（Tiếng Việt），对汉越文化术语（如仙侠概念）按档位合理取舍。",
    ),
    TargetLanguage(
        code="de",
        label="德语",
        nativeName="Deutsch",
        englishName="German",
        markets="德国 / 奥地利 / 瑞士",
        bcp47="de",
        promptHint="使用严谨、清晰、自然的德语，符合德语区消费者对事实准确与合规表达的高标准。",
    ),
    TargetLanguage(
        code="fr",
        label="法语",
        nativeName="Français",
        englishName="French",
        markets="法国 / 比利时 / 魁北克",
        bcp47="fr",
        promptHint="使用地道、自然、修辞克制的法语，避免直译腔与无依据的夸大承诺。",
    ),
    TargetLanguage(
        code="ar",
        label="阿拉伯语",
        nativeName="العربية",
        englishName="Arabic",
        markets="沙特 / 阿联酋 / 中东",
        bcp47="ar",
        rtl=True,
        subtitleSingleMax=38,
        subtitleDoubleMax=76,
        promptHint="使用清晰、自然的现代标准阿拉伯语（Modern Standard Arabic），表达得体，尊重中东海湾市场文化习惯。",
    ),
    TargetLanguage(
        code="ru",
        label="俄语",
        nativeName="Русский",
        englishName="Russian",
        markets="俄罗斯 / 独联体",
        bcp47="ru",
        subtitleSingleMax=42,
        subtitleDoubleMax=84,
        promptHint="使用自然地道的俄语（西里尔字母书写），兼顾科技/消费品表达的准确性与文娱语境的流畅度。",
    ),
)

LANGUAGE_BY_CODE: dict[str, TargetLanguage] = {lang.code: lang for lang in LANGUAGES}
SUPPORTED_LANGUAGE_CODES: tuple[str, ...] = tuple(LANGUAGE_BY_CODE.keys())


def get_language(code: Optional[str]) -> TargetLanguage:
    key = (code or DEFAULT_LANGUAGE).strip().lower()
    if key not in LANGUAGE_BY_CODE:
        raise KeyError(key)
    return LANGUAGE_BY_CODE[key]


def script_check(text: str, lang_code: str) -> Optional[str]:
    """校验终稿文字脚本是否与目标语言一致；返回 None 表示通过，否则返回中文改写原因。"""
    lang = get_language(lang_code)
    cleaned = text.strip()
    if not cleaned:
        return f"译稿为空，请使用{lang.label}输出"
    if lang.code == "ja":
        # 日语允许使用汉字，但完整日语句子必须包含平假名或片假名，避免直接输出中文。
        if not KANA_RE.search(cleaned):
            return "译稿未检测到日语假名，疑似仍为中文，请改写成自然日语"
        return None
    if HAN_RE.search(cleaned):
        return f"译稿仍含中文，请改写成{lang.label}"
    if lang.code == "ko" and not HANGUL_RE.search(cleaned):
        return "译稿未检测到韩语谚文，请改写成韩语"
    if lang.code == "th" and not THAI_RE.search(cleaned):
        return "译稿未检测到泰语正文，请改写成泰语"
    if lang.code == "ar" and not ARABIC_RE.search(cleaned):
        return "译稿未检测到阿拉伯语正文，请改写成阿拉伯语"
    if lang.code == "ru" and not CYRILLIC_RE.search(cleaned):
        return "译稿未检测到俄语西里尔字母正文，请改写成俄语"
    return None
