import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { buildSiwcAccountCredentialKeys, SIWC_ACCOUNT_INDEX_CREDENTIAL_KEY } from "@zcode/shared";
import {
  TID_CHAT_MODEL_SELECT_TRIGGER,
  TID_MODEL_PROVIDER_NAV_ITEM,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import { clearAppData, clickTestIdByDom, getE2EAppDataPaths } from "../helpers/desktop-app.js";
import { selectRegistryProviderModelById } from "../helpers/upstream-provider.js";
import { reloadElectronSessionSafely } from "../helpers/e2e-electron-reload.js";
import { skipOccupationOnboardingIfPresent } from "../helpers/occupation-onboarding.js";

// Contract: specs/chatgpt-plan-signin.md "Usage display (Settings)" (U2, U3, U6). The account is
// seeded as plain credentials and the usage probe asks the loopback mock behind
// ZCODE_E2E_CHATGPT_USAGE_URL (wdio.conf.ts), so no real ChatGPT account or network is used.

const USAGE_PORT = 45455;
const SUB = "e2e-chatgpt-usage-sub";
const ACCOUNT_KEY = createHash("sha256").update(SUB).digest("hex").slice(0, 16);
const EMAIL = "e2e-plan@example.test";
const SETTINGS_FILE = join(getE2EAppDataPaths().appDataDir, "setting.json");
const CREDENTIALS_FILE = join(getE2EAppDataPaths().appDataDir, "credentials.json");
const NAV_CHATGPT = "preset:account:chatgpt-plan";
const navSelector = (key: string) => `[data-testid="${testId(TID_MODEL_PROVIDER_NAV_ITEM, key)}"]`;

function usagePayload() {
  const now = Math.floor(Date.now() / 1000);
  return {
    plan_type: "plus",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: {
        used_percent: 42,
        limit_window_seconds: 18000,
        reset_at: now + 2 * 3600 + 13 * 60,
      },
      secondary_window: {
        used_percent: 76,
        limit_window_seconds: 604800,
        reset_at: now + 3 * 86400 + 5 * 3600,
      },
    },
  };
}

function startMockUsage(): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.url === "/backend-api/wham/usage") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(usagePayload()));
      return;
    }
    response.writeHead(404).end();
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(USAGE_PORT, "127.0.0.1", () => resolve(server));
  });
}

async function seedSignedInAccount() {
  const credentials = existsSync(CREDENTIALS_FILE)
    ? (JSON.parse(await readFile(CREDENTIALS_FILE, "utf8")) as Record<string, string>)
    : {};
  const slot = buildSiwcAccountCredentialKeys(ACCOUNT_KEY);
  const farFuture = String(Math.floor(Date.now() / 1000) + 30 * 86400);
  Object.assign(credentials, {
    [SIWC_ACCOUNT_INDEX_CREDENTIAL_KEY]: JSON.stringify([
      {
        accountKey: ACCOUNT_KEY,
        sub: SUB,
        email: EMAIL,
        name: "E2E Plan",
        addedAt: "2026-10-25T00:00:00Z",
      },
    ]),
    [slot.accessToken]: "e2e-siwc-access",
    [slot.accessExpiresAt]: farFuture,
    [slot.scopes]: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
    [slot.userInfo]: JSON.stringify({ sub: SUB, email: EMAIL, name: "E2E Plan" }),
    [`oauth:chatgpt-codex:${ACCOUNT_KEY}:access_token`]: "e2e-codex-access",
    [`oauth:chatgpt-codex:${ACCOUNT_KEY}:refresh_token`]: "e2e-codex-refresh",
    [`oauth:chatgpt-codex:${ACCOUNT_KEY}:access_expires_at`]: farFuture,
  });
  await writeFile(CREDENTIALS_FILE, JSON.stringify(credentials));
}

async function visibleNav(key: string, timeout = 20000) {
  await browser.waitUntil(
    async () => {
      for (const element of await $$(navSelector(key))) {
        if (await element.isDisplayed()) return true;
      }
      return false;
    },
    { timeout, timeoutMsg: `nav item not visible: ${key}` },
  );
  for (const element of await $$(navSelector(key))) {
    if (await element.isDisplayed()) return element;
  }
  throw new Error(`nav item disappeared: ${key}`);
}

