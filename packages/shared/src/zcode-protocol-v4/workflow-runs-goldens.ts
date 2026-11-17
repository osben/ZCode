/**
 * Node side of the workflowRuns reducer goldens (rust-cli node-store, W3).
 *
 * Input: nothing but the Node reducer and delta in this directory.
 * Output: `buildGoldens()`, serialized by `serializeGoldens()`. `scripts/rust-cli/workflow-runs-goldens.ts`
 * writes packages/rust-cli/crates/node-store/fixtures/workflow-runs/goldens.json, read by
 * `workflow_runs::tests` in Rust. For every scenario it records each envelope and what Node's
 * `reduceWorkflowRunsState` and `diffWorkflowRunsState` return for it:
 * - `state`: `JSON.stringify` of the next state, recorded only on the steps the scenario keeps
 *   (see `stateAt`). Rust must reproduce these bytes.
 * - `ops`: `JSON.stringify` of the delta list for that step (`"[]"` when there is none).
 * - a step the reducer reports as a no-op has `changed: false` and no `state` key; the prior state carries over.
 *
 * Two limit sets: the production limits, and a small injected set (`maxActors` 4, `maxNodes` 4,
 * `maxPhases` 3) so that eviction, unlisted buckets and truncation are reached in a few dozen
 * steps. The entry budget (6144 entries over 8 runs) is too large to record here; the Rust property
 * test generates that fan-out from the same event vocabulary and checks the delta property and the eviction.
 *
 * Determinism: the event stream comes from a seeded PRNG (mulberry32), never Math.random, so a
 * rerun writes the same file. The drift guard is `workflow-runs-goldens.test.ts` next to this file
 * (fork Vitest); it compares the committed fixture with `serializeGoldens(buildGoldens())`.
 *
 * It lives in the shared package (not in scripts/) so that the package's typecheck and the drift
 * guard can import it: a test under src/ cannot reach files outside the package's rootDir.
 */
import type { WorkflowRunsState } from "./workflow-runs.js";
import { WORKFLOW_RUNS_LIMITS } from "./workflow-runs.js";
import {
  reduceWorkflowRunsState,
  type WorkflowRunProgressEnvelope,
} from "./workflow-runs-reducer.js";
import type { WorkflowRunEntryLimits } from "./workflow-runs-eviction.js";
import { diffWorkflowRunsState } from "./workflow-runs-delta.js";

export interface GoldenStep {
  envelope: WorkflowRunProgressEnvelope;
  /** Whether the reducer returned a new state (false = semantic no-op, no delta). */
  changed: boolean;
  /** `JSON.stringify` of the next state; present only on the steps the scenario records. */
  state?: string;
  /** `JSON.stringify` of the delta list for this step (`"[]"` when there is none). */
  ops: string;
}

export interface GoldenScenario {
  name: string;
  /** `null` = production limits (WORKFLOW_RUNS_LIMITS); otherwise the injected entry limits. */
  limits: WorkflowRunEntryLimits | null;
  /** `every`: state for each changed step; `sampled`: every eighth step and the last. */
  stateAt: "every" | "sampled";
  steps: GoldenStep[];
}

export interface GoldenFile {
  schema: 1;
  scenarios: GoldenScenario[];
}

const TINY: WorkflowRunEntryLimits = { maxActors: 4, maxNodes: 4, maxPhases: 3 };

/** mulberry32: a 32-bit seeded PRNG. Same seed, same stream, in any runtime. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)]!;
}

function integer(rand: () => number, min: number, max: number): number {
  return min + Math.floor(rand() * (max - min + 1));
}

/**
 * Hand-written prefix: the shapes the reducer's own tests use, in the order the engine emits them.
 * Covers every reducer branch at least once, with production limits.
 */
