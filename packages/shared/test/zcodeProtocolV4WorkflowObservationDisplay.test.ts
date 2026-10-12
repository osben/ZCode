// The **wire** schema for the GetWorkflowRun tool card payload (docs/dynamic-workflow/launch.md "Their cards").
//
// This side and the CLI's getWorkflowRunToolResultDisplayPayloadSchema are two independent zod schemas that must stay
// field-by-field in sync: both are strict, so a missing field fails the whole display validation and degrades the tool
// card to plain text; one extra enum value makes the mobile remote-control bundle reject the entire frame (on
// 2026-09-04 this permanently killed a subscription). So what is pinned here is "the shape the CLI really sends
// must be accepted on this side".

import { describe, expect, it } from "vitest";
// The toolCall and toolOutput unions share the same member schema, so entering through the exported one is enough.
import { toolCallDisplaySchema } from "../src/zcode-protocol-v4/index.js";

/** The payload the CLI-side createGetWorkflowRunDisplay emits for a run with a complete situation report. */
const CARD = {
  kind: "get_workflow_run" as const,
  runId: "dwfrun-7f3a",
  label: "nightly triage",
  status: "running" as const,
  summary:
    "Running for 5m 40s, in phase 2 of 4 (judge). 5 of 7 dispatched steps settled, 2 running.",
  generatedAt: 1_755_000_000_000,
  usage: {
    spentTokens: 18_420,
    nodesObserved: 7,
    nodesRunning: 2,
    nodesCompleted: 5,
    nodesFailed: 0,
  },
  phases: [
    {
      name: "collect",
      state: "done" as const,
      rounds: 1,
      nodesSettled: 2,
      nodesRunning: 0,
      enteredAt: 1,
      exitedAt: 2,
    },
    {
      name: "judge",
      state: "current" as const,
      rounds: 1,
      nodesSettled: 3,
      nodesRunning: 2,
      enteredAt: 2,
    },
  ],
  subagents: [
    {
      siteId: "agent#2",
      ordinal: 2,
      name: "judge",
      state: "executing" as const,
      phaseName: "judge",
      instructionsHead: "Judge specs 1-7 for flakiness",
      startedAt: 3,
      turn: 4,
      toolCalls: 7,
      lastTool: { name: "Read", target: "packages/net/retry.spec.ts", at: 4 },
      stepsSettled: 1,
      stepsFailed: 0,
      tokens: 5_100,
      lastProgressAt: 4,
    },
    {
      siteId: "agent#3",
      ordinal: 1,
      state: "waiting" as const,
      waitCause: "backoff" as const,
      retryAfterMs: 20_000,
      waitSince: 5,
      parkedOn: "q-01",
      stepsSettled: 1,
      stepsFailed: 0,
      tokens: 2_130,
    },
  ],
  health: {
    lastProgressAt: 6,
    stalledSince: 7,
    concurrency: { effective: 2, cap: 3, reason: "rate_limited", since: 8 },
    consecutiveFailures: 0,
    cachedSteps: 0,
    leftoverRunning: 2,
    pendingQuestionsKnown: false,
  },
  actors: [{ siteId: "agent#2", ordinal: 2, name: "judge" }],
  logTail: [{ sequence: 19, message: "judge#1 finished" }],
};

describe("v4 get_workflow_run display payload", () => {
  it("accepts the situation report the CLI sends", () => {
    expect(toolCallDisplaySchema.parse(CARD)).toEqual(CARD);
  });

  it("takes an absent phase table and an empty roster", () => {
    const { phases: _phases, ...withoutPhases } = CARD;
    expect(toolCallDisplaySchema.parse({ ...withoutPhases, subagents: [] })).toBeTruthy();
  });

  // Payloads persisted **before** the situation report existed: no summary / generatedAt / subagents / health. Because this schema
  // is strict, making those five required would strip this card entirely and degrade it to plain text in every historical
  // session opened after the upgrade — while the spec's text fallback only targets rows with no payload at all.
  it("still accepts a payload persisted before the situation report existed", () => {
    const legacy = {
      kind: "get_workflow_run" as const,
      runId: "dwfrun-old",
      label: "yesterday's run",
      status: "completed" as const,
      usage: {
        spentTokens: 10,
        nodesObserved: 2,
        nodesRunning: 0,
        nodesCompleted: 2,
        nodesFailed: 0,
      },
      actors: [{ siteId: "agent#1", ordinal: 1 }],
      logTail: [{ sequence: 1, message: "done" }],
      result: "shipped",
    };
    expect(toolCallDisplaySchema.parse(legacy)).toEqual(legacy);
  });

  // The journal time of a log line is an optional key: new payloads carry it (the card computes age from it), old ones lack it; both must pass.
  it("takes a log entry with or without its journal time", () => {
    const withTime = {
      ...CARD,
      logTail: [{ sequence: 19, message: "judge#1 finished", at: 1_700_000_000_000 }],
    };
    expect(toolCallDisplaySchema.parse(withTime)).toEqual(withTime);
    expect(toolCallDisplaySchema.parse(CARD)).toEqual(CARD);
  });

  // Closed enum sets: one unknown phase word makes this side reject the entire frame, so both vocabularies always change together.
  it("keeps the subagent state, phase state and wait cause closed", () => {
    for (const patch of [
      { subagents: [{ ...CARD.subagents[1], state: "thinking" }] },
      { subagents: [{ ...CARD.subagents[1], waitCause: "quota" }] },
      { phases: [{ ...CARD.phases[1], state: "skipped" }] },
    ]) {
      expect(toolCallDisplaySchema.safeParse({ ...CARD, ...patch }).success).toBe(false);
    }
  });

  it("stays strict about unknown keys inside the roster", () => {
    expect(
      toolCallDisplaySchema.safeParse({
        ...CARD,
        subagents: [{ ...CARD.subagents[1], persona: "you are…" }],
      }).success,
    ).toBe(false);
  });

  it("bounds the roster at 64 rows and the instructions head at 240 chars", () => {
    expect(
      toolCallDisplaySchema.safeParse({
        ...CARD,
        subagents: Array.from({ length: 65 }, () => CARD.subagents[1]),
      }).success,
    ).toBe(false);
    expect(
      toolCallDisplaySchema.safeParse({
        ...CARD,
        subagents: [{ ...CARD.subagents[0], instructionsHead: "x".repeat(241) }],
      }).success,
    ).toBe(false);
  });
});
