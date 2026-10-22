import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  TID_CHAT_ASSISTANT_HISTORY_TRIGGER,
  TID_V4_SESSION_TITLE,
  TID_CHAT_MODEL_SELECT_GROUP,
  TID_CHAT_MODEL_SELECT_ITEM,
  TID_CHAT_MODEL_SELECT_TRIGGER,
  encodeCustomModelValue,
  testId,
} from "@zcode/shared";
import { getE2EAppDataPaths } from "./desktop-app.js";
import { getV4PaneSnapshot } from "./v4-conversation.js";

// Contract: specs/acp-agent-runtime.md "Chat delegation (phase 4)". The mock agent is the services
// fixture; the shim is the `opencode` binary the sidecar record points at.

export const ACP_PROVIDER_ID = "acp:opencode";
export const ACP_MODEL_ID = "opencode";
export const ACP_AGENT_DIR = process.env.ZCODE_E2E_ACP_AGENT_PATH?.trim() ?? "";
export const ACP_MOCK_AGENT_FIXTURE = resolve(
  process.cwd(),
  "../services/test/fixtures/acp-mock-agent.mjs",
);
const OPENCODE_SHIM = join(ACP_AGENT_DIR, "opencode");
const SPAWN_LOG = join(ACP_AGENT_DIR, "spawns.log");
const MOCK_STATE_FILE = join(ACP_AGENT_DIR, "mock-state.json");
const SIDECAR_FILE = join(dirname(getE2EAppDataPaths().configFile), "fork_acp_agents.json");

export interface AcpMockState {
  memory: string | null;
  methods: string[];
}

/**
 * Shim for the `opencode` binary: version and auth probes exit before logging; every ACP launch
 * appends its pid (exec keeps the pid) before handing over to the mock agent, which keeps its memory
 * and method log in the state file across processes. `resetState` starts a clean state.
 */
export async function writeAcpLoggingShim(options: { resetState: boolean }) {
  assert.ok(
    existsSync(ACP_MOCK_AGENT_FIXTURE),
    `missing mock agent fixture: ${ACP_MOCK_AGENT_FIXTURE}`,
  );
  await mkdir(ACP_AGENT_DIR, { recursive: true });
  if (options.resetState) {
    await rm(SPAWN_LOG, { force: true });
    await rm(MOCK_STATE_FILE, { force: true });
  }
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
      `exec ${node} ${JSON.stringify(ACP_MOCK_AGENT_FIXTURE)} --state ${JSON.stringify(MOCK_STATE_FILE)} "$@"`,
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(OPENCODE_SHIM, 0o755);
}

/** Enabled sidecar record for the mock agent, written while Electron is down (the host reads it at start). */
export async function seedEnabledAcpAgent() {
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
export async function selectAcpModelFromComposer() {
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

export async function acpSpawnCount(): Promise<number> {
  if (!existsSync(SPAWN_LOG)) return 0;
  return (await readFile(SPAWN_LOG, "utf8")).split("\n").filter((line) => line.trim()).length;
}

export async function readAcpMockState(): Promise<AcpMockState> {
  if (!existsSync(MOCK_STATE_FILE)) return { memory: null, methods: [] };
  return JSON.parse(await readFile(MOCK_STATE_FILE, "utf8")) as AcpMockState;
}

export async function removeAcpAgentDir() {
  await rm(ACP_AGENT_DIR, { recursive: true, force: true });
}

/**
 * Runs a scenario step; on failure saves a screenshot and the v4 timeline text into the E2E artifact
 * directory, so a selector or rendering problem is visible in the report without a rerun.
 */
export async function withAcpDiagnostics<T>(label: string, step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    const dir = process.env.ZCODE_E2E_ARTIFACT_DIR?.trim();
    if (dir) {
      await mkdir(dir, { recursive: true });
      const safe = label.replace(/[^a-z0-9-]+/gi, "-");
      await browser.saveScreenshot(join(dir, `acp-${safe}.png`));
      const pane = await getV4PaneSnapshot();
      const body = await browser.execute(() => document.body.innerText);
      const title = await readAcpSessionTitle();
      await writeFile(
        join(dir, `acp-${safe}.txt`),
        `title=${title}\n--- timeline ---\n${pane.timelineText}\n--- document ---\n${body}\n`,
        "utf8",
      );
    }
    throw error;
  }
}

/**
 * Waits until the v4 timeline shows `text`, expanding each collapsed "Worked for" history once. Tool
 * and plan rows of an agent turn sit inside that group, which starts collapsed. Each trigger is clicked
 * once: a second click would collapse it again.
 */
export async function waitForAcpWorkText(text: string, timeoutMsg: string, timeout = 120000) {
  await browser.waitUntil(
    async () => {
      await expandAcpHistoryOnce();
      return normalizeText((await getV4PaneSnapshot()).timelineText).includes(normalizeText(text));
    },
    { timeout, timeoutMsg },
  );
}

/**
 * Like `waitForAcpWorkText`, but reads the whole document: a plan renders in the status panel, not in
 * the timeline. The same one-time expansion applies.
 */
export async function waitForAcpDocumentText(text: string, timeoutMsg: string, timeout = 120000) {
  await browser.waitUntil(
    async () => {
      await expandAcpHistoryOnce();
      const body = await browser.execute(() => document.body.innerText);
      return normalizeText(body).includes(normalizeText(text));
    },
    { timeout, timeoutMsg },
  );
}

async function expandAcpHistoryOnce() {
  await browser.execute((prefix) => {
    document.querySelectorAll<HTMLElement>(`[data-testid^="${prefix}-"]`).forEach((trigger) => {
      if (trigger.dataset.acpExpanded === "1") return;
      trigger.dataset.acpExpanded = "1";
      trigger.click();
    });
  }, TID_CHAT_ASSISTANT_HISTORY_TRIGGER);
}

/** Rendered text breaks "Read a.txt" across lines; compare on single spaces. */
function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** The session title is carried by `data-title`; the element itself has no text. */
export async function readAcpSessionTitle(): Promise<string> {
  return browser.execute((testIdValue) => {
    return (
      document.querySelector<HTMLElement>(`[data-testid="${testIdValue}"]`)?.dataset.title ?? ""
    );
  }, TID_V4_SESSION_TITLE);
}
