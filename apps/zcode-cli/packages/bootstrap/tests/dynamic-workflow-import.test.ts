/**
 * Unit tests for the amend-resume import builder (the "Amend-resume" and "transcript source
 * resolution" rows of apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md).
 *
 * The subject is the pure function `buildImportedCache`: feed it a real InMemoryJournalStore (one
 * of the journal contract's two implementations, semantics pinned by journal-contract.ts) and
 * assert the gates and the table. The end-to-end "a hit really short-circuits the model" lives in
 * the run-service tests; here we only care that **the table is built correctly**.
 */

import { describe, expect, it } from "vitest";
import { InMemoryJournalStore, type PersonaSpec } from "@zcode/dynamic-workflow";
import type { MessageWithParts, SessionId } from "@zcode/contracts";
import { buildImportedCache, preflightAmendImport } from "../src/app/dynamic-workflow-import.js";
import type { ActorTranscriptStore } from "../src/app/workflow-actor-transcript.js";

const PERSONA: PersonaSpec = { name: "worker", system: "you are a worker" };

/** A fresh predecessor journal: one run + some actor rows + some node rows. */
function makeJournal(): InMemoryJournalStore {
  return new InMemoryJournalStore();
}

function putRun(
  journal: InMemoryJournalStore,
  input: {
    runId: string;
    status?: "completed" | "errored" | "stopped" | "running" | "pending";
    resumedFrom?: string;
  },
): void {
  journal.createRun({
    runId: input.runId,
    caps: { maxConcurrency: 4 },
    spentTokens: 0,
    status: input.status ?? "completed",
    ...(input.resumedFrom === undefined ? {} : { resumedFrom: input.resumedFrom }),
  });
}

function putActor(
  journal: InMemoryJournalStore,
  input: {
    runId: string;
    siteId?: string;
    ordinal?: number;
    name?: string;
    persona?: PersonaSpec;
    sessionId?: string;
    resolvedModel?: string;
  },
): { siteId: string; ordinal: number } {
  const siteId = input.siteId ?? "actor#1";
  const ordinal = input.ordinal ?? 1;
  journal.putActor({
    runId: input.runId,
    siteId,
    ordinal,
    ...(input.name === undefined ? {} : { name: input.name }),
    persona: input.persona ?? PERSONA,
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    ...(input.resolvedModel === undefined ? {} : { resolvedModel: input.resolvedModel }),
  });
  return { siteId, ordinal };
}

function putAsk(
  journal: InMemoryJournalStore,
  input: {
    runId: string;
    actor: { siteId: string; ordinal: number };
    seq: number;
    siteId?: string;
    ordinal?: number;
    status?: "completed" | "failed" | "running";
    result?: unknown;
    inputHash?: string;
    messageBoundary?: number;
    stats?: { inputTokens: number; outputTokens: number; totalTokens: number };
  },
): void {
  journal.putNode({
    runId: input.runId,
    siteId: input.siteId ?? "ask#1",
    ordinal: input.ordinal ?? input.seq + 1,
    kind: "ask",
    actorSiteId: input.actor.siteId,
    actorOrdinal: input.actor.ordinal,
    actorSeq: input.seq,
    inputHash: input.inputHash ?? `hash-${input.seq}`,
    status: input.status ?? "completed",
    ...(input.status === "running" ? {} : { result: input.result ?? `answer-${input.seq}` }),
    ...(input.messageBoundary === undefined ? {} : { messageBoundary: input.messageBoundary }),
    ...(input.stats === undefined ? {} : { stats: input.stats }),
  });
}

function putWorld(
  journal: InMemoryJournalStore,
  input: {
    runId: string;
    siteId: string;
    ordinal: number;
    kind?: "world-read" | "world-run";
    inputHash: string;
    status?: "completed" | "failed";
    result?: unknown;
  },
): void {
  journal.putNode({
    runId: input.runId,
    siteId: input.siteId,
    ordinal: input.ordinal,
    kind: input.kind ?? "world-read",
    inputHash: input.inputHash,
    status: input.status ?? "completed",
    result: input.result,
  });
}

