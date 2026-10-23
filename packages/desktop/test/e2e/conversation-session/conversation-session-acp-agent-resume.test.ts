import assert from "node:assert/strict";
import { TID_LOGIN_USE_API_KEY_BUTTON, TID_TASK_SETTINGS_BUTTON } from "@zcode/shared";
import { clearAppData, DEFAULT_WORKSPACE } from "../helpers/desktop-app.js";
import {
  ACP_AGENT_DIR,
  readAcpMockState,
  removeAcpAgentDir,
  seedEnabledAcpAgent,
  selectAcpModelFromComposer,
  writeAcpLoggingShim,
} from "../helpers/acp-agent-e2e.js";
import {
  getV4Messages,
  loginWithApiKey,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
} from "../helpers/v4-conversation.js";
import { restartIntoWorkspacePreservingProfile } from "../helpers/model-provider-restart-runtime.js";
import { skipOccupationOnboardingIfPresent } from "../helpers/occupation-onboarding.js";

// Contract: specs/acp-agent-runtime.md "S5" (session restore through session/load). The mock agent keeps
// its memory in a state file across processes, and records each process start and each method it serves.

describe("Conversation with an ACP agent (relaunch restores the session)", () => {
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

  it("ACP-RESUME-01: after a relaunch the next turn loads the earlier session and keeps its context", async function () {
    this.timeout(300000);
    await sendV4Prompt("remember violet");
    await waitForV4AssistantMessageContaining("remembered", 120000);
    await waitForV4ConversationState(
      (state) => state.state === "idle",
      "the first turn did not complete",
      120000,
    );

    // The shim and sidecar stay on disk, so the relaunch keeps the agent and the profile unchanged.
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE);
    await skipOccupationOnboardingIfPresent();
    await selectAcpModelFromComposer();

    await sendV4Prompt("recall");
    await waitForV4AssistantMessageContaining("recalled violet", 120000);
    await waitForV4ConversationState(
      (state) => state.state === "idle",
      "the recall turn did not complete",
      120000,
    );

    const state = await readAcpMockState();
    const lastStart = state.methods.lastIndexOf("process-start");
    const restarted = state.methods.slice(lastStart);
    assert.ok(
      restarted.includes("session/load"),
      `the relaunched agent did not load: ${state.methods}`,
    );
    assert.ok(!restarted.includes("session/new"), "the relaunched agent started a new session");
    const messages = await getV4Messages("assistant");
    assert.equal(
      messages.filter((message) => message.text.includes("replayed history")).length,
      0,
      "the history replayed by session/load must not show in the conversation",
    );
  });
});
