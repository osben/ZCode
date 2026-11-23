// Real-browser check for the composer provider flyout (specs/composer-model-picker-browse-only-providers.md
// rules 1 and 10): moving the mouse over provider rows must not change the Models list, the panel
// geometry or the flyout position, and a click browses a provider and closes the flyout.
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry =
  "/packages/ui/test/browser/manual-review/pending/composer-provider-flyout.fixture.tsx";
const artifacts = join(root, "packages/desktop/.e2e-artifacts/composer-provider-flyout");
let server, browser, origin;

before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "composer-provider-flyout-fixture",
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith("/fixture")) return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await vite.transformIndexHtml(
                req.url,
                `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
              ),
            );
          });
        },
      },
    ],
    resolve: { alias: { "@": `${root}packages/ui/src` } },
    optimizeDeps: { entries: [entry.slice(1)] },
    server: { host: "127.0.0.1", port: 0, hmr: false },
  });
  await server.listen();
  origin = server.resolvedUrls.local[0];
  browser = await chromium.launch(
    process.env.CHROME_EXECUTABLE_PATH
      ? { executablePath: process.env.CHROME_EXECUTABLE_PATH }
      : { channel: "chrome" },
  );
});

after(async () => {
  await browser?.close();
  await server?.close();
});

const snapshot = () => {
  const rect = (element) => {
    if (!element) return null;
    const { left, top, width, height } = element.getBoundingClientRect();
    return [left, top, width, height].map(Math.round);
  };
  const trigger = document.querySelector('[data-testid="composer-provider-trigger"]');
  const panel =
    document.querySelector('[data-testid="composer-model-panel"]') ??
    trigger?.closest('[role="menu"]');
  const flyout =
    document.querySelector('[data-testid="composer-provider-panel"]') ??
    document.querySelector('[data-slot="dropdown-menu-sub-content"]');
  return {
    panel: rect(panel),
    flyout: rect(flyout),
    trigger: trigger?.textContent ?? null,
    models: Array.from(
      document.querySelectorAll(
        '[data-composer-model-list] [role="option"], [data-composer-model-list] [role="menuitemradio"]',
      ),
    ).map((row) => row.textContent),
    writes: [...window.writes],
  };
};

test("hovering provider rows keeps the panel, the flyout and the Models list still", async () => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  await page.goto(`${origin}fixture`);
  const trigger = page.getByTestId("composer-provider-trigger");
  await trigger.waitFor();
  await trigger.hover();
  const rows = page.locator("[data-composer-provider-list] [data-model-provider-key]");
  await rows.first().waitFor();
  await page.waitForTimeout(300);
  const start = await page.evaluate(snapshot);
  const frames = [];
  for (let index = 0; index < (await rows.count()); index += 1) {
    const box = await rows.nth(index).boundingBox();
    // Enter the flyout through the corridor from the trigger, then walk down the rows.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
    await page.waitForTimeout(250);
    frames.push(await page.evaluate(snapshot));
  }
  await page.screenshot({ path: join(artifacts, "hover.png") });
  console.log(JSON.stringify({ start, frames }, null, 1));
  for (const frame of frames) {
    assert.deepEqual(frame.models, start.models, "hover must not change the Models list");
    assert.deepEqual(frame.panel, start.panel, "hover must not move or resize the panel");
    assert.deepEqual(frame.flyout, start.flyout, "hover must not move the flyout");
    assert.deepEqual(frame.writes, [], "hover must not write model or effort");
  }

  await rows.filter({ hasText: "LM Studio" }).click();
  await page.waitForTimeout(300);
  const picked = await page.evaluate(snapshot);
  assert.equal(picked.flyout, null, "a provider click closes the flyout");
  assert.deepEqual(picked.models, ["Qwen 3 Coder"]);
  assert.deepEqual(picked.writes, [], "a provider click only browses");
  await page.screenshot({ path: join(artifacts, "browsed.png") });
  await page.close();
});

test("narrow layout pages the provider list in place and a pick returns to Models", async () => {
  const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
  await page.goto(`${origin}fixture`);
  const trigger = page.getByTestId("composer-provider-trigger");
  await trigger.click();
  const rows = page.locator("[data-composer-provider-list] [data-model-provider-key]");
  await rows.first().waitFor();
  const paged = await page.evaluate(snapshot);
  assert.equal(paged.flyout, null, "narrow layout has no flyout");
  assert.ok(paged.panel, "the provider page stays inside the model panel");
  const [left, , width] = paged.panel;
  assert.ok(left >= 0 && left + width <= 375, `panel fits the viewport: ${paged.panel}`);
  await page.screenshot({ path: join(artifacts, "narrow-providers.png") });
  await rows.filter({ hasText: "LM Studio" }).click();
  await page.getByTestId("composer-provider-trigger").waitFor();
  const picked = await page.evaluate(snapshot);
  assert.deepEqual(picked.models, ["Qwen 3 Coder"]);
  assert.deepEqual(picked.writes, [], "a provider click only browses");
  await page.screenshot({ path: join(artifacts, "narrow-browsed.png") });
  await page.close();
});
