import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright-core";

// Manual regression prerequisite: start an unsigned-in ZCode Dev and open the BigModel settings
// page; the static config has no usable builtin/account product catalog.
// Connects to the real App to verify the full hook/RPC/render chain; no plan data is injected and
// the sign-in state is not modified.
test("未登录缺少静态套餐时隐藏购买横幅并保留外层卡片", async () => {
  const browser = await chromium.connectOverCDP(
    process.env.ZCODE_E2E_CDP_URL ?? "http://localhost:9229",
  );
  const page = browser
    .contexts()[0]
    .pages()
    .find((candidate) => candidate.url().includes("localhost:517"));
  assert.ok(page, "需要已运行的 ZCode Dev");
  const cdp = await page.context().newCDPSession(page);
  const originalClass = await page.locator("html").getAttribute("class");
  try {
    for (const width of [390, 1200]) {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      for (const theme of ["light", "dark"]) {
        await page.locator("html").evaluate((element, value) => {
          element.className = `${value} theme-zai-${value}`;
        }, theme);
        const body = await page.locator("body").innerText();
        assert.match(body, /连接 BigModel|Connect BigModel/);
        assert.match(body, /未连接|Disconnected|Not connected/);
        const buttons = await page.locator("button").allTextContents();
        assert.equal(
          buttons.some((text) => /个人套餐|Personal Plan/.test(text)),
          false,
        );
        assert.equal(
          buttons.some((text) => /团队套餐|Team Plan/.test(text)),
          false,
        );
        assert.doesNotMatch(body, /[¥￥]\s*(49|598)\.00/);
      }
    }
  } finally {
    await page.locator("html").evaluate((element, value) => {
      element.className = value ?? "";
    }, originalClass);
    await cdp.send("Emulation.clearDeviceMetricsOverride");
    await cdp.detach();
    await browser.close();
  }
});
