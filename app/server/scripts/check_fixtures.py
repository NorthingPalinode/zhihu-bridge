"""校验 fixtures：ID 引用、术语可定位、sourceSegments 能拼回原文、dev_stub 与 replays 分离、证据字段与 Day 0 原始样本一致。

用法：python scripts/check_fixtures.py [--day0 PATH]   （--day0 指向 refs/fixtures/day0_zhihu_search_samples.json，可选、只读）
"""
import json
import re
import sys
from pathlib import Path

import _path  # noqa: F401
from bridge.core.replay import ReplayStore
from bridge.fixtures import FixtureStore

FX = _path.APP / "fixtures"


def main() -> int:
    errors: list[str] = []
    fx = FixtureStore(FX)
    ev_ids = {e["id"] for e in fx.evidence}
    for case in fx.cases.values():
        joined = "".join(s.text for s in case.source_segments)
        if joined != case.text:
            errors.append(f"{case.caseId}: sourceSegments 拼不回原文")
        term_ids = {t.id for t in case.terms}
        kp_ids = {k.id for k in case.keyPoints}
        for t in case.terms:
            if any(k not in kp_ids for k in t.keyPointIds):
                errors.append(f"{case.caseId}: 术语 {t.id} 引用未知信息点")
        for d in case.decisions:
            if d.termId not in term_ids or any(e not in ev_ids for e in d.evidenceIds):
                errors.append(f"{case.caseId}: 决策 {d.id} 引用未知 ID")
        for a in case.audiences:
            if a.recommendedLevel not in case.levels:
                errors.append(f"{case.caseId}: 受众 {a.id} 推荐档不在 levels 中")
    for e in fx.evidence:
        if e["status"] == "reviewed":
            errors.append(f"{e['id']}: 未经 DI 人工审核不得标 reviewed")
        if e["provider"] == "zhihu" and "zhihu.com" not in e["url"]:
            errors.append(f"{e['id']}: 知乎来源 URL 不是 zhihu.com")
    if fx.gen_stub.get("provenance") != "dev_stub" or fx.retell_stub.get("provenance") != "dev_stub":
        errors.append("dev_stubs 必须标 provenance=dev_stub")
    rs = ReplayStore(FX / "replays")
    if rs.rejected:
        errors.append("replays/ 中存在被拒绝的文件：" + "; ".join(rs.rejected))

    if "--day0" in sys.argv:
        day0 = Path(sys.argv[sys.argv.index("--day0") + 1])
        data = json.loads(day0.read_text(encoding="utf-8"))
        probes = {p["id"]: p for p in data["samples"] + data["extraProbes"]}
        checked = 0
        for e in fx.evidence:
            m = re.match(r"^(\w+)#(\d+)$", e["id"])
            if not m or m.group(1) not in probes:
                continue
            item = probes[m.group(1)]["response"]["Data"]["Items"][int(m.group(2)) - 1]
            title = re.sub(r"\s*-\s*知乎\s*$", "", item["Title"])
            url = re.sub(r"\?utm_[^#]*$", "", item["Url"])
            author = item.get("AuthorName") or None
            if (e["title"], e["url"], e["author"]) != (title, url, author):
                errors.append(f"{e['id']}: 与 Day 0 原始字段不一致 {(e['title'], e['url'], e['author'])} != {(title, url, author)}")
            checked += 1
        for pre in fx.precached:
            pid = "P1_qrec_A"
            src = [{"title": i["Title"], "url": i["Url"]} for i in probes[pid]["response"]["Data"]["Items"]]
            if pre["items"] != src:
                errors.append("预缓存的已有讨论与 Day 0 原始样本不一致")
        print(f"Day 0 对照：核对 {checked} 条证据、{len(fx.precached)} 个预缓存")

    if errors:
        print("FAIL")
        for x in errors:
            print(" -", x)
        return 1
    print(f"OK：{len(fx.cases)} 个案例、{len(fx.evidence)} 条证据（全部 candidate）、replays 有效 {len(rs)} 个")
    return 0


if __name__ == "__main__":
    sys.exit(main())
