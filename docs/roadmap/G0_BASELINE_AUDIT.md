# G0 基线审计（PR-00）

审计日期：2026-11-26。分支：`feat/v1.4-workbench`，基于 `main@e5351af`。

## 1. 代码事实来源
- **结论：以 GitHub 仓库 `NorthingPalinode/zhihu-bridge` 为唯一事实来源。**
- 本地目录 `D:\agent_project\Zhihu Bridge\app`（不是 git 仓库）与仓库 `app/` 的差异：

| 差异 | 判断 |
| :--- | :--- |
| `.gitignore`：仓库多出 `.env.*`、`*.log`、`*.sqlite3*` 等忽略项 | 仓库更新、更完整 |
| `README_zh.md`、`web/e2e/prototype.mjs`：本地版本仍引用已删除的 `prototype/index.html` | 仓库更新（`be0a244` 已移除独立原型） |
| `server/tests/test_api.py`：只差一个空行 | 无实质差异 |
| 本地独有 `docs/`（旧验收证据）、`SHA256SUMS.txt`、`web/src/assets/delivery-hardware-bg.png`（未被引用） | 历史产物，不合并 |

- 处理方式：**不需要合并**，直接在仓库工作区开分支开发。

## 2. 基线测试（实测）
| 项目 | 命令 | 结果 |
| :--- | :--- | :--- |
| 后端 | `python -m pytest -q`（Python 3.12.14，FastAPI 0.165，Pydantic 2.14） | **89 passed** |
| 前端单测 | `npx vitest run` | **37 passed**（5 个文件） |
| 前端构建 | `npm run build`（`tsc -b && vite build`） | 通过 |
| 旧 e2e | `e2e/smoke.mjs` 等 | 需要 Chromium 路径，本次未跑；入口切换后改为指向 `/legacy.html` |

## 3. 现有调用链（摘要）
- 当前对外运行的页面是 `web/index.html`（内联样式和旧原型脚本），它动态导入 `src/connected.ts`，调用 `/api/runs`（SSE）、`/api/questions/draft`、`/api/zhihu/*`。
- `src/main.tsx` → `App.tsx` → `ui/*` 是一套没有被挂载的 V5 React 组件。
- 后端：`api/app.py` 是 FastAPI 工厂；`pipeline/deps.py` 是依赖容器（Settings、FixtureStore、SQLite Store、LLM 适配器、知乎客户端）；`core/store.py` 是 SQLite WAL 存储。

## 4. 知乎能力实测（未完成，需要你提供条件）
§1.6 要求的实测会调用真实的知乎开放接口，并消耗公网额度或个人凭证额度，所以本次**没有执行**。需要你：
1. 提供一个可用的个人知乎 Access Secret（通过安全输入，不要写进代码或聊天）；或者确认可以使用公网额度；
2. 确认后，按 §1.6 跑 5 个英文 `global_search` 查询，并测试 `question_answers` 与 `knowledge_upload` 的可见范围，结果写入 `ZHIHU_CAPABILITY_CHECK.md`。

在实测完成前，骨架阶段只使用 `curated_demo` 示例数据，界面如实标注「示例数据（未实时检索）」。
