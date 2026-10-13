/**
 * Reason for the split: journal-contract.ts hit the oxlint max-lines cap (400 lines), so the actor-record and
 * node-record cases (ask / world / report rows, absent keys, messageBoundary backfill) moved into this file;
 * the public surface is still exported from journal-contract.ts (`runJournalStoreContract` calls each topic's
 * registration function in the original order).
 *
 * Note: only `it(...)` cases are registered here and no describe is opened — the suite's grouping and case order
 * must stay verbatim identical to before the split.
 */

import { expect, it } from "vitest";
import type { ActorRecord, JournalStorePort, NodeRecord } from "../engine/index.js";
import { baseRun } from "./journal-contract-helpers.js";

export function registerNodeCases(factory: () => JournalStorePort): void {
  it("puts, gets and lists actors keyed by (siteId, ordinal)", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    store.putActor({ runId: "r1", siteId: "actor#1", ordinal: 1, name: "planner" });
    store.putActor({ runId: "r1", siteId: "actor#1", ordinal: 2, name: "planner" });
    expect(store.getActor("r1", "actor#1", 1)?.name).toBe("planner");
    expect(store.getActor("r1", "actor#1", 3)).toBeUndefined();
    expect(store.listActors("r1", { withPersona: true })).toHaveLength(2);
    // Idempotent overwrite: writing again with the same key updates sessionId.
    store.putActor({
      runId: "r1",
      siteId: "actor#1",
      ordinal: 1,
      name: "planner",
      sessionId: "s1",
    });
    expect(store.getActor("r1", "actor#1", 1)?.sessionId).toBe("s1");
    expect(store.listActors("r1", { withPersona: true })).toHaveLength(2);
  });

  it("round-trips the frozen persona and the driver-resolved model on an actor", () => {
    // persona is the frozen identity, resolvedModel is a host fact (which model the subagent actually ran on).
    // The two are stored in separate columns: persona is written synchronously by the engine at createActor time,
    // and at that moment the host has not created the session yet, so there is no model to record.
    const store = factory();
    store.createRun(baseRun("r1"));
    const record: ActorRecord = {
      runId: "r1",
      siteId: "actor#1",
      ordinal: 1,
      name: "judge",
      persona: { name: "judge", system: "You judge." },
      sessionId: "s1",
      resolvedModel: "provider/small-model",
    };
    store.putActor(record);
    expect(store.getActor("r1", "actor#1", 1)).toEqual(record);
  });

  it("keeps an absent resolvedModel absent (not a null / undefined key)", () => {
    // Historical rows from before 0021 and rows where "the host has not resolved yet" both take this path: absent
    // must deserialize as an absent key, otherwise callers doing toEqual on the whole record (as in the previous
    // case) all fail after the upgrade.
    const store = factory();
    store.createRun(baseRun("r1"));
    store.putActor({ runId: "r1", siteId: "actor#1", ordinal: 1, name: "judge" });
    const record = store.getActor("r1", "actor#1", 1)!;
    expect(record.resolvedModel).toBeUndefined();
    expect(record).toEqual({ runId: "r1", siteId: "actor#1", ordinal: 1, name: "judge" });
  });

  it("puts, gets and lists nodes", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    const node: NodeRecord = {
      runId: "r1",
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorSeq: 0,
      inputHash: "abc",
      status: "completed",
      result: { ok: true },
    };
    store.putNode(node);
    expect(store.getNode("r1", "ask#1", 1)).toEqual(node);
    expect(store.getNode("r1", "ask#1", 2)).toBeUndefined();
    expect(store.listNodes("r1", { kinds: "all", withResult: true })).toHaveLength(1);
  });

  it("round-trips a world-read node's bounded input and keeps it absent elsewhere", () => {
    // The workspace transcript has to tell *what ran* (docs/dynamic-workflow/transcript-and-notifications.md):
    // `{op, args}` is written in the same admission as inputHash, and the settled whole-record replacement must
    // bring it back verbatim; ask rows do not have it, and it is an **absent key** (not an undefined value),
    // otherwise both toEqual and the reader-side `"input" in row` would lie.
    const store = factory();
    store.createRun(baseRun("r1"));
    const node: NodeRecord = {
      runId: "r1",
      siteId: "world-read#1",
      ordinal: 1,
      kind: "world-run",
      inputHash: "wh",
      input: { op: "run", args: ["pnpm", ["vitest", "run"], { timeoutMs: 60_000 }] },
      status: "running",
    };
    store.putNode(node);
    expect(store.getNode("r1", "world-read#1", 1)).toEqual(node);
    const settled: NodeRecord = {
      ...node,
      status: "completed",
      result: { exitCode: 1, stdout: "", stderr: "boom" },
    };
    store.putNode(settled);
    expect(store.getNode("r1", "world-read#1", 1)).toEqual(settled);
    const truncated: NodeRecord = {
      ...node,
      siteId: "world-read#2",
      input: { op: "run", args: ["node", "-e …"], truncated: true },
    };
    store.putNode(truncated);
    expect(store.getNode("r1", "world-read#2", 1)?.input).toEqual(truncated.input);
    const ask = store.getNode("r1", "ask#1", 1);
    expect(ask === undefined || !("input" in ask)).toBe(true);
  });

  it("stores a report node: one write, already completed, no actor coordinates", () => {
    // The report node is the sole exception to the two-write "admit running → settle" rule (there is no driver call
    // between admission and settlement). Its stored shape is therefore assertable: a single putNode, status always
    // completed, the three actor columns absent, and result being the reported item. Both implementations must read
    // it back verbatim, otherwise the Results panel and the completion notification would show the storage layer's
    // artifacts.
    const store = factory();
    store.createRun(baseRun("r1"));
    const report: NodeRecord = {
      runId: "r1",
      siteId: "report#1",
      ordinal: 2,
      kind: "report",
      inputHash: "rh",
      status: "completed",
      result: { finding: "duplicate impl", paths: ["a.ts", "b.ts"] },
    };
    store.putNode(report);

    const stored = store.getNode("r1", "report#1", 2);
    expect(stored).toEqual(report);
    expect(stored !== undefined && "actorSeq" in stored).toBe(false);
    expect(stored !== undefined && "actorSiteId" in stored).toBe(false);
    expect(
      store.listNodes("r1", { kinds: "all", withResult: true }).filter((n) => n.kind === "report"),
    ).toHaveLength(1);
  });

  it("keeps a null node result distinguishable from an absent one", () => {
    // The result type is unknown: a null returned by `ask<T | null>` is a real result, not "no result yet".
    // If a storage implementation collapses undefined and null together into SQL NULL, this distinction disappears
    // in the round-trip.
    const store = factory();
    store.createRun(baseRun("r1"));
    const nulled: NodeRecord = {
      runId: "r1",
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      inputHash: "h",
      status: "completed",
      result: null,
    };
    const absent: NodeRecord = {
      runId: "r1",
      siteId: "ask#2",
      ordinal: 1,
      kind: "ask",
      inputHash: "h",
      status: "running",
    };
    store.putNode(nulled);
    store.putNode(absent);

    expect(store.getNode("r1", "ask#1", 1)).toEqual(nulled);
    const stored = store.getNode("r1", "ask#2", 1);
    expect(stored).toEqual(absent);
    // An absent optional field must come back absent as-is (not become result: null / result: undefined).
    expect(stored !== undefined && "result" in stored).toBe(false);
  });

  // messageBoundary is the length (count offset) of the actor session's message log once the ask settles; the
  // driver backfills it after settle (docs/execution-engine.md "Amend-resume"). It is part of the contract:
  // it is the only truncation basis when an amended resume does full-fidelity transcript truncation, and if SQLite
  // fails to write this column, the predecessor becomes a "predecessor without marker" — the whole amend is
  // structurally rejected.
  it("round-trips an ask node's messageBoundary and keeps it absent when unrecorded", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    const bounded: NodeRecord = {
      runId: "r1",
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorSeq: 0,
      inputHash: "h1",
      status: "completed",
      result: "done",
      stats: { tokens: 120, toolCalls: 2, turns: 3 },
      messageBoundary: 9,
    };
    // 0 is a legal boundary (zero messages copied) and must be distinguishable from "no boundary was ever
    // recorded" — this is exactly the practical use of absent-key semantics for this column.
    const zero: NodeRecord = {
      ...bounded,
      siteId: "ask#2",
      actorSeq: 1,
      inputHash: "h2",
      messageBoundary: 0,
    };
    const unrecorded: NodeRecord = {
      runId: "r1",
      siteId: "ask#3",
      ordinal: 1,
      kind: "ask",
      inputHash: "h3",
      status: "running",
    };
    store.putNode(bounded);
    store.putNode(zero);
    store.putNode(unrecorded);

    expect(store.getNode("r1", "ask#1", 1)).toEqual(bounded);
    expect(store.getNode("r1", "ask#2", 1)?.messageBoundary).toBe(0);
    const bare = store.getNode("r1", "ask#3", 1);
    expect(bare).toEqual(unrecorded);
    expect(bare !== undefined && "messageBoundary" in bare).toBe(false);
  });

  // The driver's backfill shape: getNode reads back the settled row the engine just wrote, spreads it verbatim,
  // then adds the boundary column. It is in the same family as the stats backfill and carries the same risk —
  // putNode is a whole-record replacement, so if the implementation drops any column in the round-trip
  // (result / stats / the three actor columns / inputHash), this backfill wipes it out.
  it("preserves every other field when backfilling messageBoundary read-modify-write", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    const settled: NodeRecord = {
      runId: "r1",
      siteId: "ask#1",
      ordinal: 2,
      kind: "ask",
      actorSiteId: "actor#3",
      actorOrdinal: 1,
      actorSeq: 4,
      inputHash: "abc",
      status: "completed",
      result: { verdict: "ship it", notes: [1, 2, 3] },
      stats: { tokens: 512, toolCalls: 7, turns: 5 },
    };
    store.putNode(settled);

    const recorded = store.getNode("r1", "ask#1", 2)!;
    store.putNode({ ...recorded, messageBoundary: 14 });

    expect(store.getNode("r1", "ask#1", 2)).toEqual({ ...settled, messageBoundary: 14 });
  });
}