/** Transcript read-side stand-in: one message count per session id (this module only counts lengths, never looks at content). */
function transcriptsWith(lengths: Record<string, number>): ActorTranscriptStore {
  return {
    async messages({ sessionID }: { sessionID: SessionId }): Promise<MessageWithParts[]> {
      const count = lengths[sessionID as string];
      if (count === undefined) throw new Error(`session not found: ${sessionID}`);
      return Array.from({ length: count }, () => ({}) as MessageWithParts);
    },
    async saveMessage() {
      throw new Error("not used");
    },
    async savePart() {
      throw new Error("not used");
    },
  };
}

/** A minimally importable predecessor: two completed asks + a session. */
function seedSimplePredecessor(journal: InMemoryJournalStore, runId = "runA"): void {
  putRun(journal, { runId });
  const actor = putActor(journal, { runId, name: "worker", sessionId: "sess-A" });
  putAsk(journal, { runId, actor, seq: 0, messageBoundary: 2 });
  putAsk(journal, { runId, actor, seq: 1, messageBoundary: 5 });
}

describe("buildImportedCache — 三道门", () => {
  it("前驱不存在 → run_not_found", async () => {
    const result = await buildImportedCache({ journal: makeJournal() }, "missing");
    expect(result).toEqual({ ok: false, reason: "run_not_found" });
  });

  // Building still demands a terminal state: the amend path halts the in-flight predecessor and
  // waits for it to settle before building; reaching here non-terminal is a wiring fault.
  it("前驱非终态 → not_amendable（构建的内部不变式）", async () => {
    const journal = makeJournal();
    putRun(journal, { runId: "runA", status: "running" });
    const result = await buildImportedCache({ journal }, "runA");
    expect(result).toEqual({ ok: false, reason: "not_amendable" });
  });

  // The amendable set is **any** terminal state, including completed (user ruling: warm-started
  // extension analysis is one of this feature's primary use cases).
  // Deliberately different from plain resume's resumable set (stopped).
  it.each(["completed", "errored", "stopped"] as const)("终态 %s 都可修订", async (status) => {
    const journal = makeJournal();
    putRun(journal, { runId: "runA", status });
    const result = await buildImportedCache({ journal }, "runA");
    expect(result.ok).toBe(true);
  });

  it("已完结 ask 缺 messageBoundary → missing_boundaries（整体拒绝）", async () => {
    const journal = makeJournal();
    putRun(journal, { runId: "runA" });
    const actor = putActor(journal, { runId: "runA", name: "worker", sessionId: "sess-A" });
    putAsk(journal, { runId: "runA", actor, seq: 0, messageBoundary: 2 });
    putAsk(journal, { runId: "runA", actor, seq: 1 });

    const result = await buildImportedCache({ journal }, "runA");
    expect(result).toEqual({ ok: false, reason: "missing_boundaries" });
  });

  // Unfinished asks never enter the imported prefix, so it is normal for them to lack boundaries —
  // the gate only looks at completed rows.
  it("failed / running 的 ask 无边界不触发门", async () => {
    const journal = makeJournal();
    putRun(journal, { runId: "runA" });
    const actor = putActor(journal, { runId: "runA", name: "worker", sessionId: "sess-A" });
    putAsk(journal, { runId: "runA", actor, seq: 0, messageBoundary: 2 });
    putAsk(journal, { runId: "runA", actor, seq: 1, status: "failed" });
    putAsk(journal, { runId: "runA", actor, seq: 2, status: "running", ordinal: 3 });

    const result = await buildImportedCache({ journal }, "runA");
    expect(result.ok).toBe(true);
  });
});

