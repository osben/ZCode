/**
 * Shared helpers for runtime tests: temp dirs, mock launch options, event collection.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AcpSessionRuntime,
  type AcpHostBridge,
  type AcpRuntimeEvent,
  type AcpSessionRuntimeOptions,
} from "../src/index.js";

export const MOCK_AGENT_PATH = fileURLToPath(new URL("./mock-agent-process.mjs", import.meta.url));

const DEFAULT_TEST_TIMEOUTS = {
  initializeMs: 8_000,
  newSessionMs: 8_000,
  cancelGraceMs: 2_000,
  stopGraceMs: 1_000,
  killGraceMs: 1_000,
  stallWarningMs: 0,
} as const;

export async function createTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "acp-runtime-test-"));
}

export async function cleanupTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export function mockRuntimeOptions(
  cwd: string,
  scenario: string,
  overrides: Partial<AcpSessionRuntimeOptions> = {},
): AcpSessionRuntimeOptions {
  return {
    agentId: "mock",
    command: process.execPath,
    args: [MOCK_AGENT_PATH, scenario],
    cwd,
    ...overrides,
    // Merge after the spread: a partial `overrides.timeouts` must keep the
    // test defaults for the fields it does not mention.
    timeouts: { ...DEFAULT_TEST_TIMEOUTS, ...overrides.timeouts },
  };
}

export async function startMockRuntime(
  cwd: string,
  scenario: string,
  bridge: AcpHostBridge = {},
  overrides: Partial<AcpSessionRuntimeOptions> = {},
): Promise<AcpSessionRuntime> {
  return AcpSessionRuntime.start(mockRuntimeOptions(cwd, scenario, overrides), bridge);
}

export function collectEvents(runtime: AcpSessionRuntime): AcpRuntimeEvent[] {
  const events: AcpRuntimeEvent[] = [];
  runtime.on("event", (event: AcpRuntimeEvent) => {
    events.push(event);
  });
  return events;
}

export async function waitFor(condition: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("waitFor timed out");
}
