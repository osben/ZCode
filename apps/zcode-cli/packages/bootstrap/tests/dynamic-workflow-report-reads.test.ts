// The shape of the host side reading the journal (docs/execution-engine.md "Reading the journal"): report items
// leave the storage layer only when they are about to be shown, and only as many as can be displayed.
//
// - Cold replay: report events after this run's 64th are read back without items, and the reduced state is
//   byte-identical to reading the full log (docs/dynamic-workflow/presentation.md "Cold replay");
// - Amend import: not a single report row is read; whether the predecessor reported or how much, the import tables are the same;
// - Scale: a run that reported all 65,536 items, across terminal snapshot / artifact list / cold replay /
//   GetWorkflowRun / amend import combined, hands exactly 256 + 64 + 64 report items to JavaScript.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSqliteSessionStore, type DwfRunSessionListItem } from "@zcode/adapters/storage";
import {
  ALL_EVENTS,
  InMemoryJournalStore,
  type JournalStorePort,
  type ListNodesOptions,
  type NodeRecord,
  type RunEvent,
  type StoredEvent,
} from "@zcode/dynamic-workflow";
import {
  readWorkflowArtifactField,
  reduceWorkflowRunsState,
  type WorkflowRunsState,
} from "@zcode/shared/zcode-protocol-v4";
import { buildImportedCache, preflightAmendImport } from "../src/app/dynamic-workflow-import.js";
import { listArtifactItemsFrom } from "../src/app/dynamic-workflow-run-artifact-queries.js";
import { artifactsOf, snapshotOf } from "../src/app/dynamic-workflow-run-observation.js";
import {
  COLD_REPLAY_EVENT_READ,
  replayRunProgress,
  replayRunProgressFromEvents,
} from "../src/app/dynamic-workflow-run-replay.js";
import { createRunIntrospectionMethods } from "../src/app/dynamic-workflow-run-introspection.js";
import type { DynamicWorkflowIntrospectableJournal } from "../src/app/dynamic-workflow-run-journal.js";
import { resolveDynamicWorkflowJournalStore } from "../src/app/dynamic-workflow-run-service.js";
import { createWorkflowEscalationRegistry } from "../src/app/workflow-escalation-registry.js";

const PARENT = "sess_report_reads";
const CEILING = 6;

type SqliteJournal = JournalStorePort & {
  listRunsByParentSession(parentSessionId: string, limit: number): DwfRunSessionListItem[];
};

let tempRoot: string;
let store: ReturnType<typeof createSqliteSessionStore>;
let journal: SqliteJournal;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "zcode-dwf-report-reads-"));
  store = createSqliteSessionStore({ dbPath: join(tempRoot, "session.sqlite") });
  const resolved = resolveDynamicWorkflowJournalStore(store as never);
  if (resolved === undefined) throw new Error("sqlite store must expose the dwf journal");
  journal = resolved as SqliteJournal;
});

afterEach(async () => {
  await store.close?.();
  await rm(tempRoot, { force: true, recursive: true });
});

function createRun(runId: string, status: "running" | "completed" = "running"): void {
  journal.createRun({
    runId,
    parentSessionId: PARENT,
    cwd: "/repo",
    toolCallId: `call-${runId}`,
    scriptText: "report(1);",
    scriptHash: "sha-r",
    caps: { maxConcurrency: 4 },
    spentTokens: 0,
    status,
  });
}

function started(runId: string): void {
  journal.appendEvent(runId, {
    type: "run-started",
    runId,
    caps: { maxConcurrency: 4 },
  } as RunEvent);
}

/** One report: node row + event, matching the engine's "one write + one event" shape. */
function report(runId: string, ordinal: number, item: unknown, artifactId?: string): void {
  journal.putNode({
    runId,
    siteId: "report#1",
    ordinal,
    kind: "report",
    inputHash: `h-${ordinal}`,
    status: "completed",
    result: item,
    ...(artifactId === undefined ? {} : { artifactId }),
  });
  journal.appendEvent(runId, {
    type: "report",
    instance: { siteId: "report#1", ordinal },
    item,
    ...(artifactId === undefined ? {} : { artifactId }),
  });
}

