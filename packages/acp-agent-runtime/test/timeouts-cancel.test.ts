import { describe, expect, it } from "vitest";
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import type { AcpPermissionAsk } from "../src/index.js";
import {
  cleanupTempDir,
  collectEvents,
  createTempDir,
  startMockRuntime,
  waitFor,
} from "./helpers.js";

describe("timeouts and cancellation", () => {
  it("fails the handshake with ACP_TIMEOUT when initialize never responds", async () => {
    const cwd = await createTempDir();
    try {
      await expect(
        startMockRuntime(cwd, "hang", {}, { timeouts: { initializeMs: 400 } }),
      ).rejects.toMatchObject({ code: "ACP_TIMEOUT" });
    } finally {
      await cleanupTempDir(cwd);
    }
  });

  it("cancel settles a slow prompt quickly", async () => {
    const cwd = await createTempDir();
    const runtime = await startMockRuntime(cwd, "cancel");
    try {
      const events = collectEvents(runtime);
      const inFlight = runtime.prompt("do something slow");
      await waitFor(() => events.some((event) => event.type === "thought_chunk"), 3_000);
      const startedAt = Date.now();
      await runtime.cancel();
      const response = await inFlight;
      expect(response.stopReason).toBe("cancelled");
      expect(Date.now() - startedAt).toBeLessThan(3_000);
    } finally {
      await runtime.stop();
      await cleanupTempDir(cwd);
    }
  });

  it("emits a stalled warning when a prompt produces no frames", async () => {
    const cwd = await createTempDir();
    const runtime = await startMockRuntime(
      cwd,
      "silent",
      {},
      {
        timeouts: { stallWarningMs: 200 },
      },
    );
    try {
      const events = collectEvents(runtime);
      const inFlight = runtime.prompt("silent task");
      await waitFor(() => events.some((event) => event.type === "stalled"), 2_000);
      const stalled = events.find((event) => event.type === "stalled");
      if (stalled?.type === "stalled") expect(stalled.silentMs).toBe(200);
      await runtime.cancel();
      const response = await inFlight;
      expect(response.stopReason).toBe("cancelled");
    } finally {
      await runtime.stop();
      await cleanupTempDir(cwd);
    }
  });

  it("settles a cancel that raced ahead of the agent's wait (slow-runner regression)", async () => {
    const cwd = await createTempDir();
    const runtime = await startMockRuntime(cwd, "cancel-early");
    try {
      const inFlight = runtime.prompt("task");
      // Give the prompt time to reach the mock, then cancel while it is still
      // in its pre-wait delay — the exact window that hung on CI runners.
      await new Promise((resolve) => setTimeout(resolve, 150));
      const startedAt = Date.now();
      await runtime.cancel();
      const response = await inFlight;
      expect(response.stopReason).toBe("cancelled");
      expect(Date.now() - startedAt).toBeLessThan(2_500);
    } finally {
      await runtime.stop();
      await cleanupTempDir(cwd);
    }
  });

  it("marks the runtime failed after an oversized frame and restarts on the next prompt", async () => {
    const cwd = await createTempDir();
    const runtime = await startMockRuntime(cwd, "big", {}, { maxFrameBytes: 64 * 1024 });
    try {
      const events = collectEvents(runtime);
      await expect(runtime.prompt("big output")).rejects.toThrowError(/exceeds|too large/i);
      // Regression: the framing error leaves the SDK connection unusable while
      // the mock child stays alive. The runtime must not fall back to "ready"
      // on the dead connection — it tears down (killing the surviving child)
      // and the next prompt restarts the agent instead of reusing it.
      await waitFor(() => runtime.state === "failed", 3_000);
      await waitFor(() => events.some((event) => event.type === "process_exit"), 3_000);
      const second = await runtime.prompt("again");
      expect(second.stopReason).toBe("end_turn");
      expect(runtime.state).toBe("ready");
    } finally {
      await runtime.stop();
      await cleanupTempDir(cwd);
    }
  });

  it("escalates cancel to a process kill when the agent never settles", async () => {
    const cwd = await createTempDir();
    const asks: AcpPermissionAsk[] = [];
    const runtime = await startMockRuntime(
      cwd,
      "permission",
      {
        requestPermission: (ask) => {
          asks.push(ask);
          return new Promise(() => {});
        },
      },
      { timeouts: { cancelGraceMs: 500 } },
    );
    try {
      const inFlight = runtime.prompt("run echo");
      void inFlight.catch(() => {});
      await waitFor(() => asks.length > 0, 3_000);
      const startedAt = Date.now();
      await runtime.cancel();
      await expect(inFlight).rejects.toMatchObject({ code: "ACP_CANCELLED" });
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(400);
    } finally {
      await runtime.stop();
      await cleanupTempDir(cwd);
    }
  });

  it("escalates cancel to a kill when the cancel notification never flushes", async () => {
    const cwd = await createTempDir();
    const runtime = await startMockRuntime(cwd, "silent", {}, { timeouts: { cancelGraceMs: 400 } });
    try {
      // A live child that stopped reading stdin backpressures the notify
      // write forever; pin the SDK notify to reproduce that exact stall.
      const internals = runtime as unknown as {
        connection: { agent: { notify: () => Promise<void> } };
      };
      internals.connection.agent.notify = () => new Promise(() => {});
      const inFlight = runtime.prompt("stuck task");
      void inFlight.catch(() => {});
      await waitFor(() => runtime.state === "prompting", 3_000);
      const startedAt = Date.now();
      await runtime.cancel();
      await expect(inFlight).rejects.toMatchObject({ code: "ACP_CANCELLED" });
      expect(runtime.state).toBe("failed");
      expect(Date.now() - startedAt).toBeLessThan(6_000);
    } finally {
      await runtime.stop();
      await cleanupTempDir(cwd);
    }
  });

  it("marks the runtime failed after cancel escalation and restarts on the next prompt", async () => {
    const cwd = await createTempDir();
    const asks: AcpPermissionAsk[] = [];
    const runtime = await startMockRuntime(
      cwd,
      "permission",
      {
        requestPermission: (ask) => {
          asks.push(ask);
          if (asks.length === 1) return new Promise(() => {});
          return Promise.resolve({ outcome: "selected", kind: "allow_once" } as const);
        },
      },
      { timeouts: { cancelGraceMs: 400 } },
    );
    try {
      const first = runtime.prompt("run echo");
      void first.catch(() => {});
      await waitFor(() => asks.length > 0, 3_000);
      await runtime.cancel();
      await expect(first).rejects.toMatchObject({ code: "ACP_CANCELLED" });
      // Regression: an escalated cancel must not leave a "ready" runtime with a
      // cleared connection; the next prompt restarts the agent instead of
      // failing with ACP_STATE.
      expect(runtime.state).toBe("failed");
      const second = await runtime.prompt("run echo again");
      expect(second.stopReason).toBe("end_turn");
    } finally {
      await runtime.stop();
      await cleanupTempDir(cwd);
    }
  });

  it("ignores exit and stream-failure callbacks from a superseded generation", async () => {
    const cwd = await createTempDir();
    const runtime = await startMockRuntime(cwd, "normal");
    try {
      const events = collectEvents(runtime);
      // Poke the private handlers the way a late process event would: a
      // restart bumps `generation`, so events carrying the old generation must
      // be ignored (no stale process_exit, no teardown of the live session).
      const internals = runtime as unknown as {
        generation: number;
        handleExit: (
          code: number | null,
          signal: NodeJS.Signals | null,
          generation: number,
        ) => void;
        handleStreamFailure: (error: Error, generation: number) => void;
      };
      const staleGeneration = internals.generation - 1;
      internals.handleExit(1, null, staleGeneration);
      internals.handleStreamFailure(new Error("stale stream failure"), staleGeneration);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(events.some((event) => event.type === "process_exit")).toBe(false);
      expect(runtime.state).toBe("ready");
      const response = await runtime.prompt("still alive");
      expect(response.stopReason).toBe("end_turn");
    } finally {
      await runtime.stop();
      await cleanupTempDir(cwd);
    }
  });

  it("ignores stale connection callbacks from a superseded generation", async () => {
    const cwd = await createTempDir();
    const asks: AcpPermissionAsk[] = [];
    const runtime = await startMockRuntime(cwd, "normal", {
      requestPermission: (ask) => {
        asks.push(ask);
        return new Promise(() => {});
      },
    });
    try {
      const events = collectEvents(runtime);
      const sessionId = runtime.acpSessionId;
      expect(sessionId).toBe("mock-session");
      // A restart replaces the process and bumps `generation`, but the old
      // connection can still deliver buffered frames: stale updates must be
      // counted (never surfaced, even on a sessionId collision) and stale
      // permission asks must be answered cancelled without reaching the host.
      const internals = runtime as unknown as {
        generation: number;
        handleSessionUpdate: (notification: SessionNotification, generation: number) => void;
        handlePermissionRequest: (
          request: RequestPermissionRequest,
          generation: number,
        ) => Promise<RequestPermissionResponse>;
      };
      const staleGeneration = internals.generation - 1;
      const update: SessionNotification = {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "m1",
          content: { type: "text", text: "stale" },
        },
      };
      const ignoredBefore = runtime.ignoredUpdates;
      internals.handleSessionUpdate(update, staleGeneration);
      expect(runtime.ignoredUpdates).toBe(ignoredBefore + 1);
      expect(events.some((event) => event.type === "message_chunk")).toBe(false);
      const staleAsk: RequestPermissionRequest = {
        sessionId,
        toolCall: {
          toolCallId: "tc-stale",
          title: "Stale ask",
          kind: "execute",
          status: "pending",
          content: [],
        },
        options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
      };
      const staleAnswer = await internals.handlePermissionRequest(staleAsk, staleGeneration);
      expect(asks).toHaveLength(0);
      expect(staleAnswer.outcome.outcome).toBe("cancelled");
      // The live generation still surfaces the same traffic.
      internals.handleSessionUpdate(update, internals.generation);
      expect(events.some((event) => event.type === "message_chunk")).toBe(true);
      const response = await runtime.prompt("still alive");
      expect(response.stopReason).toBe("end_turn");
    } finally {
      await runtime.stop();
      await cleanupTempDir(cwd);
    }
  });
});
