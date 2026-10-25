import { describe, expect, it } from "vitest";
import {
  cleanupTempDir,
  collectEvents,
  createTempDir,
  startMockRuntime,
  waitFor,
} from "./helpers.js";
import type { AcpFrameObserver } from "../src/index.js";

/** Records the methods of the requests the runtime sent, in wire order. */
function recordSentMethods() {
  const methods: string[] = [];
  const onFrame: AcpFrameObserver = (frame) => {
    if (frame.direction !== "outbound") return;
    try {
      const message = JSON.parse(frame.text) as { method?: unknown };
      if (typeof message.method === "string") methods.push(message.method);
    } catch {
      // Non-JSON lines are not requests.
    }
  };
  return { methods, onFrame };
}

describe("session resume (session/load)", () => {
  it("restores the earlier session with session/load and does not surface the history it replays", async () => {
    const cwd = await createTempDir();
    const sent = recordSentMethods();
    const runtime = await startMockRuntime(
      cwd,
      "load",
      {},
      {
        resumeSessionId: "mock-session",
        onFrame: sent.onFrame,
      },
    );
    try {
      const events = collectEvents(runtime);
      expect(runtime.takeSessionStart()).toBe("loaded");
      expect(sent.methods).toContain("session/load");
      expect(sent.methods).not.toContain("session/new");
      expect(events).toEqual([]);
      expect(runtime.ignoredUpdates).toBe(1);
      expect(runtime.acpSessionId).toBe("mock-session");
    } finally {
      await runtime.stop();
      await cleanupTempDir(cwd);
    }
  });

  it("reports a fresh session as created when there is nothing to resume", async () => {
    const cwd = await createTempDir();
    const sent = recordSentMethods();
    const runtime = await startMockRuntime(cwd, "normal", {}, { onFrame: sent.onFrame });
    try {
      expect(runtime.takeSessionStart()).toBe("created");
      expect(sent.methods).not.toContain("session/load");
      expect(runtime.takeSessionStart()).toBeUndefined();
    } finally {
      await runtime.stop();
      await cleanupTempDir(cwd);
    }
  });

  it("starts a new session and reports a reset when the agent cannot load sessions", async () => {
    const cwd = await createTempDir();
    const sent = recordSentMethods();
    const runtime = await startMockRuntime(
      cwd,
      "normal",
      {},
      {
        resumeSessionId: "mock-session",
        onFrame: sent.onFrame,
      },
    );
    try {
      expect(runtime.takeSessionStart()).toBe("reset");
      expect(sent.methods).not.toContain("session/load");
      expect(sent.methods).toContain("session/new");
    } finally {
      await runtime.stop();
      await cleanupTempDir(cwd);
    }
  });

  it("falls back to session/new as a reset when the load is refused", async () => {
    const cwd = await createTempDir();
    const sent = recordSentMethods();
    const runtime = await startMockRuntime(
      cwd,
      "load-fails",
      {},
      {
        resumeSessionId: "mock-session",
        onFrame: sent.onFrame,
      },
    );
    try {
      expect(runtime.takeSessionStart()).toBe("reset");
      expect(
        sent.methods.filter(
          (method) => method.startsWith("session/") && method !== "session/cancel",
        ),
      ).toEqual(["session/load", "session/new"]);
      expect(runtime.state).toBe("ready");
    } finally {
      await runtime.stop();
      await cleanupTempDir(cwd);
    }
  });

  it("loads the same session again after the agent dies, and serves the next prompt", async () => {
    const cwd = await createTempDir();
    const sent = recordSentMethods();
    const runtime = await startMockRuntime(cwd, "load-die", {}, { onFrame: sent.onFrame });
    try {
      expect(runtime.takeSessionStart()).toBe("created");
      const first = await runtime.prompt("first");
      expect(first.stopReason).toBe("end_turn");
      await waitFor(() => runtime.state === "failed", 3_000);
      const second = await runtime.prompt("second");
      expect(second.stopReason).toBe("end_turn");
      expect(runtime.takeSessionStart()).toBe("loaded");
      expect(sent.methods).toContain("session/load");
    } finally {
      await runtime.stop();
      await cleanupTempDir(cwd);
    }
  });
});