function declareChart(runId: string): void {
  const artifact = { id: "perf", kind: "chart", version: 1, publishedAt: 1, spec: {} };
  journal.putNode({
    runId,
    siteId: "artifact#1",
    ordinal: 1,
    kind: "artifact",
    inputHash: "h-artifact",
    status: "completed",
    artifactId: "perf",
    result: artifact,
  });
  journal.appendEvent(runId, {
    type: "artifact-published",
    instance: { siteId: "artifact#1", ordinal: 1 },
    artifact,
  } as unknown as RunEvent);
}

function rowOf(runId: string): DwfRunSessionListItem {
  const row = journal.listRunsByParentSession(PARENT, 8).find((item) => item.runId === runId);
  if (row === undefined) throw new Error(`row missing for ${runId}`);
  return row;
}

function reduce(runId: string, stored: readonly StoredEvent[]): WorkflowRunsState["runs"][number] {
  let state: WorkflowRunsState | undefined;
  for (const payload of replayRunProgressFromEvents(rowOf(runId), stored, CEILING)) {
    state = reduceWorkflowRunsState(state, payload) ?? state;
  }
  const run = state?.runs.find((item) => item.runId === runId);
  if (run === undefined) throw new Error("run not projected");
  return run;
}

function hasItem(stored: StoredEvent): boolean {
  return stored.event.type === "report" && "item" in stored.event;
}

describe("cold replay reads report items only up to the projection's bound", () => {
  it("reduces to the same state from stripped events as from the full log, across two lives", () => {
    const runId = "dwfrun-many-reports";
    createRun(runId);
    started(runId);
    declareChart(runId);
    // First life 90 reports (one labeled every three), then stop; second life adds 60 more and settles.
    for (let ordinal = 1; ordinal <= 90; ordinal += 1) {
      report(
        runId,
        ordinal,
        { finding: ordinal, pad: "x".repeat(200) },
        ordinal % 3 === 0 ? "perf" : undefined,
      );
    }
    journal.appendEvent(runId, {
      type: "run-settled",
      status: "stopped",
      stopReason: "user",
    } as RunEvent);
    started(runId);
    for (let ordinal = 91; ordinal <= 150; ordinal += 1) {
      report(runId, ordinal, `line ${ordinal}`, ordinal % 3 === 0 ? "perf" : undefined);
    }
    journal.updateRunStatus(runId, "completed");

    const full = journal.listEvents(runId, ALL_EVENTS);
    const stripped = journal.listEvents(runId, COLD_REPLAY_EVENT_READ);
    // This case really did reach the stripping: the first 64 reports carry items, the other 86 do not; the event count is unchanged.
    expect(stripped).toHaveLength(full.length);
    expect(stripped.filter(hasItem)).toHaveLength(64);
    expect(stripped.filter((stored) => stored.event.type === "report")).toHaveLength(150);

    const fromFull = reduce(runId, full);
    const fromStripped = reduce(runId, stripped);
    expect(fromStripped).toEqual(fromFull);
    // The reduced state itself makes sense: 64 previews, truncated, and the dashboard counted all 50 labels.
    expect(fromStripped.reports).toHaveLength(64);
    expect(fromStripped.truncated).toBe(true);
    expect(fromStripped.artifacts?.find((artifact) => artifact.id === "perf")?.itemCount).toBe(50);
    // This read is the production entry point.
    let viaEntry: WorkflowRunsState | undefined;
    for (const payload of replayRunProgress(rowOf(runId), journal, CEILING)) {
      viaEntry = reduceWorkflowRunsState(viaEntry, payload) ?? viaEntry;
    }
    expect(viaEntry?.runs.find((run) => run.runId === runId)).toEqual(fromFull);
  });
});

