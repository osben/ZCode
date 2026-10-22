import assert from "node:assert/strict";
import { TID_LOGIN_USE_API_KEY_BUTTON, TID_TASK_SETTINGS_BUTTON, testId } from "@zcode/shared";
import { clearAppData, DEFAULT_WORKSPACE } from "../helpers/desktop-app.js";
import {
  ACP_AGENT_DIR,
  acpSpawnCount,
  readAcpMockState,
  removeAcpAgentDir,
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

// Contract: specs/acp-agent-runtime.md "S6: agent configuration options". The mock agent runs with
// `--config options` (mode agent|plan|ask, model m1|m2) and records each method in its state file.
// Prompts avoid the mock's markers ("plan", "tool", "title", ...) so every reply is "pong".

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

describe("Conversation with an ACP agent (agent configuration options)", () => {
  before(async function () {
    this.timeout(240000);
    if (process.platform === "win32") this.skip();
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
      },
    });
    await skipOccupationOnboardingIfPresent();
    await selectAcpModelFromComposer();
  });

  after(async () => {
    await removeAcpAgentDir();
    await clearAppData();
  });

  // Each step is its own case: the WDIO Mocha adapter caps a case at 120 s and `this.timeout` cannot
  // extend it (wdio.conf.ts mochaOpts.timeout). The cases run in order and share one session.
  it("ACP-CONFIG-01: after the first turn the composer shows the agent's mode select", async function () {
    this.timeout(120000);
    // Warm-up turn: the handshake offers the options, the driver projects them to the composer.
    await withAcpDiagnostics("config-warm-up", () => sendAndWaitForPong("ping", "warm-up"));
    await withAcpDiagnostics("config-offered", () =>
      waitForModeLabel("Agent", "the composer did not show the agent's mode after the first turn"),
    );
  });

  it("ACP-CONFIG-02: the chosen plan mode is set on the agent before the next prompt", async function () {
    this.timeout(120000);
    await withAcpDiagnostics("config-choose-plan", async () => {
      const trigger = await $(MODE_TRIGGER);
      await trigger.waitForClickable({ timeout: 30000 });
      await trigger.click();
      const item = await $(PLAN_ITEM);
      await item.waitForDisplayed({ timeout: 30000 });
      await item.click();
      // The choice is persisted before the label changes, so the next prompt's reconcile sees it.
      await waitForModeLabel("Plan", "the composer did not show the chosen plan mode");
    });

    await withAcpDiagnostics("config-second-turn", () =>
      sendAndWaitForPong("ping again", "second"),
    );

    const state = await readAcpMockState();
    const prompts = state.methods.flatMap((method, index) =>
      method === "session/prompt" ? [index] : [],
    );
    assert.ok(prompts.length >= 2, `expected two prompts: ${JSON.stringify(state.methods)}`);
    const setPlan = state.methods.flatMap((method, index) => (method === SET_PLAN ? [index] : []));
    assert.equal(setPlan.length, 1, `expected one ${SET_PLAN}: ${JSON.stringify(state.methods)}`);
    assert.ok(
      setPlan[0]! > prompts[0]! && setPlan[0]! < prompts[1]!,
      `${SET_PLAN} must arrive between the first and the second prompt: ${JSON.stringify(state.methods)}`,
    );
  });

  it("ACP-CONFIG-03: the plan mode is still shown after a relaunch, without starting the agent", async function () {
    this.timeout(120000);
    // Relaunch without sending: the shown value comes from the persisted display copy seeded into
    // the projection on hydration, not from a new agent process.
    const spawnsBeforeRestart = await acpSpawnCount();
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE);
    await skipOccupationOnboardingIfPresent();
    await selectAcpModelFromComposer();
    await withAcpDiagnostics("config-after-relaunch", () =>
      waitForModeLabel("Plan", "the plan mode was not shown after the relaunch"),
    );
    assert.equal(
      await acpSpawnCount(),
      spawnsBeforeRestart,
      "showing the stored mode must not start the agent",
    );
  });
});
