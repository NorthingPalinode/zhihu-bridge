// Connected frontend check for the local FAKE_FAILURE=generate scenario.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const [, , base = "http://127.0.0.1:8787", out = "../docs/acceptance/screens"] = process.argv;
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox", "--disable-gpu", "--no-proxy-server"],
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  await page.route("https://fonts.googleapis.com/**", (r) => r.abort());
  await page.route("https://fonts.gstatic.com/**", (r) => r.abort());
  await page.goto(base + "/?dev=1&case=case_a&aud=a_new");
  await page.locator("#txText [role=alert]").waitFor({ timeout: 15000 });
  assert.match(await page.locator(".livechip").innerText(), /已降级/);
  assert.match(await page.locator("#txText").innerText(), /没有可匹配的真实回放/);
  assert.match(await page.locator("#sourceText").innerText(), /此乃天道因果/);
  assert.equal(await page.locator(".ev").count(), 4);
  assert.ok(await page.locator("#copyFinal").isDisabled());
  assert.ok(await page.locator("#retryRun").isVisible());
  await page.screenshot({ path: out + "/connected-degraded.png" });
  console.log("PASS  降级原因、原文与证据保留、复制锁定和重试");
} finally {
  await browser.close();
}
