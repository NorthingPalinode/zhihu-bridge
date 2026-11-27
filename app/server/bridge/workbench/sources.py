"""资料解析：.txt / .md / .csv / .docx / .pdf 抽取纯文本，并能给出“第几段 / 第几行 / 哪一节 / 第几页”的定位。

扫描件 PDF 或不支持的格式返回 status="unsupported"，损坏或加密 PDF 返回 status="failed"，均不计入依据也不阻断其他资料。
"""
from __future__ import annotations

import csv
import io
import re
import zipfile
from dataclasses import dataclass, field
from typing import Optional
from xml.etree import ElementTree

SUPPORTED = (".txt", ".md", ".csv", ".docx", ".pdf")
MAX_BYTES = 10 * 1024 * 1024
MAX_PDF_PAGES = 60
MAX_EXTRACTED_CHARS = 200_000
_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


@dataclass
class ParsedSource:
    filename: str
    kind: str                      # txt | md | csv | docx | pdf | other
    status: str                    # parsed | unsupported | failed
    text: str = ""
    note: str = ""
    blocks: list[tuple[str, str]] = field(default_factory=list)   # (locator, text)

    @property
    def size_label(self) -> str:
        if self.kind == "csv":
            return f"{max(0, len(self.blocks))} 行"
        chars = len(re.sub(r"\s", "", self.text))
        if self.kind == "pdf":
            return f"{len(self.blocks)} 页 · {chars:,} 字"
        return f"{chars:,} 字"

    def locate(self, quote: str) -> Optional[str]:
        if not quote:
            return None
        for loc, block in self.blocks:
            if quote in block:
                return loc
        # PDF 表格/正文行尾可能软折行：只在相邻换行处折叠（不跨双换行分段），避免跨列误拼
        norm_q = re.sub(r"[ \t]*\n[ \t]*", "", quote).strip()
        if len(norm_q) >= 4:
            for loc, block in self.blocks:
                for para in re.split(r"\n\s*\n", block):
                    if norm_q in re.sub(r"[ \t]*\n[ \t]*", "", para):
                        return loc
        return None

    def to_record(self) -> dict:
        return {
            "filename": self.filename,
            "kind": self.kind,
            "status": self.status,
            "text": self.text,
            "note": self.note,
            "blocks": [[loc, blk] for loc, blk in self.blocks],
        }

    @classmethod
    def from_record(cls, rec: dict) -> "ParsedSource":
        return cls(
            filename=rec["filename"],
            kind=rec["kind"],
            status=rec["status"],
            text=rec.get("text", ""),
            note=rec.get("note", ""),
            blocks=[(b[0], b[1]) for b in rec.get("blocks", [])],
        )


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


def pdf_pages(data: bytes) -> list[tuple[str, str]]:
    """抽取 .pdf 每页文字，返回 [(第 N 页, 文本), ...]，受页数与总字符预算保护。"""
    from pypdf import PdfReader
    from pypdf.errors import PdfReadError

    try:
        reader = PdfReader(io.BytesIO(data), strict=False)
    except PdfReadError as exc:
        raise RuntimeError("PDF 文件已损坏或结构不完整，无法读取") from exc
    if reader.is_encrypted:
        try:
            decrypted = reader.decrypt("")
        except Exception as exc:  # noqa: BLE001
            raise ValueError("PDF 已加密，请先解除密码后再上传") from exc
        if not decrypted:
            raise ValueError("PDF 已加密，请先解除密码后再上传")

    try:
        total_pages = len(reader.pages)
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError("PDF 文件已损坏或缺少页面结构，无法读取") from exc
    if total_pages == 0:
        raise RuntimeError("PDF 文件缺少页面结构，无法读取")

    pages: list[tuple[str, str]] = []
    total_chars = 0
    for idx, page in enumerate(reader.pages[:MAX_PDF_PAGES], 1):
        try:
            raw = (page.extract_text() or "").strip()
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError("PDF 内容流损坏，无法读取文字") from exc
        cleaned = re.sub(r"[ \t]+\n", "\n", raw)
        cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).strip()
        if cleaned:
            remaining = MAX_EXTRACTED_CHARS - total_chars
            if remaining <= 0:
                break
            if len(cleaned) > remaining:
                cleaned = cleaned[:remaining]
            pages.append((f"第 {idx} 页", cleaned))
            total_chars += len(cleaned)
    return pages


def parse_source(filename: str, data: bytes) -> ParsedSource:
    name = filename.strip() or "未命名资料"
    ext = ("." + name.rsplit(".", 1)[-1].lower()) if "." in name else ""
    if len(data) > MAX_BYTES:
        return ParsedSource(name, "other", "failed", note="文件超过 10 MB，请拆分后再上传")
    if ext not in SUPPORTED:
        return ParsedSource(name, "other", "unsupported", note=f"暂不支持 {ext or '这种'} 格式，所以没有用作依据，不影响其他内容。")
    try:
        if ext == ".pdf":
            if not data.lstrip().startswith(b"%PDF"):
                return ParsedSource(name, "pdf", "failed", note="文件已损坏或不是有效的 PDF 文档")
            pages = pdf_pages(data)
            if not pages:
                return ParsedSource(name, "pdf", "unsupported", note="PDF 为扫描件或不含可提取文字，未用作依据，不影响其他内容。")
            text = "\n\n".join(p for _, p in pages)
            return ParsedSource(name, "pdf", "parsed", text, blocks=pages)
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
    except RuntimeError as exc:
        return ParsedSource(name, ext[1:], "failed", note=str(exc))
    except Exception:  # noqa: BLE001
        return ParsedSource(name, ext[1:], "failed", note="文件解析失败，请检查文件是否完整")
    if ext == ".csv":
        return ParsedSource(name, "csv", "parsed", text, blocks=_csv_blocks(text))
    if ext == ".md":
        return ParsedSource(name, "md", "parsed", text, blocks=_markdown_blocks(text))
    return ParsedSource(name, "txt", "parsed", text, blocks=_paragraphs(text))


def parse_pasted(text: str) -> ParsedSource:
    text = (text or "").strip()
    return ParsedSource("粘贴的文字", "txt", "parsed" if text else "failed", text, "" if text else "没有内容", _paragraphs(text))
