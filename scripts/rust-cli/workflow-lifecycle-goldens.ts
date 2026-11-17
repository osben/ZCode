#!/usr/bin/env -S pnpm exec tsx
/**
 * Node side of the run-lifecycle goldens (rust-cli crates/workflow, W5a; specs/fork-rust-workflow-engine.md section 9.2).
 *
 * Runs the real `WorkflowEngine` (apps/zcode-cli/packages/dynamic-workflow/src/engine/engine.ts) on an
 * `InMemoryJournalStore` with a recording driver, for the scripted lifetimes below, and writes
 * packages/rust-cli/crates/workflow/fixtures/lifecycle-goldens.json:
 * - per lifetime: whether construction threw (code and message), the result of every step, and the
 *   run row after the lifetime (`getRun`, JSON);
 * - the full event log of the run: sequence and the exact `JSON.stringify` text of each event. Key
 *   order is part of the contract, so Rust must reproduce the bytes, not just the values.
 *
 * Rust replays the same scenarios (crates/workflow/src/engine tests) and must match all of it.
 * Scenarios are the source of truth; edit them here and regenerate.
 *
 * Run from the repository root:
 *   pnpm exec tsx scripts/rust-cli/workflow-lifecycle-goldens.ts
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkflowEngine } from "../../apps/zcode-cli/packages/dynamic-workflow/src/engine/engine.ts";
import { InMemoryJournalStore } from "../../apps/zcode-cli/packages/dynamic-workflow/src/engine/journal-memory.ts";
import {
  WorkflowError,
  type WorkflowErrorCode,
  type RunStopReason,
  type WorkflowDriver,
  type RunEvent,
} from "../../apps/zcode-cli/packages/dynamic-workflow/src/engine/types.ts";
import type { RunLaunchConfig } from "../../apps/zcode-cli/packages/dynamic-workflow/src/engine/engine-launch.ts";

type Step =
  | { op: "log"; message: string }
  | { op: "retune"; value: number }
  | { op: "usage"; tokens: number }
  | { op: "complete"; artifact: unknown }
  | {
      op: "stop";
      reason: RunStopReason;
      supersededBy?: string;
      error?: { code: WorkflowErrorCode; message: string };
    }
  | { op: "fail"; error: { code: WorkflowErrorCode; message: string } };

interface Lifetime {
  scriptHash?: string;
  scriptText?: string;
  name?: string;
  args?: Record<string, unknown>;
  caps: number;
  inheritedTokens?: number;
  toolCallId?: string;
  parentSessionId?: string;
  cwd?: string;
  resumedFrom?: string;
  launch?: RunLaunchConfig;
  steps: Step[];
}

interface Scenario {
  name: string;
  runId: string;
  lifetimes: Lifetime[];
}

const scenarios: Scenario[] = [
  {
    name: "complete-with-retunes",
    runId: "run_plain",
    lifetimes: [
      {
        caps: 4,
        steps: [
          { op: "log", message: "hello 中文 😀" },
          { op: "retune", value: 8 },
          { op: "retune", value: 8 },
          { op: "retune", value: 2.7 },
          { op: "retune", value: Number.NaN },
          { op: "retune", value: 0 },
          { op: "usage", tokens: 5 },
          { op: "complete", artifact: { ok: true, items: [1, "two", null] } },
          { op: "log", message: "after settlement" },
          { op: "complete", artifact: "second" },
          { op: "retune", value: 9 },
        ],
      },
    ],
  },
  {
    name: "stopped-user-with-inherited-usage",
    runId: "run_user",
    lifetimes: [
      {
        scriptHash: "h-user",
        scriptText: "return 1;",
        name: "nightly",
        args: { b: [2, { z: 1, a: "x" }], a: 1.5 },
        caps: 2,
        inheritedTokens: 12.9,
        toolCallId: "call_1",
        parentSessionId: "sess_parent",
        cwd: "/work/repo",
        resumedFrom: "run_prior",
        steps: [
          { op: "usage", tokens: 3 },
          { op: "stop", reason: "user" },
          { op: "stop", reason: "model" },
          { op: "fail", error: { code: "DriverError", message: "late" } },
        ],
      },
    ],
  },
  {
    name: "errored-run",
    runId: "run_error",
    lifetimes: [
      {
        caps: 3,
        steps: [
          { op: "log", message: "about to fail" },
          { op: "fail", error: { code: "DriverError", message: "boom" } },
          { op: "complete", artifact: 1 },
        ],
      },
    ],
  },
  {
    name: "stopped-interrupted-and-superseded",
    runId: "run_interrupted",
    lifetimes: [
      {
        caps: 3,
        steps: [
          {
            op: "stop",
            reason: "interrupted",
            error: { code: "Interrupted", message: "sandbox exited" },
          },
        ],
      },
    ],
  },
  {
    name: "superseded-by-successor",
    runId: "run_superseded",
    lifetimes: [
      {
        caps: 3,
        steps: [{ op: "stop", reason: "superseded", supersededBy: "run_successor" }],
      },
    ],
  },
  {
    name: "resume-after-interrupt",
    runId: "run_resume",
    lifetimes: [
      {
        scriptHash: "h1",
        scriptText: "s",
        caps: 4,
        toolCallId: "tc1",
        parentSessionId: "sess1",
        cwd: "/w",
        launch: {
          inputId: "in-1",
          phaseNames: ["plan", "work"],
          subagentModel: "zai/glm$high",
          modelBindings: { sonnet: "anthropic/claude" },
          subagentPermissionMode: "yolo",
          scriptPath: "/w/script.ts",
          phaseAlongside: [[], [0]],
          holes: [1],
        },
        steps: [
          { op: "usage", tokens: 7 },
          { op: "stop", reason: "interrupted", error: { code: "Interrupted", message: "crash" } },
        ],
      },
      {
        scriptHash: "h1",
        caps: 9,
        steps: [
          { op: "usage", tokens: 2 },
          { op: "retune", value: 6 },
          { op: "complete", artifact: "done" },
        ],
      },
      {
        scriptHash: "h2",
        caps: 1,
        steps: [],
      },
    ],
  },
];

function workflowError(input: { code: WorkflowErrorCode; message: string }): WorkflowError {
  return new WorkflowError(input.code, input.message);
}

function runStepResult(engine: WorkflowEngine, step: Step): unknown {
  switch (step.op) {
    case "log":
      engine.log(step.message);
      return null;
    case "retune":
      return engine.setMaxConcurrency(step.value);
    case "usage":
      engine.askStats(
        { siteId: "ask#1", ordinal: 1 },
        { tokens: step.tokens, toolCalls: 0, turns: 1 },
      );
      return null;
    case "complete":
      engine.complete(step.artifact);
      return null;
    case "stop":
      engine.stop(
        step.reason,
        step.error === undefined ? undefined : workflowError(step.error),
        step.supersededBy,
      );
      return null;
    case "fail":
      engine.fail(workflowError(step.error));
      return null;
  }
}

function runScenario(scenario: Scenario): unknown {
  const store = new InMemoryJournalStore();
  let disposed = 0;
  const emitted: RunEvent[] = [];
  const driver: WorkflowDriver = {
    journal: store,
    emit: (event) => {
      emitted.push(event);
    },
    createActorSession: () => {
      throw new Error("not used in the lifecycle goldens");
    },
    startAsk: () => {},
    respondToSubmit: () => {},
    cancelAsk: () => {},
    executeWorldRead: () => Promise.reject(new Error("not used")),
    dispose: () => {
      disposed += 1;
    },
  };
  const lifetimes = scenario.lifetimes.map((lifetime) => {
    let constructError: { code: string; message: string } | undefined;
    let engine: WorkflowEngine | undefined;
    try {
      engine = new WorkflowEngine({
        runId: scenario.runId,
        driver,
        caps: { maxConcurrency: lifetime.caps },
        askSpecs: new Map(),
        validate: () => [],
        ...(lifetime.scriptText === undefined ? {} : { scriptText: lifetime.scriptText }),
        ...(lifetime.scriptHash === undefined ? {} : { scriptHash: lifetime.scriptHash }),
        ...(lifetime.name === undefined ? {} : { name: lifetime.name }),
        ...(lifetime.args === undefined ? {} : { args: lifetime.args }),
        ...(lifetime.toolCallId === undefined ? {} : { toolCallId: lifetime.toolCallId }),
        ...(lifetime.parentSessionId === undefined
          ? {}
          : { parentSessionId: lifetime.parentSessionId }),
        ...(lifetime.cwd === undefined ? {} : { cwd: lifetime.cwd }),
        ...(lifetime.resumedFrom === undefined ? {} : { resumedFrom: lifetime.resumedFrom }),
        ...(lifetime.launch === undefined ? {} : { launch: lifetime.launch }),
        ...(lifetime.inheritedTokens === undefined
          ? {}
          : { inheritedTokens: lifetime.inheritedTokens }),
      });
    } catch (error) {
      const err = error as WorkflowError;
      constructError = { code: err.code, message: err.message };
    }
    const results =
      engine === undefined ? [] : lifetime.steps.map((step) => runStepResult(engine!, step));
    const row = store.getRun(scenario.runId);
    return {
      ...(constructError === undefined ? {} : { constructError }),
      results,
      run: row === undefined ? null : JSON.parse(JSON.stringify(row)),
      disposed,
    };
  });
  const stored = store.listEvents(scenario.runId, { types: "all", reportItems: "all" });
  return {
    // The inputs are part of the fixture so Rust drives the same steps. A NaN step value is written as null.
    input: scenario,
    lifetimes,
    events: stored.map((entry) => ({
      sequence: entry.sequence,
      payloadJson: JSON.stringify(entry.event),
    })),
  };
}

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "../../packages/rust-cli/crates/workflow/fixtures/lifecycle-goldens.json");
const results = scenarios.map(runScenario);
writeFileSync(out, `${JSON.stringify({ scenarios: results }, null, 2)}\n`);
console.log(`wrote ${results.length} lifecycle scenarios to ${out}`);
