import assert from "node:assert/strict";
import { clearAppData, DEFAULT_WORKSPACE } from "../helpers/desktop-app.js";
import {
  ACP_AGENT_DIR,
  acpSpawnCount,
  removeAcpAgentDir,
  seedEnabledAcpAgent,
  selectAcpModelFromComposer,
  writeAcpLoggingShim,
} from "../helpers/acp-agent-e2e.js";
import { TID_LOGIN_USE_API_KEY_BUTTON, TID_TASK_SETTINGS_BUTTON } from "@zcode/shared";
import {
  clickV4Stop,
  getV4Messages,
  loginWithApiKey,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
} from "../helpers/v4-conversation.js";
import { restartIntoWorkspacePreservingProfile } from "../helpers/model-provider-restart-runtime.js";
import { skipOccupationOnboardingIfPresent } from "../helpers/occupation-onboarding.js";

// Contract: specs/acp-agent-runtime.md "Chat delegation (phase 4)" and "Acceptance scenarios".
// The mock agent (services/test/fixtures/acp-mock-agent.mjs) answers "pong"; a prompt containing
// "hang" waits for session/cancel. The shim logs one line per agent process it starts, so a
// second turn that reuses the resident process leaves exactly one line.

/** Spawn log lines are per process; see helpers/acp-agent-e2e.ts for the shim and sidecar. */

async function assistantTextCount(text: string): Promise<number> {
  const messages = await getV4Messages("assistant");
  return messages.filter((message) => message.text.includes(text)).length;
}

describe("Conversation with an ACP agent (text)", () => {
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
        await writeAcpLoggingShim({ resetState: true });
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

  it("ACP-CHAT-01: sends a prompt to the agent and streams its reply to completion", async function () {
    this.timeout(180000);
    await sendV4Prompt("ping");
    await waitForV4AssistantMessageContaining("pong", 120000);
    await waitForV4ConversationState(
      (state) => state.state === "idle",
      "the agent turn did not complete",
      120000,
    );
    assert.ok((await assistantTextCount("pong")) >= 1);
  });

  it("ACP-CHAT-02: Stop during a hung prompt ends the turn as cancelled", async function () {
    this.timeout(180000);
    const repliesBefore = await assistantTextCount("pong");
    await sendV4Prompt("hang until stopped");
    await waitForV4ConversationState(
      (state) => state.state === "streaming",
      "the hung turn never started streaming",
      60000,
    );
    await clickV4Stop();
    await waitForV4ConversationState(
      (state) => state.state === "idle",
      "Stop did not end the agent turn",
      60000,
    );
    // The hung prompt produced no reply, and Stop cancels the prompt without killing the process.
    assert.equal(await assistantTextCount("pong"), repliesBefore);
    assert.equal(await acpSpawnCount(), 1);
  });

  it("ACP-CHAT-03: a second turn reuses the agent process", async function () {
    this.timeout(180000);
    const repliesBefore = await assistantTextCount("pong");
    await sendV4Prompt("ping again");
    await browser.waitUntil(async () => (await assistantTextCount("pong")) > repliesBefore, {
      timeout: 120000,
      timeoutMsg: "the second turn did not produce a reply",
    });
    await waitForV4ConversationState(
      (state) => state.state === "idle",
      "the second agent turn did not complete",
      120000,
    );
    assert.equal(await acpSpawnCount(), 1, "the agent process must be reused across turns");
  });
});
