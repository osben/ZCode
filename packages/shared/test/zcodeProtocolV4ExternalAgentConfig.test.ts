import { describe, expect, it } from "vitest";
import {
  COMMANDS_REQUIRING_BASE_REVISION,
  parseCommandEnvelope,
  sessionConfigStateSchema,
  sessionControlSchema,
  statePatchSchema,
} from "../src/zcode-protocol-v4/index.js";

// specs/acp-agent-runtime.md "S6": additive protocol surface for ACP agent selects and stalls.

const EXTERNAL_AGENT_CONFIG = {
  agentId: "opencode",
  options: [
    {
      id: "mode",
      name: "Mode",
      description: null,
      category: "mode",
      currentValue: "plan",
      options: [
        { value: "build", name: "Build", description: null, group: null },
        { value: "plan", name: "Plan", description: "Read-only", group: "Modes" },
      ],
    },
  ],
};

const BASE_CONFIG = {
  provider: "acp:opencode",
  model: "opencode",
  thought: "",
  followupMode: "queue",
};

function envelope(payload: unknown, sessionId: string | null = "s-1") {
  return {
    commandId: "cmd-agent-config-1",
    clientId: "desktop-1",
    sessionId,
    type: "setExternalAgentConfigOption",
    payload,
    issuedAt: 1000,
  };
}

describe("zcode-protocol-v4 external agent config", () => {
  it("parses setExternalAgentConfigOption without a base revision", () => {
    const parsed = parseCommandEnvelope(
      envelope({ sessionId: "s-1", configId: "mode", value: "plan" }),
    );
    expect(parsed.ok).toBe(true);
    expect(COMMANDS_REQUIRING_BASE_REVISION.has("setExternalAgentConfigOption")).toBe(false);
  });

  it.each([
    ["a missing value", { sessionId: "s-1", configId: "mode" }],
    ["an empty config id", { sessionId: "s-1", configId: "", value: "plan" }],
    ["an empty value", { sessionId: "s-1", configId: "mode", value: "" }],
    ["a missing session id", { configId: "mode", value: "plan" }],
    ["a non-string value", { sessionId: "s-1", configId: "mode", value: 1 }],
    ["an unknown field", { sessionId: "s-1", configId: "mode", value: "plan", force: true }],
  ])("rejects %s", (_label, payload) => {
    expect(parseCommandEnvelope(envelope(payload)).ok).toBe(false);
  });

  it("round-trips externalAgentConfig in the session config and keeps old snapshots valid", () => {
    const withAgent = sessionConfigStateSchema.parse({
      ...BASE_CONFIG,
      externalAgentConfig: EXTERNAL_AGENT_CONFIG,
    });
    expect(withAgent.externalAgentConfig).toEqual(EXTERNAL_AGENT_CONFIG);
    expect(sessionConfigStateSchema.parse(BASE_CONFIG).externalAgentConfig).toBeUndefined();
    // A config patch carries the field through the state delta unchanged.
    const patch = statePatchSchema.parse({ config: withAgent });
    expect(patch.config?.externalAgentConfig).toEqual(EXTERNAL_AGENT_CONFIG);
  });

  it("rejects a malformed externalAgentConfig", () => {
    const missingNull = {
      ...EXTERNAL_AGENT_CONFIG,
      options: [{ ...EXTERNAL_AGENT_CONFIG.options[0], description: undefined }],
    };
    expect(
      sessionConfigStateSchema.safeParse({ ...BASE_CONFIG, externalAgentConfig: missingNull })
        .success,
    ).toBe(false);
    expect(
      sessionConfigStateSchema.safeParse({
        ...BASE_CONFIG,
        externalAgentConfig: { ...EXTERNAL_AGENT_CONFIG, agentId: "" },
      }).success,
    ).toBe(false);
  });

  it("carries the external agent stall on the session control and keeps old controls valid", () => {
    const control = {
      phase: "running",
      sessionEnded: false,
      canStop: true,
      stopState: "stoppable",
      stopTargetKind: "assistant",
      activeWorks: [],
      lastError: null,
      apiRetry: null,
    };
    expect(sessionControlSchema.parse(control).externalAgentStall).toBeUndefined();
    const stalled = sessionControlSchema.parse({
      ...control,
      externalAgentStall: { agentId: "opencode", since: 5000, silentMs: 30_000 },
    });
    expect(stalled.externalAgentStall).toEqual({
      agentId: "opencode",
      since: 5000,
      silentMs: 30_000,
    });
    expect(
      sessionControlSchema.parse({ ...control, externalAgentStall: null }).externalAgentStall,
    ).toBeNull();
    expect(
      sessionControlSchema.safeParse({
        ...control,
        externalAgentStall: { agentId: "opencode", since: 5000, silentMs: -1 },
      }).success,
    ).toBe(false);
  });
});