describe("ChatGPT plan usage in Settings", () => {
  let server: Server;

  before(async function () {
    this.timeout(180000);
    server = await startMockUsage();
    await skipOccupationOnboardingIfPresent();
    await reloadElectronSessionSafely(browser, {
      afterElectronProcessExit: async () => {
        const settings = existsSync(SETTINGS_FILE)
          ? JSON.parse(await readFile(SETTINGS_FILE, "utf8"))
          : {};
        await writeFile(
          SETTINGS_FILE,
          JSON.stringify({ ...settings, locale: "en-US", localePreference: "en-US" }),
        );
        await seedSignedInAccount();
      },
    });
    await skipOccupationOnboardingIfPresent();
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
    await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).waitForDisplayed({ timeout: 20000 });
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"));
  });

  after(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await clearAppData();
  });

  it("CHATGPT-USAGE-E2E-01: shows both windows with share left, severity and reset countdown", async function () {
    this.timeout(60000);
    await (await visibleNav(NAV_CHATGPT)).click();
    const usage = await $('[data-testid="chatgpt-plan-usage"]');
    await usage.waitForDisplayed({ timeout: 30000 });

    const windows = await $$('[data-testid="chatgpt-plan-usage-window"]');
    assert.equal(windows.length, 2);
    assert.equal(await windows[0]?.getAttribute("data-severity"), "normal");
    assert.equal(await windows[1]?.getAttribute("data-severity"), "warning");
    const text = await usage.getText();
    assert.match(text, /5-hour/);
    assert.match(text, /58% left/);
    assert.match(text, /Resets in 2h 1[34]m/);
    assert.match(text, /Weekly/);
    assert.match(text, /24% left/);
    assert.match(text, /Resets in 3d 5h|Resets in 3d 4h/);
    await expect($('[data-testid="chatgpt-plan-type"]')).toHaveText("Plus");

    const screenshotDir = process.env.ZCODE_E2E_SCREENSHOT_DIR?.trim();
    if (screenshotDir) await browser.saveScreenshot(join(screenshotDir, "chatgpt-plan-usage.png"));
  });

  // specs/chatgpt-plan-signin.md "Usage across the app" (S1, S5).
  it("CHATGPT-USAGE-E2E-02: the composer shows the plan chip and the picker row shows the tightest window", async function () {
    this.timeout(120000);
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
    await selectRegistryProviderModelById("gpt-6.1-sol", {
      providerId: `account:chatgpt-plan:${ACCOUNT_KEY}`,
      providerName: EMAIL,
      includePlainModelFallback: false,
    });

    const chip = await $('[data-testid="chatgpt-plan-usage-chip"]');
    await chip.waitForDisplayed({ timeout: 30000 });
    assert.equal(await chip.getText(), "Plus · 24% left");
    assert.equal(await chip.getAttribute("data-severity"), "warning");

    const screenshotDir = process.env.ZCODE_E2E_SCREENSHOT_DIR?.trim();
    if (screenshotDir) {
      await chip.moveTo();
      await $('[data-testid="chatgpt-plan-usage"]').waitForDisplayed({ timeout: 10000 });
      await browser.saveScreenshot(join(screenshotDir, "chatgpt-composer-chip-hover.png"));
    }

    // Close the chip's hover card before opening the picker.
    await browser.keys("Escape");
    await (await $("body")).moveTo({ xOffset: 5, yOffset: 5 });
    await $('[data-testid="chatgpt-plan-usage"]').waitForDisplayed({
      reverse: true,
      timeout: 5000,
    });

    // The picker's provider row carries the tightest window after the Subscription badge.
    await (await $(`[data-testid="${TID_CHAT_MODEL_SELECT_TRIGGER}"]`)).click();
    const hint = await $("[data-model-group-hint]");
    await hint.waitForDisplayed({ timeout: 15000 });
    assert.equal(await hint.getText(), "24% left");
    assert.match(
      (await hint.getAttribute("title")) ?? "",
      /^Resets in 3d [45]h · 5-hour: 58% left · Weekly: 24% left$/,
    );
    assert.equal(await hint.getAttribute("data-tone"), "warning");
    // The chip's card does not stay open behind the picker.
    assert.equal(
      await browser.execute(
        () => document.querySelector("[data-slot=hover-card-content][data-state=open]") !== null,
      ),
      false,
    );
    if (screenshotDir) {
      await browser.saveScreenshot(join(screenshotDir, "chatgpt-picker-hint.png"));
    }
    await browser.keys("Escape");
  });
});
