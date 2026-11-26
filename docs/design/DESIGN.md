# DESIGN.md — Zhihu Bridge 设计契约（V1.4 · Nebula）

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

**减负不减价值**：行为上以已认可的 Direction D 为底只做减法，视觉上以 §1 的参考图为准。删掉的是用户的操作负担，不是展示产品价值的结构。以下结构必须保留：流程条、桥接卡、依据联动、检查详情。

## 1. Visual Source of Truth
- **当前视觉基准（2026-11-27 起）**：用户提供的界面参考图，共 8 张，放在仓库外的 `D:/agent_project/Zhihu Bridge/界面参考素材/`（约 16 MB，不入库）。覆盖首页、产品资料、知乎认知洞察、海外内容、发布前审校与交付。实现截图见 `app/docs/acceptance/workbench/01-07*.png`。
- **复刻边界**：复刻参考图的视觉语言与版式，**不复刻其中的假数据与假功能**：
  - 不放虚构的指标、版本号、团队名、通知铃；
  - 不加没有功能的导航项（模板中心、团队空间、知识洞察）；
  - 参考图里的对比表、示例数据只在示例项目（PulseRing X1）里出现，并标「示例产品 · 虚构」。
- **Visual Direction Summary**：「Nebula 深空」。深海军蓝画布、青蓝发光、玻璃卡片；首页有刘看山与地球弧线；面板有渐变图标方块；关键结构加发光描边。信息密度中等偏高，三栏工作台。
- **流程结构**：沿用 d3（[`direction-d3.html`](../design-reference/direction-d3.html)）的四步流程、决定与撤销规则；视觉层由参考图取代。§0、§8、§9 的行为规则不变。

## 2. Color Tokens（`app/web/src/workbench/styles.css` 的 `:root`，`color-scheme: dark`）
| Role | Token | Value | Usage Rule |
| :--- | :--- | :--- | :--- |
| Page Canvas | `--bg-canvas` / `--bg-deep` | `#050F24` / `#030A1A` | 页面底色，叠加顶部径向光晕与星点 |
| Glass Surface | `.glass` | `linear-gradient(180deg, rgba(22,50,100,.58), rgba(9,26,58,.62))` + 1px `--border-subtle` + blur | 所有面板、卡片 |
| Raised / Hover | `--bg-raised` / `--bg-hover` | `rgba(26,56,110,.55)` / `rgba(96,165,250,.10)` | 选中行、悬停 |
| Primary Text | `--text-primary` | `#EAF3FF` | 标题、正文 |
| Secondary Text | `--text-secondary` | `#B4C8E8` | 说明 |
| Muted Text | `--text-muted` | `#8AA2C8` | 元信息（在画布上 ≥ 6:1） |
| Borders | `--border-subtle` / `--border-strong` / `--border-glow` | 16% / 32% / 55% 透明度的青蓝 | 分隔线 / 控件 / 选中与焦点发光 |
| Accent | `--accent-cyan` / `--accent-primary` / `--accent-grad` | `#38E1FF` / `#3AA0FF` / `90deg #45E6FF→#3AA0FF` | 主按钮（深色字 `--text-on-accent #03182F`）、当前步骤、焦点环 |
| Title Gradient | `--title-grad` | `#5CE8FF→#4DA3FF` | 首页 H1 的「认知桥梁」等一处强调词 |

### 语义色（固定含义，全站一致）
| 含义 | Token | Value | 用在哪里 |
| :--- | :--- | :--- | :--- |
| **需要你决定** | `--need`（= `--status-warning`） | `#FBBF24` | 状态按钮、决定区、正文占位 |
| **系统已处理 / 已完成** | `--status-success` | `#34D399` | 正文绿色虚线、「已检查」「已确认」「可以导出」 |
| **风险 / 已拦下** | `--status-danger` | `#F87171` | 你保留的风险原句、新写入的风险说法 |
| **信息** | `--status-info` | `#60A5FA` | 中性提示 |
| **演示 / 说明** | `.t-demo` 石板灰描边标签 | — | 「示例产品 · 虚构」「开发占位 · 非真实运行」 |

### 来源层（颜色、形状、文字三者同时出现）
| 层 | Token | 形状 | 界面文字 |
| :--- | :--- | :--- | :--- |
| 企业资料 | `--layer-company` `#C7D6F2` | 方块 | 你的资料 |
| 知乎社区 | `--layer-zhihu` `#5BB0FF` | 圆点 | 知乎讨论 |
| 英文参考 | `--layer-global` `#2DD4BF` | 菱形 | 英文同类产品 |
| 官方规则 | `--layer-rule` `#A78BFA` | 三角 | 官方规则提示 |
| AI 推断 | `--layer-ai` `#94A3B8` | 灰色虚线圈 | AI 推断 · 待验证 |

