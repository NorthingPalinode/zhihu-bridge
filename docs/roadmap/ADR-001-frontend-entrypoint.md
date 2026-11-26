# ADR-001：前端入口——Vite 多页面，新工作台与旧页面隔离

- 状态：已采纳（2026-11-26）
- 关联：PLAN_V1.4 §1.3、§6.3

## 背景
现在的 `web/index.html` 是旧版单句转译页面：内联样式加旧原型脚本，通过动态 `import('./src/connected.ts')` 接入后端。`src/main.tsx` 及其下的 React 组件没有被挂载，也属于旧产品形态。新的四步工作台需要一个干净的入口，同时不能破坏旧能力和现有的 e2e。

## 决定
1. 原样保留旧页面，只把它移到 `web/legacy.html`，脚本仍然导入 `connected.ts`。
2. 新的 `web/index.html` 只挂载新工作台，入口是 `src/workbench/main.tsx`。
3. `vite.config.ts` 用 `build.rollupOptions.input` 同时构建 `index.html` 和 `legacy.html`；保留 `ZB_TEST_BUNDLE` 离线别名。
4. 旧 e2e（`smoke.mjs`、`degrade.mjs`、`prototype.mjs`）改为访问 `/legacy.html`。
5. 后端 SPA 回退仍然返回 `index.html`；`/legacy.html` 作为静态文件直接返回。
6. 不再给 `legacy.html` 增加任何功能。旧的 `App.tsx` / `ui/*` 在 PR-08 清理。

## 影响
- 新旧页面共用同一个后端，旧路由（`/api/runs` 等）保留。
- 旧 e2e 的选择器不用改，只改入口地址。
