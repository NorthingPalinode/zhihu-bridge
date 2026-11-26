"""资料解析：.txt / .md / .csv / .docx 抽取纯文本，并能给出“第几段 / 第几行 / 哪一节”的定位。

不支持的格式（PDF、图片等）返回 status="unsupported"，不计入依据，也不阻断流程（PLAN_V1.4 §3.3）。
"""
from __future__ import annotations

import csv
import io
import re
import zipfile
from dataclasses import dataclass, field
from typing import Optional
from xml.etree import ElementTree

SUPPORTED = (".txt", ".md", ".csv", ".docx")
MAX_BYTES = 2 * 1024 * 1024
_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


@dataclass
class ParsedSource:
    filename: str
    kind: str                      # txt | md | csv | docx | other
    status: str                    # parsed | unsupported | failed
    text: str = ""
    note: str = ""
    blocks: list[tuple[str, str]] = field(default_factory=list)   # (locator, text)

    @property
    def size_label(self) -> str:
        if self.kind == "csv":
            return f"{max(0, len(self.blocks))} 行"
        chars = len(re.sub(r"\s", "", self.text))
        return f"{chars:,} 字"

    def locate(self, quote: str) -> Optional[str]:
        for loc, block in self.blocks:
            if quote in block:
                return loc
        return None


def _decode(data: bytes) -> str:
    for enc in ("utf-8-sig", "utf-8", "gb18030"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    raise ValueError("文件编码无法识别，请另存为 UTF-8 后再上传")


def _paragraphs(text: str) -> list[tuple[str, str]]:
    paras = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    return [(f"第 {i} 段", p) for i, p in enumerate(paras, 1)]


def _markdown_blocks(text: str) -> list[tuple[str, str]]:
    blocks: list[tuple[str, str]] = []
    heading = "开头"
    buf: list[str] = []

    def flush():
        if buf:
            blocks.append((heading, "\n".join(buf)))
            buf.clear()

    for line in text.splitlines():
        m = re.match(r"^#{2,6}\s+(.*)$", line)
        if m:
            flush()
            title = m.group(1).strip()
            num = re.match(r"^(\d+)[.、]", title)
            appendix = re.match(r"^(附录\s*[A-Z一二三四五六七八九十]+)", title)
            heading = f"第 {num.group(1)} 节" if num else (appendix.group(1) if appendix else title)
            continue
        if line.strip() and not line.startswith("# "):
            buf.append(line.strip())
    flush()
    return blocks


def _csv_blocks(text: str) -> list[tuple[str, str]]:
    rows = list(csv.reader(io.StringIO(text)))
    return [(f"第 {i} 行", "，".join(c.strip() for c in row if c.strip())) for i, row in enumerate(rows, 1) if any(c.strip() for c in row)]


def docx_text(data: bytes) -> list[str]:
    """抽取 .docx 正文段落（只读 word/document.xml，不依赖第三方库）。"""
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        xml = zf.read("word/document.xml")
    root = ElementTree.fromstring(xml)
    paras = []
    for p in root.iter(f"{_W}p"):
        t = "".join(node.text or "" for node in p.iter(f"{_W}t")).strip()
        if t:
            paras.append(t)
    return paras


def parse_source(filename: str, data: bytes) -> ParsedSource:
    name = filename.strip() or "未命名资料"
    ext = ("." + name.rsplit(".", 1)[-1].lower()) if "." in name else ""
    if len(data) > MAX_BYTES:
        return ParsedSource(name, "other", "failed", note="文件超过 2 MB，请拆分后再上传")
    if ext not in SUPPORTED:
        why = "扫描件或 PDF 暂时读不出文字" if ext == ".pdf" else f"暂不支持 {ext or '这种'} 格式"
        return ParsedSource(name, "other", "unsupported", note=f"{why}，所以没有用作依据，不影响其他内容。")
    try:
        if ext == ".docx":
            paras = docx_text(data)
            text = "\n\n".join(paras)
            blocks = [(f"第 {i} 段", p) for i, p in enumerate(paras, 1)]
            return ParsedSource(name, "docx", "parsed" if text else "unsupported", text, "" if text else "文档里没有读到文字", blocks)
        text = _decode(data)
    except (zipfile.BadZipFile, KeyError, ElementTree.ParseError):
        return ParsedSource(name, ext[1:], "failed", note="文件已损坏或不是有效的 Word 文档")
    except ValueError as exc:
        return ParsedSource(name, ext[1:], "failed", note=str(exc))
    if ext == ".csv":
        return ParsedSource(name, "csv", "parsed", text, blocks=_csv_blocks(text))
    if ext == ".md":
        return ParsedSource(name, "md", "parsed", text, blocks=_markdown_blocks(text))
    return ParsedSource(name, "txt", "parsed", text, blocks=_paragraphs(text))


def parse_pasted(text: str) -> ParsedSource:
    text = (text or "").strip()
    return ParsedSource("粘贴的文字", "txt", "parsed" if text else "failed", text, "" if text else "没有内容", _paragraphs(text))
