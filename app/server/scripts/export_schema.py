"""把 Pydantic 契约导出为 app/contracts/*.schema.json。用法：python scripts/export_schema.py [--check]"""
import json
import sys

import _path  # noqa: F401
from bridge.contracts import SCHEMA_MODELS

OUT = _path.APP / "contracts"


def render() -> dict[str, str]:
    return {f"{name}.schema.json": json.dumps(model.model_json_schema(), ensure_ascii=False, indent=2, sort_keys=True) + "\n"
            for name, model in SCHEMA_MODELS.items()}


def main() -> int:
    files = render()
    if "--check" in sys.argv:
        stale = [n for n, body in files.items() if not (OUT / n).exists() or (OUT / n).read_text(encoding="utf-8") != body]
        if stale:
            print("contracts 与 Pydantic 契约不一致：", ", ".join(stale))
            return 1
        print(f"contracts 一致（{len(files)} 个文件）")
        return 0
    OUT.mkdir(exist_ok=True)
    for n, body in files.items():
        (OUT / n).write_text(body, encoding="utf-8", newline="\n")
    print(f"已写入 {len(files)} 个 schema 到 {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
