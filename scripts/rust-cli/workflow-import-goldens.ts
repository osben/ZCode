#!/usr/bin/env -S pnpm exec tsx
/**
 * Node side of the resume, amend and world-row goldens (rust-cli crates/workflow, W5b; specs/fork-rust-workflow-engine.md
 * section 9.5).
 *
 * Runs the real `WorkflowEngine` (apps/zcode-cli/packages/dynamic-workflow/src/engine/engine.ts) and the real import
 * builder (apps/zcode-cli/packages/bootstrap/src/app/dynamic-workflow-import.ts) with a recording driver, and writes
 * packages/rust-cli/crates/workflow/fixtures/import-goldens.json. Per scenario, the runs share one journal store, in
 * order (a predecessor run first, then the successor that imports from it). Per run and lifetime it records: the
 * preflight and build outcome (the cache or the refusal), the step results, the constructor error, the run, node and
 * actor rows, and the dispose count. For the whole scenario it records every settlement of an ask or world-read
 * promise (in settlement order), every driver call (in call order, with the session seed), and every event as the
 * exact `JSON.stringify` text.
 *
 * The builder module imports `TERMINAL_RUN_STATUSES` from `dynamic-workflow-run-observation.ts`, which pulls the whole
 * bootstrap graph (`@zcode/*` runtime imports that tsx cannot resolve outside the app build). This generator answers
 * that one module with a resolve hook, carrying the same set (`completed`, `errored`, `stopped`, as in the source).
 * Nothing else in the builder is replaced.
 *
 * Driver-owned fields are simulated as the production driver writes them: `setBoundary` writes `messageBoundary` on an
 * ask row (workflow-driver-transcript.ts), and `transcriptCounts` answers the message count of a session.
 *
 * Scenarios are the source of truth (workflow-import-scenarios.ts, next to this file); edit them there and regenerate from the repository root:
 *   pnpm exec tsx scripts/rust-cli/workflow-import-goldens.ts
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";
import { WorkflowEngine } from "../../apps/zcode-cli/packages/dynamic-workflow/src/engine/engine.ts";
import { InMemoryJournalStore } from "../../apps/zcode-cli/packages/dynamic-workflow/src/engine/journal-memory.ts";
import {
  WorkflowError,
  refToString,
  type AskSpec,
} from "../../apps/zcode-cli/packages/dynamic-workflow/src/engine/types.ts";

// Answers only the module that drags in the bootstrap graph. The set is the one in dynamic-workflow-run-observation.ts.
const TERMINAL_STUB =
  'export const TERMINAL_RUN_STATUSES = new Set(["completed", "errored", "stopped"]);';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith("dynamic-workflow-run-observation.js")) {
      return {
        url: `data:text/javascript,${encodeURIComponent(TERMINAL_STUB)}`,
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});

import { scenarios, type Ref, type Scenario, type Step } from "./workflow-import-scenarios.ts";
const STRING_SCHEMA = { type: "string" };
const askSpecs = (): Map<string, AskSpec> =>
  new Map<string, AskSpec>([
    ["ask#1", { typed: true, schema: STRING_SCHEMA }],
    ["ask#2", { typed: true, schema: STRING_SCHEMA }],
    ["free#1", { typed: false }],
  ]);

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

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

/** The engine addresses an instance as {siteId, ordinal}; the scenarios write {site, ordinal}. */
function instanceOf(at: Ref): { siteId: string; ordinal: number } {
  return { siteId: at.site, ordinal: at.ordinal };
}

/** Map → plain object in insertion order, the shape the Rust fixture reader expects. */
function jsonOf(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) =>
      item instanceof Map ? Object.fromEntries(item) : item,
    ),
  );
}

