import type { ClientConnection } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import {
  cleanupTempDir,
  collectEvents,
  createTempDir,
  startMockRuntime,
  waitFor,
} from "./helpers.js";
import {
  AcpRuntimeError,
  type AcpConfigOption,
  type AcpFrameObserver,
  type AcpRuntimeEvent,
} from "../src/index.js";
import { AcpConfigState } from "../src/runtime-config.js";

// Contract: specs/acp-agent-runtime.md "S6: agent configuration options".

interface SentRequest {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

/** Records the outbound requests the runtime sent, in wire order. */
function recordSent() {
  const requests: SentRequest[] = [];
  const onFrame: AcpFrameObserver = (frame) => {
    if (frame.direction !== "outbound") return;
    try {
      const message = JSON.parse(frame.text) as { method?: unknown; params?: unknown };
      if (typeof message.method === "string") {
        requests.push({
          method: message.method,
          params: (message.params ?? {}) as Record<string, unknown>,
        });
      }
    } catch {
      // Non-JSON lines are not requests.
    }
  };
  const configRequests = () =>
    requests.filter(
      (request) =>
        request.method === "session/set_config_option" || request.method === "session/set_mode",
    );
  return { requests, onFrame, configRequests };
}

const OPTIONS_SNAPSHOT: readonly AcpConfigOption[] = [
  {
    id: "mode",
    name: "Mode",
    description: null,
    category: "mode",
    currentValue: "agent",
    options: [
      { value: "agent", name: "Agent", description: "Edits files", group: null },
      { value: "plan", name: "Plan", description: null, group: null },
      { value: "ask", name: "Ask", description: null, group: null },
    ],
  },
  {
    id: "model",
    name: "Model",
    description: null,
    category: "model",
    currentValue: "m1",
    options: [
      { value: "m1", name: "Model 1", description: null, group: "Fast" },
      { value: "m2", name: "Model 2", description: null, group: "Smart" },
    ],
  },
];

const LEGACY_SNAPSHOT: readonly AcpConfigOption[] = [
  {
    id: "mode",
    name: "Mode",
    description: null,
    category: "mode",
    currentValue: "build",
    options: [
      { value: "build", name: "Build", description: "Default agent", group: null },
      { value: "plan", name: "Plan", description: null, group: null },
    ],
  },
];

function withCurrent(
  snapshot: readonly AcpConfigOption[],
  id: string,
  currentValue: string,
): AcpConfigOption[] {
  return snapshot.map((option) => (option.id === id ? { ...option, currentValue } : option));
}

const configEvents = (events: readonly AcpRuntimeEvent[]) =>
  events.filter((event) => event.type === "config_options");

async function withRuntime(
  scenario: string,
  config: "options" | "legacy" | null,
  body: (
    runtime: Awaited<ReturnType<typeof startMockRuntime>>,
    sent: ReturnType<typeof recordSent>,
  ) => Promise<void>,
  overrides: Parameters<typeof startMockRuntime>[3] = {},
): Promise<void> {
  const cwd = await createTempDir();
  const sent = recordSent();
  const runtime = await startMockRuntime(
    cwd,
    scenario,
    {},
    {
      ...overrides,
      onFrame: sent.onFrame,
      env: config === null ? {} : { ACP_MOCK_CONFIG: config },
    },
  );
  try {
    await body(runtime, sent);
  } finally {
    await runtime.stop();
    await cleanupTempDir(cwd);
  }
}

describe("agent configuration options", () => {
  it("normalizes configOptions from session/new, flattening groups and dropping booleans", async () => {
    await withRuntime("config", "options", async (runtime) => {
      expect(runtime.configOptions).toEqual(OPTIONS_SNAPSHOT);
    });
  });

  it("normalizes configOptions from session/load", async () => {
    await withRuntime(
      "load-config",
      "options",
      async (runtime, sent) => {
        expect(runtime.takeSessionStart()).toBe("loaded");
        expect(sent.requests.map((request) => request.method)).not.toContain("session/new");
        // The current_mode_update replayed during the load is not applied.
        expect(runtime.configOptions).toEqual(OPTIONS_SNAPSHOT);
      },
      { resumeSessionId: "mock-session" },
    );
  });

  it("synthesizes a mode option from legacy modes only when configOptions is absent", async () => {
    await withRuntime("config", "legacy", async (runtime) => {
      expect(runtime.configOptions).toEqual(LEGACY_SNAPSHOT);
    });
  });

  it("offers no options when the agent advertises neither", async () => {
    await withRuntime("config", null, async (runtime) => {
      expect(runtime.configOptions).toEqual([]);
    });
  });

  it("sets a config option with session/set_config_option and returns the new snapshot", async () => {
    await withRuntime("config", "options", async (runtime, sent) => {
      const events = collectEvents(runtime);
      const snapshot = await runtime.setConfigOption("mode", "plan");
      const expected = withCurrent(OPTIONS_SNAPSHOT, "mode", "plan");
      expect(snapshot).toEqual(expected);
      expect(runtime.configOptions).toEqual(expected);
      expect(sent.configRequests()).toEqual([
        {
          method: "session/set_config_option",
          params: { sessionId: "mock-session", configId: "mode", value: "plan" },
        },
      ]);
      // The direct response is returned, not emitted.
      expect(configEvents(events)).toEqual([]);
    });
  });

  it("sets a synthesized legacy mode with session/set_mode", async () => {
    await withRuntime("config", "legacy", async (runtime, sent) => {
      const snapshot = await runtime.setConfigOption("mode", "plan");
      expect(snapshot).toEqual(withCurrent(LEGACY_SNAPSHOT, "mode", "plan"));
      expect(sent.configRequests()).toEqual([
        { method: "session/set_mode", params: { sessionId: "mock-session", modeId: "plan" } },
      ]);
    });
  });

  it("rejects an unknown id or a value outside the options before any request", async () => {
    await withRuntime("config", "options", async (runtime, sent) => {
      await expect(runtime.setConfigOption("missing", "plan")).rejects.toMatchObject({
        code: "ACP_INVALID_CONFIG",
      });
      await expect(runtime.setConfigOption("mode", "nope")).rejects.toBeInstanceOf(AcpRuntimeError);
      // A dropped boolean option is not offered, so it cannot be set either.
      await expect(runtime.setConfigOption("auto", "true")).rejects.toMatchObject({
        code: "ACP_INVALID_CONFIG",
      });
      expect(sent.configRequests()).toEqual([]);
      expect(runtime.configOptions).toEqual(OPTIONS_SNAPSHOT);
    });
  });

  it("requires the ready state", async () => {
    await withRuntime("config", "options", async (runtime, sent) => {
      await runtime.stop();
      await expect(runtime.setConfigOption("mode", "plan")).rejects.toMatchObject({
        code: "ACP_STATE",
      });
      expect(sent.configRequests()).toEqual([]);
    });
  });

  it("applies config_option_update and current_mode_update and emits the snapshot", async () => {
    await withRuntime("config", "options", async (runtime) => {
      const events = collectEvents(runtime);
      await runtime.prompt("foreign config-update mode-update");
      const afterConfig = withCurrent(OPTIONS_SNAPSHOT, "model", "m2");
      const afterMode = withCurrent(afterConfig, "mode", "plan");
      expect(configEvents(events)).toEqual([
        { type: "config_options", options: afterConfig },
        { type: "config_options", options: afterMode },
      ]);
      expect(runtime.configOptions).toEqual(afterMode);
      // The update of another session is counted, not applied.
      expect(runtime.ignoredUpdates).toBe(1);
    });
  });

  it("applies current_mode_update to a synthesized legacy mode", async () => {
    await withRuntime("config", "legacy", async (runtime) => {
      const events = collectEvents(runtime);
      await runtime.prompt("mode-update");
      const expected = withCurrent(LEGACY_SNAPSHOT, "mode", "plan");
      expect(configEvents(events)).toEqual([{ type: "config_options", options: expected }]);
      expect(runtime.configOptions).toEqual(expected);
    });
  });

  it("ignores current_mode_update without a mode option", async () => {
    await withRuntime("config", null, async (runtime) => {
      const events = collectEvents(runtime);
      await runtime.prompt("mode-update");
      expect(configEvents(events)).toEqual([]);
      expect(runtime.configOptions).toEqual([]);
    });
  });
});

describe("stall resume", () => {
  it("emits resumed once on the first inbound frame after stalled", async () => {
    await withRuntime(
      "stall-resume",
      null,
      async (runtime) => {
        const events = collectEvents(runtime);
        await runtime.prompt("wait");
        const types = events.map((event) => event.type);
        expect(types).toEqual(["stalled", "resumed", "message_chunk", "message_chunk", "stopped"]);
      },
      { timeouts: { stallWarningMs: 150 } },
    );
  });

  it("does not emit resumed without a stall", async () => {
    await withRuntime(
      "config",
      null,
      async (runtime) => {
        const events = collectEvents(runtime);
        await runtime.prompt("plain");
        await waitFor(() => events.some((event) => event.type === "stopped"), 2_000);
        expect(events.some((event) => event.type === "resumed")).toBe(false);
      },
      { timeouts: { stallWarningMs: 5_000 } },
    );
  });
});

describe("AcpConfigState", () => {
  /** A connection double that records requests and answers set_config_option with `configOptions`. */
  function fakeChange(state: AcpConfigState, configId: string, value: string) {
    const sent: string[] = [];
    const connection = {
      agent: {
        request: (method: string) => {
          sent.push(method);
          return Promise.resolve({ configOptions: undefined });
        },
      },
    } as unknown as ClientConnection;
    const result = state.set({
      connection,
      sessionId: "s",
      configId,
      value,
      timeoutMs: 1_000,
      race: (operation) => operation,
      isCurrent: () => true,
    });
    return { sent, result };
  }

  it("prefers configOptions over legacy modes and sets mode with session/set_config_option", async () => {
    const state = new AcpConfigState();
    state.reset({
      configOptions: [
        {
          id: "mode",
          name: "Mode",
          category: "mode",
          type: "select",
          currentValue: "agent",
          options: [
            { value: "agent", name: "Agent" },
            { value: "plan", name: "Plan" },
          ],
        },
      ],
      modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] },
    });
    expect(state.options.map((option) => option.currentValue)).toEqual(["agent"]);
    const { sent, result } = fakeChange(state, "mode", "plan");
    expect(await result).toEqual([expect.objectContaining({ id: "mode", currentValue: "plan" })]);
    expect(sent).toEqual(["session/set_config_option"]);
  });

  it("falls back to legacy modes when configOptions holds only booleans", () => {
    const state = new AcpConfigState();
    state.reset({
      configOptions: [{ id: "auto", name: "Auto", type: "boolean", currentValue: true }],
      modes: { currentModeId: "build", availableModes: [{ id: "build", name: "Build" }] },
    });
    expect(state.options).toEqual([
      {
        id: "mode",
        name: "Mode",
        description: null,
        category: "mode",
        currentValue: "build",
        options: [{ value: "build", name: "Build", description: null, group: null }],
      },
    ]);
  });

  it("rejects a response that arrives after the session changed", async () => {
    const state = new AcpConfigState();
    state.reset({
      modes: { currentModeId: "build", availableModes: [{ id: "plan", name: "Plan" }] },
    });
    const connection = {
      agent: { request: () => Promise.resolve({}) },
    } as unknown as ClientConnection;
    await expect(
      state.set({
        connection,
        sessionId: "s",
        configId: "mode",
        value: "plan",
        timeoutMs: 1_000,
        race: (operation) => operation,
        isCurrent: () => false,
      }),
    ).rejects.toMatchObject({ code: "ACP_STATE" });
    expect(state.options[0]?.currentValue).toBe("build");
  });
});
