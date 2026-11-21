"""凭证扫描（V6 §6.10，回归表第 12 项）：扫描 app/ 下源码、配置、fixtures 与构建产物，发现疑似密钥即失败。"""
import re
import sys
from pathlib import Path

import _path  # noqa: F401

SKIP_DIRS = {".venv", ".venv-win", "node_modules", "__pycache__", ".pytest_cache", "var", ".git"}
ALLOW_MARK = "scan:allow-fake"
PATTERNS = [
    ("openai-style key", re.compile(r"\bsk-[A-Za-z0-9_\-]{16,}")),
    ("bearer token", re.compile(r"Bearer\s+(?!<|\$\{|\{|\"|'|\*)[A-Za-z0-9._\-]{20,}")),
    ("env secret assignment", re.compile(r"^[ \t]*(ZHIHU_ACCESS_SECRET|LLM_API_KEY|SILICONFLOW_API_KEY|ZHIHU_OAUTH_APP_KEY)[ \t]*=[ \t]*[^\s#]+", re.M)),
    ("private key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
]


def scan(root: Path) -> list[str]:
    hits = []
    for p in root.rglob("*"):
        if not p.is_file() or any(part in SKIP_DIRS for part in p.relative_to(root).parts):
            continue
        if p.suffix.lower() in {".png", ".jpg", ".jpeg", ".woff", ".woff2", ".ttf", ".ico", ".sqlite3"}:
            continue
        try:
            text = p.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        for name, pat in PATTERNS:
            for m in pat.finditer(text):
                line = text[text.rfind("\n", 0, m.start()) + 1 : text.find("\n", m.end()) if text.find("\n", m.end()) >= 0 else len(text)]
                if ALLOW_MARK in line:
                    continue  # 测试里故意构造的假值，逐行显式标注
                hits.append(f"{p.relative_to(root)}: {name}: {m.group(0)[:12]}…")
    return hits


def main() -> int:
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else _path.APP
    hits = scan(root)
    if hits:
        print("发现疑似凭证：")
        for h in hits:
            print(" -", h)
        return 1
    print(f"未发现疑似凭证（扫描根目录：{root}）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
