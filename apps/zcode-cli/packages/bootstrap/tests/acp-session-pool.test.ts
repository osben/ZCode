import { describe, expect, it, vi } from "vitest";
import type { AcpRuntimeEvent, AcpRuntimeState, AcpSessionRuntimeOptions } from "@zcode/acp-agent-runtime";
import { AcpSessionPool, type AcpPoolRuntime } from "../src/acp-agent/acp-session-pool.js";

interface FakeRuntime extends AcpPoolRuntime {
  readonly options: AcpSessionRuntimeOptions;
  readonly stop: ReturnType<typeof vi.fn>;
  readonly restart: ReturnType<typeof vi.fn>;
  setState(state: AcpRuntimeState): void;
}

function fakeRuntime(options: AcpSessionRuntimeOptions): FakeRuntime {
  let state: AcpRuntimeState = "ready";
  const runtime = {
    options,
    get state() {
      return state;
    },
    setState(next: AcpRuntimeState) {
      state = next;
    },
    restart: vi.fn(async () => {
      state = "ready";
    }),
    stop: vi.fn(async () => {
      state = "stopped";
    }),
    cancel: vi.fn(async () => undefined),
    prompt: vi.fn(async () => ({ stopReason: "end_turn" })),
    on: vi.fn((_event: "event", _listener: (event: AcpRuntimeEvent) => void) => runtime),
    off: vi.fn((_event: "event", _listener: (event: AcpRuntimeEvent) => void) => runtime),
  };
  return runtime as unknown as FakeRuntime;
}

function launch(overrides: { command?: string; cwd?: string; env?: Record<string, string> } = {}) {
  return {
    agentId: "opencode",
    command: overrides.command ?? "/usr/local/bin/opencode",
    args: ["acp"],
    cwd: overrides.cwd ?? "/work/project",
    ...(overrides.env === undefined ? {} : { env: overrides.env }),
  };
}

function createPool() {
  const created: FakeRuntime[] = [];
  const pool = new AcpSessionPool({
    createRuntime: async (options) => {
      const runtime = fakeRuntime(options);
      created.push(runtime);
      return runtime;
    },
  });
  return { pool, created };
}

describe("AcpSessionPool", () => {
  it("reuses one resident runtime per session across turns", async () => {
    const { pool, created } = createPool();

    const first = await pool.acquire("session-a", launch());
    const second = await pool.acquire("session-a", launch());

    expect(second).toBe(first);
    expect(created).toHaveLength(1);
    expect(created[0]!.options).toMatchObject({
      agentId: "opencode",
      command: "/usr/local/bin/opencode",
      args: ["acp"],
      cwd: "/work/project",
    });
  });

  it("keeps separate runtimes for separate sessions", async () => {
    const { pool, created } = createPool();

    const a = await pool.acquire("session-a", launch());
    const b = await pool.acquire("session-b", launch());

    expect(a).not.toBe(b);
    expect(created).toHaveLength(2);
    expect(pool.size).toBe(2);
  });

  it("stops the runtime on deactivation and spawns a fresh one on the next turn", async () => {
    const { pool, created } = createPool();
    const first = await pool.acquire("session-a", launch());

    await pool.stopSession("session-a");
    expect(created[0]!.stop).toHaveBeenCalledTimes(1);
    expect(pool.size).toBe(0);

    await pool.stopSession("session-a");
    expect(created[0]!.stop).toHaveBeenCalledTimes(1);

    const next = await pool.acquire("session-a", launch());
    expect(next).not.toBe(first);
    expect(created).toHaveLength(2);
  });

  it("restarts a failed runtime before its next prompt and keeps the same process", async () => {
    const { pool, created } = createPool();
    const runtime = await pool.acquire("session-a", launch());
    created[0]!.setState("failed");

    const again = await pool.acquire("session-a", launch());

    expect(again).toBe(runtime);
    expect(created[0]!.restart).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(1);
  });

  it("replaces the runtime when its launch config changes", async () => {
    const { pool, created } = createPool();
    await pool.acquire("session-a", launch({ env: { A: "1" } }));

    const replaced = await pool.acquire("session-a", launch({ env: { A: "2" } }));

    expect(created).toHaveLength(2);
    expect(created[0]!.stop).toHaveBeenCalledTimes(1);
    expect(replaced).toBe(created[1]);
  });

  it("does not treat an equal launch with reordered env keys as a change", async () => {
    const { pool, created } = createPool();
    await pool.acquire("session-a", launch({ env: { A: "1", B: "2" } }));

    await pool.acquire("session-a", launch({ env: { B: "2", A: "1" } }));

    expect(created).toHaveLength(1);
  });

  it("replaces a stopped runtime instead of reusing it", async () => {
    const { pool, created } = createPool();
    await pool.acquire("session-a", launch());
    created[0]!.setState("stopped");

    await pool.acquire("session-a", launch());

    expect(created).toHaveLength(2);
    expect(created[0]!.restart).not.toHaveBeenCalled();
  });

  it("stops every resident runtime on worker shutdown", async () => {
    const { pool, created } = createPool();
    await pool.acquire("session-a", launch());
    await pool.acquire("session-b", launch());

    await pool.stopAll();

    expect(created.map((runtime) => runtime.stop.mock.calls.length)).toEqual([1, 1]);
    expect(pool.size).toBe(0);
  });

  it("binds each runtime to its agent's permission bridge", async () => {
    const seen: string[] = [];
    const pool = new AcpSessionPool({
      bridgeFor: (agentId) => ({
        requestPermission: async () => {
          seen.push(agentId);
          return { outcome: "cancelled" };
        },
      }),
      createRuntime: async (_options, bridge) => {
        await bridge.requestPermission?.({
          requestId: "r",
          sessionId: "s",
          toolCallId: "t",
          title: "t",
          detail: null,
          options: [],
          raw: null,
        });
        return fakeRuntime(_options);
      },
    });

    await pool.acquire("session-a", launch());

    expect(seen).toEqual(["opencode"]);
  });
});
