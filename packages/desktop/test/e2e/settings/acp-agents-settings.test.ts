import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  TID_MODEL_PROVIDER_NAV_ITEM,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import { clearAppData, clickTestIdByDom, getE2EAppDataPaths } from "../helpers/desktop-app.js";
import { reloadElectronSessionSafely } from "../helpers/e2e-electron-reload.js";
import { seedPersonalProviderConfig } from "../helpers/model-provider-restart-config.js";
import { skipOccupationOnboardingIfPresent } from "../helpers/occupation-onboarding.js";

// Contract: specs/acp-agent-runtime.md "Settings UI placement" and "Availability (platform rule)".
// Detection only probes ZCODE_E2E_ACP_AGENT_PATH (wdio.conf.ts), so the real opencode /
// cursor-agent on the machine is never detected; this spec writes a mock `opencode` there.

const AGENT_DIR = process.env.ZCODE_E2E_ACP_AGENT_PATH?.trim() ?? "";
const MOCK_AGENT_FIXTURE = resolve(process.cwd(), "../services/test/fixtures/acp-mock-agent.mjs");
const OPENCODE_SHIM = join(AGENT_DIR, "opencode");
const CUSTOM_PROVIDER_ID = "e2e-acp-custom";
const NAV_CUSTOM = `custom:${CUSTOM_PROVIDER_ID}`;
const NAV_DETECT = "acp-detect";
const NAV_OPENCODE = "acp-agent:opencode";
const ACP_PROVIDER_ID = "acp:opencode";
const SETTINGS_FILE = join(getE2EAppDataPaths().appDataDir, "setting.json");
const SAVED_ARGS = "acp --e2e-marker";
const SAVED_ENV = "E2E_ACP_MARKER=1";

const navSelector = (key: string) => `[data-testid="${testId(TID_MODEL_PROVIDER_NAV_ITEM, key)}"]`;

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
  // The responsive layout keeps hidden copies; act on the visible one.
  for (const element of await $$(navSelector(key))) {
    if (await element.isDisplayed()) return element;
  }
  throw new Error(`nav item disappeared: ${key}`);
}

async function isNavPresent(key: string): Promise<boolean> {
  return browser.execute((selector) => document.querySelector(selector) !== null, navSelector(key));
}

async function card() {
  const element = await $('[data-acp-agent-card="opencode"]');
  await element.waitForDisplayed({ timeout: 20000 });
  return element;
}

async function enabledSwitch() {
  const element = await (await card()).$('[data-testid="acp-agent-enabled-switch"]');
  await element.waitForDisplayed();
  return element;
}

async function waitForSwitch(checked: boolean) {
  try {
    await browser.waitUntil(
      async () => {
        const element = await enabledSwitch();
        return (
          (await element.getAttribute("aria-checked")) === String(checked) &&
          (await element.isEnabled())
        );
      },
      { timeout: 20000 },
    );
  } catch {
    const element = await enabledSwitch();
    const state = `aria-checked=${await element.getAttribute("aria-checked")} enabled=${await element.isEnabled()}`;
    if (process.env.ZCODE_E2E_ARTIFACT_DIR) {
      await browser.saveScreenshot(join(process.env.ZCODE_E2E_ARTIFACT_DIR, "acp-switch.png"));
    }
    throw new Error(
      `enable switch did not settle on ${checked} (${state}); card: ${await (await card()).getText()}`,
    );
  }
}

/** Opens the detail's Advanced section (launch config and Test diagnostics); a no-op when already open. */
async function expandAdvanced() {
  const trigger = await (await card()).$('[data-testid="acp-agent-advanced-trigger"]');
  await trigger.waitForClickable();
  if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
  await browser.waitUntil(async () => (await trigger.getAttribute("aria-expanded")) === "true", {
    timeout: 5000,
    timeoutMsg: "Advanced section did not expand",
  });
}

async function readLaunchForm() {
  return {
    command: await $("#acp-command-opencode").getValue(),
    args: await $("#acp-args-opencode").getValue(),
    env: await $("#acp-env-opencode").getValue(),
  };
}

