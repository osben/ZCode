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
});
