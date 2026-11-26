# V1.4 开发进度

分支：`feat/v1.4-workbench`（基于 `main@e5351af`）。最后更新：2026-11-26。

## 已完成

### PR-00：基线、设计对齐
- 代码事实来源已确定为 GitHub 仓库，见 [G0_BASELINE_AUDIT.md](./G0_BASELINE_AUDIT.md)。
- 设计契约：[`docs/design/DESIGN.md`](../design/DESIGN.md)；冻结的视觉基准：[`docs/design-reference/direction-d3.html`](../design-reference/direction-d3.html)。
- 两份 ADR：[ADR-001 多页面入口](./ADR-001-frontend-entrypoint.md)、[ADR-002 工作台减负](./ADR-002-workbench-simplification.md)。
- 演示资料包 `app/fixtures/workbench/pulsering/` 共 5 份：.md、.csv、.txt，加上由 `server/scripts/make_demo_pack.py` 生成的 `.docx` 和故意不可读的 `.pdf`。
- **未完成**：知乎能力实测。需要你提供凭证或确认可以使用公网额度，见 G0 审计 §4。

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

## 实测结果
| 项目 | 结果 |
| :--- | :--- |
| 后端 `pytest` | **114 passed**（原有 89 + 工作台 25：负面断言、撤销还原、上传、SSE） |
| 前端 `vitest` | **43 passed**（原有 37 + 工作台 6） |
| `tsc -b && vite build` | 通过，产出 `index.html` 与 `legacy.html` |
| `e2e/workbench.mjs`（Edge headless，1440 与 390） | **通过**。主路径点击数 6（打开示例 → 3 个决定 → 导出 → 下载）；Toast 撤销与 Ctrl+Z 有效；默认焦点安全；编辑后复查；高风险恢复必须选理由；导出无占位、无无依据声称；390 宽度下无溢出，且正文排在依据之前；`/legacy.html` 返回 200 |
| 旧 `e2e/smoke.mjs`（指向 `/legacy.html`） | 页面能加载并跑完一次转译（`connected-a.png` 已截图），之后在 `getByLabel("目标受众").selectOption` 处失败。`legacy.html` 与原来的 `index.html` 逐字节相同，`connected.ts` 也没有改动；推测是脚本早就跟不上自定义选择器的变化。**未在 main 上单独复现确认。** |

截图在 `app/docs/acceptance/workbench/`。

## 下一步（按 PLAN_V1.4 §10）
1. **PR-03 事实加厚**：接入真实模型提取，替换示例流水线和启发式抽取。
2. **PR-04 知乎建议加厚**：需要先完成 G0 的知乎能力实测（等你提供条件）。
3. PR-05 内容加厚、PR-06 自动检查加厚、PR-07 回流与导出、PR-08 体验验收与证据包。
4. 修复旧 `smoke.mjs` 的选择器问题（或在 PR-08 清理旧页面时一并处理）。
