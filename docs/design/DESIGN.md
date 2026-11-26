# DESIGN.md — Zhihu Bridge 设计契约（V1.4）

> Stage 2 产物，从用户已确认的 Stage 1 原型反向提取。之后所有正式 UI 页面和组件都必须遵守本契约。产品背景见 [`docs/product/PRODUCT.md`](../product/PRODUCT.md)，开发计划见 [`docs/roadmap/PLAN_V1.4.md`](../roadmap/PLAN_V1.4.md)。

## 0. 体验宪章（高于一切视觉规则）
复杂留给系统，不留给用户。每个界面决策都要逐条对照这 8 条：
1. 系统能判断的，不留给用户
2. 此刻没用的，就不出现
3. 能替人做的，就直接做
4. 同一件事，处处一样
5. 按下去有回应，再按能收回
6. 不打断人手上的事
7. 常用的好做，会丢东西的难误碰
8. 界面自己说明自己

**减负不减价值**：在已认可的 Direction D 上做减法。删掉的是用户的操作负担，不是展示产品价值的结构。以下结构必须保留：流程条、桥接卡、依据联动、检查详情。

## 1. Visual Source of Truth
- **Approved HTML Reference**：[`docs/design-reference/direction-d3.html`](../design-reference/direction-d3.html)。用户于 2026-11-26 确认，项目根目录的 `.ui-preview/direction-d3.html` 是同一个文件。
- **Visual Direction Summary**：「证据链工程台」。顶栏深海军蓝，工作区为中性灰白，知乎蓝是唯一强调色，字体用 IBM Plex 家族，偏工程气质。工作台采用两栏、中等信息密度，以细线边框为主，阴影很克制。

## 2. Color Tokens
| Role | Token | Value | Usage Rule |
| :--- | :--- | :--- | :--- |
| Page Canvas | `--bg-canvas` | `#F2F3F1` | 页面底色 |
| Primary Surface | `--bg-surface` | `#FFFFFF` | 面板、卡片、抽屉 |
| Subtle Surface | `--bg-subtle` | `#E9EBE7` | 悬停填充、中性标签 |
| Sunken Surface | `--bg-sunken` | `#F7F8F6` | 表头、引文框、卡片页脚 |
| Chrome | `--bg-chrome` / `--bg-chrome-2` | `#0F1B2B` / `#192A3E` | 仅用于顶栏 |
| Primary Text | `--text-primary` | `#121A23` | 正文与标题（在画布上对比度 ≥ 15:1） |
| Secondary Text | `--text-secondary` | `#3A4552` | 说明文字（≥ 9:1） |
| Muted Text | `--text-muted` | `#56606C` | 元信息（在白底上 ≥ 6:1，在画布上 ≥ 5.6:1） |
| Hairline Border | `--border-subtle` | `#DCDFDA` | 分隔线 |
| Control Border | `--border-control` | `#858D86` | 输入框、按钮描边（≥ 3:1） |
| Brand Accent | `--accent-primary` | `#0B5FDB` | 唯一主操作色、焦点环、推荐标记；白字对比度 5.6:1 |

### 语义色（固定含义，全站一致）
| 含义 | Token | Value | 用在哪里 |
| :--- | :--- | :--- | :--- |
| **需要你决定** | `--need` / `--need-bg` / `--need-line` | `#9C5700` / `#FBF0DC` / `#E6C789` | 状态胶囊、决定区、正文占位、段落状态 |
| **系统已处理 / 已完成** | `--status-success` / `-bg` | `#127A4A` / `#E3F3EA` | 正文绿色虚线、「已检查」「已确认」「可以导出了」 |
| **风险 / 已拦下** | `--status-danger` / `-bg` | `#BE2530` / `#FBE9EA` | 用户保留的风险原句、新写入的风险说法、无依据事实 |
| **演示 / 说明** | 中性石板灰 `#4A5563` + `#C5CBD3` 描边 | — | 「示例产品 · 虚构」「开发占位 · 非真实运行」 |

