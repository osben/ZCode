import { describe, expect, it, vi } from "vitest";
import type { AcpConfigOption, AcpRuntimeEvent, AcpRuntimeState } from "@zcode/acp-agent-runtime";
import type { ExternalAgentConfigOption, ExternalAgentTurnRequest } from "@zcode/contracts";
import { createAcpExternalAgentHost } from "../src/acp-agent/acp-external-agent-host.js";
import type { AcpSessionConfigStore } from "../src/acp-agent/acp-config-reconcile.js";
import { AcpSessionPool, type AcpPoolRuntime } from "../src/acp-agent/acp-session-pool.js";

// specs/acp-agent-runtime.md "S6": the driver re-applies chosen values before each prompt.

const LAUNCH = { agentId: "opencode", command: "/bin/opencode", args: ["acp"], cwd: "/work/project" };

function modeOption(currentValue: string): AcpConfigOption {
  return {
    id: "mode",
    name: "Mode",
    description: null,
    category: "mode",
    currentValue,
    options: [
      { value: "build", name: "Build", description: null, group: null },
      { value: "plan", name: "Plan", description: null, group: null },
    ],
  };
}

/** Config rows kept in memory; the adapter tests cover the SQLite columns. */
function memoryConfig(initial: {
  offered?: readonly ExternalAgentConfigOption[];
  choices?: Record<string, string>;
}) {
  let offered = initial.offered;
  const choices: Record<string, string> = { ...initial.choices };
  const store: AcpSessionConfigStore & { offeredWrites: (readonly ExternalAgentConfigOption[])[] } = {
    offeredWrites: [],
    readConfig: vi.fn(async () => ({ agentId: "opencode", offered, choices: { ...choices } })),
    writeOffered: vi.fn(async (_sessionId, options) => {
      store.offeredWrites.push(options);
      offered = options;
    }),
    writeChoice: vi.fn(async (_sessionId, _agentId, configId, value) => {
      choices[configId] = value;
    }),
  };
  return store;
}

interface FakeRuntime extends AcpPoolRuntime {
  readonly calls: string[];
  emit(event: AcpRuntimeEvent): void;
  fail(): void;
}

function fakeRuntime(options: { mode: string; failSet?: Error; onPrompt?: () => Promise<void> }) {
  let state: AcpRuntimeState = "ready";
  let configOptions = [modeOption(options.mode)];
  const listeners = new Set<(event: AcpRuntimeEvent) => void>();
  const calls: string[] = [];
  const runtime: FakeRuntime = {
    calls,
    get state() {
      return state;
    },
    get configOptions() {
      return configOptions;
    },
    get handshakeConfigOptions() {
      return [modeOption(options.mode)];
    },
    setConfigOption: vi.fn(async (configId: string, value: string) => {
      calls.push(`set:${configId}=${value}`);
      if (options.failSet) throw options.failSet;
      configOptions = [modeOption(value)];
      return configOptions;
    }),
    acpSessionId: "acp-1",
    // A restarted agent comes back with its own defaults, not with the values set earlier.
    restart: vi.fn(async () => {
      calls.push("restart");
      state = "ready";
      configOptions = [modeOption(options.mode)];
    }),
    fail: () => {
      state = "failed";
    },
    stop: vi.fn(async () => {
      state = "stopped";
    }),
    cancel: vi.fn(async () => undefined),
    prompt: vi.fn(async () => {
      calls.push("prompt");
      await options.onPrompt?.();
      return { stopReason: "end_turn" };
    }),
    on: (_event, listener) => {
      listeners.add(listener);
      return runtime;
    },
    off: (_event, listener) => {
      listeners.delete(listener);
      return runtime;
    },
    emit: (event) => {
      for (const listener of listeners) listener(event);
    },
  };
  return runtime;
}

