"""Translation strategies in order from accessible target language to terminology retention."""

GUIDANCE = {
    "plain": "面向初次接触题材的读者，用自然英文展开关键词的意思，少用专门术语。",
    "light": "保留一个最有辨识度的术语，其余用自然英文说明；首次出现可用很短的解释。",
    "balanced": "兼顾可读性与原文特色，在译文里保留关键术语，把次要解释放到注释。",
    "technical": "优先保留已有的题材或行业用语，给难懂的词加简短释义。",
    "genre": "面向熟悉题材或行业的读者，尽量沿用约定术语和语气，将释义放在译文之外。",
}


def guidance_for(level: str, lang_label: str = "英文") -> str:
    base = GUIDANCE.get(level, "保留原文要点")
    if lang_label in ("英语", "英文"):
        return base
    return base.replace("英文", lang_label)


def requested_levels(levels: list[str], expanded: bool) -> list[str]:
    return list(GUIDANCE) if expanded and levels == ["plain", "genre"] else levels
