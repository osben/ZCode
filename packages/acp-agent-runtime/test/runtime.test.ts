import { describe, expect, it } from "vitest";
import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import type { AcpPermissionAsk } from "../src/index.js";
import {
  cleanupTempDir,
  collectEvents,
  createTempDir,
  startMockRuntime,
  waitFor,
} from "./helpers.js";

describe("AcpSessionRuntime lifecycle", () => {
  it("runs a full prompt and maps every supported update kind", async () => {
    const cwd = await createTempDir();
    const runtime = await startMockRuntime(cwd, "normal");
    try {
      expect(runtime.state).toBe("ready");
      const events = collectEvents(runtime);
      const response = await runtime.prompt("hi");
      expect(response.stopReason).toBe("end_turn");
      expect(response.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
      const types = events.map((event) => event.type);
      for (const expected of [
        "message_chunk",
        "thought_chunk",
        "tool_call",
        "tool_call_update",
        "plan",
        "usage",
        "session_title",
        "available_commands",
        "stopped",
      ]) {
        expect(types).toContain(expected);
      }
      expect(events).toContainEqual({ type: "message_chunk", text: "hello" });
      expect(events).toContainEqual({ type: "session_title", title: "Mock Title" });
      const stopped = events.find((event) => event.type === "stopped");
      if (stopped?.type === "stopped") expect(stopped.reason).toBe("end_turn");
      const second = await runtime.prompt("again");
      expect(second.stopReason).toBe("end_turn");
      expect(runtime.acpSessionId).toBe("mock-session");
      await waitFor(() => runtime.stderrTail().includes("mock-agent stderr ready"), 2_000);
    } finally {
      await runtime.stop();
      await cleanupTempDir(cwd);
    }
  });

  it("restarts after an unexpected death and serves the next prompt", async () => {
    const cwd = await createTempDir();
    const runtime = await startMockRuntime(cwd, "die");
    try {
      const events = collectEvents(runtime);
      const first = await runtime.prompt("first");
      expect(first.stopReason).toBe("end_turn");
      await waitFor(() => runtime.state === "failed", 3_000);
      expect(events.some((event) => event.type === "process_exit")).toBe(true);
      const second = await runtime.prompt("second");
      expect(second.stopReason).toBe("end_turn");
    } finally {
      await runtime.stop();
      await cleanupTempDir(cwd);
    }
  });

  it("rejects an in-flight prompt when the agent dies mid-turn, then restarts", async () => {
    const cwd = await createTempDir();
    const runtime = await startMockRuntime(cwd, "die-mid");
    try {
      await expect(runtime.prompt("x")).rejects.toMatchObject({ code: "ACP_AGENT_DIED" });
      await waitFor(() => runtime.state === "failed", 3_000);
      await runtime.restart();
      expect(runtime.state).toBe("ready");
    } finally {
      await runtime.stop();
      await cleanupTempDir(cwd);
    }
  });

  it("fails the handshake when the process dies before session/new commits", async () => {
    const cwd = await createTempDir();
    const runtime = await startMockRuntime(cwd, "slow-new");
    try {
      const internals = runtime as unknown as {
        generation: number;
        handleExit: (
          code: number | null,
          signal: NodeJS.Signals | null,
          generation: number,
        ) => void;
      };
      internals.handleExit(7, null, internals.generation);
      expect(runtime.state).toBe("failed");
      const restarting = runtime.restart();
      // restart() first finishes cleaning generation 1, then spawns generation
      // 2, whose slow session/new response stays in flight for 150ms. The
      // child "dies" before that response can commit the handshake — the
      // handshake must reject instead of resurrecting the dead generation.
      await waitFor(() => internals.generation === 2, 5_000);
      internals.handleExit(0, null, 2);
      await expect(restarting).rejects.toMatchObject({ code: "ACP_AGENT_DIED" });
      expect(runtime.state).toBe("failed");
    } finally {
      await runtime.stop();
      await cleanupTempDir(cwd);
    }
  });

  it("answers orphaned and foreign permission asks as cancelled without reaching the host", async () => {
    const cwd = await createTempDir();
    const asks: AcpPermissionAsk[] = [];
    const runtime = await startMockRuntime(cwd, "normal", {
      requestPermission: (ask) => {
        asks.push(ask);
        return new Promise(() => {});
      },
    });
    try {
      const sessionId = runtime.acpSessionId ?? "mock-session";
      const internals = runtime as unknown as {
        generation: number;
        handlePermissionRequest: (
          request: RequestPermissionRequest,
          generation: number,
        ) => Promise<RequestPermissionResponse>;
      };
      const mkAsk = (sid: string): RequestPermissionRequest => ({
        sessionId: sid,
        toolCall: {
          toolCallId: "tc-gate",
          title: "Gate check",
          kind: "execute",
          status: "pending",
          content: [],
        },
        options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
      });
      // Current generation but no live turn (state "ready"): the ask must
      // be answered cancelled without surfacing it to the host bridge.
      const outOfTurn = await internals.handlePermissionRequest(
        mkAsk(sessionId),
        internals.generation,
      );
      expect(outOfTurn.outcome.outcome).toBe("cancelled");
      // Foreign session id: cancelled regardless of turn state.
      const foreign = await internals.handlePermissionRequest(
        mkAsk("other-session"),
        internals.generation,
      );
      expect(foreign.outcome.outcome).toBe("cancelled");
      expect(asks).toHaveLength(0);
    } finally {
      await runtime.stop();
      await cleanupTempDir(cwd);
    }
  });

  it("keeps one active prompt per session", async () => {
    const cwd = await createTempDir();
    const runtime = await startMockRuntime(cwd, "cancel");
    try {
      const inFlight = runtime.prompt("slow task");
      await waitFor(() => runtime.state === "prompting", 3_000);
      await expect(runtime.prompt("second")).rejects.toMatchObject({ code: "ACP_STATE" });
      await runtime.cancel();
      const response = await inFlight;
      expect(response.stopReason).toBe("cancelled");
    } finally {
      await runtime.stop();
      await cleanupTempDir(cwd);
    }
  });

  it("filters foreign-session updates and counts ignored ones", async () => {
    const cwd = await createTempDir();
    const runtime = await startMockRuntime(cwd, "noise");
    try {
      const events = collectEvents(runtime);
      const response = await runtime.prompt("noise");
      expect(response.stopReason).toBe("end_turn");
      expect(events).toContainEqual({ type: "message_chunk", text: "own" });
      const foreign = events.some(
        (event) => event.type === "message_chunk" && event.text === "foreign",
      );
      expect(foreign).toBe(false);
      expect(runtime.ignoredUpdates).toBe(2);
    } finally {
      await runtime.stop();
      await cleanupTempDir(cwd);
    }
  });

  it("stop is idempotent and terminal", async () => {
    const cwd = await createTempDir();
    const runtime = await startMockRuntime(cwd, "normal");
    try {
      await runtime.cancel(); // no active prompt: no-op
      await runtime.restart(); // not failed: no-op
      expect(runtime.state).toBe("ready");
      await runtime.stop();
      await runtime.stop();
      expect(runtime.state).toBe("stopped");
      await expect(runtime.prompt("after stop")).rejects.toMatchObject({ code: "ACP_STATE" });
    } finally {
      await cleanupTempDir(cwd);
    }
  });
});
