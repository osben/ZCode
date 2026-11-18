#!/usr/bin/env -S pnpm exec tsx
/**
 * Node side of the holes, artifacts and reports goldens (rust-cli crates/workflow, W5c;
 * specs/fork-rust-workflow-engine.md section 9.6).
 *
 * Runs the real `WorkflowEngine` (apps/zcode-cli/packages/dynamic-workflow/src/engine/engine.ts) on
 * `InMemoryJournalStore` with a recording driver, for the scenarios below, and writes
 * packages/rust-cli/crates/workflow/fixtures/holes-goldens.json:
 * - the scenario input (the steps of every lifetime, so Rust replays the same calls);
 * - per lifetime: the result of every step, the constructor error, the run row, the node rows
 *   (with results), the open holes and the filled holes after the lifetime;
 * - for the whole run: every outcome of a hole or an artifact promise (in settlement order), every
 *   driver publish request (in call order), and every event as the exact `JSON.stringify` text.
 *
 * The clock is explicit: every step carries `now`, and the engine's injected clock returns it, so the
 * hole timestamps are the same numbers on both sides. Driver publishes are controlled by steps
 * (`publishSettle`), so the order of settlements is the order of the steps.
 *
 * Scenarios are the source of truth; edit them here and regenerate:
 *   pnpm --dir <repo root> exec tsx <abs path to this file>
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkflowEngine } from "../../apps/zcode-cli/packages/dynamic-workflow/src/engine/engine.ts";
import { InMemoryJournalStore } from "../../apps/zcode-cli/packages/dynamic-workflow/src/engine/journal-memory.ts";
import {
  WorkflowError,
  type RunEvent,
  type RunStopReason,
  type WorkflowDriver,
  type WorkflowErrorCode,
} from "../../apps/zcode-cli/packages/dynamic-workflow/src/engine/types.ts";

type Step =
  | { op: "phase"; name: string; now: number }
  | { op: "report"; site: string; item: unknown; artifactId?: string; now: number }
  | {
      op: "declare";
      site: string;
      preset: "chart" | "table" | "metrics" | "board";
      args: unknown[];
      now: number;
    }
  | {
      op: "publish";
      tag: string;
      site: string;
      kind: "file" | "markdown";
      args: unknown[];
      now: number;
    }
  | {
      op: "publishSettle";
      tag: string;
      ok: boolean;
      error?: { code: WorkflowErrorCode; message: string };
      now: number;
    }
  | { op: "hole"; tag: string; site: string; name: string; prompt?: string; now: number }
  | {
      op: "fill";
      site: string;
      code: string;
      script: { text: string; hash: string };
      sitePhases?: Record<string, string>;
      phaseNames: string[];
      holes?: number[];
      filledBy?: string;
      scriptPath?: string;
      now: number;
    }
  | { op: "complete"; artifact: unknown; now: number }
  | {
      op: "stop";
      reason: RunStopReason;
      error?: { code: WorkflowErrorCode; message: string };
      now: number;
    };

interface Lifetime {
  scriptHash?: string;
  steps: Step[];
}

interface Scenario {
  name: string;
  runId: string;
  caps: number;
  sitePhases?: Record<string, string>;
  lifetimes: Lifetime[];
}

const HASH = "h-holes";

const scenarios: Scenario[] = [
  {
    // Reports (untagged and tagged), a declared chart and table, an identical re-declaration (no
    // event), an interrupted stop, and a resumed lifetime that repeats the calls in order: the
    // declarations and the reports replay as deduplicated, and the new report continues the tally.
    name: "reports-and-presets-resume",
    runId: "run_reports",
    caps: 2,
    lifetimes: [
      {
        scriptHash: HASH,
        steps: [
          { op: "phase", name: "plan", now: 10 },
          {
            op: "declare",
            site: "artifact.chart#1",
            preset: "chart",
            args: ["perf", { title: "Perf", x: { field: "t" }, y: [{ field: "v", label: "V" }] }],
            now: 11,
          },
          {
            op: "declare",
            site: "artifact.table#1",
            preset: "table",
            args: ["rows", { title: "Rows", columns: [{ field: "a" }], key: "a" }],
            now: 12,
          },
          {
            op: "declare",
            site: "artifact.chart#2",
            preset: "chart",
            args: ["perf", { title: "Perf", x: { field: "t" }, y: [{ field: "v", label: "V" }] }],
            now: 13,
          },
          { op: "report", site: "report#1", item: { n: 1 }, now: 14 },
          {
            op: "report",
            site: "report#2",
            item: { n: 2, tags: ["a", "b"] },
            artifactId: "perf",
            now: 15,
          },
          { op: "phase", name: "work", now: 16 },
          { op: "report", site: "report#3", item: "三", artifactId: "rows", now: 17 },
          {
            op: "stop",
            reason: "interrupted",
            error: { code: "Interrupted", message: "sandbox exited" },
            now: 18,
          },
        ],
      },
      {
        scriptHash: HASH,
        steps: [
          { op: "phase", name: "plan", now: 20 },
          {
            op: "declare",
            site: "artifact.chart#1",
            preset: "chart",
            args: ["perf", { title: "Perf", x: { field: "t" }, y: [{ field: "v", label: "V" }] }],
            now: 21,
          },
          {
            op: "declare",
            site: "artifact.table#1",
            preset: "table",
            args: ["rows", { title: "Rows", columns: [{ field: "a" }], key: "a" }],
            now: 22,
          },
          {
            op: "declare",
            site: "artifact.chart#2",
            preset: "chart",
            args: ["perf", { title: "Perf", x: { field: "t" }, y: [{ field: "v", label: "V" }] }],
            now: 23,
          },
          { op: "report", site: "report#1", item: { n: 1 }, now: 24 },
          {
            op: "report",
            site: "report#2",
            item: { n: 2, tags: ["a", "b"] },
            artifactId: "perf",
            now: 25,
          },
          { op: "phase", name: "work", now: 26 },
          { op: "report", site: "report#3", item: "三", artifactId: "rows", now: 27 },
          { op: "report", site: "report#4", item: [null, 1.5e21], now: 28 },
          { op: "complete", artifact: { done: true }, now: 29 },
        ],
      },
    ],
  },
  {
    // A report tagged with an undeclared preset fails the run (ArtifactUndeclared) and the later
    // report is ignored. A declaration with a different spec for a declared id fails the run too.
    name: "report-undeclared-and-redeclared",
    runId: "run_undeclared",
    caps: 1,
    lifetimes: [
      {
        scriptHash: HASH,
        steps: [
          {
            op: "declare",
            site: "artifact.metrics#1",
            preset: "metrics",
            args: ["kpi", { title: "KPI", metrics: [{ field: "x" }] }],
            now: 1,
          },
          { op: "report", site: "report#1", item: { x: 1 }, artifactId: "kpi", now: 2 },
          { op: "report", site: "report#2", item: { x: 2 }, artifactId: "missing", now: 3 },
          { op: "report", site: "report#3", item: { x: 3 }, now: 4 },
        ],
      },
    ],
  },
  {
    // Redeclaration with a different spec, and a kind mismatch, each fail the run. Declarations are
    // validated before the idempotency check, so an invalid spec fails first.
    name: "declare-redeclared-and-invalid",
    runId: "run_redeclared",
    caps: 1,
    lifetimes: [
      {
        scriptHash: HASH,
        steps: [
          {
            op: "declare",
            site: "artifact.board#1",
            preset: "board",
            args: ["flow", { key: "id", status: "stage", columns: ["todo", "done"] }],
            now: 1,
          },
          {
            op: "declare",
            site: "artifact.board#2",
            preset: "board",
            args: ["flow", { key: "id", status: "stage", columns: ["todo", "doing", "done"] }],
            now: 2,
          },
        ],
      },
      {
        scriptHash: HASH,
        steps: [
          {
            op: "declare",
            site: "artifact.table#9",
            preset: "table",
            args: ["bad", { columns: [] }],
            now: 3,
          },
        ],
      },
    ],
  },
  {
    // Content publications: a file, a markdown with the same id (a second version), a publish that
    // the driver rejects (a failed row, no version), a primary declaration that conflicts with the
    // one already set, and a resumed lifetime that replays the completed and failed rows through
    // the settle-order gate. The second lifetime calls the publishes in the reverse of the order the
    // first lifetime settled them, so the gate has to release them in the recorded order.
    name: "publish-settle-order-and-replay",
    runId: "run_publish",
    caps: 4,
    lifetimes: [
      {
        scriptHash: HASH,
        steps: [
          {
            op: "publish",
            tag: "p1",
            site: "pub#1",
            kind: "file",
            args: ["doc", "out/a.pdf", { primary: true }],
            now: 1,
          },
          {
            op: "publish",
            tag: "p2",
            site: "pub#2",
            kind: "markdown",
            args: ["notes", "# hi"],
            now: 2,
          },
          { op: "publishSettle", tag: "p2", ok: true, now: 3 },
          { op: "publishSettle", tag: "p1", ok: true, now: 4 },
          {
            op: "publish",
            tag: "p3",
            site: "pub#3",
            kind: "markdown",
            args: ["notes", "# v2"],
            now: 5,
          },
          {
            op: "publishSettle",
            tag: "p3",
            ok: false,
            error: { code: "DriverError", message: "disk full" },
            now: 6,
          },
          {
            op: "publish",
            tag: "p4",
            site: "pub#4",
            kind: "markdown",
            args: ["notes", "# v2 again"],
            now: 7,
          },
          { op: "publishSettle", tag: "p4", ok: true, now: 8 },
          {
            op: "publish",
            tag: "p5",
            site: "pub#5",
            kind: "markdown",
            args: ["extra", "x"],
            now: 9,
          },
          {
            op: "publish",
            tag: "p6",
            site: "pub#6",
            kind: "file",
            args: ["other", "b.pdf", { primary: true }],
            now: 10,
          },
          { op: "publishSettle", tag: "p5", ok: true, now: 11 },
          {
            op: "stop",
            reason: "interrupted",
            error: { code: "Interrupted", message: "sandbox exited" },
            now: 13,
          },
        ],
      },
      {
        scriptHash: HASH,
        steps: [
          {
            op: "publish",
            tag: "q5",
            site: "pub#5",
            kind: "markdown",
            args: ["extra", "x"],
            now: 20,
          },
          {
            op: "publish",
            tag: "q4",
            site: "pub#4",
            kind: "markdown",
            args: ["notes", "# v2 again"],
            now: 21,
          },
          {
            op: "publish",
            tag: "q1",
            site: "pub#1",
            kind: "file",
            args: ["doc", "out/a.pdf", { primary: true }],
            now: 22,
          },
          {
            op: "publish",
            tag: "q3",
            site: "pub#3",
            kind: "markdown",
            args: ["notes", "# v2"],
            now: 23,
          },
          {
            op: "publish",
            tag: "q2",
            site: "pub#2",
            kind: "markdown",
            args: ["notes", "# hi"],
            now: 24,
          },
          {
            op: "publish",
            tag: "q7",
            site: "pub#7",
            kind: "file",
            args: ["third", "c.pdf"],
            now: 25,
          },
          { op: "publishSettle", tag: "q7", ok: true, now: 26 },
          {
            op: "publish",
            tag: "q8",
            site: "pub#8",
            kind: "file",
            args: ["doc", "d.pdf", {}],
            now: 27,
          },
          { op: "publishSettle", tag: "q8", ok: true, now: 28 },
          { op: "complete", artifact: null, now: 29 },
        ],
      },
    ],
  },
  {
    // Holes: two branches park at one site and both release on a fill; a third reach at the same site
    // is answered from memory with no event; a fill for a site nobody waits on is `not_waiting`; a
    // hole still parked when the run stops is rejected. The resumed lifetime starts with no open or
    // filled holes, and the script reaches the same sites again.
    name: "holes-fill-and-stop",
    runId: "run_holes",
    caps: 1,
    lifetimes: [
      {
        scriptHash: HASH,
        steps: [
          { op: "phase", name: "pick", now: 0 },
          { op: "hole", tag: "h1", site: "hole#1", name: "pick", prompt: "Which file?", now: 1 },
          { op: "hole", tag: "h2", site: "hole#1", name: "pick", now: 2 },
          {
            op: "fill",
            site: "hole#1",
            code: "(async () => { return 1; })",
            script: { text: "script v2", hash: "h-filled" },
            sitePhases: { "hole#2": "late" },
            phaseNames: ["plan", "pick"],
            holes: [],
            filledBy: "sess-1",
            scriptPath: "/tmp/draft.ts",
            now: 3,
          },
          { op: "hole", tag: "h3", site: "hole#1", name: "pick", now: 4 },
          {
            op: "fill",
            site: "hole#9",
            code: "(async () => {})",
            script: { text: "script v3", hash: "h-filled-2" },
            phaseNames: ["plan"],
            now: 5,
          },
          {
            op: "hole",
            tag: "h4",
            site: "hole#2",
            name: "review",
            prompt: "x".repeat(4100),
            now: 6,
          },
          { op: "stop", reason: "user", now: 7 },
        ],
      },
      {
        scriptHash: "h-filled",
        steps: [
          { op: "hole", tag: "r1", site: "hole#1", name: "pick", now: 10 },
          { op: "hole", tag: "r2", site: "hole#2", name: "review", now: 11 },
          { op: "complete", artifact: "done", now: 12 },
        ],
      },
    ],
  },
];

const clockCell = { now: 0 };
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function errorJson(error: unknown): unknown {
  return error instanceof WorkflowError ? error.toJSON() : { message: String(error) };
}

const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

async function runScenario(scenario: Scenario): Promise<unknown> {
  const store = new InMemoryJournalStore();
  const outcomes: unknown[] = [];
  const driverCalls: unknown[] = [];
  const emitted: RunEvent[] = [];
  let disposed = 0;
  let currentTag = "";
  const pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (reason: unknown) => void;
      request: Record<string, unknown>;
    }
  >();
  const driver: WorkflowDriver = {
    journal: store,
    emit: (event) => {
      emitted.push(event);
    },
    createActorSession: () => Promise.reject(new Error("not used in the holes goldens")),
    startAsk: () => {
      throw new Error("not used in the holes goldens");
    },
    respondToSubmit: () => {
      throw new Error("not used in the holes goldens");
    },
    cancelAsk: () => {
      throw new Error("not used in the holes goldens");
    },
    executeWorldRead: () => Promise.reject(new Error("not used in the holes goldens")),
    executeArtifactPublish: (request) =>
      new Promise((resolve, reject) => {
        driverCalls.push({ op: "executeArtifactPublish", request: plain(request) });
        pending.set(currentTag, {
          resolve,
          reject,
          request: request as unknown as Record<string, unknown>,
        });
      }),
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
  const lifetimes: unknown[] = [];
  for (const lifetime of scenario.lifetimes) {
    let constructError: unknown;
    let engine: WorkflowEngine | undefined;
    try {
      engine = new WorkflowEngine({
        runId: scenario.runId,
        driver,
        caps: { maxConcurrency: scenario.caps },
        askSpecs: new Map(),
        validate: () => [],
        sitePhases: new Map(Object.entries(scenario.sitePhases ?? {})),
        now: () => clockCell.now,
        ...(lifetime.scriptHash === undefined ? {} : { scriptHash: lifetime.scriptHash }),
      });
    } catch (error) {
      constructError = errorJson(error);
    }
    const results: unknown[] = [];
    const runStep = (step: Step): unknown => {
      if (engine === undefined) return null;
      clockCell.now = step.now;
      switch (step.op) {
        case "phase":
          engine.enterPhase(step.name);
          return null;
        case "report":
          engine.report(step.site, step.item, step.artifactId);
          return null;
        case "declare":
          engine.declareArtifact(step.site, step.preset, step.args);
          return null;
        case "publish": {
          currentTag = step.tag;
          track(step.tag, engine.publishArtifact(step.site, step.kind, step.args));
          return null;
        }
        case "publishSettle": {
          const entry = pending.get(step.tag);
          if (entry === undefined) throw new Error(`no pending publish ${step.tag}`);
          if (step.ok) {
            const request = entry.request;
            entry.resolve({
              id: request.id,
              kind: request.op,
              version: request.version,
              uri: `zcode-artifact://${String(request.id)}/v${String(request.version)}`,
              bytes: 4,
              contentType: "text/plain",
              ...(request.op === "file" ? { sourcePath: request.path } : {}),
              publishedAt: step.now,
            });
          } else {
            const error = step.error ?? { code: "DriverError", message: "failed" };
            entry.reject(new WorkflowError(error.code, error.message));
          }
          return null;
        }
        case "hole":
          currentTag = step.tag;
          track(step.tag, engine.hole(step.site, step.name, step.prompt));
          return null;
        case "fill": {
          const specs = new Map();
          const sitePhases = new Map(Object.entries(step.sitePhases ?? {}));
          return engine.fillHole({
            siteId: step.site,
            code: step.code,
            script: step.script,
            askSpecs: specs,
            sitePhases,
            phaseNames: step.phaseNames,
            ...(step.holes === undefined ? {} : { holes: step.holes }),
            ...(step.filledBy === undefined ? {} : { filledBy: step.filledBy }),
            ...(step.scriptPath === undefined ? {} : { scriptPath: step.scriptPath }),
          });
        }
        case "complete":
          engine.complete(step.artifact);
          return null;
        case "stop":
          engine.stop(
            step.reason,
            step.error === undefined
              ? undefined
              : new WorkflowError(step.error.code, step.error.message),
          );
          return null;
      }
    };
    for (const step of lifetime.steps) {
      results.push(runStep(step));
      await flush();
    }
    const row = store.getRun(scenario.runId);
    lifetimes.push({
      ...(constructError === undefined ? {} : { constructError }),
      results: plain(results),
      run: row === undefined ? null : plain(row),
      nodes: plain(store.listNodes(scenario.runId, { kinds: "all", withResult: true })),
      openHoles: engine === undefined ? [] : plain(engine.openHoles()),
      filledHoles: engine === undefined ? [] : plain(engine.filledHoles()),
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
const out = join(here, "../../packages/rust-cli/crates/workflow/fixtures/holes-goldens.json");

async function main(): Promise<void> {
  const results: unknown[] = [];
  for (const scenario of scenarios) {
    try {
      results.push(await runScenario(scenario));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`holes scenario "${scenario.name}" failed: ${reason}`, { cause: error });
    }
  }
  writeFileSync(out, `${JSON.stringify({ scenarios: results }, null, 2)}\n`);
  console.log(`wrote ${results.length} holes scenarios to ${out}`);
}

void main();