// amend's preflight (docs/execution-engine.md "Amend-resume"): it decides **before** halting the
// predecessor, so it ignores status — an in-flight predecessor passes preflight and is halted
// afterwards; a rejected amend therefore never leaves behind a run that was halted for nothing.
describe("preflightAmendImport — two gates before the halt", () => {
  it("前驱不存在 → run_not_found", () => {
    expect(preflightAmendImport(makeJournal(), "missing")).toEqual({
      ok: false,
      reason: "run_not_found",
    });
  });

  it.each(["running", "pending", "completed", "errored", "stopped"] as const)(
    "状态 %s 的前驱通过预检并交出记录",
    (status) => {
      const journal = makeJournal();
      putRun(journal, { runId: "runA", status });
      const result = preflightAmendImport(journal, "runA");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.run.runId).toBe("runA");
    },
  );

  it("在飞前驱的已完结 ask 缺边界 → missing_boundaries，未完结的 ask 无边界不触发", () => {
    const journal = makeJournal();
    putRun(journal, { runId: "runA", status: "running" });
    const actor = putActor(journal, { runId: "runA", name: "worker", sessionId: "sess-A" });
    putAsk(journal, { runId: "runA", actor, seq: 0, messageBoundary: 2 });
    putAsk(journal, { runId: "runA", actor, seq: 1, status: "running", ordinal: 2 });
    expect(preflightAmendImport(journal, "runA").ok).toBe(true);

    putAsk(journal, { runId: "runA", actor, seq: 2, ordinal: 3 });
    expect(preflightAmendImport(journal, "runA")).toEqual({
      ok: false,
      reason: "missing_boundaries",
    });
  });
});

describe("buildImportedCache — actor 前缀", () => {
  it("收下全 completed 前缀，带 result / stats / 边界", async () => {
    const journal = makeJournal();
    putRun(journal, { runId: "runA" });
    const actor = putActor(journal, {
      runId: "runA",
      name: "worker",
      sessionId: "sess-A",
      resolvedModel: "anthropic/claude-x",
    });
    const stats = { inputTokens: 3, outputTokens: 4, totalTokens: 7 };
    putAsk(journal, { runId: "runA", actor, seq: 0, messageBoundary: 2, stats });
    putAsk(journal, { runId: "runA", actor, seq: 1, messageBoundary: 6 });

    const result = await buildImportedCache({ journal }, "runA");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resumedFrom).toBe("runA");
    const candidate = result.cache.actors.get("worker");
    expect(candidate).toEqual({
      persona: PERSONA,
      entries: [
        { inputHash: "hash-0", result: "answer-0", messageBoundary: 2, stats },
        { inputHash: "hash-1", result: "answer-1", messageBoundary: 6 },
      ],
      transcriptSourceSessionId: "sess-A",
      resolvedModel: "anthropic/claude-x",
    });
  });

  // A failed ask terminates the importable prefix: it is not imported itself (a failure binds
  // nothing on the new run), and nothing after it is either — skipping it to import later entries
  // would smuggle in context (that round's Q&A still sits in the source session's transcript).
  it("前缀停在 failed 处", async () => {
    const journal = makeJournal();
    putRun(journal, { runId: "runA" });
    const actor = putActor(journal, { runId: "runA", name: "worker", sessionId: "sess-A" });
    putAsk(journal, { runId: "runA", actor, seq: 0, messageBoundary: 2 });
    putAsk(journal, { runId: "runA", actor, seq: 1, status: "failed" });
    putAsk(journal, { runId: "runA", actor, seq: 2, messageBoundary: 9, ordinal: 3 });

    const result = await buildImportedCache({ journal }, "runA");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cache.actors.get("worker")?.entries).toHaveLength(1);
  });

  it("前缀停在 running 处（崩溃中的 ask 不导入）", async () => {
    const journal = makeJournal();
    putRun(journal, { runId: "runA", status: "stopped" });
    const actor = putActor(journal, { runId: "runA", name: "worker", sessionId: "sess-A" });
    putAsk(journal, { runId: "runA", actor, seq: 0, messageBoundary: 2 });
    putAsk(journal, { runId: "runA", actor, seq: 1, status: "running" });

    const result = await buildImportedCache({ journal }, "runA");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cache.actors.get("worker")?.entries).toHaveLength(1);
  });

  it("前缀停在序号空洞处", async () => {
    const journal = makeJournal();
    putRun(journal, { runId: "runA" });
    const actor = putActor(journal, { runId: "runA", name: "worker", sessionId: "sess-A" });
    putAsk(journal, { runId: "runA", actor, seq: 0, messageBoundary: 2 });
    putAsk(journal, { runId: "runA", actor, seq: 2, messageBoundary: 8, ordinal: 3 });

    const result = await buildImportedCache({ journal }, "runA");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cache.actors.get("worker")?.entries).toHaveLength(1);
  });

  it("空前缀（seq 0 就失败）不产候选", async () => {
    const journal = makeJournal();
    putRun(journal, { runId: "runA", status: "errored" });
    const actor = putActor(journal, { runId: "runA", name: "worker", sessionId: "sess-A" });
    putAsk(journal, { runId: "runA", actor, seq: 0, status: "failed" });

    const result = await buildImportedCache({ journal }, "runA");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cache.actors.size).toBe(0);
  });

  it("匿名 actor 不产候选（名字是缓存身份键）", async () => {
    const journal = makeJournal();
    putRun(journal, { runId: "runA" });
    const actor = putActor(journal, { runId: "runA", sessionId: "sess-A" });
    putAsk(journal, { runId: "runA", actor, seq: 0, messageBoundary: 2 });

    const result = await buildImportedCache({ journal }, "runA");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cache.actors.size).toBe(0);
  });

  // Neither duplicate is taken: picking a candidate by name on a duplicate-name predecessor is a
  // dice roll, and a wrong pick means using another actor's session prefix as this actor's
  // context. The engine's DuplicateActorName is a newly added runtime invariant; journals written
  // before it can genuinely contain duplicate-name rows.
  it("前驱内重名 actor 全部跳过", async () => {
    const journal = makeJournal();
    putRun(journal, { runId: "runA" });
    const first = putActor(journal, {
      runId: "runA",
      name: "worker",
      siteId: "actor#1",
      sessionId: "sess-1",
    });
    const second = putActor(journal, {
      runId: "runA",
      name: "worker",
      siteId: "actor#2",
      sessionId: "sess-2",
    });
    putAsk(journal, { runId: "runA", actor: first, seq: 0, messageBoundary: 2 });
    putAsk(journal, { runId: "runA", actor: second, seq: 0, siteId: "ask#2", messageBoundary: 3 });

    const result = await buildImportedCache({ journal }, "runA");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cache.actors.size).toBe(0);
  });

  it("persona 缺席的 actor 行不产候选", async () => {
    const journal = makeJournal();
    putRun(journal, { runId: "runA" });
    journal.putActor({
      runId: "runA",
      siteId: "actor#1",
      ordinal: 1,
      name: "worker",
      sessionId: "s",
    });
    putAsk(journal, {
      runId: "runA",
      actor: { siteId: "actor#1", ordinal: 1 },
      seq: 0,
      messageBoundary: 2,
    });

    const result = await buildImportedCache({ journal }, "runA");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cache.actors.size).toBe(0);
  });
});