function handWrittenPrefix(runId: string): WorkflowRunProgressEnvelope[] {
  let sequence = 0;
  const push = (
    eventType: string,
    payload: Record<string, unknown>,
    extra: Partial<WorkflowRunProgressEnvelope> = {},
  ): WorkflowRunProgressEnvelope => {
    const envelope: WorkflowRunProgressEnvelope = {
      runId,
      toolCallId: "tc-1",
      sequence: (sequence += 1),
      eventType,
      payload,
      ...extra,
    };
    return envelope;
  };
  const actor = { siteId: "agent#1", ordinal: 1 };
  const ask = { siteId: "ask#1", ordinal: 1 };
  return [
    push("run-launched", {
      phaseNames: ["Survey", "Write", "Review"],
      phaseAlongside: [[], [0], []],
      holes: [1],
    }),
    push("run-started", {
      caps: { maxConcurrency: 3 },
      concurrencyCeiling: 8,
      subagentModel: "  claude-sonnet  ",
    }),
    push("phase-entered", { name: "Survey", ordinal: 1 }),
    push(
      "actor-created",
      { actor, name: "scout", phaseName: "Survey", persona: { model: "fast" } },
      { actorSessionId: "sess_dwf-dwfrun-1-agent_1_1" },
    ),
    push("node-queued", {
      instance: ask,
      actor,
      kind: "ask",
      phaseName: "Survey",
      instructionsHead: "Find the sources",
    }),
    push(
      "node-dispatched",
      {
        instance: ask,
        actor,
        actorName: "scout",
        actorPhaseName: "Survey",
        actorModel: "claude-haiku",
      },
      { actorSessionId: "sess_dwf-dwfrun-1-agent_1_1" },
    ),
    push("node-executing", { instance: ask }),
    push("node-progress", {
      instance: ask,
      turn: 2,
      toolCalls: 5,
      lastTool: { name: "Read", target: "src/main.rs" },
    }),
    push("node-waiting", { instance: ask }),
    push("node-repairing", { instance: ask }),
    push("node-nudged", { instance: ask }),
    push("report", {
      instance: { siteId: "report#1", ordinal: 1 },
      item: { title: "Sources", count: 3, tags: ["a", "b"] },
    }),
    push("report", {
      instance: { siteId: "report#1", ordinal: 2 },
      item: "plain text item",
      artifactId: "board-1",
    }),
    push("artifact-published", {
      artifact: {
        id: "board-1",
        kind: "board",
        title: "Board",
        version: 1,
        bytes: 120,
        primary: true,
      },
    }),
    push("artifact-published", {
      artifact: {
        id: "board-1",
        kind: "board",
        title: "Board",
        version: 2,
        contentType: "application/json",
      },
    }),
    push("artifact-failed", { artifact: { id: "bad", kind: "file" } }),
    push("escalation-raised", {
      qid: "q-1",
      actor,
      actorName: "scout",
      question: "Which branch?",
      context: "two candidates",
      askedAt: 1700000000000,
    }),
    push("escalation-resolved", { qid: "q-1" }),
    push("escalation-raised", { qid: "q-2", question: "Still blocked" }),
    push("hole-reached", {
      instance: { siteId: "hole#0a1b2c3d", ordinal: 1 },
      name: "Verdict",
      type: "Verdict",
      prompt: "Pick one",
      reachedAt: 1700000001000,
    }),
    push("hole-filled", {
      siteId: "hole#0a1b2c3d",
      filledAt: 1700000002000,
      filledBy: "user",
      phaseNames: ["Survey", "Write", "Review"],
      holes: [],
    }),
    push("concurrency-changed", {
      key: "provider/model",
      previous: 3,
      next: 2,
      cooldownMs: 500,
      reason: "rate_limit",
    }),
    push("run-caps-changed", { caps: { maxConcurrency: 6 }, concurrencyCeiling: 8 }),
    push("usage-updated", { spentTokens: 1234 }),
    push("node-settled", { instance: ask, actor, outcome: "ok" }),
    push("node-queued", {
      instance: { siteId: "ask#1", ordinal: 2 },
      actor,
      kind: "ask",
      phaseName: "Write",
    }),
    push("node-settled", {
      instance: { siteId: "ask#1", ordinal: 3 },
      actor,
      cached: true,
      outcome: "failed",
      phaseName: "Write",
      sourceSessionId: "sess-prior",
    }),
    push("log", { message: "noise" }),
    push("usage-updated", { spentTokens: 1500 }),
    push("run-settled", {
      status: "stopped",
      stopReason: "superseded",
      supersededBy: "dwfrun-2",
      error: "Superseded by a revision",
    }),
  ];
}

