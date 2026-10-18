import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import type {
  LanguageServerConnection,
  LanguageServerEvent,
  LanguageServerKey,
  LanguageServerPort,
  Logger,
  ResolvedLspServer,
} from "@zcode/contracts";
import { createLanguageServerPool, type LanguageServerPoolOptions } from "../src/lsp/index.js";

/**
 * Shared helpers for LSP pool tests. The fake server's env knobs are documented in
 * tests/fixtures/fake-lsp-server.mjs.
 */
export const FAKE_SERVER_PATH = fileURLToPath(
  new URL("./fixtures/fake-lsp-server.mjs", import.meta.url),
);

export const TEST_WORKSPACE = tmpdir();

export const TEST_KEY: LanguageServerKey = {
  identityKey: "workspace-under-test",
  workspacePath: TEST_WORKSPACE,
};

export function fakeServer(
  env: Record<string, string> = {},
  overrides: Partial<ResolvedLspServer> = {},
): ResolvedLspServer {
  return {
    id: "fake/ts",
    pluginId: "fake",
    serverName: "ts",
    priority: 0,
    command: process.execPath,
    args: [FAKE_SERVER_PATH],
    env,
    extensionToLanguage: { ".ts": "typescript" },
    startupTimeoutMs: 5_000,
    shutdownTimeoutMs: 1_000,
    requestTimeoutMs: 5_000,
    restartOnCrash: true,
    maxRestarts: 3,
    diagnosticsAfterEdit: true,
    ...overrides,
  };
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 5_000,
  message = "condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${message}`);
    await sleep(10);
  }
}

/** Polls `acquire` the way a tool call retries until the server is ready. */
export async function waitForReady(
  pool: LanguageServerPort,
  server: ResolvedLspServer,
  key: LanguageServerKey = TEST_KEY,
  timeoutMs = 5_000,
): Promise<LanguageServerConnection> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = pool.acquire(server, key);
    if (result.state === "ready") return result.connection;
    if (result.state === "failed") throw new Error(`${result.code}: ${result.message}`);
    if (Date.now() > deadline) throw new Error("timed out waiting for ready");
    await sleep(10);
  }
}

export interface RecordedLog {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  context?: Record<string, unknown>;
}

export function recordingLogger(base: Record<string, unknown> = {}): {
  logger: Logger;
  logs: RecordedLog[];
} {
  const logs: RecordedLog[] = [];
  const build = (context: Record<string, unknown>): Logger => {
    const merge = (extra?: Record<string, unknown>) => ({ ...context, ...extra });
    return {
      debug: (message, extra) => logs.push({ level: "debug", message, context: merge(extra) }),
      info: (message, extra) => logs.push({ level: "info", message, context: merge(extra) }),
      warn: (message, extra) => logs.push({ level: "warn", message, context: merge(extra) }),
      error: (message, _error, extra) =>
        logs.push({ level: "error", message, context: merge(extra) }),
      child: (extra) => build({ ...context, ...extra }),
    };
  };
  return { logger: build(base), logs };
}

export function createTestPool(options: Partial<LanguageServerPoolOptions> = {}): {
  pool: LanguageServerPort;
  events: LanguageServerEvent[];
  dispose(): Promise<void>;
} {
  const pool = createLanguageServerPool({
    baseEnv: { ...process.env },
    idleShutdownMs: 60_000,
    ...options,
  });
  const events: LanguageServerEvent[] = [];
  const unsubscribe = pool.onEvent((event) => events.push(event));
  return {
    pool,
    events,
    async dispose() {
      unsubscribe();
      await pool.stopAll();
    },
  };
}
