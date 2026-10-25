// specs/acp-agent-runtime.md "S6": setExternalAgentConfigOption stores the user's choice, updates the
// display copy and appends external_agent_config_updated; it never reaches the agent process.
import { describe, expect, it, vi } from "vitest";
import {
  SessionEventType,
  type ExternalAgentConfigOption,
  type SessionEvent,
} from "@zcode/contracts";
import { parseCommandEnvelope, type CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import { V4CommandExecutor } from "../src/zcode-protocol-v4/commands/executor.js";
import { V4CommandNoopError } from "../src/zcode-protocol-v4/index.js";
import type { V4ExternalAgentConfigStore } from "../src/zcode-protocol-v4/commands/external-agent-config-store.js";
import type {
  V4CommandCoreHost,
  V4SessionRecordView,
} from "../src/zcode-protocol-v4/commands/types.js";

const MODE: ExternalAgentConfigOption = {
  id: "mode",
  name: "Mode",
  description: null,
  category: "mode",
  currentValue: "build",
  options: [
    { value: "build", name: "Build", description: null, group: null },
    { value: "plan", name: "Plan", description: null, group: null },
  ],
};

function makeStore(initial: {
  agentId?: string;
  offered?: readonly ExternalAgentConfigOption[];
  choices?: Record<string, string>;
  /** The agent's catalog (S6 readiness); absent means the agent was never run or tested. */
  catalog?: readonly ExternalAgentConfigOption[];
}) {
  let offered = initial.offered;
  const choices: Record<string, string> = { ...initial.choices };
  const store: V4ExternalAgentConfigStore = {
    readConfig: vi.fn(async () => ({ agentId: initial.agentId, offered, choices: { ...choices } })),
    readCatalog: vi.fn(async () => initial.catalog),
    // Like the real store: the offered copy exists only for a binding (an offered snapshot); pending sessions have none.
    writeOffered: vi.fn(async (_sessionId, options) => {
      if (offered !== undefined) offered = options;
    }),
    writeChoice: vi.fn(async (_sessionId, _agentId, configId, value) => {
      choices[configId] = value;
    }),
  };
  return { store, read: () => ({ offered, choices }) };
}

function makeHost(store: V4ExternalAgentConfigStore, providerId = "acp:opencode") {
  const appended: SessionEvent[] = [];
  const record = {
    app: {
      runtime: {
        getSessionModelSelection: () => ({ providerId, modelId: "opencode" }),
        appendEvent: vi.fn(async (event: SessionEvent) => {
          appended.push(event);
        }),
      },
    },
    workspace: { workspacePath: "/w" },
    persistence: "immediate",
    traceContext: { traceId: "trace-1", sessionId: "s1" },
  } as unknown as V4SessionRecordView;
  const host: V4CommandCoreHost = {
    getRecord: (id) => (id === "s1" ? record : undefined),
    externalAgentConfig: store,
  };
  return { host, appended };
}

function command(payload: { sessionId?: string; configId: string; value: string }): CommandEnvelope {
  const parsed = parseCommandEnvelope({
    commandId: "cmd-agent-config",
    clientId: "test",
    sessionId: "s1",
    type: "setExternalAgentConfigOption",
    payload: { sessionId: "s1", ...payload },
    issuedAt: 1,
  });
  if (!parsed.ok) throw parsed.error;
  return parsed.envelope;
}

describe("v4 setExternalAgentConfigOption", () => {
  it("refuses before the first turn when the agent has no catalog, with config.notAvailable", async () => {
    const { store } = makeStore({ agentId: "opencode" });
    const { host, appended } = makeHost(store);

    await expect(
      new V4CommandExecutor(host).execute(command({ configId: "mode", value: "plan" })),
    ).rejects.toMatchObject({ reasonCode: "config.notAvailable" });
    expect(store.writeChoice).not.toHaveBeenCalled();
    expect(appended).toEqual([]);
  });

  // S6 readiness: the catalog offers the options before the first turn; the choice is pending, and the event
  // carries the catalog with the chosen value.
  it("accepts a choice before the first turn when the catalog offers it, and appends the catalog", async () => {
    const { store, read } = makeStore({ agentId: "opencode", catalog: [MODE] });
    const { host, appended } = makeHost(store);

    await new V4CommandExecutor(host).execute(command({ configId: "mode", value: "plan" }));

    expect(store.writeChoice).toHaveBeenCalledWith("s1", "opencode", "mode", "plan");
    expect(read().choices).toEqual({ mode: "plan" });
    const updated = [{ ...MODE, currentValue: "plan" }];
    expect(appended[0]?.payload).toEqual({ agentId: "opencode", options: updated });
  });

  // Pending choices are all shown: the event after a second choice still reflects the first one.
  it("reflects every pre-turn choice made so far in the event, not only the latest", async () => {
    const MODEL: ExternalAgentConfigOption = {
      id: "model",
      name: "Model",
      description: null,
      category: "model",
      currentValue: "fast",
      options: [
        { value: "fast", name: "Fast", description: null, group: null },
        { value: "slow", name: "Slow", description: null, group: null },
      ],
    };
    const { store } = makeStore({ agentId: "opencode", catalog: [MODE, MODEL] });
    const { host, appended } = makeHost(store);
    const executor = new V4CommandExecutor(host);

    await executor.execute(command({ configId: "mode", value: "plan" }));
    await executor.execute(command({ configId: "model", value: "slow" }));

    const options = (appended[1]?.payload as { options: ExternalAgentConfigOption[] }).options;
    expect(options.find((option) => option.id === "mode")?.currentValue).toBe("plan");
    expect(options.find((option) => option.id === "model")?.currentValue).toBe("slow");
  });

  it("refuses a pre-turn choice the catalog does not offer with config.invalid", async () => {
    const { store } = makeStore({ agentId: "opencode", catalog: [MODE] });
    await expect(
      new V4CommandExecutor(makeHost(store).host).execute(command({ configId: "mode", value: "yolo" })),
    ).rejects.toMatchObject({ reasonCode: "config.invalid" });
    expect(store.writeChoice).not.toHaveBeenCalled();
  });

  it("refuses a pre-turn choice when the pending session belongs to another agent", async () => {
    const { store } = makeStore({ agentId: "claude", catalog: [MODE] });
    await expect(
      new V4CommandExecutor(makeHost(store).host).execute(command({ configId: "mode", value: "plan" })),
    ).rejects.toMatchObject({ reasonCode: "config.notAvailable" });
    expect(store.writeChoice).not.toHaveBeenCalled();
  });

  it("refuses an id or value the agent does not offer with config.invalid", async () => {
    const { store } = makeStore({ agentId: "opencode", offered: [MODE] });
    const executor = new V4CommandExecutor(makeHost(store).host);

    await expect(executor.execute(command({ configId: "model", value: "fast" }))).rejects.toMatchObject({
      reasonCode: "config.invalid",
    });
    await expect(executor.execute(command({ configId: "mode", value: "yolo" }))).rejects.toMatchObject({
      reasonCode: "config.invalid",
    });
    expect(store.writeChoice).not.toHaveBeenCalled();
  });

  it("is a no-op for the value that is already chosen", async () => {
    const { store } = makeStore({
      agentId: "opencode",
      offered: [{ ...MODE, currentValue: "plan" }],
      choices: { mode: "plan" },
    });
    const { host, appended } = makeHost(store);

    await expect(
      new V4CommandExecutor(host).execute(command({ configId: "mode", value: "plan" })),
    ).rejects.toThrow(V4CommandNoopError);
    expect(store.writeChoice).not.toHaveBeenCalled();
    expect(appended).toEqual([]);
  });

  it("stores the choice, updates the display copy and appends one config event", async () => {
    const { store, read } = makeStore({ agentId: "opencode", offered: [MODE] });
    const { host, appended } = makeHost(store);

    await new V4CommandExecutor(host).execute(command({ configId: "mode", value: "plan" }));

    const updated = [{ ...MODE, currentValue: "plan" }];
    expect(read()).toEqual({ offered: updated, choices: { mode: "plan" } });
    expect(appended).toHaveLength(1);
    expect(appended[0]?.type).toBe(SessionEventType.ExternalAgentConfigUpdated);
    expect(appended[0]?.payload).toEqual({ agentId: "opencode", options: updated });
  });

  it("refuses a session whose model is not an ACP agent, and options of another agent", async () => {
    const zcodeModel = makeStore({ agentId: "opencode", offered: [MODE] });
    await expect(
      new V4CommandExecutor(makeHost(zcodeModel.store, "zai").host).execute(
        command({ configId: "mode", value: "plan" }),
      ),
    ).rejects.toMatchObject({ reasonCode: "config.notExternalAgent" });

    const otherAgent = makeStore({ agentId: "claude", offered: [MODE] });
    await expect(
      new V4CommandExecutor(makeHost(otherAgent.store).host).execute(
        command({ configId: "mode", value: "plan" }),
      ),
    ).rejects.toMatchObject({ reasonCode: "config.notAvailable" });
  });

  it("refuses a payload session that differs from the envelope", async () => {
    const { store } = makeStore({ agentId: "opencode", offered: [MODE] });
    await expect(
      new V4CommandExecutor(makeHost(store).host).execute(
        command({ sessionId: "s2", configId: "mode", value: "plan" }),
      ),
    ).rejects.toMatchObject({ reasonCode: "config.invalid" });
    expect(store.readConfig).not.toHaveBeenCalled();
  });
});