### 来源层（颜色、形状、文字三者同时出现，不只靠颜色区分）
| 层 | Token | 形状 | 界面文字 |
| :--- | :--- | :--- | :--- |
| 企业资料 | `--layer-company` `#26313D` | 方块 | 你的资料 |
| 知乎社区 | `--layer-zhihu` `#0B5FDB` | 圆点 | 知乎讨论 |
| 英文参考 | `--layer-global` `#0E6F67` | 菱形 | 英文同类产品 |
| 官方规则 | `--layer-rule` `#6B3DBA` | 三角 | 官方规则提示 |
| AI 推断 | `--layer-ai` `#4A5563` | 灰色虚线圈 | AI 推断 · 待验证 |

> 不使用框架别名层：项目没有使用 shadcn 等带自有变量的组件库。

## 3. Typography System
- **Font Delivery**：自托管 `.woff2`，放在 `app/web/src/workbench/fonts/`，来自 `@fontsource` 5.3.0 的 latin 子集，内容与原型一致。中文走系统字体栈：`"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC",sans-serif`。
- **Display**：IBM Plex Sans Condensed 600，用于首页 H1（44/1.14）、桥接卡标题（22）、英文页主标题（24）、关键数字。
- **Body / UI**：IBM Plex Sans 400/500/600，基础字号 14px，行高 1.55；英文正文 14.5px，行高 1.6。
- **Mono**：IBM Plex Mono 400/500，用于文件名与资料定位。**不用于内部编号**：界面不显示 F-/I-/R-/W- 这类编号。
- **Scale**：Display 44 / H1 28 / H2 22 / H3 14–16（600）/ Body 14 / Small 12.5 / Micro 11.5。

## 4. Layout, Spacing & Surface Rhythm
- **工作台**：顶栏 52px，吸顶。下面依次是设置行和流程条（吸顶），再下面是两栏 `340px | 1fr`；第 4 步为 `380px | 1fr`。栏间距 20px，左右边距 24px（移动端 16px）。
- **首页**：最大宽度 1240px，两栏 hero（1.08fr | 1fr），间距 48px。
- **断点**：`1440 / 1024 / 768 / 375`。`≤1100` 时变为单栏，且**主内容排在辅助信息之前**（第 1 步决定区、第 2 步桥接卡、第 3 步英文正文）。`≤768` 时设置芯片换行，流程条可以横向滑动。任何宽度下都不允许页面横向溢出。
- **Spacing Unit**：4px 网格。面板内边距 14–16px，卡片间距 16px。
- **Radius**：`--radius-sm 4px`（标签、来源层）、`--radius-md 6px`（按钮、输入框、选项）、`--radius-lg 10px`（面板、卡片、弹层）。
- **Elevation**：以边框为主。`--shadow-sm` 只给面板一像素的底边投影；`--shadow-md` 只用于弹层、菜单、抽屉、Toast。

## 5. Component & Reference Sources（Stage 2 锁定）
- **Stack**：React 19 + Vite 8 + TypeScript（沿用 `app/web` 现有依赖，不新增运行时依赖）。
- **Base UI Primitives**：原生元素。抽屉用 `<dialog>`，此外使用 `<button>`、`role="tablist"` 的流程条、`role="switch"` 的复选框。弹层和菜单的定位逻辑自写，必须支持 Esc 关闭、点击外部关闭和默认焦点规则。
- **Iconography Set**：一套内联 SVG sprite（24 网格，描边 1.6，圆角端点），与原型一致。不引入图标库，不用 emoji。
- **Component Spec Reference**：本文件 §9 与 `direction-d3.html`。
- **Audit Tool**：`app/web/e2e/workbench.mjs`，基于 playwright-core，覆盖主路径的点击预算、撤销覆盖、焦点和溢出检查。

