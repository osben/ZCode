/**
 * Lifecycle guarantees: `stopped` is terminal, handshake errors survive a
 * failed cleanup, one terminal event per prompt, pending asks are cancelled on
 * every teardown, and any inbound frame resets the stall timer.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AcpSessionRuntime, type AcpRuntimeLogger } from "../src/index.js";
import {
  cleanupTempDir,
  collectEvents,
  createTempDir,
  mockRuntimeOptions,
  startMockRuntime,
  waitFor,
} from "./helpers.js";

interface RuntimeInternals {
  process: unknown;
  pendingAsks: Map<string, unknown>;
  terminateOwnedProcess: (reason: Error) => Promise<void>;
  terminateProcess: (reason: Error) => Promise<void>;
}

const internalsOf = (runtime: AcpSessionRuntime) => runtime as unknown as RuntimeInternals;

const terminalEvents = (events: { type: string }[]) =>
  events.filter((event) => event.type === "stopped" || event.type === "prompt_failed");

function recordingLogger() {
  const entries: { level: string; message: string; fields?: Readonly<Record<string, unknown>> }[] =
    [];
  const logger: AcpRuntimeLogger = {
    info: (message, fields) => entries.push({ level: "info", message, fields }),
    warn: (message, fields) => entries.push({ level: "warn", message, fields }),
    error: (message, fields) => entries.push({ level: "error", message, fields }),
  };
  return { logger, entries };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runtime lifecycle", () => {
  it("keeps an explicit stop terminal when cleanup fails, and retries on the next stop", async () => {
    const cwd = await createTempDir();
    const runtime = await startMockRuntime(cwd, "normal");
    const internals = internalsOf(runtime);
    const original = internals.terminateOwnedProcess.bind(runtime);
    try {
      internals.terminateOwnedProcess = async () => {
        throw new Error("ACP process cleanup incomplete: 4242");
      };
      await expect(runtime.stop()).rejects.toThrow(/cleanup incomplete/);
      expect(runtime.state).toBe("stopped");
      expect(internals.process).toBeDefined();

      // Neither restart nor prompt may resurrect a stopped runtime.
      await runtime.restart();
      expect(runtime.state).toBe("stopped");
      await expect(runtime.prompt("after stop")).rejects.toMatchObject({ code: "ACP_STATE" });

      internals.terminateOwnedProcess = original;
      await runtime.stop();
      expect(runtime.state).toBe("stopped");
      expect(internals.process).toBeUndefined();
    } finally {
      internals.terminateOwnedProcess = original;
      await runtime.stop();
      await cleanupTempDir(cwd);
    }
  });

  it("rejects a failed handshake with its own error even when cleanup also fails", async () => {
    const cwd = await createTempDir();
    const { logger, entries } = recordingLogger();
    const prototype = AcpSessionRuntime.prototype as unknown as RuntimeInternals;
    const original = prototype.terminateOwnedProcess;
    vi.spyOn(prototype, "terminateOwnedProcess").mockImplementationOnce(async function (
      this: AcpSessionRuntime,
      reason: Error,
    ) {
      // Really clean the child, then report a failure like an incomplete tree kill.
      await original.call(this, reason);
      throw new Error("ACP process cleanup incomplete: 4242");
    });
    try {
      const failure = await AcpSessionRuntime.start(
        mockRuntimeOptions(cwd, "new-fails", { logger }),
      ).then(
        () => new Error("expected the handshake to fail"),
        (error: unknown) => error as Error,
      );
      // The agent's session/new rejection (the SDK reports it as a JSON-RPC
      // internal error), never the cleanup failure that followed it.
      expect(failure.message).not.toMatch(/cleanup|expected the handshake/);
      expect(failure.message).toMatch(/Internal error/);
      expect(entries).toContainEqual(
        expect.objectContaining({ level: "warn", message: "ACP agent handshake failed" }),
      );
      expect(entries).toContainEqual(
        expect.objectContaining({
          level: "error",
          message: "ACP agent process cleanup failed",
          fields: expect.objectContaining({ agentId: "mock" }),
        }),
      );
    } finally {
      await cleanupTempDir(cwd);
    }
  });

  it("emits exactly one terminal event per prompt", async () => {
    const cwd = await createTempDir();
    const ok = await startMockRuntime(cwd, "normal");
    const died = await startMockRuntime(cwd, "die-mid");
    try {
      const okEvents = collectEvents(ok);
      await ok.prompt("hello");
      expect(terminalEvents(okEvents)).toEqual([
        expect.objectContaining({ type: "stopped", reason: "end_turn" }),
      ]);

      const diedEvents = collectEvents(died);
      await expect(died.prompt("die")).rejects.toMatchObject({ code: "ACP_AGENT_DIED" });
      expect(terminalEvents(diedEvents)).toEqual([
        expect.objectContaining({ type: "prompt_failed" }),
      ]);
    } finally {
      await ok.stop();
      await died.stop();
      await cleanupTempDir(cwd);
    }
  });

  it("emits prompt_failed when stop() interrupts a prompt", async () => {
    const cwd = await createTempDir();
    const runtime = await startMockRuntime(cwd, "silent");
    try {
      const events = collectEvents(runtime);
      const inFlight = runtime.prompt("silent");
      inFlight.catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 100));
      await runtime.stop();
      await expect(inFlight).rejects.toBeDefined();
      expect(terminalEvents(events)).toEqual([expect.objectContaining({ type: "prompt_failed" })]);
    } finally {
      await runtime.stop();
      await cleanupTempDir(cwd);
    }
  });

  it("cancels pending permission asks on a teardown that is not stop()", async () => {
    const cwd = await createTempDir();
    const runtime = await startMockRuntime(cwd, "permission", {
      requestPermission: () => new Promise(() => {}),
    });
    const internals = internalsOf(runtime);
    try {
      const inFlight = runtime.prompt("ask");
      inFlight.catch(() => {});
      await waitFor(() => internals.pendingAsks.size === 1, 3_000);
      const teardown = internals.terminateProcess(new Error("transport failure"));
      // Resolved synchronously, before the prompt is rejected.
      expect(internals.pendingAsks.size).toBe(0);
      await teardown;
      await expect(inFlight).rejects.toThrow(/transport failure/);
      expect(runtime.state).toBe("failed");
    } finally {
      await runtime.stop();
      await cleanupTempDir(cwd);
    }
  });

  it("does not report a stall while the agent keeps sending non-update frames", async () => {
    const cwd = await createTempDir();
    const runtime = await startMockRuntime(
      cwd,
      "ask-heartbeat",
      { requestPermission: async () => ({ outcome: "selected", kind: "allow_once" }) },
      { timeouts: { stallWarningMs: 250 } },
    );
    try {
      const events = collectEvents(runtime);
      const response = await runtime.prompt("heartbeat");
      expect(response.stopReason).toBe("end_turn");
      expect(events.some((event) => event.type === "stalled")).toBe(false);
    } finally {
      await runtime.stop();
      await cleanupTempDir(cwd);
    }
  });

  it("logs unexpected exits with code and signal only", async () => {
    const cwd = await createTempDir();
    const { logger, entries } = recordingLogger();
    const runtime = await startMockRuntime(cwd, "die", {}, { logger, env: { MOCK_MARKER: "x" } });
    try {
      await runtime.prompt("die");
      await waitFor(() => runtime.state === "failed", 3_000);
      const exit = entries.find(
        (entry) => entry.message === "ACP agent process exited unexpectedly",
      );
      expect(exit?.fields).toEqual({ agentId: "mock", code: 7, signal: null });
      expect(JSON.stringify(entries)).not.toContain("MOCK_MARKER");
    } finally {
      await runtime.stop();
      await cleanupTempDir(cwd);
    }
  });
});