/** Runs one scenario on one shared store and returns its golden record. */
async function runScenario(scenario: Scenario): Promise<unknown> {
  const store = new InMemoryJournalStore();
  const { buildImportedCache, preflightAmendImport } =
    await import("../../apps/zcode-cli/packages/bootstrap/src/app/dynamic-workflow-import.ts");
  const outcomes: unknown[] = [];
  const driverCalls: unknown[] = [];
  const counts = scenario.transcriptCounts ?? {};
  // World reads are matched by the tag of the step that made the call: the driver is called synchronously in it.
  const worldPending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();
  let currentTag = "";
  let currentRunId = "";
  let disposed = 0;
  const driver = {
    journal: store,
    emit: () => {},
    createActorSession: (
      actor: { siteId: string; ordinal: number },
      _persona: unknown,
      seed?: unknown,
    ) => {
      const key = refToString(actor as never);
      driverCalls.push({
        op: "createActorSession",
        actor: key,
        seed: seed === undefined ? null : seed,
      });
      return Promise.resolve({ id: `sess:${currentRunId}/${key}` });
    },
    startAsk: (
      session: { id: string },
      instance: unknown,
      message: { instructions: string; typed?: boolean },
    ) => {
      driverCalls.push({
        op: "startAsk",
        session: session.id,
        instance: refToString(instance as never),
        instructions: message.instructions,
        typed: message.typed ?? false,
      });
    },
    respondToSubmit: (instance: unknown, verdict: unknown) => {
      driverCalls.push({
        op: "respondToSubmit",
        instance: refToString(instance as never),
        verdict,
      });
    },
    cancelAsk: (instance: unknown) => {
      driverCalls.push({ op: "cancelAsk", instance: refToString(instance as never) });
    },
    executeWorldRead: (op: string, args: unknown[]) => {
      driverCalls.push({ op: "executeWorldRead", worldOp: op, args });
      return new Promise((resolve, reject) => {
        worldPending.set(currentTag, { resolve, reject });
      });
    },
    dispose: () => {
      disposed += 1;
    },
  };
  const track = (tag: string, promise: Promise<unknown>): void => {
    promise.then(
      (value) => outcomes.push({ tag, ok: true, value: value ?? null }),
      (error) => outcomes.push({ tag, ok: false, error: errorJson(error) }),
    );
  };
  const runs: unknown[] = [];
  for (const run of scenario.runs) {
    currentRunId = run.runId;
    const lifetimes: unknown[] = [];
    for (const lifetime of run.lifetimes) {
      let build: unknown = null;
      let importedCache: unknown;
      if (run.importFrom !== undefined) {
        const preflight = preflightAmendImport(store, run.importFrom);
        const built = await buildImportedCache(
          {
            journal: store,
            actorTranscriptStore: {
              messages: ({ sessionID }: { sessionID: string }) => {
                const count = counts[sessionID];
                if (count === undefined) return Promise.reject(new Error("no transcript"));
                return Promise.resolve(Array.from({ length: count }, () => ({})));
              },
            },
          } as never,
          run.importFrom,
        );
        build = jsonOf({ preflight, built });
        if (built.ok) importedCache = built.cache;
      }
      let constructError: unknown;
      let engine: WorkflowEngine | undefined;
      try {
        engine = new WorkflowEngine({
          runId: run.runId,
          driver,
          caps: { maxConcurrency: lifetime.caps },
          askSpecs: askSpecs(),
          validate,
          sitePhases: new Map(),
          ...(importedCache === undefined ? {} : { importedCache }),
          ...(run.importFrom === undefined ? {} : { resumedFrom: run.importFrom }),
        } as never);
      } catch (error) {
        constructError = errorJson(error);
      }
      const results: unknown[] = [];
      // A resumed ask is redispatched only after its session exists, which takes a turn of the job queue.
      await flush();
      for (const step of lifetime.steps) {
        results.push(await runStep(engine, step));
        await flush();
      }
      const row = store.getRun(run.runId);
      lifetimes.push({
        build,
        ...(constructError === undefined ? {} : { constructError }),
        results,
        run: row === undefined ? null : jsonOf(row),
        nodes: jsonOf(store.listNodes(run.runId, { kinds: "all", withResult: true })),
        actors: jsonOf(store.listActors(run.runId, { withPersona: true })),
        disposed,
      });
      disposed = 0;
    }
    runs.push({ runId: run.runId, lifetimes });
  }
  return {
    name: scenario.name,
    input: scenario,
    runs,
    outcomes,
    driverCalls,
    events: scenario.runs.flatMap((run) =>
      store.listEvents(run.runId, { types: "all", reportItems: "all" }).map((entry) => ({
        runId: run.runId,
        sequence: entry.sequence,
        payloadJson: JSON.stringify(entry.event),
      })),
    ),
  };

  async function runStep(engine: WorkflowEngine | undefined, step: Step): Promise<unknown> {
    if (engine === undefined) return null;
    switch (step.op) {
      case "createActor":
        try {
          return { actorId: engine.createActor(step.site, step.name, step.persona) };
        } catch (error) {
          return { error: errorJson(error) };
        }
      case "ask":
        track(step.tag, engine.ask(step.site, step.actor, step.instructions));
        return null;
      case "worldRead":
        currentTag = step.tag;
        track(step.tag, engine.worldRead(step.site, step.worldOp, step.args));
        currentTag = "";
        return null;
      case "worldDone": {
        const pending = worldPending.get(step.tag);
        if (pending === undefined)
          throw new Error(
            `no pending world read for tag ${step.tag}: ${JSON.stringify(driverCalls)} ${JSON.stringify(outcomes)}`,
          );
        worldPending.delete(step.tag);
        if (step.ok) pending.resolve(step.value);
        else pending.reject(new Error(step.message ?? "failed"));
        return null;
      }
      case "askMutating":
        engine.askMutating(instanceOf(step.at));
        return null;
      case "setBoundary": {
        const row = store.getNode(currentRunId, step.at.site, step.at.ordinal);
        if (row !== undefined) store.putNode({ ...row, messageBoundary: step.boundary });
        return null;
      }
      case "submit":
        // A submit settles the ask once its turn ends; the scenario macro ends the turn right after.
        engine.askSubmitAttempted(instanceOf(step.at), step.payload);
        engine.askTurnEnded(instanceOf(step.at), "");
        return null;
      case "stats":
        engine.askStats(instanceOf(step.at), step.stats);
        return null;
      case "complete":
        engine.complete(step.artifact);
        return null;
      case "stop":
        engine.stop(step.reason);
        return null;
    }
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "../../packages/rust-cli/crates/workflow/fixtures/import-goldens.json");

async function main(): Promise<void> {
  const results: unknown[] = [];
  for (const scenario of scenarios) {
    results.push(await runScenario(scenario));
  }
  writeFileSync(out, `${JSON.stringify({ scenarios: results }, null, 2)}\n`);
  console.log(`wrote ${results.length} import scenarios to ${out}`);
}

void main();
