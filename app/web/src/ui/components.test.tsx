import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MODE_LABEL, contentTypeLabel } from "../lib/labels";
import { initialState } from "../lib/state";
import { loadBundle, snapshotOf } from "../lib/testdata";
import type { Evidence } from "../lib/types";
import { Home, startBlockReason } from "./Home";
import { LeftPanel } from "./LeftPanel";
import { RightPanel } from "./RightPanel";
import { TopBar } from "./TopBar";

afterEach(cleanup);
const bundle = loadBundle();

const topProps = {
  cases: bundle.cases,
  caseId: "case_a",
  audienceId: "a_genre",
  audiences: bundle.cases[0].audiences,
  offline: false,
  evidenceSource: "zhihu_curated" as const,
  evidencePending: true,
  present: false,
  onHome: () => {},
  onCase: () => {},
  onAudience: () => {},
  onPresent: () => {},
  onReset: () => {},
};

describe("诚实标签", () => {
  it("dev_stub 显示“开发占位 · 非真实运行”，绝不显示为缓存回放或实时生成", () => {
    render(<TopBar {...topProps} mode="dev_stub" />);
    const tag = screen.getByTestId("mode-tag").textContent ?? "";
    expect(tag).toContain("开发占位 · 非真实运行");
    expect(tag).not.toContain("缓存回放");
    expect(tag).not.toContain("实时生成");
    expect(screen.getByTestId("evidence-tag").textContent).toContain("知乎精选");
    expect(screen.getByTestId("evidence-tag").textContent).not.toContain("待审核");
  });
  it("区分五种生成模式", () => {
    expect(MODE_LABEL).toEqual({ live: "实时生成", replay: "缓存回放", preset: "预设缓存", degraded: "已降级", dev_stub: "开发占位 · 非真实运行" });
  });
  it("作者为空时按内容类型显示，不编造署名", () => {
    const e = { provider: "zhihu", contentType: "article", author: null } as unknown as Evidence;
    expect(contentTypeLabel(e)).toBe("知乎专栏");
  });
});

describe("首页", () => {
  it("开始按钮的禁用原因", () => {
    expect(startBlockReason({ text: "  ", caseId: null, audienceId: "a_new" }, false)).toBe("请输入原文后再开始");
    expect(startBlockReason({ text: "字".repeat(401), caseId: null, audienceId: "a_new" }, false)).toContain("超过 400");
    expect(startBlockReason({ text: "你好", caseId: null, audienceId: "a_new" }, true)).toContain("离线包");
    expect(startBlockReason({ text: "你好", caseId: null, audienceId: "a_new" }, false)).toBeNull();
  });
  it("编辑案例原文后案例标记消失（按自定义输入处理）", () => {
    const onInput = vi.fn();
    const c = bundle.cases[0];
    render(<Home cases={bundle.cases} health={null} offline={false} input={{ text: c.text, caseId: c.caseId, audienceId: c.defaultAudienceId }} onInput={onInput} onStart={() => {}} present={false} onPresent={() => {}} />);
    fireEvent.change(screen.getByLabelText("中文原文"), { target: { value: c.text + "改" } });
    expect(onInput).toHaveBeenLastCalledWith(expect.objectContaining({ caseId: null }));
    expect(screen.getByText("评委三步体验")).toBeTruthy();
  });
});

describe("左栏证据卡", () => {
  it("展开后显示能支撑 / 不能支撑 / 打开知乎原文", () => {
    const snap = snapshotOf(bundle, "case_a|a_genre");
    render(
      <LeftPanel segments={snap.sourceSegments} terms={snap.terms} keyPoints={snap.keyPoints} evidence={snap.evidence} claimChecks={[]}
        activeTermId="T2" activeCheckId={null} openEvidenceId="A1#1" notices={[]} loading={false} onTerm={() => {}} onEvidence={() => {}} />,
    );
    expect(screen.getByText("能支撑")).toBeTruthy();
    expect(screen.getByText("不能支撑")).toBeTruthy();
    expect(screen.getByText("打开知乎原文 ↗").getAttribute("href")).toBe("https://zhuanlan.zhihu.com/p/721900687");
  });
});

describe("右栏", () => {
  const snap = snapshotOf(bundle, "case_a|a_genre");
  const base = {
    snap,
    caseMeta: bundle.cases[0],
    level: "genre" as const,
    test: initialState.test,
    stale: false,
    flow: initialState.flow,
    onRunTest: () => {},
    onFlowFromMisreading: () => {},
    onFlowManual: () => {},
    onFlowEdit: () => {},
    onFlowClose: () => {},
    onCopied: () => {},
  };
  it("复制终稿受 copyGate 控制", () => {
    render(<RightPanel {...base} copy={{ enabled: false, text: "", reason: "生成中 · 复制已锁定" }} />);
    expect((screen.getByRole("button", { name: /复制终稿/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("生成中 · 复制已锁定")).toBeTruthy();
    expect(screen.getByText("系统不发布，请遵守知乎社区规范自行决定")).toBeTruthy();
  });
  it("测试结果显示 n=3、开发占位与针对上一版本", () => {
    const result = bundle.tests["case_a|a_genre|genre"];
    render(<RightPanel {...base} test={{ ...initialState.test, status: "done", result }} stale copy={{ enabled: true, text: "x", reason: "可复制" }} />);
    expect(screen.getByText("模拟读者 · n=3")).toBeTruthy();
    expect(screen.getByText("开发占位 · 非评测结果")).toBeTruthy();
    expect(screen.getByText(/针对上一版本/)).toBeTruthy();
    expect(screen.getByText(/已完成 6\/6/)).toBeTruthy();
  });

  it("改变已选信息点时立即将先前结果标为过期", () => {
    const result = bundle.tests["case_a|a_genre|genre"];
    render(<RightPanel {...base} test={{ ...initialState.test, status: "done", result }} copy={{ enabled: true, text: "x", reason: "可复制" }} />);
    expect(screen.queryByText(/针对上一版本/)).toBeNull();
    fireEvent.click(screen.getAllByRole("checkbox")[1]);
    expect(screen.getByText(/针对上一版本/)).toBeTruthy();
  });

  it("复述成功但评判失败时显示评判重试与零覆盖", () => {
    const old = bundle.tests["case_a|a_genre|genre"];
    const result = { ...old, readers: old.readers.map((r) => ({ ...r, judgments: [] })),
      summary: { literal: { hit: 0, valid: 0 }, selected: { hit: 0, valid: 0 } } };
    render(<RightPanel {...base} test={{ ...initialState.test, status: "done", result }} copy={{ enabled: true, text: "x", reason: "可复制" }} />);
    expect(screen.getByText(/复述已完成 6\/6/)).toBeTruthy();
    expect(screen.getByText("已评判 0/18 项")).toBeTruthy();
    expect(screen.getByText("暂无可确认结果")).toBeTruthy();
    expect(screen.getByRole("button", { name: "重新运行模拟读者测试" })).toBeTruthy();
  });
});
