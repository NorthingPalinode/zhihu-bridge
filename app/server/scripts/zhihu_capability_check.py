"""G0 知乎能力实测（PLAN_V1.4 §1.6）：只做读取类调用，不上传、不发布。

凭证只从环境变量 ZHIHU_ACCESS_SECRET 读取，报告里不出现凭证。
用法：ZHIHU_ACCESS_SECRET=... python scripts/zhihu_capability_check.py <raw.json> <report.md>

会消耗个人凭证额度：global_search 5 次、zhihu_search 4 次、question_discovery 最多 3 次、zhida 1 次、knowledge 1 次。
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import sys
import tempfile
import time
from collections import Counter
from pathlib import Path

import _path  # noqa: F401
from bridge.adapters.zhihu import ZhihuClient, ZhihuError
from bridge.config import Settings
from bridge.core.store import Store

EN_QUERIES = [
    "smart ring kickstarter battery life",
    "smart ring waterproof 5 ATM review",
    "smart ring open source firmware developer",
    "custom PCB smart ring components",
    "kickstarter hardware campaign claims FTC",
]
ZH_QUERIES = ["堆料 主板 用料", "极限压榨功耗 续航宣传", "底层协议调试 固件开源", "Kickstarter 硬件众筹 经验"]
CJK = re.compile(r"[一-鿿]")


def is_english(text: str) -> bool:
    letters = re.findall(r"[A-Za-z]", text)
    return len(letters) > 20 and len(CJK.findall(text)) < len(letters) / 10


async def main(raw_path: Path, report_path: Path) -> None:
    secret = os.environ.get("ZHIHU_ACCESS_SECRET", "").strip()
    if not secret:
        sys.exit("缺少 ZHIHU_ACCESS_SECRET")
    tmp = Path(tempfile.mkdtemp()) / "cap.sqlite3"
    os.environ["DB_PATH"] = str(tmp)
    settings = Settings()
    client = ZhihuClient(settings, Store(tmp)).personal(secret)
    raw: dict = {"checked_at": time.strftime("%Y-%m-%d %H:%M:%S"), "calls": []}

    async def call(name: str, coro):
        t0 = time.perf_counter()
        try:
            res = await coro
            raw["calls"].append({"call": name, "ok": True, "ms": round((time.perf_counter() - t0) * 1000), "result": res})
            return res
        except ZhihuError as exc:
            raw["calls"].append({"call": name, "ok": False, "ms": round((time.perf_counter() - t0) * 1000), "error": exc.kind, "message": str(exc)})
            return None

    quota_before = await call("quota_before", client.quota_details())
    en = {}
    for q in EN_QUERIES:
        res = await call(f"global_search:{q}", client.global_search(q, 6))
        en[q] = res[0] if res else None
    zh = {}
    for q in ZH_QUERIES:
        res = await call(f"zhihu_search:{q}", client.search(q, 6))
        zh[q] = res[0] if res else None
    recs = await call("question_recommendations:堆料 主板", client.question_recommendations("堆料 主板 用料", 5))
    question_urls = [r["url"] for r in (recs[0] if recs else []) if "/question/" in r["url"]]
    for it in (v for items in zh.values() if items for v in items):
        u = str(it.get("Url", ""))
        m = re.search(r"https://www\.zhihu\.com/question/\d+", u)
        if m and m.group(0) not in question_urls:
            question_urls.append(m.group(0))
    answers = []
    for u in question_urls[:2]:
        res = await call(f"question_answers:{u}", client.question_answers(u, 0, 5))
        if res:
            answers.append(res[0])
    zhida = await call("zhida_ask", client.zhida_ask("“堆料”在嵌入式硬件语境里是什么意思？直译成英文会有什么误解？请简短回答。", "zhida-fast-1p5"))
    kbs = await call("knowledge_bases", client.knowledge_bases("all"))
    quota_after = await call("quota_after", client.quota_details())
    await client.close()
    raw_path.parent.mkdir(parents=True, exist_ok=True)
    raw_path.write_text(json.dumps(raw, ensure_ascii=False, indent=2), encoding="utf-8")

    # ---------------- report ----------------
    L = ["# 知乎能力实测（G0）", "", f"实测时间：{raw['checked_at']}（北京时间）。凭证：个人 Access Secret（报告中不记录凭证）。", "",
         "调用方式：`server/scripts/zhihu_capability_check.py`，只做读取类调用，**没有调用 `knowledge_upload`，也没有任何发布操作**。", ""]
    L += ["## 1. 额度", "", "| 接口 | 总额度 | 实测前剩余 | 实测后剩余 |", "| :--- | ---: | ---: | ---: |"]
    after = {q["apiId"]: q for q in (quota_after or [])}
    for q in quota_before or []:
        L.append(f"| {q['apiName']}（`{q['apiId']}`） | {q['totalQuota']} | {q['remainingQuota']} | {after.get(q['apiId'], {}).get('remainingQuota')} |")
    if not quota_before:
        L.append("| 额度接口调用失败 | — | — | — |")
    L += ["", "## 2. `global_search` 英文查询（英文对照侧主路径能否成立）", "", "| 查询 | 返回条数 | 英文正文条数 | 来源域名 |", "| :--- | ---: | ---: | :--- |"]
    en_total = en_eng = 0
    hosts = Counter()
    for q, items in en.items():
        if items is None:
            L.append(f"| `{q}` | 调用失败 | — | — |")
            continue
        eng = sum(1 for i in items if is_english(i["title"] + " " + i["contentText"]))
        en_total += len(items)
        en_eng += eng
        hs = Counter(i["host"] for i in items)
        hosts.update(hs)
        L.append(f"| `{q}` | {len(items)} | {eng} | {', '.join(f'{h}×{n}' for h, n in hs.most_common(4)) or '—'} |")
    L += ["", f"合计：{en_total} 条，其中英文正文 {en_eng} 条；域名分布前五：{', '.join(f'{h}×{n}' for h, n in hosts.most_common(5)) or '—'}。", ""]
    L += ["## 3. `zhihu_search` 中文语境", "", "| 查询 | 返回条数 | 第一条标题 |", "| :--- | ---: | :--- |"]
    for q, items in zh.items():
        L.append(f"| {q} | {'调用失败' if items is None else len(items)} | {(items[0].get('Title', '') if items else '—')[:40]} |")
    L += ["", "## 4. 问题发现与回答摘录", "",
          f"- `question_recommendations`：{'调用失败' if recs is None else str(len(recs[0])) + ' 个问题'}",
          f"- `question_answers`：读取了 {len(answers)} 个问题，摘录条数分别为 {', '.join(str(len(a['items'])) for a in answers) or '—'}"]
    L += ["", "## 5. 知乎直答（`zhihu_direct` 模型可用性）", "",
          f"- {'可用：返回 ' + str(len(zhida['content'])) + ' 字，模型 ' + zhida['model'] if zhida else '调用失败'}"]
    L += ["", "## 6. 知识库", "", f"- `knowledge_bases`：{'调用失败' if kbs is None else f'{len(kbs)} 个知识库'}",
          "- `knowledge_upload` 的可见范围：**没有实测**。实测需要真实上传一份内容，属于写操作，需要你单独确认。在确认之前，回流功能不开放上传。"]
    fails = [c for c in raw["calls"] if not c["ok"]]
    if fails:
        L += ["", "## 7. 失败的调用", ""] + [f"- `{c['call']}`：{c['error']} · {c['message']}" for c in fails]
    report_path.write_text("\n".join(L) + "\n", encoding="utf-8")
    print(f"calls={len(raw['calls'])} failed={len(fails)} en={en_eng}/{en_total}")


if __name__ == "__main__":
    asyncio.run(main(Path(sys.argv[1]), Path(sys.argv[2])))