describe("buildImportedCache — 转录源解析", () => {
  // Chained amends: in B this actor hit throughout => B never created a session for it; when C is
  // amended from B, the transcript source is in A.
  it("沿 resumed_from 走两跳找到会话与 pin", async () => {
    const journal = makeJournal();
    putRun(journal, { runId: "runA" });
    putActor(journal, {
      runId: "runA",
      name: "worker",
      sessionId: "sess-A",
      resolvedModel: "anthropic/claude-a",
    });

    putRun(journal, { runId: "runB", resumedFrom: "runA" });
    putActor(journal, { runId: "runB", name: "worker", siteId: "actor#7" });

    putRun(journal, { runId: "runC", resumedFrom: "runB" });
    const actorC = putActor(journal, { runId: "runC", name: "worker", siteId: "actor#9" });
    putAsk(journal, { runId: "runC", actor: actorC, seq: 0, messageBoundary: 4 });

    const result = await buildImportedCache({ journal }, "runC");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const candidate = result.cache.actors.get("worker");
    expect(candidate?.transcriptSourceSessionId).toBe("sess-A");
    // The pin and the session come from the same row: the promise is "do not switch models when continuing **this** transcript".
    expect(candidate?.resolvedModel).toBe("anthropic/claude-a");
  });

  it("链末无会话 → 弃该候选（全新重跑），其余 actor 不受影响", async () => {
    const journal = makeJournal();
    putRun(journal, { runId: "runA" });
    putActor(journal, { runId: "runA", name: "worker", siteId: "actor#1" });

    putRun(journal, { runId: "runB", resumedFrom: "runA" });
    const orphan = putActor(journal, { runId: "runB", name: "worker", siteId: "actor#1" });
    const kept = putActor(journal, {
      runId: "runB",
      name: "keeper",
      siteId: "actor#2",
      sessionId: "sess-keeper",
    });
    putAsk(journal, { runId: "runB", actor: orphan, seq: 0, messageBoundary: 2 });
    putAsk(journal, { runId: "runB", actor: kept, seq: 0, siteId: "ask#2", messageBoundary: 3 });

    const result = await buildImportedCache({ journal }, "runB");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cache.actors.has("worker")).toBe(false);
    expect(result.cache.actors.get("keeper")?.transcriptSourceSessionId).toBe("sess-keeper");
  });

  it("链上出现重名 → 停止上溯、弃候选", async () => {
    const journal = makeJournal();
    putRun(journal, { runId: "runA" });
    putActor(journal, { runId: "runA", name: "worker", siteId: "actor#1", sessionId: "sess-A1" });
    putActor(journal, { runId: "runA", name: "worker", siteId: "actor#2", sessionId: "sess-A2" });

    putRun(journal, { runId: "runB", resumedFrom: "runA" });
    const actorB = putActor(journal, { runId: "runB", name: "worker", siteId: "actor#1" });
    putAsk(journal, { runId: "runB", actor: actorB, seq: 0, messageBoundary: 2 });

    const result = await buildImportedCache({ journal }, "runB");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cache.actors.size).toBe(0);
  });

  // Pure defense: supersede only points at already-terminated earlier runs, so a cycle cannot be
  // constructed; but corrupted data must not turn into an infinite loop.
  it("resumed_from 成环时终止而不是死循环", async () => {
    const journal = makeJournal();
    putRun(journal, { runId: "runA", resumedFrom: "runB" });
    putActor(journal, { runId: "runA", name: "worker", siteId: "actor#1" });
    putRun(journal, { runId: "runB", resumedFrom: "runA" });
    const actorB = putActor(journal, { runId: "runB", name: "worker", siteId: "actor#1" });
    putAsk(journal, { runId: "runB", actor: actorB, seq: 0, messageBoundary: 2 });

    const result = await buildImportedCache({ journal }, "runB");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cache.actors.size).toBe(0);
  });

  // Source honesty check: when the session was cleaned up / truncated below the boundary, the
  // candidate is dropped at build time, so the driver-side DriverError degrades to a
  // corruption-level backstop instead of a reachable user path.
  it("源会话短于边界 → 弃候选（转录面在场时）", async () => {
    const journal = makeJournal();
    seedSimplePredecessor(journal);

    const short = await buildImportedCache(
      { actorTranscriptStore: transcriptsWith({ "sess-A": 4 }), journal },
      "runA",
    );
    expect(short.ok).toBe(true);
    if (!short.ok) return;
    expect(short.cache.actors.size).toBe(0);

    const enough = await buildImportedCache(
      { actorTranscriptStore: transcriptsWith({ "sess-A": 5 }), journal },
      "runA",
    );
    expect(enough.ok).toBe(true);
    if (!enough.ok) return;
    expect(enough.cache.actors.size).toBe(1);
  });

  it("源会话读不到 → 弃候选", async () => {
    const journal = makeJournal();
    seedSimplePredecessor(journal);
    const result = await buildImportedCache(
      { actorTranscriptStore: transcriptsWith({}), journal },
      "runA",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cache.actors.size).toBe(0);
  });

  // Assemblies without a transcript surface (no session store): candidates are taken as-is; the
  // driver enforces the honesty at兑现 time.
  it("无转录面时不做诚实性检查", async () => {
    const journal = makeJournal();
    seedSimplePredecessor(journal);
    const result = await buildImportedCache({ journal }, "runA");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cache.actors.size).toBe(1);
  });
});

