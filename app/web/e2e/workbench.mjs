// V1.4 四步工作台 E2E：主路径点击预算、撤销、默认焦点、编辑后复查、导出、手机宽度溢出（PLAN §8.4）。
// 用法：node e2e/workbench.mjs [base=http://127.0.0.1:8787] [out=../docs/acceptance/workbench]
// 需要后端以 fake 模式运行并服务 web/dist；浏览器路径用 CHROMIUM_PATH 指定。
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const [, , base = "http://127.0.0.1:8787", out = "../docs/acceptance/workbench"] = process.argv;
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox", "--disable-gpu", "--no-proxy-server"],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", permissions: ["clipboard-read", "clipboard-write"] });
const page = await context.newPage();
const failures = [];
page.on("pageerror", (e) => failures.push(String(e)));
page.on("response", (r) => { if (new URL(r.url()).origin === base && r.status() >= 500) failures.push(r.status() + " " + new URL(r.url()).pathname); });
const shot = (name) => page.screenshot({ path: `${out}/${name}.png` });
let clicks = 0;
const click = async (loc) => { clicks++; await loc.click(); };
const pill = () => page.locator(".pill").innerText();
const settle = () => page.waitForTimeout(750);

try {
  // ---- 1. 首页 → 示例项目 → 运行进度 → 自动进入第 1 步
  await page.goto(base + "/");
  await page.getByRole("heading", { level: 1 }).waitFor();
  await shot("01-home");
  await click(page.getByRole("button", { name: /打开示例项目/ }));
  await page.locator(".runlist").waitFor();
  await page.waitForURL(/#\/p\/.+\/materials/, { timeout: 15000 });
  assert.equal(await pill(), "还需你决定 3 件");
  await page.waitForTimeout(300);
  await shot("02-materials");

  // ---- 2. 撤销覆盖：决定 → Toast 撤销；再决定 → Ctrl+Z
  await page.getByRole("button", { name: /3\.6 g（9 号指围）/ }).first().click();
  await settle();
  assert.equal(await pill(), "还需你决定 2 件");
  await page.locator(".toast").getByRole("button", { name: "撤销" }).click();
  await settle();
  assert.equal(await pill(), "还需你决定 3 件", "Toast 撤销应还原");

  // ---- 3. 主路径：3 次判断（第 1 步决定区）
  await click(page.getByRole("button", { name: /3\.6 g（9 号指围）/ }).first());
  await settle();
  await click(page.getByRole("button", { name: /照实写：上市可导出/ }).first());
  await settle();
  await click(page.getByRole("button", { name: /都对，确认这 4 条/ }).first());
  await settle();
  assert.equal(await pill(), "可以导出了");
  await page.keyboard.press("Control+z");
  await settle();
  assert.equal(await pill(), "还需你决定 1 件", "Ctrl+Z 应撤销最近一次决定");
  await page.keyboard.press("Control+y"); // 无副作用
  await page.getByRole("button", { name: /都对，确认这 4 条/ }).first().click();
  await settle();
  assert.equal(await pill(), "可以导出了");

  // ---- 4. 第 2 步：桥接卡与开关
  await page.locator("#t-insights").click();
  await page.locator(".icard").first().waitFor();
  assert.equal(await page.locator(".icard").count(), 3);
  await shot("03-insights");

  // ---- 5. 第 3 步：系统修订弹层的默认焦点 + 编辑后复查
  await page.locator("#t-content").click();
  await page.locator(".fx").first().click();
  assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "好的", "默认焦点不能落在“恢复原句”");
  await page.keyboard.press("Escape");
  await page.locator(".feat").nth(2).click();
  assert.equal(await page.locator(".lchip.is-linked").count(), 2, "卖点应高亮它用到的事实与知乎建议");
  await shot("04-content");
  const faq = page.locator("#m-faq");
  await faq.getByRole("button", { name: "编辑" }).click();
  await faq.locator(".editable").nth(1).evaluate((el) => { el.textContent = "No. It is fully waterproof and a wellness ring."; });
  await faq.getByRole("button", { name: "保存" }).click();
  await faq.getByText("检查中…").waitFor({ timeout: 2000 });
  await faq.locator("mark.risk").waitFor({ timeout: 3000 });
  assert.equal(await pill(), "还需你决定 1 件");
  await faq.locator("mark.risk").click();
  await page.locator(".pop .opt.primary").click();
  await settle();
  assert.equal(await pill(), "可以导出了");

  // ---- 6. 第 4 步：高风险恢复必须选理由
  await page.locator("#t-review").click();
  await page.locator(".issue", { hasText: "全天续航" }).click();
  await page.locator(".review-detail").getByRole("button", { name: /恢复原句/ }).click();
  assert.equal(await page.locator(".review-detail .reasons button").count(), 3);
  await shot("05-review");
  await page.locator(".review-detail .reasons button").first().click();
  await settle();
  await page.locator(".review-detail").getByText("你保留了原句").first().waitFor();
  await page.keyboard.press("Control+z");
  await settle();

  // ---- 7. 导出：全部决定后不含 [待确认]
  await click(page.getByRole("button", { name: "导出交付" }));
  await page.locator("dialog pre.md").first().waitFor();
  const md = await page.locator("dialog pre.md").first().innerText();
  assert.ok(!md.includes("[待确认]"), "全部决定后导出不应有占位");
  assert.ok(!/all-day battery|fda approved|medical-grade/i.test(md), "导出不应含无依据声称");
  await shot("06-export");
  const [download] = await Promise.all([page.waitForEvent("download"), click(page.getByRole("button", { name: /下载全部/ }))]);
  assert.match(download.suggestedFilename(), /launch-pack\.md$/);
  console.log(`主路径点击数：${clicks}（含打开示例项目与导出）`);
  assert.ok(clicks <= 6, `主路径点击超出预算：${clicks}`);
  await page.keyboard.press("Escape");

  // ---- 8. 手机宽度：无横向溢出，主内容在前
  await page.setViewportSize({ width: 390, height: 844 });
  for (const step of ["materials", "insights", "content", "review"]) {
    await page.locator(`#t-${step}`).click();
    await page.waitForTimeout(150);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    assert.equal(overflow, false, `${step} 在 390 宽度下横向溢出`);
  }
  await page.locator("#t-content").click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(150);
  const order = await page.evaluate(() => ({
    doc: document.querySelector("#m-headline")?.getBoundingClientRect().top ?? 0,
    index: document.querySelector(".chip-list")?.getBoundingClientRect().top ?? 0,
  }));
  assert.ok(order.doc < order.index, "手机上英文正文应排在依据列表之前");
  await shot("07-mobile-content");

  // ---- 9. 旧页面仍可访问
  const legacy = await page.goto(base + "/legacy.html");
  assert.equal(legacy?.status(), 200);

  assert.deepEqual(failures, []);
  console.log("workbench e2e: ok");
} catch (e) {
  await shot("failure").catch(() => {});
  console.error(failures);
  throw e;
} finally {
  await browser.close();
}