## 3. Typography System
- **Font Delivery**：`@fontsource/inter` 400/500/600/700/800 + latin-800-italic，由 Vite 打包。中文走系统字体栈：`"PingFang SC","HarmonyOS Sans SC","Microsoft YaHei","Noto Sans SC",sans-serif`。Mono 用系统 `Cascadia Mono / Consolas`。
- **Display**：Inter 800 italic，用于首页 H1，字号为 `clamp(32px, 2.75vw, 46px)`；两行都不在词中间断开，`≤768` 时 30px，允许换行。Inter 800 italic 也用于英文页主标题。
- **Headings**：项目名 30px/800；面板标题 18–20px/700，后面跟一个灰色英文副标题（如 `/ Global Launch Content`）。
- **Body / UI**：14px，行高 1.6；英文正文 15–16px。
- **不用于内部编号**：界面不显示 F-/I-/R-/W- 这类编号。

## 4. Layout, Spacing & Surface Rhythm
- **顶栏**：64px，吸顶。依次是 logo、中英副标题、「新建项目」（主按钮）、「最近项目」、Demo、头像。
- **首页**：`1fr | 360px`。左侧是 hero（文案 | 刘看山 + 地球弧线，四周径向渐隐）、三张能力卡和最近项目；右侧是「出海内容工作流」面板。
- **工作台**：
  1. 面包屑；
  2. 项目头卡：产品图块、名称、状态标签、设置芯片、完成环、主按钮；
  3. 玻璃流程条：4 步 + 导出交付；
  4. 按步骤分栏：
     - 资料 `1fr | 1.25fr`；
     - 洞察 `1fr | 340px`；
     - 内容 `220px | 1fr | 360px`；
     - 审校 `360px | 1fr | 380px`，底部有交付栏。
- **断点**：`1280 / 1100 / 768`。
  - `≤1280`：三栏的最右栏落到下方。
  - `≤1100`：单栏，**主内容排在辅助信息之前**。
  - `≤768`：
    - 隐藏顶栏文字与头像，隐藏产品图块，设置芯片收为单行；
    - 流程条横向滑动；
    - 任何宽度都不允许页面横向溢出（e2e 在 390 宽度下检查）。
- **Radius**：`6 / 10 / 16 / 20px`（标签 / 按钮与选项 / 卡片 / 大面板）。
- **Elevation**：`--shadow-card`（玻璃卡）、`--shadow-glow`（选中、当前步骤）、`--shadow-pop`（弹层、抽屉、Toast）。

## 5. Component & Reference Sources
- **Stack**：React 19 + Vite 8 + TypeScript；新增 `@fontsource/inter`，不引入组件库。
- **Base UI Primitives**：原生元素。抽屉用 `<dialog>`；流程条用 `role="tablist"`；开关用 `role="switch"`。弹层和菜单自写，支持 Esc 关闭、点击外部关闭和默认焦点规则。
- **Iconography Set**：`icons.tsx` 内联 SVG（24 网格，描边 1.6）。另有渐变定义 `GradDefs`，以及 `Logo`、`ProductTile`、`Ring` 三个图形组件。不引入图标库，不用 emoji。
- **Audit Tool**：`app/web/e2e/workbench.mjs`，基于 playwright-core。覆盖点击预算、撤销、焦点、编辑后复查、导出和 390 宽度溢出检查。

## 6. Iconography & Imagery
- **吉祥物**：刘看山官方 GIF。
  - 首页：`kanshan-wave`；
  - 运行进度：`kanshan-idle`；
  - 洞察页：`kanshan-laptop`；
  - 静态兜底：`kanshan-still.png`。
  - `prefers-reduced-motion` 时用静态图。
- **装饰**：只用 CSS / SVG 绘制，不用照片：
  - 首页的地球、弧线和「知」徽标；
  - 项目头卡的轨道弧线；
  - 渐变图标方块 `.itile`（cyan / violet / teal / zhi）。
- **产品图**：没有真实产品照片时，用 `ProductTile` 的发光线稿代替，不放虚构的产品照片。

## 7. Motion Tokens
- **Easing**：`--ease-standard: cubic-bezier(.2,.7,.2,1)`。
- **Durations**：`--dur-fast 150ms` / `--dur-base 220ms` / `--dur-slow 340ms`。
- **反馈**：
  - 被改动的文本闪一次（`.changed`）；
  - 检查中显示 spinner；
  - Toast 从底部弹出，带「撤销」；
  - 当前步骤和选中卡片有发光描边。
- **Reduced Motion**：关闭全部动画和过渡，吉祥物换成静态图。

## 8. Anti-Patterns（本项目禁止）
- [ ] 不用 emoji 当图标。
- [ ] 不在卡片里套卡片。
- [ ] 不在 `:root` token 之外写临时 hex 色值（图标渐变定义与装饰性光晕除外）。
- [ ] 不复刻参考图里的假数据、假指标和没有功能的导航项。
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