/**
 * 「一条完结 ask（边界 3）+ 紧随其后一条在飞 ask」的前驱，转录源是它自己的会话 `sess-A`。
 * 这正是「修订一个跑到一半的 run」最常见的形状。
 */
function seedInFlightPredecessor(journal: InMemoryJournalStore, runId = "runA"): void {
  putRun(journal, { runId, status: "stopped" });
  const actor = putActor(journal, { runId, name: "worker", sessionId: "sess-A" });
  putAsk(journal, { runId, actor, seq: 0, messageBoundary: 3 });
  putAsk(journal, { runId, actor, seq: 1, status: "running", inputHash: "hash-live" });
}

// 在飞 ask 的接续（docs/execution-engine.md「What is imported」）：前驱停下时还在飞的那条 ask
// 没有结果可导入，导入的是**它已经跑出来的那段转录**。
describe("buildImportedCache — 在飞 ask", () => {
  it("前缀之后的 running 行 → inFlight 带整个会话的消息数", async () => {
    const journal = makeJournal();
    seedInFlightPredecessor(journal);

    const result = await buildImportedCache(
      { actorTranscriptStore: transcriptsWith({ "sess-A": 7 }), journal },
      "runA",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const candidate = result.cache.actors.get("worker");
    expect(candidate?.entries).toHaveLength(1);
    // 边界是**整个会话**的条数（含那半场未完的问答），不是某一条 ask 的记账边界。
    expect(candidate?.inFlight).toEqual({ inputHash: "hash-live", messageBoundary: 7 });
  });

  // 扇出第一轮在飞时被修订：一条都没做完的候选照样是候选。
  it("空前缀 + 在飞 ask → 候选带 inFlight、entries 为空", async () => {
    const journal = makeJournal();
    putRun(journal, { runId: "runA", status: "stopped" });
    const actor = putActor(journal, { runId: "runA", name: "worker", sessionId: "sess-A" });
    putAsk(journal, { runId: "runA", actor, seq: 0, status: "running", inputHash: "hash-live" });

    const result = await buildImportedCache(
      { actorTranscriptStore: transcriptsWith({ "sess-A": 2 }), journal },
      "runA",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const candidate = result.cache.actors.get("worker");
    expect(candidate?.entries).toEqual([]);
    expect(candidate?.inFlight).toEqual({ inputHash: "hash-live", messageBoundary: 2 });
  });

  it("前缀之后是 failed 行 → 不接续，前缀照收", async () => {
    const journal = makeJournal();
    putRun(journal, { runId: "runA", status: "errored" });
    const actor = putActor(journal, { runId: "runA", name: "worker", sessionId: "sess-A" });
    putAsk(journal, { runId: "runA", actor, seq: 0, messageBoundary: 3 });
    putAsk(journal, { runId: "runA", actor, seq: 1, status: "failed" });

    const result = await buildImportedCache(
      { actorTranscriptStore: transcriptsWith({ "sess-A": 7 }), journal },
      "runA",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const candidate = result.cache.actors.get("worker");
    expect(candidate?.entries).toHaveLength(1);
    expect(candidate?.inFlight).toBeUndefined();
  });

  // 空洞与「running 行不在前缀正后方」是同一件事：紧接前缀的那个位置上没有在飞的 ask。
  it("前缀之后是序号空洞 → 不接续", async () => {
    const journal = makeJournal();
    putRun(journal, { runId: "runA", status: "stopped" });
    const actor = putActor(journal, { runId: "runA", name: "worker", sessionId: "sess-A" });
    putAsk(journal, { runId: "runA", actor, seq: 0, messageBoundary: 3 });
    putAsk(journal, { runId: "runA", actor, seq: 2, status: "running", ordinal: 3 });

    const result = await buildImportedCache(
      { actorTranscriptStore: transcriptsWith({ "sess-A": 7 }), journal },
      "runA",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cache.actors.get("worker")?.inFlight).toBeUndefined();
  });

  // 那半场对话只存在于前驱自己的会话里；从更早祖先解析出的源只有完整前缀。
  it("转录源来自更早的祖先 → 只带前缀，不接续", async () => {
    const journal = makeJournal();
    putRun(journal, { runId: "runA" });
    putActor(journal, { runId: "runA", name: "worker", sessionId: "sess-A" });

    putRun(journal, { runId: "runB", status: "stopped", resumedFrom: "runA" });
    const actorB = putActor(journal, { runId: "runB", name: "worker", siteId: "actor#7" });
    putAsk(journal, { runId: "runB", actor: actorB, seq: 0, messageBoundary: 3 });
    putAsk(journal, { runId: "runB", actor: actorB, seq: 1, status: "running" });

    const result = await buildImportedCache(
      { actorTranscriptStore: transcriptsWith({ "sess-A": 9 }), journal },
      "runB",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const candidate = result.cache.actors.get("worker");
    expect(candidate?.transcriptSourceSessionId).toBe("sess-A");
    expect(candidate?.entries).toHaveLength(1);
    expect(candidate?.inFlight).toBeUndefined();
  });

  // 排队却从未派发的 ask 没有多出来的转录可带；种子的 messageCount 也绝不能等于前缀边界
  // （那已经是前缀自己的位置），更不能是 0。
  it("会话条数不严格大于前缀边界 → 不接续", async () => {
    const journal = makeJournal();
    seedInFlightPredecessor(journal);

    const result = await buildImportedCache(
      { actorTranscriptStore: transcriptsWith({ "sess-A": 3 }), journal },
      "runA",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const candidate = result.cache.actors.get("worker");
    expect(candidate?.entries).toHaveLength(1);
    expect(candidate?.inFlight).toBeUndefined();
  });

  it("空前缀且会话为空 → 整个候选都不产（没有任何可接续的东西）", async () => {
    const journal = makeJournal();
    putRun(journal, { runId: "runA", status: "stopped" });
    const actor = putActor(journal, { runId: "runA", name: "worker", sessionId: "sess-A" });
    putAsk(journal, { runId: "runA", actor, seq: 0, status: "running" });

    const result = await buildImportedCache(
      { actorTranscriptStore: transcriptsWith({ "sess-A": 0 }), journal },
      "runA",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cache.actors.size).toBe(0);
  });

  it("无转录面 → 不接续（数不出接续位置），前缀照收", async () => {
    const journal = makeJournal();
    seedInFlightPredecessor(journal);

    const result = await buildImportedCache({ journal }, "runA");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const candidate = result.cache.actors.get("worker");
    expect(candidate?.entries).toHaveLength(1);
    expect(candidate?.inFlight).toBeUndefined();
  });

  it("源会话读不到 → 整个候选弃置", async () => {
    const journal = makeJournal();
    seedInFlightPredecessor(journal);

    const result = await buildImportedCache(
      { actorTranscriptStore: transcriptsWith({}), journal },
      "runA",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cache.actors.size).toBe(0);
  });
});

// 静默闸门（docs/execution-engine.md「Tool contract and refusals」的 import 行）：被取代的前驱
// 刚被 abort，它的 turn 可能还在落最后几条消息——此刻数出来的条数不可信。
describe("buildImportedCache — 会话静默", () => {
  it("会话仍在被写入 → 只带前缀，不接续", async () => {
    const journal = makeJournal();
    seedInFlightPredecessor(journal);

    const result = await buildImportedCache(
      { actorTranscriptStore: transcriptsWith({ "sess-A": 7 }), journal },
      "runA",
      { quietSessions: new Set<string>() },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const candidate = result.cache.actors.get("worker");
    expect(candidate?.entries).toHaveLength(1);
    expect(candidate?.inFlight).toBeUndefined();
  });

  it("会话在静默集合里 → 照常接续", async () => {
    const journal = makeJournal();
    seedInFlightPredecessor(journal);

    const result = await buildImportedCache(
      { actorTranscriptStore: transcriptsWith({ "sess-A": 7 }), journal },
      "runA",
      { quietSessions: new Set(["sess-A"]) },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cache.actors.get("worker")?.inFlight).toEqual({
      inputHash: "hash-live",
      messageBoundary: 7,
    });
  });

  // resume 侧的重建不带这个集合：那时前驱早已结算、进程里没有它的 driver，没有东西在写。
  // 闸门若把「缺席」读成「都不静默」，重建出的表就会比提交时那张少一个 inFlight。
  it("静默集合缺席 = 全部静默（resume 重建与提交时构建给出同一张表）", async () => {
    const journal = makeJournal();
    seedInFlightPredecessor(journal);
    const deps = { actorTranscriptStore: transcriptsWith({ "sess-A": 7 }), journal };

    const built = await buildImportedCache(deps, "runA", { quietSessions: new Set(["sess-A"]) });
    const rebuilt = await buildImportedCache(deps, "runA");
    expect(rebuilt).toEqual(built);
  });
});

describe("buildImportedCache — world 表", () => {
  it("按内容哈希分队列，队内保持 journal 插入序", async () => {
    const journal = makeJournal();
    putRun(journal, { runId: "runA" });
    putWorld(journal, {
      runId: "runA",
      siteId: "w#1",
      ordinal: 1,
      inputHash: "h1",
      result: "first",
    });
    putWorld(journal, {
      runId: "runA",
      siteId: "w#2",
      ordinal: 1,
      inputHash: "h2",
      result: "other",
    });
    putWorld(journal, {
      runId: "runA",
      siteId: "w#1",
      ordinal: 2,
      inputHash: "h1",
      result: "second",
    });

    const result = await buildImportedCache({ journal }, "runA");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cache.world.get("h1")?.map((entry) => entry.result)).toEqual(["first", "second"]);
    expect(result.cache.world.get("h2")?.map((entry) => entry.result)).toEqual(["other"]);
  });

  // world-run 的导入是**安全特性**：修订续跑绝不静默重放一次已 journal 的效应。
  it("world-run 与 world-read 同表，report / ask 不入表", async () => {
    const journal = makeJournal();
    putRun(journal, { runId: "runA" });
    putWorld(journal, {
      runId: "runA",
      siteId: "w#1",
      ordinal: 1,
      kind: "world-run",
      inputHash: "hrun",
      result: { exitCode: 0 },
    });
    journal.putNode({
      runId: "runA",
      siteId: "report#1",
      ordinal: 1,
      kind: "report",
      inputHash: "hreport",
      status: "completed",
      result: "progress",
    });

    const result = await buildImportedCache({ journal }, "runA");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cache.world.get("hrun")?.[0]).toEqual({
      inputHash: "hrun",
      kind: "world-run",
      result: { exitCode: 0 },
    });
    expect(result.cache.world.has("hreport")).toBe(false);
  });

  it("失败的 world 节点不入表（重新执行）", async () => {
    const journal = makeJournal();
    putRun(journal, { runId: "runA", status: "errored" });
    putWorld(journal, {
      runId: "runA",
      siteId: "w#1",
      ordinal: 1,
      inputHash: "h1",
      status: "failed",
    });

    const result = await buildImportedCache({ journal }, "runA");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cache.world.size).toBe(0);
  });
});

// 确定性不是风格偏好而是正确性前提：崩溃后 resume 用同一个函数重建同一张表，两次不等
// 就意味着「重建」变成了「另建一张」。
it("同一份 journal 状态两次构建逐字段相等", async () => {
  const journal = makeJournal();
  putRun(journal, { runId: "runA" });
  const actor = putActor(journal, { runId: "runA", name: "worker", sessionId: "sess-A" });
  putAsk(journal, { runId: "runA", actor, seq: 0, messageBoundary: 2 });
  putAsk(journal, { runId: "runA", actor, seq: 1, messageBoundary: 5 });
  const other = putActor(journal, {
    runId: "runA",
    name: "reviewer",
    siteId: "actor#2",
    sessionId: "sess-B",
  });
  putAsk(journal, { runId: "runA", actor: other, seq: 0, siteId: "ask#2", messageBoundary: 3 });
  putWorld(journal, { runId: "runA", siteId: "w#1", ordinal: 1, inputHash: "h1", result: 1 });
  putWorld(journal, { runId: "runA", siteId: "w#1", ordinal: 2, inputHash: "h1", result: 2 });

  const first = await buildImportedCache({ journal }, "runA");
  const second = await buildImportedCache({ journal }, "runA");
  expect(first).toEqual(second);
  expect(first.ok).toBe(true);
  if (!first.ok || !second.ok) return;
  // Map 的遍历序也必须一致（引擎不依赖它，但「同一张表」的说法要经得起逐项核对）。
  expect([...first.cache.actors.keys()]).toEqual([...second.cache.actors.keys()]);
  expect([...first.cache.world.keys()]).toEqual([...second.cache.world.keys()]);
});
