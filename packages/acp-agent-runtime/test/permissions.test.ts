import { describe, expect, it } from "vitest";
import {
  cleanupTempDir,
  collectEvents,
  createTempDir,
  startMockRuntime,
  waitFor,
} from "./helpers.js";
import type { AcpPermissionAsk } from "../src/index.js";

describe("permission bridge", () => {
  it("surfaces the ask and applies an allow answer", async () => {
    const cwd = await createTempDir();
    const asks: AcpPermissionAsk[] = [];
    const runtime = await startMockRuntime(cwd, "permission", {
      requestPermission: async (ask) => {
        asks.push(ask);
        return { outcome: "selected", optionId: "allow-once" };
      },
    });
    try {
      const events = collectEvents(runtime);
      const response = await runtime.prompt("run echo");
      expect(response.stopReason).toBe("end_turn");
      expect(asks).toHaveLength(1);
      const ask = asks[0];
      if (!ask) throw new Error("expected a permission ask");
      expect(ask.toolCallId).toBe("tc-1");
      expect(ask.title).toBe("Run echo");
      expect(ask.detail).toBe("Not in allowlist: echo");
      expect(ask.options.map((option) => option.kind)).toEqual([
        "allow_once",
        "allow_always",
        "reject_once",
      ]);
      expect(events).toContainEqual({ type: "message_chunk", text: "granted" });
    } finally {
      await runtime.stop();
      await cleanupTempDir(cwd);
    }
  });

  it("turns a cancelled answer into a cancelled turn", async () => {
    const cwd = await createTempDir();
    const runtime = await startMockRuntime(cwd, "permission", {
      requestPermission: async () => ({ outcome: "cancelled" }),
    });
    try {
      const events = collectEvents(runtime);
      const response = await runtime.prompt("run echo");
      expect(response.stopReason).toBe("cancelled");
      expect(events).toContainEqual({ type: "message_chunk", text: "denied" });
    } finally {
      await runtime.stop();
      await cleanupTempDir(cwd);
    }
  });

  it("auto-cancels when no permission bridge is provided", async () => {
    const cwd = await createTempDir();
    const runtime = await startMockRuntime(cwd, "permission");
    try {
      const events = collectEvents(runtime);
      const response = await runtime.prompt("run echo");
      expect(response.stopReason).toBe("cancelled");
      expect(events).toContainEqual({ type: "message_chunk", text: "denied" });
    } finally {
      await runtime.stop();
      await cleanupTempDir(cwd);
    }
  });

  it("never allows on an unknown optionId (stale answer degrades to cancelled)", async () => {
    const cwd = await createTempDir();
    const runtime = await startMockRuntime(cwd, "permission", {
      requestPermission: async () => ({ outcome: "selected", optionId: "bogus-option" }),
    });
    try {
      const events = collectEvents(runtime);
      const response = await runtime.prompt("run echo");
      expect(response.stopReason).toBe("cancelled");
      expect(events).toContainEqual({ type: "message_chunk", text: "denied" });
    } finally {
      await runtime.stop();
      await cleanupTempDir(cwd);
    }
  });

  it("treats a rejecting bridge as cancelled", async () => {
    const cwd = await createTempDir();
    const runtime = await startMockRuntime(cwd, "permission", {
      requestPermission: async () => {
        throw new Error("host exploded");
      },
    });
    try {
      const events = collectEvents(runtime);
      const response = await runtime.prompt("run echo");
      expect(response.stopReason).toBe("cancelled");
      expect(events).toContainEqual({ type: "message_chunk", text: "denied" });
    } finally {
      await runtime.stop();
      await cleanupTempDir(cwd);
    }
  });

  it("rejects the in-flight prompt when stop races a pending ask", async () => {
    const cwd = await createTempDir();
    const asks: AcpPermissionAsk[] = [];
    const runtime = await startMockRuntime(cwd, "permission", {
      requestPermission: (ask) => {
        asks.push(ask);
        return new Promise(() => {});
      },
    });
    try {
      const inFlight = runtime.prompt("run echo");
      void inFlight.catch(() => {});
      await waitFor(() => asks.length > 0, 3_000);
      await runtime.stop();
      await expect(inFlight).rejects.toMatchObject({ code: "ACP_CANCELLED" });
    } finally {
      await cleanupTempDir(cwd);
    }
  });
});