function hostWith(
  runtime: AcpPoolRuntime,
  config: AcpSessionConfigStore,
  logger?: { debug: ReturnType<typeof vi.fn> },
  catalog?: { write: (agentId: string, options: readonly ExternalAgentConfigOption[]) => Promise<unknown> },
) {
  const pool = new AcpSessionPool({ createRuntime: async () => runtime });
  return createAcpExternalAgentHost({
    records: {
      read: async () => ({
        agents: [{ agentId: "opencode", enabled: true, command: LAUNCH.command, args: ["acp"] }],
      }),
    },
    pool,
    config,
    ...(catalog === undefined ? {} : { catalog }),
    ...(logger === undefined
      ? {}
      : { logger: { debug: logger.debug, info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never }),
  });
}

function turnRequest(seen: unknown[]): ExternalAgentTurnRequest {
  return {
    sessionId: "zcode-1",
    workingDirectory: LAUNCH.cwd,
    prompt: [{ type: "text", text: "go" }],
    signal: new AbortController().signal,
    onEvent: (event) => seen.push(event),
    requestPermission: async () => "cancelled",
  };
}

const OFFERED_BUILD = [
  {
    id: "mode",
    name: "Mode",
    description: null,
    category: "mode",
    currentValue: "build",
    options: [
      { value: "build", name: "Build", description: null, group: null },
      { value: "plan", name: "Plan", description: null, group: null },
    ],
  },
];

describe("ACP config reconcile", () => {
  it("re-applies a stored choice after a cold start, once and before the prompt", async () => {
    const runtime = fakeRuntime({ mode: "build" });
    const config = memoryConfig({ offered: OFFERED_BUILD, choices: { mode: "plan" } });
    const seen: unknown[] = [];

    await hostWith(runtime, config).driverFor("opencode").runTurn(turnRequest(seen));

    expect(runtime.setConfigOption).toHaveBeenCalledTimes(1);
    expect(runtime.setConfigOption).toHaveBeenCalledWith("mode", "plan");
    expect(runtime.calls).toEqual(["set:mode=plan", "prompt"]);
    // The agent's value changed, so the display copy is stored and emitted once.
    expect(config.offeredWrites).toHaveLength(1);
    expect(config.offeredWrites[0]?.[0]?.currentValue).toBe("plan");
    expect(seen).toEqual([{ type: "config_options", options: config.offeredWrites[0] }]);
  });

  it("re-applies a stored choice after the runtime restarts", async () => {
    const runtime = fakeRuntime({ mode: "build" });
    const config = memoryConfig({ offered: OFFERED_BUILD, choices: { mode: "plan" } });
    const host = hostWith(runtime, config);

    await host.driverFor("opencode").runTurn(turnRequest([]));
    runtime.fail();
    await host.driverFor("opencode").runTurn(turnRequest([]));

    expect(runtime.calls).toEqual(["set:mode=plan", "prompt", "restart", "set:mode=plan", "prompt"]);
  });

  it("drops a choice the agent does not offer without a request", async () => {
    const runtime = fakeRuntime({ mode: "build" });
    const config = memoryConfig({ offered: OFFERED_BUILD, choices: { mode: "yolo", effort: "high" } });
    const debug = vi.fn();

    await hostWith(runtime, config, { debug }).driverFor("opencode").runTurn(turnRequest([]));

    expect(runtime.setConfigOption).not.toHaveBeenCalled();
    expect(runtime.calls).toEqual(["prompt"]);
    const dropped = debug.mock.calls.filter(([, fields]) => fields?.event === "external_agent.config_dropped");
    expect(dropped.map(([, fields]) => fields.configId).sort()).toEqual(["effort", "mode"]);
    // Only ids are logged, never the chosen values.
    expect(JSON.stringify(dropped)).not.toContain("yolo");
  });

  it("applies a change made during a running turn before the next prompt, not during it", async () => {
    let config: ReturnType<typeof memoryConfig> | undefined;
    const runtime = fakeRuntime({
      mode: "build",
      onPrompt: async () => {
        await config?.writeChoice("zcode-1", "opencode", "mode", "plan");
      },
    });
    config = memoryConfig({ offered: OFFERED_BUILD });
    const host = hostWith(runtime, config);

    await host.driverFor("opencode").runTurn(turnRequest([]));
    expect(runtime.setConfigOption).not.toHaveBeenCalled();

    await host.driverFor("opencode").runTurn(turnRequest([]));
    expect(runtime.calls).toEqual(["prompt", "set:mode=plan", "prompt"]);
  });

  it("fails the turn visibly when the agent rejects a choice", async () => {
    const runtime = fakeRuntime({ mode: "build", failSet: new Error("mode is locked") });
    const config = memoryConfig({ offered: OFFERED_BUILD, choices: { mode: "plan" } });

    await expect(hostWith(runtime, config).driverFor("opencode").runTurn(turnRequest([]))).rejects.toMatchObject({
      name: "ExternalAgentTurnError",
      code: "prompt_failed",
      message: "Could not set Mode to Plan: mode is locked",
    });
    expect(runtime.prompt).not.toHaveBeenCalled();
  });

  it("persists and emits the offered snapshot only when it changes", async () => {
    const runtime = fakeRuntime({ mode: "build" });
    const config = memoryConfig({});
    const host = hostWith(runtime, config);
    const first: unknown[] = [];
    const second: unknown[] = [];

    await host.driverFor("opencode").runTurn(turnRequest(first));
    await host.driverFor("opencode").runTurn(turnRequest(second));

    expect(config.offeredWrites).toEqual([OFFERED_BUILD]);
    expect(first).toEqual([{ type: "config_options", options: OFFERED_BUILD }]);
    expect(second).toEqual([]);
  });

  it("forwards agent-initiated changes, stalls and resumes during the prompt", async () => {
    let runtime: FakeRuntime | undefined;
    runtime = fakeRuntime({
      mode: "build",
      onPrompt: async () => {
        runtime?.emit({ type: "stalled", silentMs: 30_000 });
        runtime?.emit({ type: "resumed" });
        runtime?.emit({ type: "config_options", options: [modeOption("plan")] });
      },
    });
    const config = memoryConfig({ offered: OFFERED_BUILD, choices: { mode: "build" } });
    const seen: unknown[] = [];

    await hostWith(runtime, config).driverFor("opencode").runTurn(turnRequest(seen));

    const planCopy = [{ ...OFFERED_BUILD[0], currentValue: "plan" }];
    expect(seen).toEqual([
      { type: "stalled", silentMs: 30_000 },
      { type: "resumed" },
      { type: "config_options", options: planCopy },
    ]);
    // The display copy follows the agent; the user's choice is not rewritten by the driver.
    expect(config.offeredWrites).toEqual([planCopy]);
    expect(config.writeChoice).not.toHaveBeenCalled();
  });

  // S6 readiness: a choice made before the first turn is pending in the config store, and the first prompt
  // is the first thing the agent sees after it.
  it("applies a choice made before the first turn before the first prompt", async () => {
    const runtime = fakeRuntime({ mode: "build" });
    const config = memoryConfig({ choices: { mode: "plan" } });

    await hostWith(runtime, config).driverFor("opencode").runTurn(turnRequest([]));

    expect(runtime.calls).toEqual(["set:mode=plan", "prompt"]);
  });

  it("stores the offered snapshot in the agent catalog before the prompt", async () => {
    const runtime = fakeRuntime({ mode: "build" });
    const catalog = { write: vi.fn(async () => true) };

    await hostWith(runtime, memoryConfig({}), undefined, catalog)
      .driverFor("opencode")
      .runTurn(turnRequest([]));

    expect(catalog.write).toHaveBeenCalledWith("opencode", OFFERED_BUILD);
    expect(catalog.write.mock.invocationCallOrder[0]).toBeLessThan(
      runtime.prompt.mock.invocationCallOrder[0]!,
    );
  });

  // The catalog is what the agent offers. A choice applied before the prompt belongs to the session, so it must not
  // become the default that the next new draft shows.
  it("writes the catalog from the handshake's values, not from a choice applied before the prompt", async () => {
    const runtime = fakeRuntime({ mode: "build" });
    const config = memoryConfig({ offered: OFFERED_BUILD, choices: { mode: "plan" } });
    const catalog = { write: vi.fn(async () => true) };

    await hostWith(runtime, config, undefined, catalog).driverFor("opencode").runTurn(turnRequest([]));

    expect(runtime.calls).toEqual(["set:mode=plan", "prompt"]);
    expect(catalog.write).toHaveBeenCalledWith("opencode", OFFERED_BUILD);
    expect(catalog.write.mock.calls[0]?.[1]?.[0]?.currentValue).toBe("build");
  });

  it("a failed catalog write never fails the turn", async () => {
    const runtime = fakeRuntime({ mode: "build" });
    const catalog = { write: vi.fn(async () => Promise.reject(new Error("disk full"))) };

    const result = await hostWith(runtime, memoryConfig({}), undefined, catalog)
      .driverFor("opencode")
      .runTurn(turnRequest([]));

    expect(result.stopReason).toBe("end_turn");
  });
});