/**
 * Seeded random stream over the per-actor, per-node and per-run kinds that recur in a run, with replays
 * (duplicate sequence numbers) and out-of-order arrivals. `run-launched`, `run-settled` and `artifact-failed`
 * are not drawn here; the hand-written prefix covers them.
 */
function randomStream(
  runId: string,
  seed: number,
  count: number,
  actorSpace: number,
  instanceSpace: number,
): WorkflowRunProgressEnvelope[] {
  const rand = prng(seed);
  const out: WorkflowRunProgressEnvelope[] = [];
  let sequence = 0;
  const phases = ["Survey", "Write", "Review", "Ship"];
  const kinds = ["ask", "world-read"] as const;
  const outcomes = ["ok", "failed", "cancelled"] as const;
  for (let index = 0; index < count; index += 1) {
    const roll = rand();
    const actorOrdinal = integer(rand, 1, actorSpace);
    const actor = { siteId: "agent#1", ordinal: actorOrdinal };
    const askOrdinal = integer(rand, 1, instanceSpace);
    const instance = { siteId: "ask#1", ordinal: askOrdinal };
    const phaseName = pick(rand, phases);
    // Sequence: mostly increasing; sometimes a replay of an earlier one; rarely a stale low one.
    if (rand() < 0.05 && sequence > 0) sequence = Math.max(0, sequence - integer(rand, 0, 2));
    else sequence += 1;
    let eventType: string;
    let payload: Record<string, unknown>;
    if (roll < 0.1) {
      eventType = "actor-created";
      payload = {
        actor,
        name: `agent-${actorOrdinal}`,
        phaseName,
        ...(rand() < 0.3 ? { persona: { model: "fast" } } : {}),
      };
    } else if (roll < 0.3) {
      eventType = "node-queued";
      payload = {
        instance,
        actor,
        kind: pick(rand, kinds),
        phaseName,
        instructionsHead: `ask ${askOrdinal} ${"x".repeat(integer(rand, 0, 30))}`,
      };
    } else if (roll < 0.4) {
      eventType = "node-dispatched";
      payload = {
        instance,
        actor,
        actorName: `agent-${actorOrdinal}`,
        actorPhaseName: phaseName,
        actorModel: "claude-haiku",
      };
    } else if (roll < 0.47) {
      eventType = pick(rand, [
        "node-executing",
        "node-waiting",
        "node-repairing",
        "node-nudged",
      ] as const);
      payload = { instance };
    } else if (roll < 0.55) {
      eventType = "node-settled";
      payload = {
        instance,
        actor,
        outcome: pick(rand, outcomes),
        ...(rand() < 0.2 ? { cached: true, sourceSessionId: "sess-x", phaseName } : {}),
      };
    } else if (roll < 0.62) {
      eventType = "node-progress";
      payload = {
        instance,
        turn: integer(rand, 1, 9),
        toolCalls: integer(rand, 0, 40),
        lastTool: { name: "Bash", target: "ls -la".slice(0, integer(rand, 1, 6)) },
      };
    } else if (roll < 0.67) {
      eventType = "report";
      payload = {
        instance: { siteId: "report#1", ordinal: integer(rand, 1, 80) },
        item: { n: askOrdinal, label: `r${askOrdinal}` },
        ...(rand() < 0.2 ? { artifactId: "board-1" } : {}),
      };
    } else if (roll < 0.71) {
      eventType = "artifact-published";
      payload = {
        artifact: {
          id: pick(rand, ["board-1", "md-2", "chart-3"]),
          kind: pick(rand, ["board", "markdown", "chart"]),
          title: "T",
          version: integer(rand, 1, 3),
          bytes: integer(rand, 0, 500),
        },
      };
    } else if (roll < 0.75) {
      eventType = pick(rand, ["escalation-raised", "escalation-resolved"] as const);
      payload = {
        qid: `q-${integer(rand, 1, 6)}`,
        question: `question ${askOrdinal}`,
        actor,
        actorName: `agent-${actorOrdinal}`,
        askedAt: 1700000000000 + index,
      };
    } else if (roll < 0.8) {
      eventType = pick(rand, ["hole-reached", "hole-filled"] as const);
      payload =
        eventType === "hole-reached"
          ? {
              instance: {
                siteId: `hole#${integer(rand, 0, 5).toString(16).padStart(8, "0")}`,
                ordinal: 1,
              },
              name: phaseName,
              type: "Verdict",
              reachedAt: 1700000003000,
            }
          : {
              siteId: `hole#${integer(rand, 0, 5).toString(16).padStart(8, "0")}`,
              filledAt: 1700000004000,
              phaseNames: phases.slice(0, integer(rand, 1, 4)),
            };
    } else if (roll < 0.84) {
      eventType = "phase-entered";
      payload = { name: phaseName, ordinal: integer(rand, 1, 3) };
    } else if (roll < 0.88) {
      eventType = pick(rand, ["concurrency-changed", "run-caps-changed"] as const);
      payload =
        eventType === "concurrency-changed"
          ? {
              key: "provider/model",
              previous: integer(rand, 1, 6),
              next: integer(rand, 1, 6),
              cooldownMs: integer(rand, 0, 900),
              reason: "rate_limit",
            }
          : { caps: { maxConcurrency: integer(rand, 1, 8) }, concurrencyCeiling: 8 };
    } else if (roll < 0.92) {
      eventType = "usage-updated";
      payload = { spentTokens: sequence * 10 };
    } else if (roll < 0.95) {
      eventType = "run-started";
      payload = { caps: { maxConcurrency: integer(rand, 1, 6) }, concurrencyCeiling: 8 };
    } else {
      eventType = "log";
      payload = { message: "noise" };
    }
    out.push({
      runId,
      toolCallId: "tc-rand",
      sequence,
      eventType,
      payload,
      actorSessionId: `sess_dwf-${runId}-agent_1_${actorOrdinal}`,
    });
  }
  return out;
}

