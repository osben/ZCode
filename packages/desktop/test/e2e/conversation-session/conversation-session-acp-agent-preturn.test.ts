import assert from "node:assert/strict";
import { TID_LOGIN_USE_API_KEY_BUTTON, TID_TASK_SETTINGS_BUTTON, testId } from "@zcode/shared";
import { clearAppData, DEFAULT_WORKSPACE } from "../helpers/desktop-app.js";
import {
  ACP_AGENT_DIR,
  acpSpawnCount,
  readAcpMockState,
  removeAcpAgentDir,
  seedAcpCatalog,
  seedEnabledAcpAgent,
  selectAcpModelFromComposer,
  withAcpDiagnostics,
  writeAcpLoggingShim,
} from "../helpers/acp-agent-e2e.js";
import {
  getV4Messages,
  loginWithApiKey,
  sendV4Prompt,
  waitForV4ConversationState,
} from "../helpers/v4-conversation.js";
import { restartIntoWorkspacePreservingProfile } from "../helpers/model-provider-restart-runtime.js";
import { skipOccupationOnboardingIfPresent } from "../helpers/occupation-onboarding.js";

// Contract: specs/acp-agent-runtime.md "S6 readiness: catalog, pre-turn choices". The catalog is seeded (as after
// a Settings Test), the composer shows the selects before the first message, and a plan choice made there is
// applied by the first turn before its prompt. Prompts avoid the mock's markers so every reply is "pong".

// Same values as packages/ui/src/v4/composer/externalAgentConfig.ts; importing that module here would
// load @zcode/provider into the WDIO process.
const TID_EXTERNAL_AGENT_CONFIG_TRIGGER = "external-agent-config-trigger";
const TID_EXTERNAL_AGENT_CONFIG_ITEM = "external-agent-config-item";
const MODE_TRIGGER = `[data-testid="${testId(TID_EXTERNAL_AGENT_CONFIG_TRIGGER, "mode")}"]`;
const PLAN_ITEM = `[data-testid="${testId(TID_EXTERNAL_AGENT_CONFIG_ITEM, "mode-plan")}"]`;
const SET_PLAN = "session/set_config_option mode=plan";
const IDLE_TIMEOUT = 120000;

async function assistantTextCount(text: string): Promise<number> {
  const messages = await getV4Messages("assistant");
  return messages.filter((message) => message.text.includes(text)).length;
}

async function readModeTrigger(): Promise<{ available: string | null; label: string | null }> {
  const trigger = await $(MODE_TRIGGER);
  if (!(await trigger.isExisting())) return { available: null, label: null };
  return {
    available: await trigger.getAttribute("data-external-agent-config-available"),
    label: await trigger.getAttribute("aria-label"),
  };
}

/** The renderer keeps no optimistic copy: the label changes only after the projection event arrives. */
async function waitForModeLabel(valueName: string, timeoutMsg: string) {
  let latest = await readModeTrigger();
  await browser.waitUntil(
    async () => {
      latest = await readModeTrigger();
      return latest.available === "true" && (latest.label ?? "").endsWith(`: ${valueName}`);
    },
    { timeout: 60000, timeoutMsg: `${timeoutMsg} (latest ${JSON.stringify(latest)})` },
  );
}

async function sendAndWaitForPong(prompt: string, label: string) {
  const repliesBefore = await assistantTextCount("pong");
  await sendV4Prompt(prompt);
  await browser.waitUntil(async () => (await assistantTextCount("pong")) > repliesBefore, {
    timeout: IDLE_TIMEOUT,
    timeoutMsg: `the ${label} turn did not produce a reply`,
  });
  await waitForV4ConversationState(
    (state) => state.state === "idle",
    `the ${label} turn did not complete`,
    IDLE_TIMEOUT,
  );
}

describe("Conversation with an ACP agent (choices before the first message)", () => {
  before(async function () {
    this.timeout(240000);
    if (process.platform !== "darwin") this.skip();
    assert.ok(ACP_AGENT_DIR, "ZCODE_E2E_ACP_AGENT_PATH is not set by wdio.conf.ts");
    await browser.waitUntil(
      async () =>
        browser.execute(
          (login, settings) =>
            Boolean(
              document.querySelector(
                `[data-testid="${login}"], [data-testid="${settings}"], [data-testid="onboarding-page"]`,
              ),
            ),
          TID_LOGIN_USE_API_KEY_BUTTON,
          TID_TASK_SETTINGS_BUTTON,
        ),
      { timeout: 30000 },
    );
    if (await $(`[data-testid="${TID_LOGIN_USE_API_KEY_BUTTON}"]`).isExisting())
      await loginWithApiKey();
    await skipOccupationOnboardingIfPresent();

    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE, {
      afterElectronProcessExit: async () => {
        await writeAcpLoggingShim({ resetState: true, config: "options" });
        await seedEnabledAcpAgent();
        await seedAcpCatalog();
      },
    });
    await skipOccupationOnboardingIfPresent();
  });

  after(async () => {
    await removeAcpAgentDir();
    await clearAppData();
  });

  // Each step is its own case (the WDIO adapter caps a case at 120 s); the cases run in order.
  it("ACP-PRETURN-01: before any message the composer shows the catalog's mode and enables it", async function () {
    this.timeout(120000);
    await withAcpDiagnostics("preturn-select-model", () => selectAcpModelFromComposer());
    await withAcpDiagnostics("preturn-catalog-shown", () =>
      waitForModeLabel(
        "Agent",
        "the composer did not show the catalog's mode before the first message",
      ),
    );
    assert.equal(await acpSpawnCount(), 0, "showing the catalog must not start the agent");
  });

  it("ACP-PRETURN-02: a plan choice made before the first message is accepted", async function () {
    this.timeout(120000);
    await withAcpDiagnostics("preturn-choose-plan", async () => {
      const trigger = await $(MODE_TRIGGER);
      await trigger.waitForClickable({ timeout: 30000 });
      await trigger.click();
      const item = await $(PLAN_ITEM);
      await item.waitForDisplayed({ timeout: 30000 });
      await item.click();
      await waitForModeLabel(
        "Plan",
        "the composer did not show the plan mode chosen before the first message",
      );
    });
    assert.equal(
      await acpSpawnCount(),
      0,
      "a choice before the first turn must not start the agent",
    );
  });

  it("ACP-PRETURN-03: the first turn sets the plan mode on the agent before its first prompt", async function () {
    this.timeout(120000);
    await withAcpDiagnostics("preturn-first-turn", () => sendAndWaitForPong("ping", "first"));

    const state = await readAcpMockState();
    const prompt = state.methods.indexOf("session/prompt");
    const setPlan = state.methods.indexOf(SET_PLAN);
    assert.ok(prompt >= 0, `expected a prompt: ${JSON.stringify(state.methods)}`);
    assert.ok(
      setPlan >= 0 && setPlan < prompt,
      `${SET_PLAN} must arrive before the first session/prompt: ${JSON.stringify(state.methods)}`,
    );
  });
});
