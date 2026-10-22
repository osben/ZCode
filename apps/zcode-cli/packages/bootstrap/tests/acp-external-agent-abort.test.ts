import { describe, expect, it, vi } from "vitest";
import { AcpSessionPool } from "../src/acp-agent/acp-session-pool.js";
import { createAcpExternalAgentHost } from "../src/acp-agent/acp-external-agent-host.js";
import type { AcpSessionConfigStore } from "../src/acp-agent/acp-config-reconcile.js";
import type { ExternalAgentTurnRequest } from "@zcode/contracts";

// Stop (abort) must end a turn that is still spawning or reconciling as cancelled, with no session/prompt.
// The runtime of a finished spawn stays resident for the next turn (specs/acp-agent-runtime.md "S6").

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function modeOption(currentValue: string) {
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

/** A runtime double that records every request; `setGate` holds a set_config_option until released. */
function runtimeDouble(setGate?: Promise<void>) {
  let configOptions = [modeOption("build")];
  const calls: string[] = [];
  const runtime = {
    calls,
    get state() {
      return "ready" as const;
    },
    get configOptions() {
      return configOptions;
    },
    acpSessionId: "acp-1",
    setConfigOption: vi.fn(async (configId: string, value: string) => {
      calls.push(`set:${configId}=${value}`);
      await setGate;
      configOptions = [modeOption(value)];
      return configOptions;
    }),
    restart: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    prompt: vi.fn(async () => {
      calls.push("prompt");
      return { stopReason: "end_turn" };
    }),
    on: () => runtime,
    off: () => runtime,
  };
  return runtime;
}

/** A chosen `plan` mode that the agent does not have yet, so the reconcile must send a set request. */
function configStore(choices: Record<string, string>): AcpSessionConfigStore {
  return {
    readConfig: vi.fn(async () => ({
      agentId: "opencode",
      offered: [],
      choices: { ...choices },
    })),
    writeOffered: vi.fn(async () => undefined),
    writeChoice: vi.fn(async () => undefined),
  } as unknown as AcpSessionConfigStore;
}

function setup(options: {
  createRuntime: (...args: never[]) => Promise<unknown>;
  config?: AcpSessionConfigStore;
}) {
  const pool = new AcpSessionPool({ createRuntime: options.createRuntime as never });
  const host = createAcpExternalAgentHost({
    records: {
      read: async () => ({
        agents: [{ agentId: "opencode", enabled: true, command: "/bin/opencode", args: ["acp"] }],
      }),
    },
    pool,
    ...(options.config === undefined ? {} : { config: options.config }),
  });
  const controller = new AbortController();
  const request = {
    sessionId: "zcode-1",
    workingDirectory: "/work/project",
    prompt: [{ type: "text", text: "edit the file" }],
    signal: controller.signal,
    onEvent: () => undefined,
    requestPermission: async () => "cancelled",
  } as ExternalAgentTurnRequest;
  return { pool, driver: host.driverFor("opencode"), controller, request };
}

describe("ACP turn driver honours Stop before the prompt", () => {
  it("control: without Stop the turn prompts and ends normally", async () => {
    const runtime = runtimeDouble();
    const { driver, request } = setup({ createRuntime: async () => runtime as never });
    const result = await driver.runTurn(request);
    expect(result.stopReason).toBe("end_turn");
    expect(runtime.calls).toEqual(["prompt"]);
  });

  it("Stop during the spawn: no prompt, cancelled, and the runtime stays resident", async () => {
    const runtime = runtimeDouble();
    const spawn = deferred<unknown>();
    const spawning = vi.fn(() => spawn.promise);
    const { pool, driver, controller, request } = setup({ createRuntime: spawning as never });
    const turn = driver.runTurn(request);
    await vi.waitFor(() => expect(spawning).toHaveBeenCalled());
    controller.abort();
    spawn.resolve(runtime);
    const result = await turn;
    expect(result.stopReason).toBe("cancelled");
    expect(runtime.calls).toEqual([]);
    expect(runtime.stop).not.toHaveBeenCalled();
    expect(pool.size).toBe(1);
  });

  it("Stop during the reconcile: the value set is awaited, then the turn ends without a prompt", async () => {
    const setGate = deferred<void>();
    const runtime = runtimeDouble(setGate.promise);
    const { driver, controller, request } = setup({
      createRuntime: async () => runtime as never,
      config: configStore({ mode: "plan" }),
    });
    const turn = driver.runTurn(request);
    await vi.waitFor(() => expect(runtime.setConfigOption).toHaveBeenCalled());
    controller.abort();
    setGate.resolve();
    const result = await turn;
    expect(result.stopReason).toBe("cancelled");
    expect(runtime.calls).toEqual(["set:mode=plan"]);
    expect(runtime.calls).not.toContain("prompt");
  });

  it("Stop exactly before the prompt (after the permission bind): no session/prompt", async () => {
    const runtime = runtimeDouble();
    const { pool, driver, controller, request } = setup({ createRuntime: async () => runtime as never });
    const bind = pool.bindTurnPermission.bind(pool);
    vi.spyOn(pool, "bindTurnPermission").mockImplementation((sessionId, handler) => {
      controller.abort();
      return bind(sessionId, handler);
    });
    const result = await driver.runTurn(request);
    expect(result.stopReason).toBe("cancelled");
    expect(runtime.calls).toEqual([]);
  });

  it("Stop before the turn reaches the pool: the agent is not spawned", async () => {
    const runtime = runtimeDouble();
    const spawning = vi.fn(async () => runtime);
    const { driver, controller, request } = setup({ createRuntime: spawning as never });
    controller.abort();
    const result = await driver.runTurn(request);
    expect(result.stopReason).toBe("cancelled");
    expect(spawning).not.toHaveBeenCalled();
  });
});
