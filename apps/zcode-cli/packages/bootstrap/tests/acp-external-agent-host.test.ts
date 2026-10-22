import { describe, expect, it, vi } from "vitest";
import { AcpAgentDiedError, type AcpRuntimeEvent, type AcpRuntimeState } from "@zcode/acp-agent-runtime";
import { ExternalAgentTurnError, type ExternalAgentTurnRequest } from "@zcode/contracts";
import {
  createAcpExternalAgentHost,
  type AcpAgentRecordSource,
} from "../src/acp-agent/acp-external-agent-host.js";
import { AcpSessionPool, type AcpPoolRuntime } from "../src/acp-agent/acp-session-pool.js";

type Listener = (event: AcpRuntimeEvent) => void;

/** A runtime whose prompt is driven by the test; `emit` plays session/update notifications. */
function scriptedRuntime(script: {
  prompt: (text: string, blocks?: unknown) => Promise<{ stopReason: string; usage?: unknown }>;
  cancel?: () => Promise<void>;
}) {
  const listeners = new Set<Listener>();
  let state: AcpRuntimeState = "ready";
  const runtime: AcpPoolRuntime & { emit(event: AcpRuntimeEvent): void; cancelled: number } = {
    get state() {
      return state;
    },
    cancelled: 0,
    emit(event) {
      for (const listener of listeners) listener(event);
    },
    restart: vi.fn(async () => undefined),
    stop: vi.fn(async () => {
      state = "stopped";
    }),
    cancel: vi.fn(async () => {
      runtime.cancelled += 1;
      await script.cancel?.();
    }),
    prompt: vi.fn(script.prompt),
    on(_event, listener) {
      listeners.add(listener);
      return runtime;
    },
    off(_event, listener) {
      listeners.delete(listener);
      return runtime;
    },
  };
  return runtime;
}

