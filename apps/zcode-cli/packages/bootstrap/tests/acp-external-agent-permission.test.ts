import { describe, expect, it, vi } from "vitest";
import type { AcpHostBridge, AcpPermissionAsk, AcpRuntimeState } from "@zcode/acp-agent-runtime";
import type { ExternalAgentPermissionAnswer, ExternalAgentTurnRequest } from "@zcode/contracts";
import { createAcpExternalAgentHost } from "../src/acp-agent/acp-external-agent-host.js";
import { AcpSessionPool, type AcpPoolRuntime } from "../src/acp-agent/acp-session-pool.js";

const ASK: AcpPermissionAsk = {
  requestId: "req-1",
  sessionId: "acp-session",
  toolCallId: "tc-1",
  title: "Run the tests",
  detail: "pnpm test",
  options: [
    { optionId: "a", kind: "allow_once", name: "Allow once" },
    { optionId: "b", kind: "allow_always", name: "Always allow" },
    { optionId: "c", kind: "reject_once", name: "Reject" },
  ],
  raw: null,
};

/** A runtime whose prompt stays open until the test finishes it. */
function promptingRuntime() {
  let state: AcpRuntimeState = "ready";
  let finish: (() => void) | undefined;
  const runtime: AcpPoolRuntime = {
    get state() {
      return state;
    },
    restart: vi.fn(async () => undefined),
    stop: vi.fn(async () => {
      state = "stopped";
    }),
    cancel: vi.fn(async () => undefined),
    prompt: vi.fn(
      () =>
        new Promise((resolve) => {
          state = "prompting";
          finish = () => {
            state = "ready";
            resolve({ stopReason: "end_turn" });
          };
        }),
    ),
    on: () => runtime,
    off: () => runtime,
  };
  return { runtime, finish: () => finish?.() };
}

function harness() {
  let bridge: AcpHostBridge | undefined;
  const { runtime, finish } = promptingRuntime();
  const pool = new AcpSessionPool({
    createRuntime: async (_options, hostBridge) => {
      bridge = hostBridge;
      return runtime;
    },
  });
  const host = createAcpExternalAgentHost({
    records: {
      read: async () => ({
        agents: [{ agentId: "opencode", enabled: true, command: "/bin/opencode", args: ["acp"] }],
      }),
    },
    pool,
  });
  /** Starts a turn and waits until its prompt is running, the only time the agent may ask. */
  async function startTurn(answer: ExternalAgentPermissionAnswer) {
    const requestPermission = vi.fn(async () => answer);
    const request = {
      sessionId: "zcode-session",
      workingDirectory: "/work",
      prompt: [{ type: "text", text: "run" }],
      signal: new AbortController().signal,
      onEvent: () => undefined,
      requestPermission,
    } as ExternalAgentTurnRequest;
    const turn = host.driverFor("opencode").runTurn(request);
    await vi.waitFor(() => expect(runtime.prompt).toHaveBeenCalled());
    return { turn, requestPermission };
  }
  return {
    startTurn,
    finish,
    ask: (): Promise<unknown> => {
      if (bridge === undefined) throw new Error("the runtime was not created");
      return Promise.resolve(bridge.requestPermission!(ASK));
    },
  };
}

describe("ACP external agent permission asks", () => {
  it("answers allow as allow_once and forwards the ask's title, detail and offered kinds", async () => {
    const h = harness();
    const { turn, requestPermission } = await h.startTurn("allow");
    await expect(h.ask()).resolves.toEqual({ outcome: "selected", kind: "allow_once" });
    expect(requestPermission).toHaveBeenCalledWith({
      toolCallId: "tc-1",
      title: "Run the tests",
      detail: "pnpm test",
      optionKinds: ["allow_once", "allow_always", "reject_once"],
    });
    h.finish();
    await turn;
  });

  it("answers deny as reject_once", async () => {
    const h = harness();
    const { turn } = await h.startTurn("deny");
    await expect(h.ask()).resolves.toEqual({ outcome: "selected", kind: "reject_once" });
    h.finish();
    await turn;
  });

  it("answers cancelled when the turn cancels the ask", async () => {
    const h = harness();
    const { turn } = await h.startTurn("cancelled");
    await expect(h.ask()).resolves.toEqual({ outcome: "cancelled" });
    h.finish();
    await turn;
  });

  it("answers cancelled, without asking any turn, when no turn is bound to the session", async () => {
    const h = harness();
    const { turn, requestPermission } = await h.startTurn("allow");
    h.finish();
    await turn;
    await expect(h.ask()).resolves.toEqual({ outcome: "cancelled" });
    expect(requestPermission).not.toHaveBeenCalled();
  });
});