describe("amend import never reads report rows", () => {
  function seedPredecessor(target: JournalStorePort, reports: number): void {
    target.createRun({
      runId: "runA",
      caps: { maxConcurrency: 4 },
      spentTokens: 0,
      status: "completed",
    });
    target.putActor({
      runId: "runA",
      siteId: "actor#1",
      ordinal: 1,
      name: "worker",
      persona: { name: "worker", system: "you work" },
      sessionId: "ses_a",
    });
    for (let seq = 0; seq < 3; seq += 1) {
      target.putNode({
        runId: "runA",
        siteId: "ask#1",
        ordinal: seq + 1,
        kind: "ask",
        actorSiteId: "actor#1",
        actorOrdinal: 1,
        actorSeq: seq,
        inputHash: `ask-${seq}`,
        status: "completed",
        result: `answer ${seq}`,
        messageBoundary: (seq + 1) * 2,
      });
    }
    target.putNode({
      runId: "runA",
      siteId: "files.grep#1",
      ordinal: 1,
      kind: "world-read",
      inputHash: "grep-1",
      status: "completed",
      result: ["a.ts:1"],
    });
    for (let ordinal = 1; ordinal <= reports; ordinal += 1) {
      target.putNode({
        runId: "runA",
        siteId: "report#1",
        ordinal,
        kind: "report",
        inputHash: `r-${ordinal}`,
        status: "completed",
        result: { big: "x".repeat(512) },
      });
    }
  }

  class SpyJournal extends InMemoryJournalStore {
    readonly reads: ListNodesOptions[] = [];
    override listNodes(runId: string, opts: ListNodesOptions): NodeRecord[] {
      this.reads.push(opts);
      return super.listNodes(runId, opts);
    }
  }

  it("builds the same cache whether or not the predecessor reported, without touching report rows", async () => {
    const quiet = new SpyJournal();
    seedPredecessor(quiet, 0);
    const loud = new SpyJournal();
    seedPredecessor(loud, 300);

    expect(preflightAmendImport(loud, "runA")).toMatchObject({ ok: true });
    const a = await buildImportedCache({ journal: quiet }, "runA");
    const b = await buildImportedCache({ journal: loud }, "runA");
    expect(b).toEqual(a);
    expect(b.ok).toBe(true);
    for (const read of loud.reads) {
      expect(read.kinds).not.toBe("all");
      expect(read.kinds).not.toContain("report");
    }
  });
});

describe("a run that reported 65,536 items", () => {
  /** Wrap it: count the report items these reads hand to JavaScript (node rows' result, events' item). */
  function countingJournal(target: SqliteJournal): { journal: SqliteJournal; items: () => number } {
    let items = 0;
    const proxy = new Proxy(target, {
      get(obj, prop, receiver) {
        const value = Reflect.get(obj, prop, receiver) as unknown;
        if (typeof value !== "function") return value;
        const fn = value as (...args: unknown[]) => unknown;
        return (...args: unknown[]) => {
          const out = fn.apply(obj, args);
          if (prop === "listNodes" || prop === "getNode") {
            const rows = (
              Array.isArray(out) ? out : out === undefined ? [] : [out]
            ) as NodeRecord[];
            items += rows.filter((row) => row.kind === "report" && "result" in row).length;
          }
          if (prop === "listEvents") items += (out as StoredEvent[]).filter(hasItem).length;
          return out;
        };
      },
    });
    return { journal: proxy, items: () => items };
  }

  it("hands 256 + 64 + 64 items to the host across snapshot, artifacts, cold replay, GetWorkflowRun and amend", async () => {
    const runId = "dwfrun-65536";
    const total = 65_536;
    createRun(runId);
    started(runId);
    declareChart(runId);
    for (let ordinal = 1; ordinal <= total; ordinal += 1) {
      report(runId, ordinal, { n: ordinal }, ordinal % 2 === 0 ? "perf" : undefined);
    }
    journal.updateRunStatus(runId, "completed");

    const counted = countingJournal(journal);
    // Cold row (no entry in this process's registry): the terminal snapshot reads everything from the journal.
    const snapshot = snapshotOf(runId, new Map(), counted.journal);
    expect(snapshot?.reportCount).toBe(total);
    expect(snapshot?.reports).toHaveLength(256);
    expect(snapshot?.artifacts?.[0]?.itemCount).toBe(total / 2);
    expect(artifactsOf(runId, counted.journal).artifacts?.[0]?.itemCount).toBe(total / 2);

    let state: WorkflowRunsState | undefined;
    for (const payload of replayRunProgress(rowOf(runId), counted.journal, CEILING)) {
      state = reduceWorkflowRunsState(state, payload) ?? state;
    }
    const run = state?.runs.find((item) => item.runId === runId);
    expect(run?.reports).toHaveLength(64);
    expect(run?.artifacts?.find((artifact) => artifact.id === "perf")?.itemCount).toBe(total / 2);

    // GetWorkflowRun: the same event read as cold replay (64 items); node rows carry no results and no report is read.
    const { getRunDetail } = createRunIntrospectionMethods({
      introspection: counted.journal as unknown as DynamicWorkflowIntrospectableJournal,
      journal: counted.journal,
      parentSessionId: PARENT,
      runs: new Map(),
      escalations: createWorkflowEscalationRegistry(),
      defaultConcurrency: () => CEILING,
    });
    const detail = await getRunDetail(runId);
    expect(detail?.status).toBe("completed");
    expect(detail?.artifacts?.[0]?.itemCount).toBe(total / 2);

    expect(preflightAmendImport(counted.journal, runId)).toMatchObject({ ok: true });
    await buildImportedCache({ journal: counted.journal }, runId);

    // Snapshot 256 + cold replay 64 + GetWorkflowRun 64; the artifact list and amend import read none.
    expect(counted.items()).toBe(256 + 64 + 64);
  }, 120_000);
});

