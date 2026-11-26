// Connected frontend smoke using the local fake backend or a static fixture bundle.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const [, , base = "http://127.0.0.1:8787", out = "../docs/acceptance/screens"] = process.argv;
const offline = process.argv.includes("--offline");
const query = offline ? "?offline=1" : "?dev=1";
const prefix = offline ? "offline-" : "";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox", "--disable-gpu", "--no-proxy-server"],
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  reducedMotion: "reduce",
  permissions: ["clipboard-read", "clipboard-write"],
});
await context.route("https://fonts.googleapis.com/**", (r) => r.abort());
await context.route("https://fonts.gstatic.com/**", (r) => r.abort());
const page = await context.newPage();
const failures = [];
let apiRequests = 0;
page.on("pageerror", (e) => failures.push(String(e)));
page.on("request", (r) => { if (new URL(r.url()).pathname.startsWith("/api/")) apiRequests++; });
page.on("response", (r) => {
  const url = new URL(r.url());
  if (url.origin === base && r.status() >= 400) failures.push(r.status() + " " + url.pathname);
});

const ready = () => page.locator("#copyFinal:enabled").waitFor({ timeout: 15000 });
const level = () => page.locator("#stops .on").innerText();
const shot = (name) => page.screenshot({ path: out + "/" + prefix + name + ".png" });
try {
  await page.goto(base + "/legacy.html" + query);
  await page.getByText(/开发占位 · 非真实运行/, { exact: false }).filter({ visible: true }).waitFor();
  assert.equal(await page.locator("#heroChips .chip").count(), offline ? 2 : 3);
  if (!offline) {
    await page.locator("[data-fill=b]").click();
    assert.equal(await page.locator("#input").inputValue(), "自研高密度堆料主板，极限压榨功耗，支持底层协议调试。");
  }
  await page.locator("[data-fill=a]").click();
  assert.match(await page.locator("#input").inputValue(), /此乃天道因果/);
  await page.locator("#startBtn").click();
  await ready();
  assert.match(await page.locator(".livechip").innerText(), /开发占位 · 非真实运行/);
  assert.doesNotMatch(await page.locator(".livechip").innerText(), /缓存回放|实时生成/);
  assert.equal(await level(), "通俗版");
  await shot("connected-a");

  // Wait for a blocked request to verify the copy lock while a new run is pending.
  if (!offline) {
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    await page.route("**/api/runs", async (route) => { await pending; await route.continue(); }, { times: 1 });
    await page.getByLabel("目标受众").selectOption("a_genre");
    try { assert.ok(await page.locator("#copyFinal").isDisabled()); }
    finally { release(); }
  } else {
    await page.getByLabel("目标受众").selectOption("a_genre");
    assert.ok(await page.locator("#copyFinal").isDisabled());
  }
  await ready();
  assert.equal(await level(), "保留术语");
  assert.match(await page.locator("#lvlFit").innerText(), /惯用术语/);

  await page.locator("#sourceText .src-term", { hasText: "九重雷劫" }).click();
  const evidence = page.locator(".ev.flipped").first();
  assert.match(await evidence.locator(".ev-back").innerText(), /能支撑.*\n.*不能支撑|能支撑[\s\S]*不能支撑/);
  assert.match(await evidence.locator("a").getAttribute("href"), /^https?:/);
  assert.match(await page.locator("#annos").innerText(), /D1[\s\S]*归因：知乎/);
  const before = apiRequests;
  await page.getByRole("button", { name: "通俗版" }).click();
  await page.getByRole("button", { name: "保留术语" }).click();
  assert.equal(apiRequests, before);
  console.log("PASS  案例 A、受众推荐、生成期复制锁定、证据翻卡、决策说明及本地换档");

  await page.locator("#runTest").click();
  await page.locator("#results .p-card").last().waitFor();
  assert.match(await page.locator("#results").innerText(), /模拟复述 6\/6 次/);
  assert.match(await page.locator("#results .score").innerText(), /读懂的信息点/);
  assert.match(await page.locator("#results").innerText(), /开发占位 · 非评测结果/);
  await shot("connected-a-test");
  await page.locator("#pCommunity").getByRole("button", { name: "用本次误解生成草稿" }).click();
  await page.locator("#draftTitle").waitFor();
  assert.match(await page.locator("#modal").innerText(), /模拟读者误解（非真实用户）/);
  assert.match(await page.locator("#modal").innerText(), /缓存.*2026-11-19|2026-11-19.*缓存/);
  assert.match(await page.locator("#modal").innerText(), /系统不发布/);
  assert.equal(await page.locator("#modal").getByRole("link", { name: /打开知乎/ }).getAttribute("href"), "https://www.zhihu.com/");
  assert.ok((await page.locator("#draftText").inputValue()).trim());
  await shot("connected-draft");
  await page.locator("#closeModal").click();
  await page.getByRole("button", { name: "通俗版" }).click();
  assert.match(await page.locator("#stale").innerText(), /上一档位/);
  assert.equal(await page.locator("[data-service-misreading]").count(), 0);
  await page.reload();
  await ready();
  assert.equal(await level(), "通俗版");
  assert.equal(await page.getByLabel("目标受众").inputValue(), "a_genre");
  console.log("PASS  模拟读者、回流草稿、旧结果标记、刷新恢复档位和受众");

  await page.locator("[data-case=c]").click();
  await ready();
  const expectedC = "A light, refreshing herbal tea for humid days — cooling and soothing to rescue you from late-night burnout.";
  assert.equal(await page.locator("#txText").innerText(), expectedC);
  assert.match(await page.locator("#guard").innerText(), /当地广告法排查[\s\S]*当地风俗习惯排查/);
  await page.locator("#sourceText .src-term", { hasText: "回南天" }).click();
  assert.match(await page.locator(".ev.flipped .ev-back").first().innerText(), /不能支撑[\s\S]*功效/);
  await page.locator("#copyFinal").click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), expectedC);
  if (offline) assert.equal(apiRequests, 0);
  assert.deepEqual(failures, []);
  await shot("connected-c");
  console.log("PASS  案例 C 守门与终稿复制" + (offline ? " · 未调用 API" : ""));
} finally {
  await browser.close();
}
