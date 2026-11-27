// Browser check of the app's demo mode, with pixel comparisons when an HTML reference is supplied.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const [, , base = "http://127.0.0.1:8787", out = "../docs/acceptance/screens", input] = process.argv;
const reference = input ? resolve(input) : undefined;
const compare = reference !== undefined && existsSync(reference);
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox", "--disable-gpu", "--no-proxy-server"],
});
mkdirSync(out, { recursive: true });

async function capture(page, name, size) {
  return page.screenshot({ path: out + "/" + size + "-" + name + ".png", fullPage: true, animations: "disabled" });
}
async function enterA(page) {
  await page.locator("[data-fill=a]").click();
  await page.locator("#startBtn").click();
  await page.locator("#runTest").waitFor({ timeout: 15000 });
  await page.mouse.move(0, 0);
}
async function comparePixels(page, actual, expected, name) {
  const { dimensionsMatch, ratio } = await page.evaluate(async ([first, second]) => {
    async function decode(png) {
      const bitmap = await createImageBitmap(await (await fetch("data:image/png;base64," + png)).blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);
      return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    }
    const a = await decode(first);
    const b = await decode(second);
    if (a.width !== b.width || a.height !== b.height) return { dimensionsMatch: false, ratio: 1 };
    let mismatches = 0;
    for (let i = 0; i < a.data.length; i += 4) {
      if ([0, 1, 2].some((c) => Math.abs(a.data[i + c] - b.data[i + c]) > 4)) mismatches++;
    }
    return { dimensionsMatch: true, ratio: mismatches / (a.width * a.height) };
  }, [actual.toString("base64"), expected.toString("base64")]);
  // Exact DOM and CSS are checked separately. Edge can composite subpixel text differently between captures.
  assert.ok(dimensionsMatch && ratio < 0.0025, name + " 截图差异 " + (ratio * 100).toFixed(3) + "%");
  return (ratio * 100).toFixed(3) + "%";
}
const dimensions = [{ width: 1440, height: 900 }, { width: 390, height: 844 }];
const errors = [];

try {
  for (const viewport of dimensions) {
    const context = await browser.newContext({ viewport, reducedMotion: "reduce", deviceScaleFactor: 1 });
    await context.route("https://fonts.googleapis.com/**", (r) => r.abort());
    await context.route("https://fonts.gstatic.com/**", (r) => r.abort());
    const actual = await context.newPage();
    actual.on("pageerror", (e) => errors.push(String(e)));
    const size = String(viewport.width);
    let referenceHome;
    let referenceWork;
    let referenceStyle;
    let referenceHomeLayout;
    let referenceWorkLayout;
    if (compare) {
      const route = (r) => r.fulfill({
        contentType: "text/html; charset=utf-8",
        body: readFileSync(reference),
      });
      await actual.route(base + "/legacy.html", route);
      await actual.goto(base + "/legacy.html");
      referenceStyle = await actual.locator("style").first().textContent();
      referenceHomeLayout = await actual.locator("#app").innerHTML();
      referenceHome = await capture(actual, "reference-home", size);
      await enterA(actual);
      referenceWorkLayout = await actual.locator("#app").innerHTML();
      referenceWork = await capture(actual, "reference-workbench", size);
      await actual.unroute(base + "/legacy.html", route);
    }
    await actual.goto(base + "/legacy.html?demo=1");
    assert.equal(await actual.locator("#heroChips .chip").count(), 3);
    assert.match(await actual.locator("h1").innerText(), /也让他们信得过/);
    if (referenceHome) {
      assert.equal(await actual.locator("style").first().textContent(), referenceStyle, "样式与原型一致");
      assert.equal(await actual.locator("#app").innerHTML(), referenceHomeLayout, "首页 DOM 与原型一致");
    }
    const home = await capture(actual, "home", size);

    await enterA(actual);
    assert.equal(await actual.locator("#stops button").count(), 5);
    if (referenceWork) assert.equal(await actual.locator("#app").innerHTML(), referenceWorkLayout, "工作台 DOM 与原型一致");
    const work = await capture(actual, "workbench", size);
    const detail = compare
      ? " · 与原型 CSS / DOM 一致，截图像素差异 " + await comparePixels(actual, home, referenceHome, size + " 首页") +
        " / " + await comparePixels(actual, work, referenceWork, size + " 工作台")
      : "";
    console.log("PASS  " + size + " px 首页和案例 A 工作台" + detail);

    if (viewport.width === 1440) {
      await actual.locator("#sourceText [data-terms='1']").hover();
      assert.ok(await actual.locator("#bridge .b-row.hl").count());
      await actual.locator("#ev-0 .ev-flip").first().click();
      assert.match(await actual.locator("#ev-0").getAttribute("class"), /flipped/);
      await actual.locator("#stops [data-l='5']").click();
      assert.equal(await actual.locator("#lvl").inputValue(), "5");
      assert.match(await actual.locator("#lvlName").innerText(), /完全异化/);
      await actual.locator("#tDuel").click();
      assert.ok(await actual.locator("#duelCard").isVisible());
      await actual.locator("#tTrace").click();
      assert.match(await actual.locator("#traceBody").innerText(), /translate\.switch/);
      await actual.locator("#tTrace").click();
      await actual.locator("#tTheme").click();
      assert.equal(await actual.locator("html").getAttribute("data-theme"), "dark");
      await capture(actual, "dark-duel", size);
      await actual.locator("#tTheme").click();
      await actual.locator("#tDuel").click();
      await actual.locator("#runTest").click();
      await actual.locator("#scoreBox .mx").waitFor({ timeout: 15000 });
      await actual.locator("#stops [data-l='3']").click();
      assert.match(await actual.locator("#stale").innerText(), /对应第 5 档/);
      await actual.locator("#tSheet").click();
      assert.ok(await actual.locator("#sheet.on").isVisible());
      await actual.locator("[data-draft]").first().click();
      assert.match(await actual.locator("#modal.on h3").innerText(), /知乎提问草稿/);
      await actual.locator("#closeModal").click();
      await actual.locator("#approve").click();
      await actual.locator("#deliver .pill.ok").waitFor();
      await actual.locator("[data-case=b]").click();
      await actual.locator("#runTest").waitFor({ timeout: 15000 });
      await actual.locator("#bH").fill("36");
      await actual.locator("#bC").fill("蓝牙常连");
      await actual.locator("#bApply").click();
      assert.match(await actual.locator("#txText").innerText(), /36 h/);
      await actual.locator("[data-case=c]").click();
      await actual.locator("#runTest").waitFor({ timeout: 15000 });
      assert.match(await actual.locator("#guard").innerText(), /清热解毒/);
      console.log("PASS  悬停联动、翻卡、五档切换、对照、主题、追踪、模拟复述、草稿、答主授权和案例 B/C");
    }
    await context.close();
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