describe("report item size: 1 MiB items stay out of JavaScript except where they are shown", () => {
  // docs/execution-engine.md "Progressive results: `report`" and "Reading the journal": after the 1 MiB per-item
  // cap, "read only the first N items" cannot control bytes — every reader also needs a byte bound. What is counted
  // here is the report payload bytes genuinely handed to JavaScript (node rows' result, events' item, dashboard entries' item / fields).
  const ITEM_PAD = 1_000_000;
  const TOTAL = 40;

  function payloadBytes(value: unknown): number {
    return value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value));
  }

  function byteCountingJournal(target: SqliteJournal): {
    journal: SqliteJournal;
    bytes: () => number;
    reset: () => void;
  } {
    let bytes = 0;
    const proxy = new Proxy(target, {
      get(obj, prop, receiver) {
        const value = Reflect.get(obj, prop, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const out = (value as (...inner: unknown[]) => unknown).apply(obj, args);
          if (prop === "listNodes" || prop === "getNode") {
            const rows = (
              Array.isArray(out) ? out : out === undefined ? [] : [out]
            ) as NodeRecord[];
            for (const row of rows) if (row.kind === "report") bytes += payloadBytes(row.result);
          }
          if (prop === "listEvents" || prop === "listEventPage") {
            const events = (
              prop === "listEvents" ? out : (out as { events: StoredEvent[] }).events
            ) as StoredEvent[];
            for (const stored of events) {
              if (stored.event.type === "report")
                bytes += payloadBytes((stored.event as { item?: unknown }).item);
            }
          }
          if (prop === "listArtifactItems") {
            for (const entry of (out as { items: Array<{ item?: unknown; fields?: unknown }> })
              .items) {
              bytes += payloadBytes(entry.item) + payloadBytes(entry.fields);
            }
          }
          return out;
        };
      },
    });
    return { journal: proxy, bytes: () => bytes, reset: () => (bytes = 0) };
  }

  it("bounds the snapshot at 8 MiB, dashboard and event-log pages at 4 MiB, and a field read at the fields", async () => {
    const runId = "dwfrun-big-items";
    createRun(runId);
    started(runId);
    declareChart(runId);
    for (let ordinal = 1; ordinal <= TOTAL; ordinal += 1) {
      report(
        runId,
        ordinal,
        { n: ordinal, pad: "x".repeat(ITEM_PAD) },
        ordinal % 2 === 0 ? "perf" : undefined,
      );
    }
    journal.updateRunStatus(runId, "completed");
    const counted = byteCountingJournal(journal);
    const MiB = 1024 * 1024;

    // Terminal snapshot: the first few items, at most 8 MiB (about 1 MB each, hence 8), with the true total.
    const snapshot = snapshotOf(runId, new Map(), counted.journal);
    expect(snapshot?.reportCount).toBe(TOTAL);
    expect(snapshot?.reports).toHaveLength(8);
    expect(counted.bytes()).toBeLessThanOrEqual(8 * MiB);

    // The dashboard takes fields only: 20 label reports fit on one page, and only 20 small numbers reach JS.
    counted.reset();
    const fieldPage = listArtifactItemsFrom(counted.journal, runId, "perf", {
      limit: 200,
      maxBytes: 4 * MiB,
      fields: ["n"],
    });
    expect(fieldPage.items.map((entry) => entry.fields?.n)).toEqual(
      Array.from({ length: TOTAL / 2 }, (_v, index) => (index + 1) * 2),
    );
    expect(fieldPage.hasMore).toBe(false);
    expect(counted.bytes()).toBeLessThan(1024);

    // The dashboard takes whole items (old renderer): at most 4 MiB per page, hence 4 items, with hasMore reported.
    counted.reset();
    const wholePage = listArtifactItemsFrom(counted.journal, runId, "perf", {
      limit: 200,
      maxBytes: 4 * MiB,
    });
    expect(wholePage.items).toHaveLength(4);
    expect(wholePage.hasMore).toBe(true);
    expect(counted.bytes()).toBeLessThanOrEqual(4 * MiB);

    // One event-log page: likewise at most 4 MiB.
    counted.reset();
    const eventPage = (
      counted.journal as unknown as DynamicWorkflowIntrospectableJournal
    ).listEventPage(runId, {
      limit: 500,
      maxBytes: 4 * MiB,
    });
    expect(eventPage.hasMore).toBe(true);
    expect(counted.bytes()).toBeLessThanOrEqual(4 * MiB);

    // The byte count resume restores: sum(octet_length(result_json)), the same bytes as JSON.stringify at write time.
    const expected = Array.from({ length: TOTAL }, (_v, index) =>
      payloadBytes({ n: index + 1, pad: "x".repeat(ITEM_PAD) }),
    ).reduce((sum, value) => sum + value, 0);
    expect(journal.sumResultBytes(runId, "report")).toBe(expected);
  }, 120_000);

  it("extracts fields in SQLite exactly as the renderer reads them from the whole item", () => {
    // The path rules are a protocol-level contract (readWorkflowArtifactField): the CLI extracts in SQLite and the
    // renderer extracts in JS; the same item and the same path must yield the same value (failure = the key is not in the table).
    const runId = "dwfrun-field-parity";
    createRun(runId);
    started(runId);
    declareChart(runId);
    const items: unknown[] = [
      { a: { b: 1 }, list: [10, { c: "deep" }], flag: false, none: null },
      { a: [{ b: 2 }], list: { "0": "key-zero", "1": { c: "obj" } }, "": { x: 5 } },
      [{ a: 3 }, "tail"],
      "just a string",
      42,
      null,
      {
        weird: { "1e0": "sci", "01": "lead", "-1": "neg" },
        arr: [
          [1, 2],
          [3, [4, 5]],
        ],
      },
    ];
    items.forEach((item, index) => report(runId, index + 1, item, "perf"));
    const paths = [
      "a.b",
      "a.0.b",
      "list.0",
      "list.1.c",
      "flag",
      "none",
      "missing",
      ".x",
      "0.a",
      "1",
      "weird.1e0",
      "weird.01",
      "weird.-1",
      "arr.1.1.0",
      "arr.1e0.0",
      "arr.01.1.1",
      "a.b.c",
    ];

    const page = listArtifactItemsFrom(journal, runId, "perf", {
      limit: 50,
      maxBytes: 1 << 30,
      fields: paths,
    });
    expect(page.items).toHaveLength(items.length);
    page.items.forEach((entry, index) => {
      const expected: Record<string, unknown> = {};
      for (const path of paths) {
        const value = readWorkflowArtifactField(items[index], path);
        if (value !== undefined) expected[path] = value;
      }
      expect(entry.fields, `item ${index}`).toEqual(expected);
    });
  });
});
