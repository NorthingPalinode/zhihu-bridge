# V1.4 开发进度

分支：`feat/v1.4-workbench`（基于 `main@e5351af`）。最后更新：2026-11-27。

## 已完成

### PR-00：基线、设计对齐
- 代码事实来源已确定为 GitHub 仓库，见 [G0_BASELINE_AUDIT.md](./G0_BASELINE_AUDIT.md)。
- 设计契约：[`docs/design/DESIGN.md`](../design/DESIGN.md)；冻结的视觉基准：[`docs/design-reference/direction-d3.html`](../design-reference/direction-d3.html)。
- 两份 ADR：[ADR-001 多页面入口](./ADR-001-frontend-entrypoint.md)、[ADR-002 工作台减负](./ADR-002-workbench-simplification.md)。
- 演示资料包 `app/fixtures/workbench/pulsering/` 共 5 份：.md、.csv、.txt，加上由 `server/scripts/make_demo_pack.py` 生成的 `.docx` 和故意不可读的 `.pdf`。
- 知乎能力实测已完成，见 [ZHIHU_CAPABILITY_CHECK.md](./ZHIHU_CAPABILITY_CHECK.md)：16/16 次调用成功；`knowledge_upload` 属于写操作，**尚未测试，等你单独确认**。

### PR-01：入口隔离与项目骨架
- 旧页面原样移到 `web/legacy.html`；新 `web/index.html` 挂载 `src/workbench/main.tsx`；Vite 多页面构建同时产出两个入口。
- 旧 e2e 改为访问 `/legacy.html`。
- 无表单创建项目：`POST /api/projects` 接收文件（base64）或粘贴文字，支持 .txt / .md / .csv / .docx。.docx 由标准库直接解析，不新增依赖；PDF 和图片如实标记为“未使用”，不阻断流程。

### PR-02：贯穿骨架
- 后端 `server/bridge/workbench/`：
  - 示例流水线：每条事实都必须能在资料里找到原文才会收录，定位由解析器给出；
  - 状态引擎：正文按片段渲染，统一的决定接口，保守自动修订（高风险恢复必须带理由），编辑后立即复查；
  - SQLite 存储：每次操作记录前后快照，按栈撤销；
  - API：12 个路由，统一挂在 `/api/projects` 下。
- 前端 `web/src/workbench/`：
  - 首页、运行进度（SSE）、四步工作台（D 布局）；
  - `DecisionCard` 在三处共用；正文标记与弹层；依据联动；
  - Toast 撤销与 Ctrl/Cmd+Z；导出抽屉和生成记录抽屉。

### PR-03 / PR-04（部分）：真实流水线
- 设置 `ZHIHU_LIVE_ENABLED=true` 和 `LLM_PROVIDER=zhihu_direct` 后，新项目走真实流水线（`workbench/live.py`）：
  - 模型提取事实，每条事实必须能在资料里核对到原文；
  - 知乎搜索、全网搜索和问答生成洞察；
  - 英文页逐段生成，引用编号会做校验。
- 流水线在后台任务里运行，SSE 实时推送进度。失败时退回开发占位，并在步骤里写明“改用开发占位”。
- 确定性兜底，不只依赖模型判断：
  - 跨文件冲突检测（同一标签、不同数值或单位）；
  - 中文营销声称识别（`claim_rules.json` 的 `zh_claims`）；
  - 冲突数值在正文里以占位等你决定；
  - 英文参考过滤掉购物站、中文站和知乎站。
- 实跑一次 PulseRing 资料包约 38 秒，链接都是真实的。

### 视觉重做：按参考图复刻（Nebula 深空）
- 视觉基准换成用户提供的界面参考图，见 [`DESIGN.md` §1](../design/DESIGN.md)：深海军蓝、青蓝发光、玻璃卡片、刘看山、地球弧线。行为规则（d3 的流程、决定、撤销）不变。
- 新增和重写的组件：
  - 顶栏 `TopNav`；
  - 首页：hero、能力卡、最近项目卡、工作流面板；
  - 项目头卡：设置芯片、完成环；
  - 玻璃流程条：4 步 + 导出交付；
  - 四步页面：资料、洞察、内容、审校，审校页带环形图和交付栏；
  - 导出抽屉。
- 不复刻参考图里的假数据和假功能：没有模板中心、团队空间、通知铃和虚构指标。
- 字体从 IBM Plex 换成 Inter；吉祥物用刘看山官方 GIF。

## 实测结果
| 项目 | 结果 |
| :--- | :--- |
| 后端 `pytest` | **119 passed**（原有 89 + 工作台 25 + 真实流水线 5） |
| 前端 `vitest` | **43 passed**（原有 37 + 工作台 6） |
| `tsc -b && vite build` | 通过，产出 `index.html` 与 `legacy.html` |
| `e2e/workbench.mjs`（Edge headless，1440 与 390，重做后的界面） | **通过**。主路径点击数 6（打开示例 → 3 个决定 → 导出 → 下载）；Toast 撤销与 Ctrl+Z 有效；默认焦点安全；编辑后复查；高风险恢复必须选理由；导出无占位、无无依据声称；390 宽度下无溢出，且正文排在依据之前；`/legacy.html` 返回 200 |
| 旧 `e2e/smoke.mjs`（指向 `/legacy.html`） | 页面能加载并跑完一次转译（`connected-a.png` 已截图），之后在 `getByLabel("目标受众").selectOption` 处失败。`legacy.html` 与原来的 `index.html` 逐字节相同，`connected.ts` 也没有改动；推测是脚本早就跟不上自定义选择器的变化。**未在 main 上单独复现确认。** |

截图在 `app/docs/acceptance/workbench/`。

## 下一步（按 PLAN_V1.4 §10）
1. PR-05 内容加厚、PR-06 自动检查加厚。
2. PR-07 回流与导出：`knowledge_upload` 需要你确认后才实测。
3. PR-08 体验验收与证据包。
4. 修复旧 `smoke.mjs` 的选择器问题（或在 PR-08 清理旧页面时一并处理）。
