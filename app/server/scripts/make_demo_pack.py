"""生成 PulseRing X1 示例资料包里的二进制文件：中文预热营销初稿.docx（可读）与认证清单.pdf（故意不可读）。

用法：python scripts/make_demo_pack.py
输出：app/fixtures/workbench/pulsering/
"""
from __future__ import annotations

import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

OUT = Path(__file__).resolve().parents[2] / "fixtures" / "workbench" / "pulsering"

MARKETING = [
    "PulseRing X1：全天续航，行业领先能效，医疗级睡眠监测，已获 FDA 认证。",
    "自研高密度堆料主板，极限压榨功耗，戴上就忘了它的存在。",
    "支持 Apple Health 双向同步，开箱即用。",
]

CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"""
RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"""


def document_xml(paras: list[str]) -> str:
    body = "".join(f'<w:p><w:r><w:t xml:space="preserve">{escape(p)}</w:t></w:r></w:p>' for p in paras)
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
            f"<w:body>{body}</w:body></w:document>")


def write_docx(path: Path, paras: list[str]) -> None:
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in (("[Content_Types].xml", CONTENT_TYPES), ("_rels/.rels", RELS), ("word/document.xml", document_xml(paras))):
            info = zipfile.ZipInfo(name, date_time=(2026, 11, 26, 0, 0, 0))
            zf.writestr(info, data)


def write_image_only_pdf(path: Path) -> None:
    """一页只有矩形图形、没有文字层的 PDF，模拟扫描件。"""
    content = b"0.85 g 72 600 450 120 re f 0.6 g 72 560 300 16 re f 72 530 360 16 re f"
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >>",
        b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objs, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % i + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
    out += b"".join(b"%010d 00000 n \n" % o for o in offsets)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)
    path.write_bytes(bytes(out))


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    write_docx(OUT / "中文预热营销初稿.docx", MARKETING)
    write_image_only_pdf(OUT / "PulseRing_X1_认证清单.pdf")
    print("written to", OUT)


if __name__ == "__main__":
    main()
