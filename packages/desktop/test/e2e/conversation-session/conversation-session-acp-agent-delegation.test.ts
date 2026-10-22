import assert from "node:assert/strict";
import {
  TID_LOGIN_USE_API_KEY_BUTTON,
  TID_TASK_SETTINGS_BUTTON,
  TID_V4_SESSION_TITLE,
} from "@zcode/shared";
import { clearAppData, DEFAULT_WORKSPACE } from "../helpers/desktop-app.js";
import {
  ACP_AGENT_DIR,
  removeAcpAgentDir,
  seedEnabledAcpAgent,
  selectAcpModelFromComposer,
  writeAcpLoggingShim,
} from "../helpers/acp-agent-e2e.js";
import {
  approveV4Permission,
  clickV4Stop,
  denyV4PermissionWithFeedback,
  hasV4PermissionDialog,
  loginWithApiKey,
  sendV4Prompt,
  waitForV4ConversationState,
  waitForV4PermissionDialog,
  waitForV4TimelineContaining,
} from "../helpers/v4-conversation.js";
import { restartIntoWorkspacePreservingProfile } from "../helpers/model-provider-restart-runtime.js";
import { skipOccupationOnboardingIfPresent } from "../helpers/occupation-onboarding.js";

// Contract: specs/acp-agent-runtime.md "S3" (tool, plan, title) and "S4" (user-once permissions).
// The mock agent answers by prompt marker: "tool", "plan", "title", "permission" (see the fixture).

const IDLE_TIMEOUT = 120000;

describe("Conversation with an ACP agent (tools, plan, title, permissions)", () => {
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

  it("ACP-TOOL-01: a tool row appears with its title and completes", async function () {
    this.timeout(180000);
    await sendV4Prompt("tool please");
    await waitForV4TimelineContaining("Read a.txt", 120000);
    await waitForV4TimelineContaining("tool finished", 120000);
    await waitForV4ConversationState(
      (state) => state.state === "idle",
      "the tool turn did not complete",
      IDLE_TIMEOUT,
    );
  });

  it("ACP-PLAN-01: a plan renders as the todo steps", async function () {
    this.timeout(180000);
    await sendV4Prompt("plan please");
    await waitForV4TimelineContaining("Write the tests", 120000);
    await waitForV4ConversationState(
      (state) => state.state === "idle",
      "the plan turn did not complete",
      IDLE_TIMEOUT,
    );
  });

  it("ACP-TITLE-01: the agent's session title replaces the placeholder title", async function () {
    this.timeout(180000);
    await sendV4Prompt("title please");
    await browser.waitUntil(
      async () => {
        const title = await $(`[data-testid="${TID_V4_SESSION_TITLE}"]`);
        return (
          (await title.isExisting()) && (await title.getText()).includes("Parser fix from ACP")
        );
      },
      { timeout: 120000, timeoutMsg: "the session title did not follow the agent" },
    );
    await waitForV4ConversationState(
      (state) => state.state === "idle",
      "the title turn did not complete",
      IDLE_TIMEOUT,
    );
  });

  it("ACP-PERM-01: allow once continues the turn", async function () {
    this.timeout(180000);
    await sendV4Prompt("permission please");
    await waitForV4PermissionDialog(120000);
    await approveV4Permission();
    await waitForV4TimelineContaining("permission granted", 120000);
    await waitForV4ConversationState(
      (state) => state.state === "idle",
      "the allowed turn did not complete",
      IDLE_TIMEOUT,
    );
  });

  it("ACP-PERM-02: deny rejects the ask and the turn ends with the agent's answer", async function () {
    this.timeout(180000);
    await sendV4Prompt("permission please");
    await waitForV4PermissionDialog(120000);
    await denyV4PermissionWithFeedback("");
    await waitForV4TimelineContaining("permission denied", 120000);
    await waitForV4ConversationState(
      (state) => state.state === "idle",
      "the denied turn did not complete",
      IDLE_TIMEOUT,
    );
    assert.equal(await hasV4PermissionDialog(), false);
  });

  it("ACP-PERM-03: Stop ends the turn and clears the permission dialog", async function () {
    this.timeout(180000);
    await sendV4Prompt("permission please");
    await waitForV4PermissionDialog(120000);
    await clickV4Stop();
    await waitForV4ConversationState(
      (state) => state.state === "idle",
      "Stop did not end the turn with a pending permission",
      IDLE_TIMEOUT,
    );
    await browser.waitUntil(async () => !(await hasV4PermissionDialog()), {
      timeout: 30000,
      timeoutMsg: "the permission dialog stayed open after Stop",
    });
  });
});
