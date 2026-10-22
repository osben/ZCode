import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  TID_CHAT_MODEL_SELECT_GROUP,
  TID_CHAT_MODEL_SELECT_ITEM,
  TID_CHAT_MODEL_SELECT_TRIGGER,
  TID_LOGIN_USE_API_KEY_BUTTON,
  TID_TASK_SETTINGS_BUTTON,
  encodeCustomModelValue,
  testId,
} from "@zcode/shared";
import { clearAppData, DEFAULT_WORKSPACE, getE2EAppDataPaths } from "../helpers/desktop-app.js";
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

const AGENT_DIR = process.env.ZCODE_E2E_ACP_AGENT_PATH?.trim() ?? "";
const MOCK_AGENT_FIXTURE = resolve(process.cwd(), "../services/test/fixtures/acp-mock-agent.mjs");
const OPENCODE_SHIM = join(AGENT_DIR, "opencode");
const SPAWN_LOG = join(AGENT_DIR, "spawns.log");
const ACP_PROVIDER_ID = "acp:opencode";
const ACP_MODEL_ID = "opencode";
const SIDECAR_FILE = join(dirname(getE2EAppDataPaths().configFile), "fork_acp_agents.json");

/**
 * Shim for the `opencode` binary: version and auth probes exit before logging; every ACP launch
 * appends its pid (exec keeps the pid) before handing over to the mock agent.
 */
async function writeLoggingShim() {
  assert.ok(existsSync(MOCK_AGENT_FIXTURE), `missing mock agent fixture: ${MOCK_AGENT_FIXTURE}`);
  await mkdir(AGENT_DIR, { recursive: true });
  await rm(SPAWN_LOG, { force: true });
  const node = JSON.stringify(process.execPath);
  await writeFile(
    OPENCODE_SHIM,
    [
      "#!/bin/sh",
      'case "$1" in',
      '  --version) echo "0.0.0-e2e"; exit 0 ;;',
      '  auth) echo "e2e mock agent: logged in"; exit 0 ;;',
      "esac",
      `echo "$$" >> ${JSON.stringify(SPAWN_LOG)}`,
      `exec ${node} ${JSON.stringify(MOCK_AGENT_FIXTURE)} "$@"`,
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(OPENCODE_SHIM, 0o755);
}

/** Enabled sidecar record for the mock agent, written while Electron is down (the host reads it at start). */
async function seedEnabledAgent() {
  await writeFile(
    SIDECAR_FILE,
    JSON.stringify({
      schemaVersion: 1,
      agents: [
        {
          agentId: "opencode",
          providerName: "opencode (ACP)",
          enabled: true,
          command: OPENCODE_SHIM,
          args: ["acp"],
        },
      ],
    }),
    "utf8",
  );
}

/**
 * The composer lists providers in a submenu that is closed by default. Open the model menu, open the
 * provider submenu, pick the agent's group, then its model.
 */
async function selectAcpModelFromComposer() {
  const modelTrigger = await $(`[data-testid="${TID_CHAT_MODEL_SELECT_TRIGGER}"]`);
  await modelTrigger.waitForClickable({ timeout: 30000 });
  await modelTrigger.click();
  const providerTrigger = await $('[data-testid="composer-provider-trigger"]');
  await providerTrigger.waitForClickable({ timeout: 20000 });
  await providerTrigger.click();
  const group = await $(
    `[data-testid="${testId(TID_CHAT_MODEL_SELECT_GROUP, `registry-provider:${ACP_PROVIDER_ID}`)}"]`,
  );
  await group.waitForDisplayed({ timeout: 30000 });
  await group.click();
  const item = await $(
    `[data-testid="${testId(TID_CHAT_MODEL_SELECT_ITEM, encodeCustomModelValue(ACP_PROVIDER_ID, ACP_MODEL_ID))}"]`,
  );
  await item.waitForDisplayed({ timeout: 30000 });
  await item.click();
}

async function spawnCount(): Promise<number> {
  if (!existsSync(SPAWN_LOG)) return 0;
  return (await readFile(SPAWN_LOG, "utf8")).split("\n").filter((line) => line.trim()).length;
}

async function assistantTextCount(text: string): Promise<number> {
  const messages = await getV4Messages("assistant");
  return messages.filter((message) => message.text.includes(text)).length;
}

describe("Conversation with an ACP agent (text)", () => {
  before(async function () {
    this.timeout(240000);
    if (process.platform === "win32") this.skip();
    assert.ok(AGENT_DIR, "ZCODE_E2E_ACP_AGENT_PATH is not set by wdio.conf.ts");
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
        await writeLoggingShim();
        await seedEnabledAgent();
      },
    });
    await skipOccupationOnboardingIfPresent();
    await selectAcpModelFromComposer();
  });

  after(async () => {
    await rm(AGENT_DIR, { recursive: true, force: true });
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
    assert.equal(await spawnCount(), 1);
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
    assert.equal(await spawnCount(), 1, "the agent process must be reused across turns");
  });
});