/** Runs the reducer over a stream, recording exactly what Node returns. */
function record(
  name: string,
  limits: WorkflowRunEntryLimits | null,
  stateAt: GoldenScenario["stateAt"],
  envelopes: WorkflowRunProgressEnvelope[],
): GoldenScenario {
  let prior: WorkflowRunsState | undefined;
  const steps: GoldenStep[] = [];
  const last = envelopes.length - 1;
  envelopes.forEach((envelope, index) => {
    const next = reduceWorkflowRunsState(prior, envelope, limits ?? WORKFLOW_RUNS_LIMITS);
    if (next === null) {
      steps.push({ envelope, changed: false, ops: "[]" });
      return;
    }
    const ops = diffWorkflowRunsState(prior, next);
    const recorded =
      stateAt === "every" || (stateAt === "sampled" && (index % 8 === 0 || index === last));
    steps.push({
      envelope,
      changed: true,
      ...(recorded ? { state: JSON.stringify(next) } : {}),
      ops: JSON.stringify(ops),
    });
    prior = next;
  });
  return { name, limits, stateAt, steps };
}

export function buildGoldens(): GoldenFile {
  const scenarios: GoldenScenario[] = [
    record("hand-written-production", null, "every", handWrittenPrefix("dwfrun-1")),
    record("hand-written-tiny", TINY, "every", handWrittenPrefix("dwfrun-1")),
    record("random-production", null, "sampled", randomStream("dwfrun-1", 7, 160, 12, 40)),
    record("random-tiny-a", TINY, "sampled", randomStream("dwfrun-1", 11, 240, 10, 12)),
    record("random-tiny-b", TINY, "sampled", randomStream("dwfrun-1", 99, 240, 6, 30)),
  ];
  return { schema: 1, scenarios };
}

/** The exact bytes of the fixture file; the drift guard compares against these. */
export function serializeGoldens(file: GoldenFile): string {
  return `${JSON.stringify(file)}\n`;
}
