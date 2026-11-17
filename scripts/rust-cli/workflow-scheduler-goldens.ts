#!/usr/bin/env -S pnpm exec tsx
/**
 * Node side of the scheduler and replay goldens (rust-cli crates/workflow, W5a part 2;
 * specs/fork-rust-workflow-engine.md section 9.3).
 *
 * Runs the real `WorkflowEngine` (apps/zcode-cli/packages/dynamic-workflow/src/engine/engine.ts) with
 * a recording driver, for the scenarios below, and writes
 * packages/rust-cli/crates/workflow/fixtures/scheduler-goldens.json:
 * - per lifetime: the result of every step, the constructor error (if any), the run row, the node
 *   rows and the actor rows after the lifetime, and the dispose count;
 * - for the whole run: every outcome of an ask promise (in settlement order), every driver call (in
 *   call order), and every event as the exact `JSON.stringify` text.
 *
 * Asks are driven by explicit steps (submit, turn end, failure, stats). The generator flushes the
 * microtask queue after every step, so the order of settlements is the order a host would observe
 * after the same synchronous slice. Rust drains its own job queue after every step in the same way.
 *
 * Scenarios are the source of truth; edit them here and regenerate:
 *   pnpm exec tsx scripts/rust-cli/workflow-scheduler-goldens.ts
 * (run from the repository root of the checkout whose engine sources you want to pin).
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkflowEngine } from "../../apps/zcode-cli/packages/dynamic-workflow/src/engine/engine.ts";
import { InMemoryJournalStore } from "../../apps/zcode-cli/packages/dynamic-workflow/src/engine/journal-memory.ts";
import {
  WorkflowError,
  refToString,
  type AskSpec,
  type RunEvent,
  type RunStopReason,
  type WorkflowDriver,
  type WorkflowErrorCode,
} from "../../apps/zcode-cli/packages/dynamic-workflow/src/engine/types.ts";

type Ref = { site: string; ordinal: number };

type Step =
  | { op: "createActor"; site: string; name?: string; persona?: string | Record<string, unknown> }
  | { op: "ask"; tag: string; site: string; actor: string; instructions: string }
  | { op: "submit"; at: Ref; payload: unknown }
  | { op: "turnEnded"; at: Ref; finalText: string }
  | { op: "askFailed"; at: Ref; error: { code: WorkflowErrorCode; message: string } }
  | {
      op: "stats";
      at: Ref;
      stats: { tokens: number; toolCalls: number; turns: number; worldToolCalls?: number };
    }
  | { op: "retune"; value: number }
  | { op: "phase"; name: string }
  | { op: "log"; message: string }
  | { op: "complete"; artifact: unknown }
  | {
      op: "stop";
      reason: RunStopReason;
      error?: { code: WorkflowErrorCode; message: string };
      supersededBy?: string;
    }
  | { op: "fail"; error: { code: WorkflowErrorCode; message: string } };

interface Lifetime {
  caps: number;
  scriptHash?: string;
  inheritedTokens?: number;
  steps: Step[];
}

interface Scenario {
  name: string;
  runId: string;
  askSpecs: Record<string, AskSpec>;
  sitePhases?: Record<string, string>;
  lifetimes: Lifetime[];
}

const STRING_SCHEMA = { type: "string" };
const askSpecs = (): Record<string, AskSpec> => ({
  "ask#1": { typed: true, schema: STRING_SCHEMA },
  "ask#2": { typed: true, schema: STRING_SCHEMA },
  "ask#3": { typed: true, schema: STRING_SCHEMA },
  "free#1": { typed: false },
});

const scenarios: Scenario[] = [
  {
    // FIFO by actorSeq under a cap of one, retune with queued asks, typed repair, nudge and
    // ResultNotSubmitted, usage from asks (live and settled), birth phases from markers and sitePhases,
    // then an interrupted stop with running asks, and two resumed lifetimes replaying the settle order.
    name: "fifo-retune-repair-resume",
    runId: "run_fifo",
    askSpecs: askSpecs(),
    sitePhases: { "ask#2": "review" },
    lifetimes: [
      {
        caps: 1,
        scriptHash: "h-fifo",
        steps: [
          { op: "createActor", site: "actor#1", name: "alpha" },
          { op: "createActor", site: "actor#2", persona: { system: "sys b", model: "zai/glm" } },
          { op: "phase", name: "plan" },
          { op: "ask", tag: "a1", site: "ask#1", actor: "actor#1@1", instructions: "first" },
          { op: "ask", tag: "a2", site: "ask#2", actor: "actor#1@1", instructions: "second" },
          { op: "phase", name: "work" },
          { op: "ask", tag: "b1", site: "ask#1", actor: "actor#2@1", instructions: "third" },
          { op: "retune", value: 2 },
          { op: "retune", value: 2 },
          { op: "submit", at: { site: "ask#1", ordinal: 1 }, payload: "done-1" },
          {
            op: "stats",
            at: { site: "ask#1", ordinal: 1 },
            stats: { tokens: 5, toolCalls: 2, turns: 1, worldToolCalls: 1 },
          },
          { op: "submit", at: { site: "ask#2", ordinal: 1 }, payload: 42 },
          { op: "submit", at: { site: "ask#2", ordinal: 1 }, payload: "fixed" },
          { op: "turnEnded", at: { site: "ask#1", ordinal: 2 }, finalText: "no submit yet" },
          { op: "turnEnded", at: { site: "ask#1", ordinal: 2 }, finalText: "still none" },
          {
            op: "stats",
            at: { site: "ask#1", ordinal: 2 },
            stats: { tokens: 3, toolCalls: 0, turns: 2 },
          },
          { op: "ask", tag: "c1", site: "ask#3", actor: "actor#1@1", instructions: "fourth" },
          { op: "ask", tag: "c2", site: "ask#3", actor: "actor#2@1", instructions: "fifth" },
          {
            op: "stop",
            reason: "interrupted",
            error: { code: "Interrupted", message: "sandbox exited" },
          },
        ],
      },
      {
        caps: 3,
        scriptHash: "h-fifo",
        inheritedTokens: 0,
        steps: [
          { op: "createActor", site: "actor#1", name: "alpha" },
          { op: "createActor", site: "actor#2", persona: { system: "sys b", model: "zai/glm" } },
          { op: "phase", name: "plan" },
          { op: "ask", tag: "a1", site: "ask#1", actor: "actor#1@1", instructions: "first" },
          { op: "phase", name: "work" },
          // Called before a2 although it settled after a2 in the first lifetime: the settle-order gate
          // must release the cached settlements in the recorded order, not in call order.
          { op: "ask", tag: "b1", site: "ask#1", actor: "actor#2@1", instructions: "third" },
          { op: "ask", tag: "a2", site: "ask#2", actor: "actor#1@1", instructions: "second" },
          { op: "ask", tag: "c1", site: "ask#3", actor: "actor#1@1", instructions: "fourth" },
          { op: "ask", tag: "c2", site: "ask#3", actor: "actor#2@1", instructions: "fifth" },
          { op: "submit", at: { site: "ask#3", ordinal: 1 }, payload: "c1-done" },
          { op: "submit", at: { site: "ask#3", ordinal: 2 }, payload: "c2-done" },
          {
            op: "stats",
            at: { site: "ask#3", ordinal: 2 },
            stats: { tokens: 4, toolCalls: 1, turns: 1 },
          },
          { op: "complete", artifact: { ok: true } },
        ],
      },
    ],
  },
  {
    // Settlement with asks in flight: complete aborts them in insertion order (cancelAsk only for the
    // dispatched ones), and a late stat after settlement updates the accounting only.
    name: "complete-with-asks-in-flight",
    runId: "run_complete",
    askSpecs: askSpecs(),
    lifetimes: [
      {
        caps: 2,
        scriptHash: "h-complete",
        steps: [
          { op: "createActor", site: "actor#1", name: "x" },
          { op: "createActor", site: "actor#2", name: "y" },
          { op: "createActor", site: "actor#3", name: "z" },
          { op: "ask", tag: "x1", site: "ask#1", actor: "actor#1@1", instructions: "one" },
          { op: "ask", tag: "y1", site: "ask#1", actor: "actor#2@1", instructions: "two" },
          { op: "ask", tag: "z1", site: "ask#1", actor: "actor#3@1", instructions: "three" },
          { op: "complete", artifact: "partial" },
          {
            op: "stats",
            at: { site: "ask#1", ordinal: 1 },
            stats: { tokens: 7, toolCalls: 0, turns: 1 },
          },
          { op: "log", message: "after settlement" },
        ],
      },
    ],
  },
  {
    // A run-level failure rejects the in-flight ask with the run error and emits no cancelled events.
    name: "fail-rejects-in-flight",
    runId: "run_fail",
    askSpecs: askSpecs(),
    lifetimes: [
      {
        caps: 1,
        steps: [
          { op: "createActor", site: "actor#1", name: "solo" },
          { op: "ask", tag: "s1", site: "free#1", actor: "actor#1@1", instructions: "go" },
          { op: "fail", error: { code: "DriverError", message: "boom" } },
          { op: "complete", artifact: 1 },
        ],
      },
    ],
  },
  {
    // A user stop cancels in-flight asks with the stop message and keeps the run resumable.
    name: "stop-user-cancels-asks",
    runId: "run_user",
    askSpecs: askSpecs(),
    lifetimes: [
      {
        caps: 2,
        steps: [
          { op: "createActor", site: "actor#1", name: "solo" },
          { op: "ask", tag: "s1", site: "ask#1", actor: "actor#1@1", instructions: "go" },
          { op: "ask", tag: "s2", site: "ask#1", actor: "actor#1@1", instructions: "again" },
          { op: "stop", reason: "user" },
        ],
      },
    ],
  },
  {
    // A second createActor with the same name fails the run; later calls return the run error.
    name: "duplicate-actor-name",
    runId: "run_dup",
    askSpecs: askSpecs(),
    lifetimes: [
      {
        caps: 1,
        steps: [
          { op: "createActor", site: "actor#1", name: "alpha" },
          { op: "createActor", site: "actor#2", name: "alpha" },
          { op: "createActor", site: "actor#3", name: "gamma" },
        ],
      },
    ],
  },
  {
    // A resumed script that asks with different instructions at a recorded site fails with
    // InputHashMismatch (the replay check), not with a silent offset.
    name: "replay-hash-mismatch",
    runId: "run_hash",
    askSpecs: askSpecs(),
    lifetimes: [
      {
        caps: 1,
        scriptHash: "h-hash",
        steps: [
          { op: "createActor", site: "actor#1", name: "alpha" },
          { op: "ask", tag: "a1", site: "ask#1", actor: "actor#1@1", instructions: "original" },
          { op: "submit", at: { site: "ask#1", ordinal: 1 }, payload: "ok" },
        ],
      },
      {
        caps: 1,
        scriptHash: "h-hash",
        steps: [
          { op: "createActor", site: "actor#1", name: "alpha" },
          { op: "ask", tag: "a1", site: "ask#1", actor: "actor#1@1", instructions: "changed" },
        ],
      },
    ],
  },
];

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** Test validator: a string schema accepts strings only. Violations use the same shape as Rust. */
function validate(schema: unknown, value: unknown) {
  const type = (schema as { type?: unknown } | undefined)?.type;
  if (type === "string" && typeof value !== "string") {
    return [{ path: "$", expected: "string", got: typeName(value) }];
  }
  return [];
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function errorJson(error: unknown): unknown {
  return error instanceof WorkflowError ? error.toJSON() : { message: String(error) };
}

async function runScenario(scenario: Scenario): Promise<unknown> {
  const store = new InMemoryJournalStore();
  const outcomes: unknown[] = [];
  const driverCalls: unknown[] = [];
  const emitted: RunEvent[] = [];
  let disposed = 0;
  const driver: WorkflowDriver = {
    journal: store,
    emit: (event) => {
      emitted.push(event);
    },
    createActorSession: (actor) => {
      driverCalls.push({ op: "createActorSession", actor: refToString(actor) });
      return Promise.resolve({ id: `sess:${refToString(actor)}` });
    },
    startAsk: (session, instance, message) => {
      driverCalls.push({
        op: "startAsk",
        session: session.id,
        instance: refToString(instance),
        instructions: message.instructions,
        typed: message.typed,
      });
    },
    respondToSubmit: (instance, verdict) => {
      driverCalls.push({ op: "respondToSubmit", instance: refToString(instance), verdict });
    },
    cancelAsk: (instance) => {
      driverCalls.push({ op: "cancelAsk", instance: refToString(instance) });
    },
    executeWorldRead: () => Promise.reject(new Error("not used in the scheduler goldens")),
    dispose: () => {
      disposed += 1;
    },
  };
  const specs = new Map(Object.entries(scenario.askSpecs));
  const sitePhases = new Map(Object.entries(scenario.sitePhases ?? {}));
  const track = (tag: string, promise: Promise<unknown>): void => {
    promise.then(
      (value) => outcomes.push({ tag, ok: true, value: value ?? null }),
      (error) => outcomes.push({ tag, ok: false, error: errorJson(error) }),
    );
  };
  const lifetimes: unknown[] = [];
  for (const lifetime of scenario.lifetimes) {
    let constructError: unknown;
    let engine: WorkflowEngine | undefined;
    try {
      engine = new WorkflowEngine({
        runId: scenario.runId,
        driver,
        caps: { maxConcurrency: lifetime.caps },
        askSpecs: specs,
        validate,
        sitePhases,
        ...(lifetime.scriptHash === undefined ? {} : { scriptHash: lifetime.scriptHash }),
        ...(lifetime.inheritedTokens === undefined
          ? {}
          : { inheritedTokens: lifetime.inheritedTokens }),
      });
    } catch (error) {
      constructError = errorJson(error);
    }
    const results: unknown[] = [];
    const runStep = async (step: Step): Promise<unknown> => {
      if (engine === undefined) return null;
      switch (step.op) {
        case "createActor": {
          try {
            const id = engine.createActor(step.site, step.name, step.persona);
            return { actorId: id };
          } catch (error) {
            return { error: errorJson(error) };
          }
        }
        case "ask": {
          track(step.tag, engine.ask(step.site, step.actor, step.instructions));
          return null;
        }
        case "submit":
          engine.askSubmitAttempted(
            { siteId: step.at.site, ordinal: step.at.ordinal },
            step.payload,
          );
          return null;
        case "turnEnded":
          engine.askTurnEnded({ siteId: step.at.site, ordinal: step.at.ordinal }, step.finalText);
          return null;
        case "askFailed":
          engine.askFailed(
            { siteId: step.at.site, ordinal: step.at.ordinal },
            new WorkflowError(step.error.code, step.error.message),
          );
          return null;
        case "stats":
          engine.askStats({ siteId: step.at.site, ordinal: step.at.ordinal }, step.stats);
          return null;
        case "retune":
          return engine.setMaxConcurrency(step.value);
        case "phase":
          engine.enterPhase(step.name);
          return null;
        case "log":
          engine.log(step.message);
          return null;
        case "complete":
          engine.complete(step.artifact);
          return null;
        case "stop":
          engine.stop(
            step.reason,
            step.error === undefined
              ? undefined
              : new WorkflowError(step.error.code, step.error.message),
            step.supersededBy,
          );
          return null;
        case "fail":
          engine.fail(new WorkflowError(step.error.code, step.error.message));
          return null;
      }
    };
    for (const step of lifetime.steps) {
      results.push(await runStep(step));
      await flush();
    }
    const row = store.getRun(scenario.runId);
    lifetimes.push({
      ...(constructError === undefined ? {} : { constructError }),
      results,
      run: row === undefined ? null : JSON.parse(JSON.stringify(row)),
      nodes: JSON.parse(
        JSON.stringify(store.listNodes(scenario.runId, { kinds: "all", withResult: true })),
      ),
      actors: JSON.parse(JSON.stringify(store.listActors(scenario.runId, { withPersona: true }))),
      disposed,
    });
  }
  const stored = store.listEvents(scenario.runId, { types: "all", reportItems: "all" });
  return {
    name: scenario.name,
    input: scenario,
    lifetimes,
    outcomes,
    driverCalls,
    events: stored.map((entry) => ({
      sequence: entry.sequence,
      payloadJson: JSON.stringify(entry.event),
    })),
    emittedCount: emitted.length,
  };
}

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "../../packages/rust-cli/crates/workflow/fixtures/scheduler-goldens.json");

async function main(): Promise<void> {
  const results: unknown[] = [];
  for (const scenario of scenarios) {
    try {
      results.push(await runScenario(scenario));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`scheduler scenario "${scenario.name}" failed: ${reason}`, { cause: error });
    }
  }
  writeFileSync(out, `${JSON.stringify({ scenarios: results }, null, 2)}\n`);
  console.log(`wrote ${results.length} scheduler scenarios to ${out}`);
}

void main();
