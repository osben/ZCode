import { describe, expect, it } from "vitest";
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

  it("fails the prompt with MessageTooLargeError when a frame exceeds the limit", async () => {
    const cwd = await createTempDir();
    const runtime = await startMockRuntime(cwd, "big", {}, { maxFrameBytes: 64 * 1024 });
    try {
      await expect(runtime.prompt("big output")).rejects.toThrowError(/exceeds|too large/i);
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
});