| Tool / Registry | Pinned Version | Locked On |
| :--- | :--- | :--- |
| react / react-dom | 19.3.x（见 lockfile） | 2026-11-26 |
| vite | 8.3.x | 2026-11-26 |
| playwright-core | 1.65.x | 2026-11-26 |
| IBM Plex woff2（@fontsource） | 5.3.0 | 2026-11-26 |

## 6. Iconography & Imagery
- 单一图标集：bridge、upload、download、file、alert、check、x、link、plus、external、copy、pencil、shield、more、undo、hand、paste、right、down，共 19 个。
- 不使用插画或照片。产品价值靠真实文案和证据卡片呈现。

## 7. Motion Tokens
- **Easing**：`--ease-standard: cubic-bezier(.2,.7,.2,1)`
- **Durations**：`--dur-fast 150ms`（悬停、按压）、`--dur-base 220ms`（标签、卡片边框）、`--dur-slow 340ms`（抽屉）。
- **反馈动效**：被改动的文本闪一次蓝底（`.changed`，1.6s）；检查中显示 spinner；Toast 底部弹出。
- **Reduced Motion**：`prefers-reduced-motion: reduce` 时关闭全部动画和过渡。

## 8. Anti-Patterns（本项目禁止）
- [ ] 不用 emoji 当图标。
- [ ] 不在卡片里套卡片。
- [ ] 不在 `:root` token 之外写临时 hex 色值。
- [ ] 不增加需要用户手动触发的“复检 / 刷新 / 采纳”步骤。
- [ ] 不强制跳页；系统操作不切换用户当前所在的步骤。
- [ ] 不使用阻断式确认弹窗；危险操作用“选理由”或“可撤销”代替。
- [ ] 界面不出现版本号、内部编号（F-/I-/R-/W-）、接口名（`zhihu_search`、`curated_demo`）、Brief、stale、Trace（生成记录抽屉内除外）。
- [ ] 不用橙黄色表示 AI 推断或演示；橙黄色只表示“需要你决定”。
- [ ] 弹层默认焦点不落在「恢复原句」「重新生成」这类风险动作上。
- [ ] 减负时不删除流程条、桥接卡、依据联动和检查详情这类展示价值的结构。

## 9. 组件规则
| 组件 | 规则 |
| :--- | :--- |
| `StatusPill`（顶栏） | 显示「还需你决定 N 件」（琥珀）或「可以导出了」（绿）。点击后跳到第 4 步，选中第一件待决定项并聚焦推荐选项 |
| `Stepper` | 4 步，每步下面用人话写状态，数字实时更新。键盘左右键可切换步骤 |
| `DecisionCard` | 在第 1 步决定区、第 3 步正文占位弹层、第 4 步详情三处复用：同一选项、同一推荐标记、同一默认焦点。已决定时显示结论，并给「撤销」或「改一下」 |
| 正文标记 | `.fx` 绿色点虚线表示系统改过，点开显示原句、原因、依据，可「恢复原句」。`.kept` 红底表示你保留了原句。`.ph` 琥珀占位表示等你决定，点开就地选。`mark.risk` 表示你新写入的风险说法 |
| `Popover` | 宽度为 min(390px, 视口 − 24px)，空间不够时向上翻。默认焦点依次取推荐选项、「好的」、关闭按钮。Esc 或点击外部关闭 |
| 段落编辑 | 工具位置固定为「编辑」和「⋯」（重新写这一段 / 复制这一段）。编辑态提供「保存 / 放弃」，Esc 放弃，Ctrl/Cmd+Enter 保存。保存后自动复查这一段 |
| `Toast` | 每个写操作都弹出，带「撤销」按钮（保留 7 秒），也支持 Ctrl/Cmd+Z |
| 高风险恢复 | 必须先选三个预设理由之一：已有实测数据，稍后补上 / 负责人确认保留 / 上线前会再改 |
| 导出抽屉 | 永不阻断。有未决定项时显示「先去决定」；附件（检查报告、中英口径表、知乎草稿）默认折叠 |