/** Replaces a controlled React input value through real key input. */
async function replaceValue(selector: string, value: string) {
  const element = await $(selector);
  await element.waitForDisplayed();
  await element.click();
  await browser.keys([process.platform === "darwin" ? "Meta" : "Control", "a"]);
  await browser.keys("Backspace");
  await element.addValue(value);
  await browser.waitUntil(async () => (await element.getValue()) === value, {
    timeout: 5000,
    timeoutMsg: `${selector} did not accept ${value}`,
  });
}

interface StoredAcpAccess {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * The saved launch config of the `opencode` agent from the fork sidecar
 * (specs/acp-agent-runtime.md "Storage and upstream compatibility"). The shared
 * provider_config.json must never hold an ACP provider, so its presence there fails the read.
 */
async function readSavedAcpAccess(): Promise<StoredAcpAccess | undefined> {
  const configFile = getE2EAppDataPaths().configFile;
  if (existsSync(configFile)) {
    assert.ok(
      !(await readFile(configFile, "utf8")).includes(`"${ACP_PROVIDER_ID}"`),
      "ACP providers must not be written to the shared provider_config.json",
    );
  }
  const sidecar = join(dirname(configFile), "fork_acp_agents.json");
  if (!existsSync(sidecar)) return undefined;
  const stored = JSON.parse(await readFile(sidecar, "utf8")) as {
    agents?: {
      agentId?: string;
      command?: string;
      args?: string[];
      env?: Record<string, string>;
    }[];
  };
  const record = stored.agents?.find((agent) => `acp:${agent.agentId ?? ""}` === ACP_PROVIDER_ID);
  return record ? { command: record.command, args: record.args, env: record.env } : undefined;
}

async function writeMockOpencode() {
  assert.ok(existsSync(MOCK_AGENT_FIXTURE), `missing mock agent fixture: ${MOCK_AGENT_FIXTURE}`);
  await mkdir(AGENT_DIR, { recursive: true });
  // Absolute node path: the detection probe only sees AGENT_DIR on PATH.
  const node = JSON.stringify(process.execPath);
  await writeFile(
    OPENCODE_SHIM,
    [
      "#!/bin/sh",
      'case "$1" in',
      '  --version) echo "0.0.0-e2e"; exit 0 ;;',
      '  auth) echo "e2e mock agent: logged in"; exit 0 ;;',
      "esac",
      `exec ${node} ${JSON.stringify(MOCK_AGENT_FIXTURE)} "$@"`,
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(OPENCODE_SHIM, 0o755);
}

async function openModelProviderSettings() {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
  await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).waitForDisplayed({ timeout: 20000 });
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "modelProvider"));
}

