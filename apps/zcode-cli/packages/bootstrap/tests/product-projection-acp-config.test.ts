import { describe, expect, it } from "vitest";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import { ProductProjection } from "../src/zcode-protocol-v4/index.js";

// specs/acp-agent-runtime.md "S6": the agent's selects are config state (config.externalAgentConfig) and a
// stall is a transient control status (control.externalAgentStall); neither writes a row.

const CONFIG = {
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
        { value: "plan", name: "Plan", description: null, group: null },
      ],
    },
  ],
};

function harness() {
  const projection = new ProductProjection("acp-config", "epoch");
  let seq = 0;
  const apply = (type: SessionEvent["type"], payload: unknown, turnId = "turn-1") =>
    projection.applyEvent({
      id: `event-${++seq}`,
      sessionId: "acp-config",
      turnId,
      traceId: "trace",
      timestamp: new Date(1700000000000 + seq),
      sequenceNumber: seq,
      type,
      payload,
    } as SessionEvent);
  apply(SessionEventType.SessionCreated, { mode: "default", contextWindow: 200000 });
  return { projection, apply };
}

function startTurn(apply: ReturnType<typeof harness>["apply"]) {
  apply(SessionEventType.TurnStarted, { turnNumber: 1, input: "go", messageId: "user-1" });
}

describe("ACP agent config product projection", () => {
  it("projects external_agent_config_updated onto config without a row", () => {
    const { projection, apply } = harness();
    startTurn(apply);
    const rowsBefore = projection.getSnapshot().rows.totalCount;

    const deltas = apply(SessionEventType.ExternalAgentConfigUpdated, CONFIG);

    expect(deltas).toEqual([
      {
        op: "state.updated",
        patch: expect.objectContaining({ config: expect.objectContaining({ externalAgentConfig: CONFIG }) }),
      },
    ]);
    expect(projection.getSnapshot().config.externalAgentConfig).toEqual(CONFIG);
    expect(projection.getSnapshot().rows.totalCount).toBe(rowsBefore);
    // The same options again change nothing.
    expect(apply(SessionEventType.ExternalAgentConfigUpdated, CONFIG)).toEqual([]);
  });

  it("ignores a malformed config payload", () => {
    const { projection, apply } = harness();
    expect(apply(SessionEventType.ExternalAgentConfigUpdated, { agentId: "opencode" })).toEqual([]);
    expect(projection.getSnapshot().config.externalAgentConfig).toBeUndefined();
  });

  it("seeds stored options without a delta, and an event value wins over the seed", () => {
    const seeded = harness();
    seeded.projection.seedExternalAgentConfig(CONFIG);
    expect(seeded.projection.getSnapshot().config.externalAgentConfig).toEqual(CONFIG);

    const evented = harness();
    const fromEvent = { ...CONFIG, options: [{ ...CONFIG.options[0]!, currentValue: "build" }] };
    evented.apply(SessionEventType.ExternalAgentConfigUpdated, fromEvent);
    evented.projection.seedExternalAgentConfig(CONFIG);
    expect(evented.projection.getSnapshot().config.externalAgentConfig).toEqual(fromEvent);
  });

  it("shows a stall during the running turn and clears it on resume", () => {
    const { projection, apply } = harness();
    startTurn(apply);

    apply(SessionEventType.ExternalAgentStatus, { agentId: "opencode", status: "stalled", silentMs: 30000 });
    expect(projection.getSnapshot().control.externalAgentStall).toMatchObject({
      agentId: "opencode",
      silentMs: 30000,
    });
    expect(projection.getSnapshot().control.canStop).toBe(true);

    apply(SessionEventType.ExternalAgentStatus, { agentId: "opencode", status: "resumed" });
    expect(projection.getSnapshot().control.externalAgentStall).toBeNull();
  });

  it("clears a stall when the turn ends and ignores a stall outside a running turn", () => {
    const { projection, apply } = harness();
    startTurn(apply);
    apply(SessionEventType.ExternalAgentStatus, { agentId: "opencode", status: "stalled", silentMs: 30000 });

    apply(SessionEventType.TurnComplete, { resultType: "cancelled", historyRoundCount: 1 });
    expect(projection.getSnapshot().control.externalAgentStall).toBeNull();

    expect(
      apply(SessionEventType.ExternalAgentStatus, { agentId: "opencode", status: "stalled", silentMs: 1 }),
    ).toEqual([]);
    expect(projection.getSnapshot().control.externalAgentStall).toBeNull();
  });

  it("does not add the stall field to controls that never stalled", () => {
    const { projection, apply } = harness();
    startTurn(apply);
    apply(SessionEventType.TurnComplete, { resultType: "success", historyRoundCount: 1 });
    expect("externalAgentStall" in projection.getSnapshot().control).toBe(false);
  });
});
