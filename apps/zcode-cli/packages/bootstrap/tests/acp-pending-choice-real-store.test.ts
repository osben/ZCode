// specs/acp-agent-runtime.md "S6 readiness": a choice made before the first turn is stored by the command
// (fork_acp_session_choice), the first turn's binding write moves it into the binding, and the reconcile applies it
// before session/prompt. Runs against the real SQLite session database and binding store; only the agent is fake.
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createForkAcpSessionBindingStore, createSqliteSessionStore } from "@zcode/adapters/storage";
import type { AcpConfigOption, AcpRuntimeEvent, AcpRuntimeState } from "@zcode/acp-agent-runtime";
import type { ExternalAgentTurnRequest } from "@zcode/contracts";
import { createAcpExternalAgentHost } from "../src/acp-agent/acp-external-agent-host.js";
import { AcpSessionPool, type AcpPoolRuntime } from "../src/acp-agent/acp-session-pool.js";

const LAUNCH = { command: "/bin/opencode", args: ["acp"], cwd: "/work/project" };

function modeOption(currentValue: string): AcpConfigOption {
  return {
    id: "mode",
    name: "Mode",
    description: null,
    category: "mode",
    currentValue,
    options: [
      { value: "build", name: "Build", description: null, group: null },
      { value: "plan", name: "Plan", description: null, group: null },
    ],
  };
}

/** A fake agent that offers a mode select and records each request in order. */
function fakeAgent() {
  let state: AcpRuntimeState = "ready";
  let configOptions = [modeOption("build")];
  const calls: string[] = [];
  const listeners = new Set<(event: AcpRuntimeEvent) => void>();
  const runtime: AcpPoolRuntime & { calls: string[] } = {
    calls,
    get state() {
      return state;
    },
    get configOptions() {
      return configOptions;
    },
    acpSessionId: "acp-session-1",
    setConfigOption: vi.fn(async (configId: string, value: string) => {
      calls.push(`set:${configId}=${value}`);
      configOptions = [modeOption(value)];
      return configOptions;
    }),
    restart: vi.fn(async () => undefined),
    stop: vi.fn(async () => {
      state = "stopped";
    }),
    cancel: vi.fn(async () => undefined),
    prompt: vi.fn(async () => {
      calls.push("prompt");
      return { stopReason: "end_turn" };
    }),
    on: (_event, listener) => {
      listeners.add(listener);
      return runtime;
    },
    off: (_event, listener) => {
      listeners.delete(listener);
      return runtime;
    },
  } as unknown as AcpPoolRuntime & { calls: string[] };
  return runtime;
}

describe("ACP pending choice through the real session database", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function openSessionDatabase(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "zcode-acp-pending-choice-"));
    dirs.push(dir);
    const dbPath = join(dir, "session.sqlite");
    const store = await createSqliteSessionStore({ dbPath });
    store.close();
    return dbPath;
  }

  function turnRequest(): ExternalAgentTurnRequest {
    return {
      sessionId: "zcode-1",
      workingDirectory: LAUNCH.cwd,
      prompt: [{ type: "text", text: "go" }],
      signal: new AbortController().signal,
      onEvent: () => undefined,
      requestPermission: async () => "cancelled",
    };
  }

  it("applies a pre-turn choice before the first prompt and moves it into the binding", async () => {
    const dbPath = await openSessionDatabase();
    const bindings = createForkAcpSessionBindingStore(dbPath);
    // The command handler's write, before any binding exists.
    await bindings.writeChoice("zcode-1", "opencode", "mode", "plan");
    const agent = fakeAgent();
    const pool = new AcpSessionPool({ createRuntime: async () => agent, bindings });
    const host = createAcpExternalAgentHost({
      records: {
        read: async () => ({
          agents: [{ agentId: "opencode", enabled: true, command: LAUNCH.command, args: LAUNCH.args }],
        }),
      },
      pool,
      config: bindings,
    });

    await host.driverFor("opencode").runTurn(turnRequest());

    // The choice reaches the agent before its first prompt, and the agent's value is the chosen one.
    expect(agent.calls).toEqual(["set:mode=plan", "prompt"]);
    expect(await bindings.readConfig("zcode-1")).toMatchObject({
      agentId: "opencode",
      choices: { mode: "plan" },
    });
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(db.prepare("select count(*) as count from fork_acp_session_choice").get()).toEqual({
        count: 0,
      });
    } finally {
      db.close();
    }
  });

  it("drops a pre-turn choice the live snapshot no longer offers, without a request", async () => {
    const dbPath = await openSessionDatabase();
    const bindings = createForkAcpSessionBindingStore(dbPath);
    await bindings.writeChoice("zcode-1", "opencode", "mode", "yolo");
    const agent = fakeAgent();
    const pool = new AcpSessionPool({ createRuntime: async () => agent, bindings });
    const host = createAcpExternalAgentHost({
      records: {
        read: async () => ({
          agents: [{ agentId: "opencode", enabled: true, command: LAUNCH.command, args: LAUNCH.args }],
        }),
      },
      pool,
      config: bindings,
    });

    await host.driverFor("opencode").runTurn(turnRequest());

    expect(agent.calls).toEqual(["prompt"]);
  });
});