describe("ACP agents settings", () => {
  before(async function () {
    this.timeout(180000);
    if (process.platform !== "darwin") this.skip();
    assert.ok(AGENT_DIR, "ZCODE_E2E_ACP_AGENT_PATH is not set by wdio.conf.ts");
    await skipOccupationOnboardingIfPresent();
    // Only Settings is needed: restart without the project-sidebar readiness wait.
    await reloadElectronSessionSafely(browser, {
      // Fixture writes happen only while Electron is down, so no late host write can undo them.
      afterElectronProcessExit: async () => {
        await rm(AGENT_DIR, { recursive: true, force: true });
        const settings = existsSync(SETTINGS_FILE)
          ? JSON.parse(await readFile(SETTINGS_FILE, "utf8"))
          : {};
        await writeFile(
          SETTINGS_FILE,
          JSON.stringify({ ...settings, locale: "en-US", localePreference: "en-US" }),
        );
        // One custom provider so the Custom providers group renders before the ACP group.
        await seedPersonalProviderConfig(getE2EAppDataPaths().configFile, {
          id: CUSTOM_PROVIDER_ID,
          label: "E2E ACP Custom",
          apiFormat: "openai-chat-completions",
          baseURL: "http://127.0.0.1:9/v1",
          apiKey: "synthetic-no-remote-access",
          models: [{ id: "e2e-acp-custom-model" }],
        });
      },
    });
    await skipOccupationOnboardingIfPresent();
    await openModelProviderSettings();
  });

  after(async () => {
    await rm(AGENT_DIR, { recursive: true, force: true });
    await clearAppData();
  });

  it("ACP-E2E-01: shows the catalog empty state after Custom providers when no agent is detected", async function () {
    this.timeout(60000);
    const detect = await visibleNav(NAV_DETECT);
    await visibleNav(NAV_CUSTOM);

    const order = await browser.execute(
      (customSelector, acpSelector) => {
        const custom = document.querySelector(customSelector);
        const acp = document.querySelector(acpSelector);
        if (!custom || !acp) return "missing";
        return custom.compareDocumentPosition(acp) & Node.DOCUMENT_POSITION_FOLLOWING
          ? "after"
          : "before";
      },
      navSelector(NAV_CUSTOM),
      navSelector(NAV_DETECT),
    );
    assert.equal(order, "after", "ACP group must render after Custom providers");

    await detect.click();
    const settings = await $(`[data-testid="${TID_SETTINGS_PAGE}"]`);
    await browser.waitUntil(
      async () => (await settings.getText()).includes("No supported ACP agent CLI was found"),
      { timeout: 20000, timeoutMsg: "catalog empty description not shown" },
    );
    const catalogRow = await $('[data-acp-catalog-agent="opencode"]');
    await catalogRow.waitForDisplayed();
    await expect(catalogRow).toHaveText(expect.stringContaining("Not installed"));
    assert.equal(await isNavPresent(NAV_OPENCODE), false);

    // The catalog lists every supported agent, each with its bundled brand mark
    // (specs/acp-agent-runtime.md "Settings UI placement").
    const logoByAgent: Record<string, boolean> = {
      opencode: true,
      cursor: true,
      codex: true,
      claude: true,
      qwen: true,
      gemini: true,
    };
    for (const [agentId, hasLogo] of Object.entries(logoByAgent)) {
      const row = await $(`[data-acp-catalog-agent="${agentId}"]`);
      await row.waitForDisplayed();
      const images = await row.$$("img");
      assert.equal(images.length, hasLogo ? 1 : 0, `${agentId} catalog logo`);
    }
  });

  it("ACP-E2E-02: rescan finds the mock agent and selecting it opens its detail", async function () {
    this.timeout(60000);
    await writeMockOpencode();
    const rescan = await $(`[data-testid="${TID_SETTINGS_PAGE}"]`).$("button=Rescan");
    await rescan.waitForClickable();
    await rescan.click();

    const agentNav = await visibleNav(NAV_OPENCODE);
    assert.equal(await isNavPresent(NAV_DETECT), false, "catalog entry must give way to the agent");
    await agentNav.click();
    await expect(await visibleNav(NAV_OPENCODE)).toHaveAttribute("aria-selected", "true");

    const detail = await card();
    await expect(detail).toHaveText(expect.stringContaining("0.0.0-e2e"));
    // The detected binary path sits with the launch config in the collapsed Advanced section.
    await expect(detail).not.toHaveText(expect.stringContaining(OPENCODE_SHIM));
    await expandAdvanced();
    await expect(detail).toHaveText(expect.stringContaining(OPENCODE_SHIM));
    const form = await readLaunchForm();
    assert.equal(form.command, OPENCODE_SHIM);
    assert.equal(form.args, "acp");
    await waitForSwitch(false);
  });

  it("ACP-E2E-03: Test shows a roundtrip OK with a collapsed frames disclosure", async function () {
    this.timeout(90000);
    const detail = await card();
    const testButton = await detail.$('[data-testid="acp-agent-test-button"]');
    await testButton.waitForClickable();
    await testButton.click();

    await browser.waitUntil(async () => /Roundtrip OK · \d+ ms/.test(await detail.getText()), {
      timeout: 60000,
      timeoutMsg: "roundtrip OK was not reported",
    });
    // Diagnostics (stderr, frames) live in the collapsed Advanced section.
    await expandAdvanced();
    const frames = await detail.$("details");
    await frames.waitForExist();
    assert.equal(await frames.getAttribute("open"), null, "frames disclosure must start collapsed");
    await expect(await frames.$("summary")).toHaveText(
      expect.stringMatching(/^Raw JSON-RPC frames \(\d+\)$/),
    );
    assert.equal(await (await frames.$("ul")).isDisplayed(), false);
  });

  it("ACP-E2E-04: enable then disable keeps the saved command, args and env", async function () {
    this.timeout(90000);
    await expandAdvanced();
    await replaceValue("#acp-args-opencode", SAVED_ARGS);
    await replaceValue("#acp-env-opencode", SAVED_ENV);

    await (await enabledSwitch()).click();
    await waitForSwitch(true);
    await browser
      .waitUntil(async () => (await readSavedAcpAccess()) !== undefined, {
        timeout: 20000,
      })
      .catch(() => {
        throw new Error("enabling did not save the acp-agent access for acp:opencode");
      });
    const savedOn = await readSavedAcpAccess();
    assert.deepEqual(
      { command: savedOn?.command, args: savedOn?.args, env: savedOn?.env },
      { command: OPENCODE_SHIM, args: ["acp", "--e2e-marker"], env: { E2E_ACP_MARKER: "1" } },
    );

    await (await enabledSwitch()).click();
    await waitForSwitch(false);
    const savedOff = await readSavedAcpAccess();
    assert.deepEqual(
      { command: savedOff?.command, args: savedOff?.args, env: savedOff?.env },
      { command: OPENCODE_SHIM, args: ["acp", "--e2e-marker"], env: { E2E_ACP_MARKER: "1" } },
      "disabling must keep the saved launch config",
    );
    assert.deepEqual(await readLaunchForm(), {
      command: OPENCODE_SHIM,
      args: SAVED_ARGS,
      env: SAVED_ENV,
    });

    await (await enabledSwitch()).click();
    await waitForSwitch(true);
    assert.deepEqual(await readLaunchForm(), {
      command: OPENCODE_SHIM,
      args: SAVED_ARGS,
      env: SAVED_ENV,
    });
  });

  it("ACP-E2E-05: an enabled agent is listed only under ACP agents, not Custom providers", async function () {
    this.timeout(60000);
    await waitForSwitch(true);
    await visibleNav(NAV_OPENCODE);
    await visibleNav(NAV_CUSTOM);
    assert.equal(await isNavPresent(`custom:${ACP_PROVIDER_ID}`), false);
    const opencodeRows = await browser.execute(() =>
      Array.from(document.querySelectorAll<HTMLElement>("[data-testid]"))
        .map((element) => element.dataset.testid ?? "")
        .filter((id) => id.includes("model-provider-nav-item") && id.includes("opencode")),
    );
    assert.ok(
      opencodeRows.every((id) => id.endsWith(NAV_OPENCODE)),
      `unexpected opencode nav rows: ${opencodeRows.join(", ")}`,
    );
  });

  // specs/acp-agent-runtime.md "Settings: models and Advanced" (SM2, SM4, SM5).
  it("ACP-E2E-06: a Test loads the agent's models and an unchecked one is stored in the fork sidecar", async function () {
    this.timeout(90000);
    const detail = await card();
    await expandAdvanced();
    // The mock agent offers a "model" select (m1 current, m2) only with `--config options`.
    await replaceValue("#acp-args-opencode", "acp --config options");
    await (await detail.$('[data-testid="acp-agent-test-button"]')).click();

    const checkbox = (value: string) =>
      detail.$(`[data-testid="acp-agent-model-checkbox"][data-model-value="${value}"]`);
    await (await checkbox("m2")).waitForDisplayed({ timeout: 60000 });
    assert.equal(await (await checkbox("m2")).getAttribute("aria-checked"), "true");

    await (await checkbox("m2")).click();
    const visibility = join(
      dirname(getE2EAppDataPaths().configFile),
      "fork_acp_agent_model_visibility.json",
    );
    await browser.waitUntil(
      async () => existsSync(visibility) && (await readFile(visibility, "utf8")).includes('"m2"'),
      { timeout: 10000, timeoutMsg: "hidden model was not stored in the fork sidecar" },
    );
    const stored = JSON.parse(await readFile(visibility, "utf8")) as unknown;
    assert.deepEqual(stored, {
      schemaVersion: 1,
      agents: [{ agentId: "opencode", hiddenModels: ["m2"] }],
    });
    // The last visible model cannot be unchecked; the shared config still holds no ACP provider.
    assert.equal(await (await checkbox("m1")).isEnabled(), false);
    await readSavedAcpAccess();
    const screenshotDir = process.env.ZCODE_E2E_SCREENSHOT_DIR?.trim();
    if (screenshotDir) await browser.saveScreenshot(join(screenshotDir, "acp-agent-detail.png"));
  });
});