interface TestRecord {
  readonly agentId: string;
  readonly enabled: boolean;
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

function records(initial: readonly TestRecord[]) {
  let agents = initial;
  const source: AcpAgentRecordSource = {
    read: async () => ({ agents }),
  };
  return {
    source,
    set(next: readonly TestRecord[]) {
      agents = next;
    },
  };
}

function enabledOpencode(command = "/usr/local/bin/opencode") {
  return [{ agentId: "opencode", enabled: true, command, args: ["acp"] }];
}

function request(
  overrides: Partial<ExternalAgentTurnRequest> & { sessionId?: string } = {},
): ExternalAgentTurnRequest & { events: { type: string; text: string }[] } {
  const events: { type: string; text: string }[] = [];
  return {
    sessionId: overrides.sessionId ?? "session-a",
    workingDirectory: "/work/project",
    prompt: [
      { type: "text", text: "describe the image" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    ],
    signal: new AbortController().signal,
    onEvent: (event) => {
      events.push(event);
    },
    events,
    ...overrides,
  } as ExternalAgentTurnRequest & { events: { type: string; text: string }[] };
}

function hostWith(
  runtime: ReturnType<typeof scriptedRuntime>,
  recordSource: AcpAgentRecordSource,
  launches: { command: string }[] = [],
) {
  const pool = new AcpSessionPool({
    createRuntime: async (options) => {
      launches.push({ command: options.command });
      return runtime;
    },
  });
  return { host: createAcpExternalAgentHost({ records: recordSource, pool }), pool };
}

describe("ACP external agent turn driver", () => {
  it("maps streamed chunks, prompt blocks and usage onto the turn contract", async () => {
    let finish!: () => void;
    const runtime = scriptedRuntime({
      prompt: () =>
        new Promise((resolve) => {
          finish = () =>
            resolve({
              stopReason: "end_turn",
              usage: { inputTokens: 7, outputTokens: 3, thoughtTokens: 1, unknown: "x" },
            });
        }),
    });
    const { source } = records(enabledOpencode());
    const { host } = hostWith(runtime, source);
    const turn = request();

    const driver = host.driverFor("opencode");
    const pending = driver.runTurn(turn);
    // The driver attaches its event listener only after the record read and the pool acquire.
    await vi.waitFor(() => expect(runtime.prompt).toHaveBeenCalled());
    runtime.emit({ type: "thought_chunk", text: "plan" });
    runtime.emit({ type: "message_chunk", text: "pong" });
    finish();
    const result = await pending;

    expect(turn.events).toEqual([
      { type: "reasoning_delta", text: "plan" },
      { type: "message_delta", text: "pong" },
    ]);
    expect(result).toEqual({
      agentId: "opencode",
      stopReason: "end_turn",
      usage: { inputTokens: 7, outputTokens: 3, reasoningTokens: 1 },
    });
    const sent = (runtime.prompt as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(sent[1]).toEqual([
      { type: "text", text: "describe the image" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    ]);
  });

  it("re-reads the sidecar record every turn, so a changed launch config is used", async () => {
    const runtime = scriptedRuntime({ prompt: async () => ({ stopReason: "end_turn" }) });
    const recordSource = records(enabledOpencode("/old/opencode"));
    const launches: { command: string }[] = [];
    const { host } = hostWith(runtime, recordSource.source, launches);
    const driver = host.driverFor("opencode");

    await driver.runTurn(request());
    recordSource.set(enabledOpencode("/new/opencode"));
    await driver.runTurn(request());

    expect(launches.map((launch) => launch.command)).toEqual(["/old/opencode", "/new/opencode"]);
  });

  it("refuses a missing or disabled record with an actionable message and never spawns", async () => {
    const runtime = scriptedRuntime({ prompt: async () => ({ stopReason: "end_turn" }) });
    const recordSource = records([]);
    const launches: { command: string }[] = [];
    const { host } = hostWith(runtime, recordSource.source, launches);
    const driver = host.driverFor("opencode");

    await expect(driver.runTurn(request())).rejects.toMatchObject({
      code: "agent_unavailable",
      message: expect.stringContaining("no longer configured"),
    });
    recordSource.set([{ ...enabledOpencode()[0]!, enabled: false }]);
    await expect(driver.runTurn(request())).rejects.toMatchObject({
      code: "agent_unavailable",
      message: expect.stringContaining("turned off"),
    });
    expect(launches).toEqual([]);
  });

  it("cancels the agent when the turn signal aborts and reports the cancelled stop reason", async () => {
    let settle!: (value: { stopReason: string }) => void;
    const runtime = scriptedRuntime({
      prompt: () =>
        new Promise<{ stopReason: string }>((resolve) => {
          settle = resolve;
        }),
      cancel: async () => settle({ stopReason: "cancelled" }),
    });
    const { source } = records(enabledOpencode());
    const { host } = hostWith(runtime, source);
    const controller = new AbortController();
    const turn = request({ signal: controller.signal });

    const pending = host.driverFor("opencode").runTurn(turn);
    await vi.waitFor(() => expect(runtime.prompt).toHaveBeenCalled());
    controller.abort();

    await expect(pending).resolves.toMatchObject({ stopReason: "cancelled" });
    expect(runtime.cancelled).toBe(1);
  });

  it("explains how to sign in when the agent reports an auth failure", async () => {
    const runtime = scriptedRuntime({
      prompt: async () => {
        throw new Error("Authentication required: run login");
      },
    });
    const { source } = records(enabledOpencode());
    const { host } = hostWith(runtime, source);

    await expect(host.driverFor("opencode").runTurn(request())).rejects.toMatchObject({
      code: "auth_required",
      message: expect.stringContaining('"opencode auth login"'),
    });
  });

  it("reports a process death during the turn as process_exited", async () => {
    const runtime = scriptedRuntime({
      prompt: async () => {
        throw new AcpAgentDiedError("Agent process exited (code=1, signal=null)");
      },
    });
    const { source } = records(enabledOpencode());
    const { host } = hostWith(runtime, source);

    await expect(host.driverFor("opencode").runTurn(request())).rejects.toBeInstanceOf(
      ExternalAgentTurnError,
    );
    await expect(host.driverFor("opencode").runTurn(request())).rejects.toMatchObject({
      code: "process_exited",
    });
  });

  it("releases the session's agent process through the host", async () => {
    const runtime = scriptedRuntime({ prompt: async () => ({ stopReason: "end_turn" }) });
    const { source } = records(enabledOpencode());
    const { host } = hostWith(runtime, source);
    await host.driverFor("opencode").runTurn(request());

    await host.stopSession("session-a");

    expect(runtime.stop).toHaveBeenCalledTimes(1);
  });
});
