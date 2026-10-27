import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildSiwcAccountCredentialKeys, SIWC_ACCOUNT_INDEX_CREDENTIAL_KEY } from "@zcode/shared";
import {
  TID_MODEL_PROVIDER_NAV_ITEM,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import { clearAppData, clickTestIdByDom, getE2EAppDataPaths } from "../helpers/desktop-app.js";
import { reloadElectronSessionSafely } from "../helpers/e2e-electron-reload.js";
import { skipOccupationOnboardingIfPresent } from "../helpers/occupation-onboarding.js";

// Contract: specs/chatgpt-plan-signin.md "Usage limits" (official surface only: no usage block,
// no plan badge, no "Link usage") and "Limits and recovery in Desktop" L6 (reconnect row). The
// accounts are seeded as plain credentials, so no real ChatGPT account or network is used.

const SUB = "e2e-chatgpt-plan-sub";
const ACCOUNT_KEY = createHash("sha256").update(SUB).digest("hex").slice(0, 16);
const EMAIL = "e2e-plan@example.test";
// A second indexed account without tokens: its sign-in was revoked (L6).
const REVOKED_SUB = "e2e-chatgpt-revoked-sub";
const REVOKED_KEY = createHash("sha256").update(REVOKED_SUB).digest("hex").slice(0, 16);
const REVOKED_EMAIL = "e2e-revoked@example.test";
const SETTINGS_FILE = join(getE2EAppDataPaths().appDataDir, "setting.json");
const CREDENTIALS_FILE = join(getE2EAppDataPaths().appDataDir, "credentials.json");
const NAV_CHATGPT = "preset:account:chatgpt-plan";
const navSelector = (key: string) => `[data-testid="${testId(TID_MODEL_PROVIDER_NAV_ITEM, key)}"]`;

async function seedAccounts() {
  const credentials = existsSync(CREDENTIALS_FILE)
    ? (JSON.parse(await readFile(CREDENTIALS_FILE, "utf8")) as Record<string, string>)
    : {};
  const slot = buildSiwcAccountCredentialKeys(ACCOUNT_KEY);
  const farFuture = String(Math.floor(Date.now() / 1000) + 30 * 86400);
  Object.assign(credentials, {
    [SIWC_ACCOUNT_INDEX_CREDENTIAL_KEY]: JSON.stringify([
      { accountKey: ACCOUNT_KEY, sub: SUB, email: EMAIL, name: "E2E Plan", addedAt: "" },
      { accountKey: REVOKED_KEY, sub: REVOKED_SUB, email: REVOKED_EMAIL, name: null, addedAt: "" },
    ]),
    [slot.accessToken]: "e2e-siwc-access",
    [slot.accessExpiresAt]: farFuture,
    [slot.scopes]: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
    [slot.userInfo]: JSON.stringify({ sub: SUB, email: EMAIL, name: "E2E Plan" }),
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

describe("ChatGPT plan in Settings", () => {
  before(async function () {
    this.timeout(180000);
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
        await seedAccounts();
      },
    });
    await skipOccupationOnboardingIfPresent();
    await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
    await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).waitForDisplayed({ timeout: 20000 });
    await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"));
  });

  after(async () => {
    await clearAppData();
  });

  it("CHATGPT-PLAN-E2E-01: lists the account without usage UI and offers reconnect for a revoked one", async function () {
    this.timeout(60000);
    await (await visibleNav(NAV_CHATGPT)).click();
    const reconnect = await $('[data-testid="chatgpt-plan-reconnect-row"]');
    await reconnect.waitForDisplayed({ timeout: 30000 });
    const reconnectText = await reconnect.getText();
    assert.ok(reconnectText.includes(REVOKED_EMAIL), reconnectText);
    assert.ok(reconnectText.includes("Sign in again"), reconnectText);

    const page = await $(`[data-testid="${TID_SETTINGS_PAGE}"]`);
    const text = await page.getText();
    assert.ok(text.includes(`Signed in as ${EMAIL}`), text);
    assert.ok(text.includes("Manage usage"), text);
    assert.ok(!text.includes("Link usage"), text);
    for (const selector of [
      '[data-testid="chatgpt-plan-usage"]',
      '[data-testid="chatgpt-plan-type"]',
      '[data-testid="chatgpt-plan-link-usage"]',
    ]) {
      assert.equal(await $(selector).isExisting(), false, selector);
    }

    const screenshotDir = process.env.ZCODE_E2E_SCREENSHOT_DIR?.trim();
    if (screenshotDir)
      await browser.saveScreenshot(join(screenshotDir, "chatgpt-plan-settings.png"));
  });
});
