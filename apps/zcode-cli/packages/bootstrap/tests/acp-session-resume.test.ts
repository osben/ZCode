import { describe, expect, it, vi } from "vitest";
import type { AcpRuntimeState, AcpSessionRuntimeOptions } from "@zcode/acp-agent-runtime";
import type { ExternalAgentTurnRequest } from "@zcode/contracts";
import { createAcpExternalAgentHost } from "../src/acp-agent/acp-external-agent-host.js";
import {
  AcpSessionPool,
  acpLaunchKey,
  type AcpPoolRuntime,
  type AcpSessionBinding,
  type AcpSessionBindings,
} from "../src/acp-agent/acp-session-pool.js";

const LAUNCH = {
  agentId: "opencode",
  command: "/bin/opencode",
  args: ["acp"],
  cwd: "/work/project",
};

/** Bindings kept in memory; the adapter tests cover the SQLite rows. */
function memoryBindings(initial?: AcpSessionBinding) {
  let stored = initial;
  const bindings: AcpSessionBindings & { writes: AcpSessionBinding[]; cleared: number } = {
    writes: [],
    cleared: 0,
    read: vi.fn(async () => stored),
    write: vi.fn(async (_sessionId, binding) => {
      bindings.writes.push(binding);
      stored = binding;
    }),
    clear: vi.fn(async () => {
      bindings.cleared += 1;
      stored = undefined;
    }),
  };
  return bindings;
}

function fakeRuntime(options: { acpSessionId?: string; start?: "created" | "loaded" | "reset" }) {
  let state: AcpRuntimeState = "ready";
  let pendingStart = options.start;
  const runtime: AcpPoolRuntime = {
    get state() {
      return state;
    },
    acpSessionId: options.acpSessionId,
    takeSessionStart: () => {
      const start = pendingStart;
      pendingStart = undefined;
      return start;
    },
    restart: vi.fn(async () => undefined),
    stop: vi.fn(async () => {
      state = "stopped";
    }),
    cancel: vi.fn(async () => undefined),
    prompt: vi.fn(async () => ({ stopReason: "end_turn" })),
    on: () => runtime,
    off: () => runtime,
  };
  return runtime;
}

function poolWith(bindings: AcpSessionBindings | undefined, runtimes: AcpPoolRuntime[]) {
  const created: AcpSessionRuntimeOptions[] = [];
  const pool = new AcpSessionPool({
    ...(bindings === undefined ? {} : { bindings }),
    createRuntime: async (options) => {
      created.push(options);
      return runtimes.shift() ?? fakeRuntime({ acpSessionId: "fresh" });
    },
  });
  return { pool, created };
}

describe("ACP session resume", () => {
  it("loads the stored session on a cold start when agent, cwd and launch config still match", async () => {
    const stored: AcpSessionBinding = {
      agentId: "opencode",
      acpSessionId: "acp-earlier",
      cwd: LAUNCH.cwd,
      launchKey: acpLaunchKey(LAUNCH),
    };
    const bindings = memoryBindings(stored);
    const { pool, created } = poolWith(bindings, [fakeRuntime({ acpSessionId: "acp-earlier", start: "loaded" })]);

    await pool.acquire("zcode-1", LAUNCH);

    expect(created[0]?.resumeSessionId).toBe("acp-earlier");
    expect(bindings.cleared).toBe(0);
  });

  it("starts a new session and clears the binding when the agent, cwd or launch config changed", async () => {
    for (const changed of [
      { agentId: "cursor" },
      { cwd: "/elsewhere" },
      { command: "/usr/local/bin/opencode-2" },
    ]) {
      const bindings = memoryBindings({
        agentId: "opencode",
        acpSessionId: "acp-earlier",
        cwd: LAUNCH.cwd,
        launchKey: acpLaunchKey(LAUNCH),
      });
      const { pool, created } = poolWith(bindings, [fakeRuntime({ acpSessionId: "fresh" })]);

      await pool.acquire("zcode-1", { ...LAUNCH, ...changed });

      expect(created[0]?.resumeSessionId).toBeUndefined();
      expect(bindings.cleared).toBe(1);
    }
  });

  it("records the session the runtime holds after the handshake", async () => {
    const bindings = memoryBindings();
    const { pool } = poolWith(bindings, [fakeRuntime({ acpSessionId: "acp-new" })]);

    await pool.acquire("zcode-1", LAUNCH);

    expect(bindings.writes).toEqual([
      { agentId: "opencode", acpSessionId: "acp-new", cwd: LAUNCH.cwd, launchKey: acpLaunchKey(LAUNCH) },
    ]);
  });

  it("replaces the runtime on a launch change in a live session without resuming it", async () => {
    const bindings = memoryBindings({
      agentId: "opencode",
      acpSessionId: "acp-earlier",
      cwd: LAUNCH.cwd,
      launchKey: acpLaunchKey(LAUNCH),
    });
    const { pool, created } = poolWith(bindings, [
      fakeRuntime({ acpSessionId: "acp-live" }),
      fakeRuntime({ acpSessionId: "acp-after-change" }),
    ]);
    await pool.acquire("zcode-1", LAUNCH);

    await pool.acquire("zcode-1", { ...LAUNCH, args: ["acp", "--verbose"] });

    expect(created[1]?.resumeSessionId).toBeUndefined();
    expect(bindings.writes.at(-1)?.acpSessionId).toBe("acp-after-change");
  });

  it("starts without any binding store, as before the S5 persistence", async () => {
    const { pool, created } = poolWith(undefined, [fakeRuntime({ acpSessionId: "fresh" })]);

    await pool.acquire("zcode-1", LAUNCH);

    expect(created[0]?.resumeSessionId).toBeUndefined();
  });

  it("gives the turn a reset signal when the agent could not restore the earlier session", async () => {
    const bindings = memoryBindings({
      agentId: "opencode",
      acpSessionId: "acp-earlier",
      cwd: LAUNCH.cwd,
      launchKey: acpLaunchKey(LAUNCH),
    });
    const runtime = fakeRuntime({ acpSessionId: "acp-new", start: "reset" });
    const { pool } = poolWith(bindings, [runtime]);
    const host = createAcpExternalAgentHost({
      records: {
        read: async () => ({
          agents: [{ agentId: "opencode", enabled: true, command: LAUNCH.command, args: ["acp"] }],
        }),
      },
      pool,
    });
    const seen: unknown[] = [];
    const request = {
      sessionId: "zcode-1",
      workingDirectory: LAUNCH.cwd,
      prompt: [{ type: "text", text: "continue" }],
      signal: new AbortController().signal,
      onEvent: (event: unknown) => seen.push(event),
      requestPermission: async () => "cancelled",
    } as ExternalAgentTurnRequest;

    await host.driverFor("opencode").runTurn(request);

    expect(seen).toEqual([{ type: "context_reset" }]);
  });
});
