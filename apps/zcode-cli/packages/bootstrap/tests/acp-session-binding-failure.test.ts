import { describe, expect, it, vi } from "vitest";
import type { ExternalAgentTurnRequest } from "@zcode/contracts";
import { createAcpExternalAgentHost } from "../src/acp-agent/acp-external-agent-host.js";
import {
  AcpSessionPool,
  type AcpSessionBindings,
} from "../src/acp-agent/acp-session-pool.js";

// The binding only matters for the next cold start. A failed read or write must not fail the spawn or the
// turn, and the warning must say what was lost (not "could not be started").

const LAUNCH = {
  agentId: "opencode",
  command: "/bin/opencode",
  args: ["acp"],
  cwd: "/work/project",
};

function fakeRuntime() {
  const runtime = {
    acpSessionId: "acp-1",
    state: "ready" as const,
    takeSessionStart: () => undefined,
    restart: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    prompt: vi.fn(async () => ({ stopReason: "end_turn" })),
    on: () => runtime,
    off: () => runtime,
  };
  return runtime;
}

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("ACP session binding failures", () => {
  it("a failed binding write keeps the runtime resident and the acquire successful", async () => {
    const log = logger();
    const bindings: AcpSessionBindings = {
      read: vi.fn(async () => undefined),
      write: vi.fn(async () => {
        throw new Error("SQLITE_BUSY: database is locked");
      }),
      clear: vi.fn(async () => undefined),
    };
    const pool = new AcpSessionPool({
      bindings,
      logger: log,
      createRuntime: async () => fakeRuntime() as never,
    });
    const runtime = await pool.acquire("zc-1", LAUNCH);
    expect(runtime).toBeDefined();
    expect(pool.size).toBe(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("could not write the ACP session binding"),
      expect.objectContaining({ agentId: "opencode", error: "SQLITE_BUSY: database is locked" }),
    );
  });

  it("a failed binding read starts a new session instead of failing the turn", async () => {
    const log = logger();
    const createRuntime = vi.fn(async () => fakeRuntime() as never);
    const pool = new AcpSessionPool({
      bindings: {
        read: vi.fn(async () => {
          throw new Error("SQLITE_CANTOPEN");
        }),
        write: vi.fn(async () => undefined),
        clear: vi.fn(async () => undefined),
      },
      logger: log,
      createRuntime,
    });
    await pool.acquire("zc-2", LAUNCH);
    expect(createRuntime).toHaveBeenCalledWith(
      expect.not.objectContaining({ resumeSessionId: expect.anything() }),
      expect.anything(),
    );
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("could not read the ACP session binding"),
      expect.anything(),
    );
  });

  it("the turn completes normally when only the binding write fails", async () => {
    const runtime = fakeRuntime();
    const pool = new AcpSessionPool({
      bindings: {
        read: vi.fn(async () => undefined),
        write: vi.fn(async () => {
          throw new Error("SQLITE_BUSY");
        }),
        clear: vi.fn(async () => undefined),
      },
      logger: logger(),
      createRuntime: async () => runtime as never,
    });
    const host = createAcpExternalAgentHost({
      records: {
        read: async () => ({
          agents: [{ agentId: "opencode", enabled: true, command: LAUNCH.command, args: ["acp"] }],
        }),
      },
      pool,
    });
    const request = {
      sessionId: "zc-3",
      workingDirectory: LAUNCH.cwd,
      prompt: [{ type: "text", text: "hello" }],
      signal: new AbortController().signal,
      onEvent: () => undefined,
      requestPermission: async () => "cancelled",
    } as ExternalAgentTurnRequest;
    const result = await host.driverFor("opencode").runTurn(request);
    expect(result.stopReason).toBe("end_turn");
    expect(runtime.prompt).toHaveBeenCalledTimes(1);
  });
});
