import { describe, expect, it } from "vitest";
import {
  InMemoryJournalStore,
  WorkflowEngine,
  WorkflowError,
  inputHash,
  refToString,
  type AskSpec,
  type Caps,
  type InstanceRef,
  type NodeKind,
  type NodeRecord,
  type PersonaSpec,
  type RunEvent,
  type StoredEvent,
  type ValidateFn,
} from "../../src/engine/index.js";
import { FakeDriver, flush } from "./fake-driver.js";
import { REPORT_CAPS } from "../../src/facade/report-caps.js";
import { validate } from "../../src/schema/validate.js";
import type { JsonSchema } from "../../src/schema/types.js";

const RUN = "run";

function inst(siteId: string, ordinal = 1): InstanceRef {
  return { siteId, ordinal };
}

/** A minimal validator based on schema.required (mimics a real validator's violation output). */
const requireFields: ValidateFn = (schema, value) => {
  const required = (schema as { required?: string[] } | undefined)?.required ?? [];
  const obj = (value ?? {}) as Record<string, unknown>;
  return required
    .filter((k) => obj[k] === undefined)
    .map((k) => ({ path: k, expected: "present", got: "undefined" }));
};

interface SetupOpts {
  journal?: InMemoryJournalStore;
  caps?: Caps;
  askSpecs?: Map<string, AskSpec>;
  validate?: ValidateFn;
  deferSessions?: boolean;
  name?: string;
  scriptText?: string;
  scriptHash?: string;
  parentSessionId?: string;
  cwd?: string;
  toolCallId?: string;
  resumedFrom?: string;
  /** Mimics the driver-side model tier resolution (writes the resolution into the actor record at session creation). */
  resolveModel?: (persona: { model?: string }) => string;
}

function setup(opts: SetupOpts = {}) {
  const journal = opts.journal ?? new InMemoryJournalStore();
  const driver = new FakeDriver(journal, {
    deferSessions: opts.deferSessions,
    ...(opts.resolveModel === undefined ? {} : { resolveModel: opts.resolveModel, runId: RUN }),
  });
  const engine = new WorkflowEngine({
    runId: RUN,
    driver,
    caps: opts.caps ?? { maxConcurrency: 16 },
    // askSpecs must cover every ask site in the script (a miss is a hard error); the fixture by
    // default explicitly records the two sites used in this file as untyped.
    askSpecs: opts.askSpecs ?? untypedSpecs("ask#1", "ask#2"),
    validate: opts.validate ?? (() => []),
    ...(opts.name === undefined ? {} : { name: opts.name }),
    ...(opts.scriptText === undefined ? {} : { scriptText: opts.scriptText }),
    ...(opts.scriptHash === undefined ? {} : { scriptHash: opts.scriptHash }),
    ...(opts.parentSessionId === undefined ? {} : { parentSessionId: opts.parentSessionId }),
    ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
    ...(opts.toolCallId === undefined ? {} : { toolCallId: opts.toolCallId }),
    ...(opts.resumedFrom === undefined ? {} : { resumedFrom: opts.resumedFrom }),
  });
  return { journal, driver, engine };
}

/** Explicitly records ask sites as untyped (the engine no longer treats absence as untyped). */
const untypedSpecs = (...siteIds: string[]): Map<string, AskSpec> =>
  new Map(siteIds.map((id) => [id, { typed: false } as AskSpec]));

const typedSpecs = () =>
  new Map<string, AskSpec>([["ask#1", { typed: true, schema: { required: ["x"] } }]]);

describe("WorkflowEngine — happy path", () => {
  it("dispatches, accepts a valid submit, and journals the node", async () => {
    const { engine, driver, journal } = setup({ askSpecs: typedSpecs(), validate: requireFields });
    const actor = engine.createActor("actor#1", "planner");
    const p = engine.ask("ask#1", actor, "do it");
    await flush();

    expect(driver.startAskCount()).toBe(1);
    expect(driver.startAsks[0]?.message.typed).toBe(true);
    expect(driver.startAsks[0]?.message.schema).toEqual({ required: ["x"] });

    engine.askStats(inst("ask#1"), { tokens: 10, toolCalls: 1, turns: 1 });
    engine.askSubmitAttempted(inst("ask#1"), { x: 1 });

    expect(driver.submitResponses.at(-1)?.verdict.kind).toBe("accept");
    await expect(p).resolves.toEqual({ x: 1 });

    const node = journal.getNode(RUN, "ask#1", 1);
    expect(node?.status).toBe("completed");
    expect(node?.actorSeq).toBe(0);
    expect(node?.inputHash).toBe(inputHash("do it"));
    expect(node?.result).toEqual({ x: 1 });
    expect(node?.stats?.tokens).toBe(10);
    expect(node?.actorSiteId).toBe("actor#1");

    engine.complete("final artifact");
    await expect(engine.settled).resolves.toEqual({
      status: "completed",
      artifact: "final artifact",
    });
    expect(engine.status()).toBe("completed");
  });
});

describe("WorkflowEngine — validation + repair", () => {
  it("rejects invalid submits and fails after the 3 repair attempts are exhausted", async () => {
    const { engine, driver, journal } = setup({ askSpecs: typedSpecs(), validate: requireFields });
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "do it");
    await flush();

    // 4 invalid submits: the first 3 are rejected (repair), the 4th exhausts the budget → fail.
    for (let i = 0; i < 4; i++) engine.askSubmitAttempted(inst("ask#1"), {});

    const rejects = driver.submitResponses.filter((r) => r.verdict.kind === "reject");
    expect(rejects).toHaveLength(3);
    expect(driver.cancels).toContainEqual(inst("ask#1"));

    await expect(p).rejects.toMatchObject({ code: "ValidationFailed" });
    const err = await p.catch((e: unknown) => e as { violations?: unknown[] });
    expect(err.violations?.length).toBeGreaterThan(0);

    const node = journal.getNode(RUN, "ask#1", 1);
    expect(node?.status).toBe("failed");
    expect(node?.error?.code).toBe("ValidationFailed");
  });

  it("repairs successfully within the attempt limit", async () => {
    const { engine, driver } = setup({ askSpecs: typedSpecs(), validate: requireFields });
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "do it");
    await flush();
    engine.askSubmitAttempted(inst("ask#1"), {}); // reject
    engine.askSubmitAttempted(inst("ask#1"), { x: 7 }); // accept
    await expect(p).resolves.toEqual({ x: 7 });
    expect(driver.submitResponses.map((r) => r.verdict.kind)).toEqual(["reject", "accept"]);
  });
});

describe("WorkflowEngine — nudge policy", () => {
  it("nudges once when the turn ends without a submit, then accepts", async () => {
    const { engine, driver } = setup({ askSpecs: typedSpecs(), validate: requireFields });
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "do it");
    await flush();
    engine.askTurnEnded(inst("ask#1"), "not yet");
    expect(driver.submitResponses.at(-1)?.verdict.kind).toBe("nudge");
    engine.askSubmitAttempted(inst("ask#1"), { x: 1 });
    await expect(p).resolves.toEqual({ x: 1 });
  });

  it("fails with ResultNotSubmitted + final text when nudge is exhausted", async () => {
    const { engine, driver } = setup({ askSpecs: typedSpecs(), validate: requireFields });
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "do it");
    await flush();
    engine.askTurnEnded(inst("ask#1"), "text one"); // nudge
    engine.askTurnEnded(inst("ask#1"), "final words"); // exhausted → fail
    await expect(p).rejects.toMatchObject({ code: "ResultNotSubmitted", finalText: "final words" });
    expect(driver.cancels).toContainEqual(inst("ask#1"));
  });
});

describe("WorkflowEngine — untyped ask", () => {
  it("settles on turn end with the final text and offers no submit tool", async () => {
    const { engine, driver, journal } = setup(); // sites explicitly recorded as untyped
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "summarize");
    await flush();
    expect(driver.startAsks[0]?.message.typed).toBe(false);
    engine.askTurnEnded(inst("ask#1"), "the answer");
    await expect(p).resolves.toBe("the answer");
    expect(journal.getNode(RUN, "ask#1", 1)?.result).toBe("the answer");
  });
});

describe("WorkflowEngine — per-actor FIFO", () => {
  it("serializes concurrent asks on one actor and journals actorSeq in admission order", async () => {
    const { engine, driver, journal } = setup();
    const actor = engine.createActor("actor#1");
    const p1 = engine.ask("ask#1", actor, "A");
    const p2 = engine.ask("ask#2", actor, "B");
    await flush();

    // Only the head of the queue dispatches; the second ask waits for the first to settle.
    expect(driver.startAskCount()).toBe(1);
    expect(driver.startAsks[0]?.instance).toEqual(inst("ask#1"));

    engine.askTurnEnded(inst("ask#1"), "ra");
    await flush();
    expect(driver.startAskCount()).toBe(2);
    expect(driver.startAsks[1]?.instance).toEqual(inst("ask#2"));

    engine.askTurnEnded(inst("ask#2"), "rb");
    await expect(Promise.all([p1, p2])).resolves.toEqual(["ra", "rb"]);

    expect(journal.getNode(RUN, "ask#1", 1)?.actorSeq).toBe(0);
    expect(journal.getNode(RUN, "ask#2", 1)?.actorSeq).toBe(1);
  });
});

describe("WorkflowEngine — replay", () => {
  it("short-circuits journaled nodes with zero startAsk calls", async () => {
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
    });
    journal.putActor({ runId: RUN, siteId: "actor#1", ordinal: 1 });
    journal.putNode({
      runId: RUN,
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorSeq: 0,
      inputHash: inputHash("do it"),
      status: "completed",
      result: { x: 42 },
    });

    const { engine, driver } = setup({ journal });
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "do it");
    await flush();

    expect(driver.startAskCount()).toBe(0);
    await expect(p).resolves.toEqual({ x: 42 });
  });

  it("fails the run loudly on an inputHash mismatch", async () => {
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
    });
    journal.putActor({ runId: RUN, siteId: "actor#1", ordinal: 1 });
    journal.putNode({
      runId: RUN,
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorSeq: 0,
      inputHash: "deadbeef", // does not match the hash computed at replay time
      status: "completed",
      result: { x: 1 },
    });

    const { engine } = setup({ journal });
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "do it");
    await expect(p).rejects.toMatchObject({ code: "InputHashMismatch" });
    await expect(engine.settled).resolves.toMatchObject({
      status: "errored",
      error: { code: "InputHashMismatch" },
    });

    // Both hashes are carried structurally on the error (the same mismatch field as
    // ScriptHashMismatch): a structured field that appears on only one of the two hash-mismatch
    // errors is a trap for readers.
    const err = await p.catch((e: unknown) => e as WorkflowError);
    expect(err.mismatch).toEqual({ expected: "deadbeef", got: inputHash("do it") });
    // The serializable form persisted to the journal carries it too (failure_json is the durable
    // record the app side reads).
    expect(err.toJSON()).toMatchObject({
      code: "InputHashMismatch",
      mismatch: { expected: "deadbeef", got: inputHash("do it") },
    });
    expect(journal.getRun(RUN)?.failure?.mismatch).toEqual({
      expected: "deadbeef",
      got: inputHash("do it"),
    });
  });

  it("enforces the recorded actorSeq via the hold rule when arrivals are scrambled", async () => {
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
    });
    journal.putActor({ runId: RUN, siteId: "actor#1", ordinal: 1 });
    // Recorded order: ask#1@1 = seq0, ask#2@1 = seq1.
    journal.putNode({
      runId: RUN,
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorSeq: 0,
      inputHash: inputHash("A"),
      status: "completed",
      result: "r1",
    });
    journal.putNode({
      runId: RUN,
      siteId: "ask#2",
      ordinal: 1,
      kind: "ask",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorSeq: 1,
      inputHash: inputHash("B"),
      status: "completed",
      result: "r2",
    });

    const { engine, driver } = setup({ journal });
    const actor = engine.createActor("actor#1");
    // Arrival order is the reverse of the recorded order: ask#2 first (seq1, should be held), then
    // ask#1 (seq0, triggers the release).
    const pB = engine.ask("ask#2", actor, "B");
    const pA = engine.ask("ask#1", actor, "A");
    await expect(Promise.all([pA, pB])).resolves.toEqual(["r1", "r2"]);

    // The release order follows the recorded actorSeq, not the arrival order.
    expect(driver.cachedSettleOrder()).toEqual(["ask#1@1", "ask#2@1"]);
    expect(driver.startAskCount()).toBe(0);
  });

  it("turns the same-site nondeterministic-ordinal gap into a loud inputHash failure (not wrong results)", async () => {
    // Design backstop for a v1 limitation: for a same-site ask gated by a nondeterministic
    // predecessor, its ordinal depends on arrival order and is not deterministic.
    // The journal records ask#1@1="plan A" and ask#1@2="plan B"; if replay swapped their order, the
    // first arrival would get ordinal 1 carrying "plan B" → hash mismatch with the record → the run
    // fails loudly and never returns a wrong result.
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
    });
    journal.putActor({ runId: RUN, siteId: "actor#1", ordinal: 1 });
    journal.putNode({
      runId: RUN,
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorSeq: 0,
      inputHash: inputHash("plan A"),
      status: "completed",
      result: "A",
    });
    journal.putNode({
      runId: RUN,
      siteId: "ask#1",
      ordinal: 2,
      kind: "ask",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorSeq: 1,
      inputHash: inputHash("plan B"),
      status: "completed",
      result: "B",
    });

    const { engine } = setup({ journal });
    const actor = engine.createActor("actor#1");
    const pB = engine.ask("ask#1", actor, "plan B"); // gets ordinal 1, but the record holds plan A → mismatch
    await expect(pB).rejects.toMatchObject({ code: "InputHashMismatch" });
    await expect(engine.settled).resolves.toMatchObject({
      status: "errored",
      error: { code: "InputHashMismatch" },
    });
  });
});

describe("WorkflowEngine — mid-run crash + resume", () => {
  it("resumes over the same journal, short-circuiting finished nodes and finishing the rest", async () => {
    const journal = new InMemoryJournalStore();

    // run1: settles ask#1, then "crashes" (ask#2 never ran).
    {
      const driver1 = new FakeDriver(journal);
      const e1 = new WorkflowEngine({
        runId: RUN,
        driver: driver1,
        caps: { maxConcurrency: 16 },
        askSpecs: untypedSpecs("ask#1", "ask#2"),
        validate: () => [],
      });
      const a = e1.createActor("actor#1");
      const p1 = e1.ask("ask#1", a, "A");
      await flush();
      e1.askTurnEnded(inst("ask#1"), "RA");
      await expect(p1).resolves.toBe("RA");
    }

    // run2: replays over the same journal.
    const driver2 = new FakeDriver(journal);
    const e2 = new WorkflowEngine({
      runId: RUN,
      driver: driver2,
      caps: { maxConcurrency: 16 },
      askSpecs: untypedSpecs("ask#1", "ask#2"),
      validate: () => [],
    });
    const a2 = e2.createActor("actor#1");

    const r1 = await e2.ask("ask#1", a2, "A"); // journal hit
    expect(r1).toBe("RA");
    expect(driver2.startAskCount(inst("ask#1"))).toBe(0); // not re-executed

    const p2 = e2.ask("ask#2", a2, "B"); // new node, actually dispatched
    await flush();
    expect(driver2.startAskCount(inst("ask#2"))).toBe(1);
    e2.askTurnEnded(inst("ask#2"), "RB");
    await expect(p2).resolves.toBe("RB");

    e2.complete("done");
    await expect(e2.settled).resolves.toMatchObject({ status: "completed", artifact: "done" });
  });

  it("re-dispatches a crash-mid-flight node (status running) live, enforcing its recorded actorSeq", async () => {
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
    });
    journal.putActor({ runId: RUN, siteId: "actor#1", ordinal: 1 });
    // ask#1 finished (seq0); ask#2 crashed mid-execution (seq1, status running).
    journal.putNode({
      runId: RUN,
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorSeq: 0,
      inputHash: inputHash("A"),
      status: "completed",
      result: "RA",
    });
    journal.putNode({
      runId: RUN,
      siteId: "ask#2",
      ordinal: 1,
      kind: "ask",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorSeq: 1,
      inputHash: inputHash("B"),
      status: "running",
    });

    const { engine, journal: j, driver } = setup({ journal });
    const actor = engine.createActor("actor#1");
    const p1 = engine.ask("ask#1", actor, "A"); // finished hit, short-circuits
    const p2 = engine.ask("ask#2", actor, "B"); // running → re-dispatched live
    await flush();

    expect(await p1).toBe("RA");
    expect(driver.startAskCount(inst("ask#1"))).toBe(0); // finished node not re-run
    expect(driver.startAskCount(inst("ask#2"))).toBe(1); // running node re-executed live

    engine.askTurnEnded(inst("ask#2"), "RB");
    expect(await p2).toBe("RB");
    // The running record is updated to completed, and actorSeq keeps the recorded value.
    expect(j.getNode(RUN, "ask#2", 1)?.status).toBe("completed");
    expect(j.getNode(RUN, "ask#2", 1)?.actorSeq).toBe(1);
  });

  it("re-creates the actor session via the driver even when the journal records a sessionId", async () => {
    // Bug root cause (re-dispatch on resume must blow up on a production driver): registerActor
    // used to pre-resolve the sessionId recorded in the journal into actor.sessionPromise, letting
    // ensureSession skip driver.createActorSession; the production driver's sessions map is **only**
    // populated inside createActorSession, and startAsk looks the session up by map
    // → every re-dispatched ask failed immediately with DriverError "unknown session". Pure replay
    // (zero dispatches) and the fake driver (startAsk does not consult the map) both fail to catch
    // this, so the createActorSession call count is pinned directly here.
    // Session identity is driver-owned (the production minting function is purely deterministic on
    // (runId, actorRef)); the journal value is only a record.
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
    });
    journal.putActor({ runId: RUN, siteId: "actor#1", ordinal: 1, sessionId: "session:actor#1@1" });
    journal.putNode({
      runId: RUN,
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorSeq: 0,
      inputHash: inputHash("A"),
      status: "running",
    });

    const { engine, journal: j, driver } = setup({ journal });
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "A");
    await flush();

    // Key assertion: the session was rebuilt through the driver (exactly once), and the dispatch
    // used the driver-created session.
    expect(driver.sessionCreations).toEqual([{ siteId: "actor#1", ordinal: 1 }]);
    expect(driver.startAskCount(inst("ask#1"))).toBe(1);
    expect(driver.startAsks[0]?.session.id).toBe("session:actor#1@1");

    engine.askTurnEnded(inst("ask#1"), "RA");
    await expect(p).resolves.toBe("RA");
    // ensureSession's putActor records the (necessarily identical in production) sessionId back.
    expect(j.getActor(RUN, "actor#1", 1)?.sessionId).toBe("session:actor#1@1");
  });

  it("restores the tokens already spent by the crashed run instead of starting from zero", async () => {
    // Regression: usage used to be persisted only once at createRun(0); askStats accumulations were
    // never written back, so a resumed engine started counting from zero and run-level usage was
    // discontinuous across lifecycles.
    const caps: Caps = { maxConcurrency: 16 };
    const journal = new InMemoryJournalStore();

    {
      const e1 = new WorkflowEngine({
        runId: RUN,
        driver: new FakeDriver(journal),
        caps,
        askSpecs: untypedSpecs("ask#1", "ask#2"),
        validate: () => [],
      });
      const a = e1.createActor("actor#1");
      const p = e1.ask("ask#1", a, "A");
      await flush();
      e1.askStats(inst("ask#1"), { tokens: 300, toolCalls: 1, turns: 1 });
      e1.askTurnEnded(inst("ask#1"), "RA");
      await expect(p).resolves.toBe("RA");
    }

    expect(journal.getRun(RUN)?.spentTokens).toBe(300);

    const driver2 = new FakeDriver(journal);
    const e2 = new WorkflowEngine({
      runId: RUN,
      driver: driver2,
      caps,
      askSpecs: untypedSpecs("ask#1", "ask#2"),
      validate: () => [],
    });
    const b = e2.createActor("actor#2");
    void e2.ask("ask#2", b, "B").catch(() => {});
    await flush();
    e2.askStats(inst("ask#2"), { tokens: 100, toolCalls: 0, turns: 1 });
    // The event payload and the column value are produced in the same synchronous step: after
    // resume the count keeps accumulating rather than starting from 0 again.
    expect(driver2.events.at(-1)).toEqual({ type: "usage-updated", spentTokens: 400 });
    expect(journal.getRun(RUN)?.spentTokens).toBe(400);
  });
});

describe("WorkflowEngine — cancellation", () => {
  it("cancels in-flight asks, settles cancelled, and keeps finished journal entries", async () => {
    const { engine, driver, journal } = setup();
    const actor = engine.createActor("actor#1");

    const pDone = engine.ask("ask#1", actor, "A");
    await flush();
    engine.askTurnEnded(inst("ask#1"), "RA"); // settles as completed, journaled
    await expect(pDone).resolves.toBe("RA");

    const pInFlight = engine.ask("ask#2", actor, "B");
    await flush();
    expect(driver.startAskCount(inst("ask#2"))).toBe(1);

    engine.stop("user");
    expect(driver.cancels).toContainEqual(inst("ask#2"));
    await expect(pInFlight).rejects.toMatchObject({ code: "Cancelled" });
    await expect(engine.settled).resolves.toEqual({ status: "stopped", reason: "user" });
    expect(journal.getRun(RUN)).toMatchObject({ status: "stopped", stopReason: "user" });
    expect(driver.events.at(-1)).toEqual({
      type: "run-settled",
      status: "stopped",
      stopReason: "user",
    });

    // Finished nodes stay completed; the in-flight node stays at the running record from admission
    // (not a "finished" outcome), which resume can use to re-run it.
    expect(journal.getNode(RUN, "ask#1", 1)?.status).toBe("completed");
    expect(journal.getNode(RUN, "ask#2", 1)?.status).toBe("running");
  });
});

describe("WorkflowEngine — complete() with in-flight asks", () => {
  // A script may return while asks are still in flight (the Promise.race loser, an ask nobody
  // awaited). complete() must handle them byte-for-byte the same way as cancel(), otherwise the
  // scheduler holds the node forever, the driver-side turn keeps burning tokens, and a
  // node-dispatched in the event log never sees its node-settled. See docs/execution-engine.md.
  it("aborts the in-flight ask like stop() does, then settles completed with the artifact", async () => {
    const { engine, driver, journal } = setup();
    const actor = engine.createActor("actor#1");

    const pDone = engine.ask("ask#1", actor, "A");
    await flush();
    engine.askTurnEnded(inst("ask#1"), "RA");
    await expect(pDone).resolves.toBe("RA");

    const pInFlight = engine.ask("ask#2", actor, "B");
    await flush();
    expect(driver.startAskCount(inst("ask#2"))).toBe(1);

    engine.complete("done");
    expect(driver.cancels).toContainEqual(inst("ask#2"));
    await expect(pInFlight).rejects.toMatchObject({ code: "Cancelled" });
    await expect(engine.settled).resolves.toEqual({ status: "completed", artifact: "done" });
    expect(engine.status()).toBe("completed");

    // Event order: the in-flight node is cancelled first, then run-settled(completed).
    const types = driver.events.map((e) => e.type);
    const settledIdx = types.lastIndexOf("node-settled");
    const runIdx = types.lastIndexOf("run-settled");
    expect(driver.events[settledIdx]).toMatchObject({
      instance: inst("ask#2"),
      outcome: "cancelled",
    });
    expect(driver.events[runIdx]).toMatchObject({ status: "completed" });
    expect(settledIdx).toBeLessThan(runIdx);

    // The journal mirrors the cancel path: finished nodes completed, in-flight nodes stopped at
    // running; the run is completed with its artifact.
    expect(journal.getNode(RUN, "ask#1", 1)?.status).toBe("completed");
    expect(journal.getNode(RUN, "ask#2", 1)?.status).toBe("running");
    expect(journal.getRun(RUN)?.status).toBe("completed");
    expect(journal.getRun(RUN)?.result).toBe("done");
  });

  it("does nothing extra when no ask is in flight (byte-for-byte the plain complete)", async () => {
    const { engine, driver } = setup();
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "A");
    await flush();
    engine.askTurnEnded(inst("ask#1"), "RA");
    await expect(p).resolves.toBe("RA");

    engine.complete("done");
    expect(driver.cancels).toEqual([]);
    expect(driver.eventsOfType("node-settled").map((e) => e.outcome)).toEqual(["ok"]);
    await expect(engine.settled).resolves.toEqual({ status: "completed", artifact: "done" });
  });

  it("persists straggler stats after complete() to the usage row without emitting events", async () => {
    const { engine, driver, journal } = setup();
    const winner = engine.createActor("actor#1");
    const loser = engine.createActor("actor#2");
    const pWin = engine.ask("ask#1", winner, "fast");
    void engine.ask("ask#2", loser, "slow").catch(() => {});
    await flush();
    engine.askTurnEnded(inst("ask#1"), "won");
    await expect(pWin).resolves.toBe("won");
    engine.complete("won");

    const eventCount = driver.events.length;
    // A real actor's usage is only known after the turn resolves: final stats often arrive after
    // complete(). The accounting must survive (both the usage row and the node backfill are journal
    // row updates), but the event stream must not grow again — run-settled is the last event.
    engine.askStats(inst("ask#2"), { tokens: 7, toolCalls: 0, turns: 1 });
    expect(driver.events.length).toBe(eventCount);
    expect(journal.getRun(RUN)?.spentTokens).toBe(7);
    expect(journal.getNode(RUN, "ask#2", 1)?.stats).toEqual({ tokens: 7, toolCalls: 0, turns: 1 });
  });
});

describe("WorkflowEngine — driver dispose at settlement", () => {
  // Engine contract: all three terminal paths call driver.dispose exactly once, after run-settled;
  // under first-wins it is not repeated.
  async function withInFlightAsk() {
    const { engine, driver } = setup();
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "A");
    void p.catch(() => {});
    await flush();
    expect(driver.disposeCalls).toBe(0);
    return { engine, driver };
  }

  function expectDisposedOnceAfterRunSettled(driver: FakeDriver): void {
    expect(driver.disposeCalls).toBe(1);
    const runSettledIdx = driver.events.findIndex((e) => e.type === "run-settled");
    expect(runSettledIdx).toBeGreaterThanOrEqual(0);
    expect(driver.eventsAtDispose).toBe(runSettledIdx + 1);
  }

  it("complete(): once, after run-settled, and not again on a later stop()/fail()", async () => {
    const { engine, driver } = await withInFlightAsk();
    engine.complete("done");
    expectDisposedOnceAfterRunSettled(driver);
    engine.stop("user");
    engine.fail(new WorkflowError("DriverError", "late"));
    expect(driver.disposeCalls).toBe(1);
  });

  it("stop(): once, after run-settled", async () => {
    const { engine, driver } = await withInFlightAsk();
    engine.stop("user");
    expectDisposedOnceAfterRunSettled(driver);
    engine.complete("late");
    expect(driver.disposeCalls).toBe(1);
  });

  it("fail(): once, after run-settled", async () => {
    const { engine, driver } = await withInFlightAsk();
    engine.fail(new WorkflowError("DriverError", "boom"));
    expectDisposedOnceAfterRunSettled(driver);
    expect(driver.disposeCalls).toBe(1);
  });

  it("a driver without dispose is fine (the hook is optional)", async () => {
    const journal = new InMemoryJournalStore();
    const driver = new FakeDriver(journal);
    (driver as { dispose?: () => void }).dispose = undefined;
    const engine = new WorkflowEngine({
      runId: RUN,
      driver,
      caps: { maxConcurrency: 16 },
      askSpecs: untypedSpecs("ask#1"),
      validate: () => [],
    });
    engine.complete("done");
    await expect(engine.settled).resolves.toEqual({ status: "completed", artifact: "done" });
  });
});

describe("WorkflowEngine — usage (no caps)", () => {
  it("never caps the node count: well past the old limit of 100 the run is still running", async () => {
    // docs/dynamic-workflow/authoring.md: the node cap was removed entirely; cancellation is the
    // only means of stopping.
    const { engine, driver, journal } = setup({ caps: { maxConcurrency: 200 } });
    for (let i = 1; i <= 120; i++) {
      const actor = engine.createActor(`actor#${i}`);
      void engine.ask("ask#1", actor, `job ${i}`).catch(() => {});
    }
    await flush();

    expect(journal.getRun(RUN)?.status).toBe("running");
    expect(driver.events.filter((e) => e.type === "node-dispatched")).toHaveLength(120);
    engine.stop("user");
  });

  it("emits usage-updated with the accumulated spentTokens and never fails the run on usage", async () => {
    const { engine, driver, journal } = setup({ askSpecs: typedSpecs(), validate: requireFields });
    const actor = engine.createActor("actor#1");
    void engine.ask("ask#1", actor, "do it").catch(() => {});
    await flush();

    engine.askStats(inst("ask#1"), { tokens: 30, toolCalls: 0, turns: 1 });
    expect(driver.events.at(-1)).toEqual({ type: "usage-updated", spentTokens: 30 });
    expect(journal.getRun(RUN)?.spentTokens).toBe(30);

    engine.askStats(inst("ask#1"), { tokens: 80, toolCalls: 0, turns: 1 });
    expect(driver.events.at(-1)).toEqual({ type: "usage-updated", spentTokens: 110 });
    expect(journal.getRun(RUN)?.spentTokens).toBe(110);
    expect(journal.getRun(RUN)?.status).toBe("running");
    engine.stop("user");
  });
});

describe("WorkflowEngine — fail() (harness-driven run failure)", () => {
  it("settles failed, cancels in-flight asks, records failure_json, and is first-wins", async () => {
    const { engine, driver, journal } = setup();
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "A");
    void p.catch(() => {}); // the run failure will reject this ask
    await flush();
    expect(driver.startAskCount(inst("ask#1"))).toBe(1);

    // The harness classifies a child process throw/crash/timeout as a run failure.
    const boom = new WorkflowError("DriverError", "child crashed");
    engine.fail(boom);

    expect(driver.cancels).toContainEqual(inst("ask#1")); // in-flight ask cancelled on the driver side
    await expect(p).rejects.toBe(boom); // the in-flight ask rejects with the run error
    await expect(engine.settled).resolves.toEqual({ status: "errored", error: boom });
    expect(engine.status()).toBe("errored");

    const run = journal.getRun(RUN);
    expect(run?.status).toBe("errored");
    expect(run?.failure).toEqual({ code: "DriverError", message: "child crashed" });
    expect(run?.stopReason).toBeUndefined();

    // first-wins: later complete(), a second fail(), and stop() are all no-ops.
    engine.complete("late");
    engine.fail(new WorkflowError("Cancelled", "ignored"));
    engine.stop("interrupted", new WorkflowError("Interrupted", "late"));
    await expect(engine.settled).resolves.toEqual({ status: "errored", error: boom });
  });

  it("createActorSession rejection surfaces the cause text in the DriverError (journal + reject)", async () => {
    // 2026-09-03, on a real machine: the directly started first actor hit a FOREIGN KEY constraint
    // creating session_task_link, and the run only kept "failed to create the actor session" —
    // the cause did not go into toJSON and nobody logged it, leaving nothing to diagnose from. This
    // pins that the message must carry the cause's text.
    const { engine, journal, driver } = setup({ deferSessions: true });
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "A");
    driver.sessionDeferrals[0]!.reject(new Error("FOREIGN KEY constraint failed"));
    // What is pinned is the presence of the cause text (the variable part), not the full wording.
    await expect(p).rejects.toMatchObject({
      code: "DriverError",
      message: expect.stringContaining("FOREIGN KEY constraint failed"),
    });
    expect(journal.getNode(RUN, "ask#1", 1)?.error).toMatchObject({
      code: "DriverError",
      message: expect.stringContaining("FOREIGN KEY constraint failed"),
    });
  });

  it("complete() first wins over a later fail()", async () => {
    const { engine } = setup();
    engine.complete("ok");
    engine.fail(new WorkflowError("DriverError", "too late"));
    await expect(engine.settled).resolves.toEqual({ status: "completed", artifact: "ok" });
  });

  it("createActor throws synchronously once the run has failed (harness can catch → fail())", async () => {
    const { engine } = setup();
    engine.fail(new WorkflowError("DriverError", "boom"));
    // Thrown synchronously (no async leak), so the harness's try/catch can catch it directly and
    // turn it into fail().
    expect(() => engine.createActor("actor#1")).toThrow();
  });
});

describe("WorkflowEngine — stats backfill after settle", () => {
  it("backfills stats onto a typed ask journaled at settle when askStats arrives after the submit", async () => {
    // The typed-accept path (the dominant path): submit ends the turn and is journaled at settle;
    // a real actor's usage is only known after the turn resolves (after the submit), so askStats
    // arrives after the node has already left liveNodes. The engine backfills.
    const { engine, journal } = setup({ askSpecs: typedSpecs(), validate: requireFields });
    const actor = engine.createActor("actor#1", "planner");
    const p = engine.ask("ask#1", actor, "do it");
    await flush();

    engine.askSubmitAttempted(inst("ask#1"), { x: 1 });
    await expect(p).resolves.toEqual({ x: 1 });

    const settled = journal.getNode(RUN, "ask#1", 1);
    expect(settled?.status).toBe("completed");
    expect(settled?.stats).toBeUndefined(); // stats had not arrived at settle time

    engine.askStats(inst("ask#1"), { tokens: 42, toolCalls: 2, turns: 1 });

    const node = journal.getNode(RUN, "ask#1", 1);
    expect(node?.stats).toEqual({ tokens: 42, toolCalls: 2, turns: 1 });
    // Only stats are added; every other field is unchanged (status/result/actorSeq/inputHash/actor
    // identity).
    expect(node?.status).toBe("completed");
    expect(node?.result).toEqual({ x: 1 });
    expect(node?.actorSeq).toBe(0);
    expect(node?.inputHash).toBe(inputHash("do it"));
    expect(node?.actorSiteId).toBe("actor#1");
    expect(node?.actorOrdinal).toBe(1);
    expect(node?.kind).toBe("ask");
  });

  it("preserves the pre-settle path: stats reported before submit are present at settle without a backfill", async () => {
    const { engine, journal } = setup({ askSpecs: typedSpecs(), validate: requireFields });
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "do it");
    await flush();

    engine.askStats(inst("ask#1"), { tokens: 10, toolCalls: 1, turns: 1 });
    engine.askSubmitAttempted(inst("ask#1"), { x: 1 });
    await expect(p).resolves.toEqual({ x: 1 });

    expect(journal.getNode(RUN, "ask#1", 1)?.stats).toEqual({ tokens: 10, toolCalls: 1, turns: 1 });
  });

  it("is a no-op when the node was never journaled (defensive, best-effort)", async () => {
    // Stats reported for an instance that was never admitted: no live node and no journal record;
    // the backfill silently skips (no throw, no record created).
    const { engine, journal } = setup({ askSpecs: typedSpecs(), validate: requireFields });
    engine.createActor("actor#1");
    engine.askStats(inst("ask#404"), { tokens: 5, toolCalls: 0, turns: 1 });
    expect(journal.getNode(RUN, "ask#404", 1)).toBeUndefined();
  });
});

describe("WorkflowEngine — run metadata", () => {
  it("persists scriptText / scriptHash / parentSessionId / cwd / toolCallId through createRun", async () => {
    // RunRecord declared the first four fields long ago, but createRun never populated them — so
    // the resume script_hash check had nothing to compare against. Persisting them is that check's
    // only precondition. toolCallId is the fifth, added by the cancel & resume feature: the only
    // durable source for the tool-card join and resume notification anchor after a restart.
    const { journal } = setup({
      scriptText: 'await agent("a").ask("hi");',
      scriptHash: "hash-a",
      parentSessionId: "sess_parent",
      cwd: "/tmp/project",
      toolCallId: "call-abc",
    });
    expect(journal.getRun(RUN)).toMatchObject({
      runId: RUN,
      status: "running",
      scriptText: 'await agent("a").ask("hi");',
      scriptHash: "hash-a",
      parentSessionId: "sess_parent",
      cwd: "/tmp/project",
      toolCallId: "call-abc",
    });
  });

  // name travels the exact same metadata path as the four fields above (EngineConfig → createRun,
  // and no writer touches it afterwards). It is purely presentational: the engine does not read it;
  // the host's enumeration surface uses it as a label — without this step, runs listed across
  // sessions would just be a string of bare runIds (docs/dynamic-workflow/launch.md).
  it("persists the run name through createRun", async () => {
    const { journal } = setup({ name: "nightly triage" });
    expect(journal.getRun(RUN)).toMatchObject({ runId: RUN, name: "nightly triage" });
  });

  it("omits the metadata fields entirely when the config carries none", async () => {
    // Absent fields must not be persisted as undefined keys: storage implementations distinguish
    // "field absent" from "field is null" (see the contract tests).
    const { journal } = setup();
    const run = journal.getRun(RUN)!;
    expect("scriptText" in run).toBe(false);
    expect("scriptHash" in run).toBe(false);
    expect("parentSessionId" in run).toBe(false);
    expect("cwd" in run).toBe(false);
    // An unnamed run must be an **absent key**, not a null/undefined value: the read side uses this
    // to fall back to the first line of the script.
    expect("name" in run).toBe(false);
    expect("toolCallId" in run).toBe(false);
    // The overwhelming majority of runs are not revisions: the lineage pointer must likewise be
    // absent rather than persisted as an empty value
    // (docs/execution-engine.md).
    expect("resumedFrom" in run).toBe(false);
  });

  // resumedFrom travels the same write-once metadata path. The engine does not read it: the
  // imported cache is built in the run service. Its meaning on disk shows up after a crash — a
  // revision run's plain resume reads this pointer back to rebuild ImportedCache.
  it("persists the amend-resume lineage pointer through createRun", async () => {
    const { journal } = setup({ resumedFrom: "run-predecessor" });
    expect(journal.getRun(RUN)).toMatchObject({ runId: RUN, resumedFrom: "run-predecessor" });
  });
});

// A named actor is the identity key for amend-resume cache import, and **any** run is a potential
// predecessor of a future revision — so this uniqueness rule applies to all runs, not just revision
// runs (docs/execution-engine.md "Amend-resume").
describe("WorkflowEngine — actor name uniqueness", () => {
  it("fails the run when a non-empty name repeats (both sites via the name argument)", async () => {
    const { engine, journal } = setup();
    engine.createActor("actor#1", "planner");
    // createActor is a synchronous surface (no promise to reject), so it takes the same posture as
    // assertRunning: throw.
    expect(() => engine.createActor("actor#2", "planner")).toThrow(
      expect.objectContaining({ code: "DuplicateActorName" }),
    );
    await expect(engine.settled).resolves.toMatchObject({
      status: "errored",
      error: expect.objectContaining({ code: "DuplicateActorName" }),
    });
    expect(journal.getRun(RUN)?.failure?.code).toBe("DuplicateActorName");
  });

  it("compares the effective name, so persona.name collides with a plain name argument", async () => {
    // The effective name = spec.name after normalizePersona; persona.name overrides the name
    // argument. Dedup must look at that value, otherwise "name=b, persona.name=a" could bypass the
    // rule and produce two a's in the predecessor.
    const { engine } = setup();
    engine.createActor("actor#1", "reviewer");
    expect(() => engine.createActor("actor#2", "second", { name: "reviewer" })).toThrow(
      expect.objectContaining({ code: "DuplicateActorName" }),
    );
  });

  it("does not collide when persona.name renames one of two identical name arguments", async () => {
    // The other side of the same rule: identical name arguments but persona.name overrides one of
    // them, so the effective names differ.
    const { engine, journal } = setup();
    engine.createActor("actor#1", "worker");
    engine.createActor("actor#2", "worker", { name: "worker-2" });
    expect(journal.getRun(RUN)?.status).toBe("running");
    expect(
      journal
        .listActors(RUN, { withPersona: true })
        .map((a) => a.persona?.name)
        .sort(),
    ).toEqual(["worker", "worker-2"]);
  });

  it("allows any number of anonymous actors (absent or empty names)", async () => {
    // Anonymous is legal and not checked — the tradeoff has already been adjudicated: no cache
    // eligibility. The empty string and absence both count as anonymous.
    const { engine, journal } = setup();
    engine.createActor("actor#1");
    engine.createActor("actor#2");
    engine.createActor("actor#3", "");
    engine.createActor("actor#4", "", { name: "" });
    expect(journal.getRun(RUN)?.status).toBe("running");
    expect(journal.listActors(RUN, { withPersona: true })).toHaveLength(4);
  });

  it("allows distinct names", async () => {
    const { engine, journal } = setup();
    engine.createActor("actor#1", "planner");
    engine.createActor("actor#2", "reviewer");
    expect(journal.getRun(RUN)?.status).toBe("running");
  });

  it("does not false-positive on a byte-identical resume (fresh engine, names re-registered once)", async () => {
    // Replay safety: the dedup table is purely in-memory and lives with the engine instance. Resume
    // re-runs the same sequence of createActor calls from scratch in a brand-new engine, so each
    // name gets registered exactly once. This is also why it cannot be persisted to the journal.
    const journal = new InMemoryJournalStore();
    {
      const e1 = setup({ journal }).engine;
      e1.createActor("actor#1", "planner");
      e1.createActor("actor#2", "reviewer");
      e1.stop("user");
    }
    const { engine, journal: same } = setup({ journal });
    expect(() => {
      engine.createActor("actor#1", "planner");
      engine.createActor("actor#2", "reviewer");
    }).not.toThrow();
    expect(same.getRun(RUN)?.status).toBe("running");
  });
});

describe("WorkflowEngine — actor persona and resolved model", () => {
  // The persona is **pure pass-through data** to the engine: the engine does not interpret it but
  // must deliver it verbatim to the driver, the events, and the journal —
  // it is a frozen identity, rebuilt from the same copy at resume time. The model is not in the
  // persona (no model tiers since 2026-09-11): which model a subagent runs on is a host fact,
  // written into resolvedModel by the driver.
  it("carries the persona through to the driver, the actor-created event and the journal", async () => {
    const { engine, driver, journal } = setup();
    const actor = engine.createActor("actor#1", "judge", {
      system: "You judge.",
    });
    const p = engine.ask("ask#1", actor, "judge it");
    await flush();

    expect(driver.sessionPersonas[0]).toEqual({
      name: "judge",
      system: "You judge.",
    });
    const created = driver.events.find((e) => e.type === "actor-created");
    expect(created).toMatchObject({
      persona: { name: "judge", system: "You judge." },
    });
    expect(journal.getActor(RUN, "actor#1", 1)?.persona).toEqual({
      name: "judge",
      system: "You judge.",
    });

    engine.askTurnEnded(inst("ask#1"), "ok");
    await expect(p).resolves.toBe("ok");
  });

  // docs/dynamic-workflow/authoring.md "Choosing a model per subagent": a persona may name a model.
  // The engine only records the name and hands it to the driver verbatim — looking up the binding
  // table and creating the session are the host's business.
  it("carries a persona model name verbatim to the driver, the event and the journal", async () => {
    const { engine, driver, journal } = setup();
    const actor = engine.createActor("actor#1", "judge", {
      system: "You judge.",
      model: "GLM-5.3-Flash$high",
    });
    const p = engine.ask("ask#1", actor, "judge it");
    await flush();

    const expected = { name: "judge", system: "You judge.", model: "GLM-5.3-Flash$high" };
    expect(driver.sessionPersonas[0]).toEqual(expected);
    expect(driver.events.find((e) => e.type === "actor-created")).toMatchObject({
      persona: expected,
    });
    expect(journal.getActor(RUN, "actor#1", 1)?.persona).toEqual(expected);
    // The dispatch repeats the birth facts, and the persona's model name is among them (the bounded
    // read surface that lists subagents needs to carry it).
    expect(driver.events.find((e) => e.type === "node-dispatched")).toMatchObject({
      actorName: "judge",
      actorPersonaModel: "GLM-5.3-Flash$high",
    });

    engine.askTurnEnded(inst("ask#1"), "ok");
    await expect(p).resolves.toBe("ok");
  });

  it("a dispatch of a persona without a model carries no actorPersonaModel", async () => {
    const { engine, driver } = setup();
    const actor = engine.createActor("actor#1", "judge", { system: "You judge." });
    const p = engine.ask("ask#1", actor, "judge it");
    await flush();
    const dispatched = driver.events.find((e) => e.type === "node-dispatched");
    expect(dispatched).toBeDefined();
    expect("actorPersonaModel" in dispatched!).toBe(false);
    engine.askTurnEnded(inst("ask#1"), "ok");
    await expect(p).resolves.toBe("ok");
  });

  it("keeps only the known string fields of an object persona off the wire", async () => {
    // Weird values smuggled in via type assertions from the sandbox must not travel all the way
    // into the journal and the host's session creation path.
    const { engine, journal } = setup();
    engine.createActor("actor#1", "judge", {
      system: "You judge.",
      model: 42,
      tools: "none",
    } as unknown as PersonaSpec);
    expect(journal.getActor(RUN, "actor#1", 1)?.persona).toEqual({
      name: "judge",
      system: "You judge.",
    });
  });

  it("carries a string persona through unchanged (nothing invented)", async () => {
    const { engine, journal } = setup();
    engine.createActor("actor#1", "planner", "You plan.");
    const persona = journal.getActor(RUN, "actor#1", 1)?.persona;
    expect(persona).toEqual({ name: "planner", system: "You plan." });
  });

  it("does not clobber the driver-written resolvedModel when journaling the session", async () => {
    // resolvedModel is a **driver-owned** field: only the host knows which model the subagent runs
    // on, so it is written inside createActorSession. putActor, however, replaces the whole record,
    // and the engine writes once more after session creation returns (to add the sessionId) — that
    // write must carry resolvedModel over, otherwise the basis for cost auditing and the resume pin
    // is lost on the normal path.
    const { engine, journal } = setup({
      resolveModel: (persona) =>
        persona.name === "judge" ? "anthropic/haiku" : "anthropic/sonnet",
    });
    const actor = engine.createActor("actor#1", "judge", { system: "You judge." });
    const p = engine.ask("ask#1", actor, "judge it");
    await flush();

    const record = journal.getActor(RUN, "actor#1", 1);
    expect(record?.resolvedModel).toBe("anthropic/haiku");
    // On the same record, the engine's own fields remain intact.
    expect(record?.sessionId).toBe("session:actor#1@1");
    expect(record?.persona).toEqual({ name: "judge", system: "You judge." });

    engine.askTurnEnded(inst("ask#1"), "ok");
    await expect(p).resolves.toBe("ok");
  });

  it("preserves a journaled resolvedModel across a replayed createActor", async () => {
    // Resume path: when createActor runs again for the same (siteId, ordinal), the engine's
    // putActor must not erase the model resolved by the previous
    // run — it is precisely the basis for "resume re-attaching to the same model".
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
    });
    journal.putActor({
      runId: RUN,
      siteId: "actor#1",
      ordinal: 1,
      sessionId: "session:actor#1@1",
      resolvedModel: "anthropic/haiku",
    });

    const { engine } = setup({ journal });
    engine.createActor("actor#1", "judge", { system: "You judge." });

    expect(journal.getActor(RUN, "actor#1", 1)).toMatchObject({
      sessionId: "session:actor#1@1",
      resolvedModel: "anthropic/haiku",
      persona: { name: "judge", system: "You judge." },
    });
  });
});

describe("WorkflowEngine — resume script identity", () => {
  /** Builds a pre-existing run record (simulating a journal left behind by a previous run). */
  function seedRun(journal: InMemoryJournalStore, scriptHash?: string): void {
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 7,
      status: "stopped",
      stopReason: "user",
      ...(scriptHash === undefined ? {} : { scriptHash }),
    });
  }

  it("refuses to resume when the journaled scriptHash differs from the config's", () => {
    // V1's resume restriction is "byte-identical script text". A hash mismatch means the caller is
    // reusing the same runId with a different script: refuse this resume instead of accepting it and
    // letting the run fail later.
    const journal = new InMemoryJournalStore();
    seedRun(journal, "hash-old");
    const driver = new FakeDriver(journal);

    const construct = () =>
      new WorkflowEngine({
        runId: RUN,
        driver,
        caps: { maxConcurrency: 16 },
        askSpecs: new Map(),
        validate: () => [],
        scriptHash: "hash-new",
      });
    expect(construct).toThrowError(expect.objectContaining({ code: "ScriptHashMismatch" }));

    // Both hashes must travel structurally with the error: whoever debugs a refused resume needs to
    // see which side changed,
    // not scrape values out of the message with a regex (flow decisions must not depend on error text).
    let thrown: WorkflowError | undefined;
    try {
      construct();
    } catch (error) {
      thrown = error as WorkflowError;
    }
    expect(thrown?.mismatch).toEqual({ expected: "hash-old", got: "hash-new" });
    // The serializable form persisted to the journal carries it too (failure_json is the durable
    // record the app side reads).
    expect(thrown?.toJSON()).toMatchObject({
      code: "ScriptHashMismatch",
      mismatch: { expected: "hash-old", got: "hash-new" },
    });
    expect(WorkflowError.fromJSON(thrown!.toJSON()).mismatch).toEqual({
      expected: "hash-old",
      got: "hash-new",
    });

    // The existing journal record must not be rewritten by this rejection — it is still resumable
    // with the correct script.
    expect(journal.getRun(RUN)).toMatchObject({
      status: "stopped",
      scriptHash: "hash-old",
      spentTokens: 7,
    });
    // The rejection happens before any events: no run-started, no run-settled.
    expect(driver.events).toEqual([]);
    expect(journal.listEvents(RUN, { types: "all", reportItems: "all" })).toEqual([]);
  });

  it("resumes when the two hashes match", () => {
    const journal = new InMemoryJournalStore();
    seedRun(journal, "hash-same");
    const driver = new FakeDriver(journal);
    const engine = new WorkflowEngine({
      runId: RUN,
      driver,
      caps: { maxConcurrency: 16 },
      askSpecs: new Map(),
      validate: () => [],
      scriptHash: "hash-same",
    });
    expect(engine.status()).toBe("running");
    expect(journal.getRun(RUN)?.spentTokens).toBe(7); // the budget is still restored from the record
  });

  it("resumes when either side has no hash (records predating run metadata)", () => {
    // Only "both present and different" rejects: with one side missing there is nothing to compare,
    // and no mismatch may be invented in that case.
    const withoutRecordHash = new InMemoryJournalStore();
    seedRun(withoutRecordHash);
    expect(
      new WorkflowEngine({
        runId: RUN,
        driver: new FakeDriver(withoutRecordHash),
        caps: { maxConcurrency: 16 },
        askSpecs: new Map(),
        validate: () => [],
        scriptHash: "hash-new",
      }).status(),
    ).toBe("running");

    const withoutConfigHash = new InMemoryJournalStore();
    seedRun(withoutConfigHash, "hash-old");
    expect(
      new WorkflowEngine({
        runId: RUN,
        driver: new FakeDriver(withoutConfigHash),
        caps: { maxConcurrency: 16 },
        askSpecs: new Map(),
        validate: () => [],
      }).status(),
    ).toBe("running");
  });
});

describe("WorkflowEngine — askSpecs completeness", () => {
  it("fails the run loudly instead of degrading an unlisted ask site to untyped", async () => {
    // The site table and schema synthesis come from the same compilation, so a miss can only be a
    // wiring error. The old
    // `?? { typed: false }` fallback would silently downgrade a typed ask: no submit_result
    // registration, the final turn's text taken as the result, schema validation gone entirely — a
    // type system where "the result is always valid" is worse than none.
    const { engine, driver } = setup({ askSpecs: typedSpecs(), validate: requireFields });
    const actor = engine.createActor("actor#1");

    const p = engine.ask("ask#2", actor, "unlisted site"); // askSpecs only has ask#1
    await expect(p).rejects.toMatchObject({ code: "MissingAskSpec" });
    await flush();

    // Key assertion: it was never dispatched in untyped form.
    expect(driver.startAsks).toEqual([]);
    await expect(engine.settled).resolves.toMatchObject({
      status: "errored",
      error: { code: "MissingAskSpec" },
    });
  });

  it("still honours an explicit untyped entry", async () => {
    // An untyped ask is still a first-class citizen — it just must be explicitly recorded as
    // { typed: false }.
    const { engine, driver } = setup({ askSpecs: new Map([["ask#1", { typed: false }]]) });
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "summarize");
    await flush();
    expect(driver.startAsks[0]?.message.typed).toBe(false);
    engine.askTurnEnded(inst("ask#1"), "the answer");
    await expect(p).resolves.toBe("the answer");
  });
});

describe("WorkflowEngine — world reads", () => {
  it("journals a world.run dispatch under kind world-run (effects are not reads)", async () => {
    // docs/dynamic-workflow/authoring.md "Running commands: `world.run`": the op "run" is
    // isomorphic to the other world-read mechanisms, but the journal kind is world-run — the audit
    // surface does not disguise effects as reads.
    const { engine, driver, journal } = setup();
    const p = engine.worldRead("world-read#1", "run", ["lean", ["a.lean"], { timeoutMs: 60000 }]);
    expect(driver.worldReads[0]?.op).toBe("run");
    driver.worldReads[0]?.deferred.resolve({ exitCode: 1, stdout: "", stderr: "boom" });
    await expect(p).resolves.toEqual({ exitCode: 1, stdout: "", stderr: "boom" });

    const node = journal.getNode(RUN, "world-read#1", 1);
    expect(node?.kind).toBe("world-run");
    expect(node?.inputHash).toBe(
      inputHash({ op: "run", args: ["lean", ["a.lean"], { timeoutMs: 60000 }] }),
    );
    // The event stream's node-queued carries world-run as well.
    const queued = driver.events.find(
      (event) => event.type === "node-queued" && event.instance.siteId === "world-read#1",
    );
    expect(queued !== undefined && queued.type === "node-queued" ? queued.kind : undefined).toBe(
      "world-run",
    );
  });

  it("dispatches a live world read, journals it, and resolves", async () => {
    const { engine, driver, journal } = setup();
    const p = engine.worldRead("world-read#1", "glob", ["src/**"]);
    expect(driver.worldReads).toHaveLength(1);
    // Arguments are passed to the driver verbatim and positionally (the engine does not look at op
    // or validate arity).
    expect(driver.worldReads[0]?.args).toEqual(["src/**"]);
    driver.worldReads[0]?.deferred.resolve(["a.ts", "b.ts"]);
    await expect(p).resolves.toEqual(["a.ts", "b.ts"]);

    const node = journal.getNode(RUN, "world-read#1", 1);
    expect(node?.kind).toBe("world-read");
    expect(node?.result).toEqual(["a.ts", "b.ts"]);
    // inputHash covers {op, args} (previously {op, arg}): the payload shape change is intentional,
    // and journals predating it fail loudly with InputHashMismatch on the first world-read hit (see
    // the comment on engine.worldRead).
    expect(node?.inputHash).toBe(inputHash({ op: "glob", args: ["src/**"] }));
    expect(node?.actorSeq).toBeUndefined();
  });

  it("hashes multi-argument world reads positionally (arg order is part of identity)", async () => {
    const { engine, driver, journal } = setup();
    // Uses glob to carry a multi-argument call: the engine does not interpret args at all, so this
    // assertion pins "the positional array goes into the hash",
    // not any particular op's arity (arity belongs to the driver).
    const p = engine.worldRead("world-read#1", "glob", ["a", "b"]);
    expect(driver.worldReads[0]?.args).toEqual(["a", "b"]);
    driver.worldReads[0]?.deferred.resolve(["hit"]);
    await expect(p).resolves.toEqual(["hit"]);
    expect(journal.getNode(RUN, "world-read#1", 1)?.inputHash).toBe(
      inputHash({ op: "glob", args: ["a", "b"] }),
    );
    // Order-sensitive: swapping the arguments is a different read.
    expect(inputHash({ op: "glob", args: ["a", "b"] })).not.toBe(
      inputHash({ op: "glob", args: ["b", "a"] }),
    );
  });

  it("short-circuits a journaled world read with zero driver calls", async () => {
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
    });
    journal.putNode({
      runId: RUN,
      siteId: "world-read#1",
      ordinal: 1,
      kind: "world-read",
      inputHash: inputHash({ op: "glob", args: ["src/**"] }),
      status: "completed",
      result: ["x.ts"],
    });
    const { engine, driver } = setup({ journal });
    const p = engine.worldRead("world-read#1", "glob", ["src/**"]);
    expect(driver.worldReads).toHaveLength(0);
    await expect(p).resolves.toEqual(["x.ts"]);
  });

  it("fails the run loudly when a journaled world read's args differ (arity/value change)", async () => {
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
    });
    journal.putNode({
      runId: RUN,
      siteId: "world-read#1",
      ordinal: 1,
      kind: "world-read",
      inputHash: inputHash({ op: "glob", args: ["src/**"] }),
      status: "completed",
      result: ["x.ts"],
    });
    const { engine } = setup({ journal });
    // Same op, different arguments: the purity contract is broken, so the whole run fails loudly
    // instead of returning the old result.
    await expect(
      engine.worldRead("world-read#1", "glob", ["src/**", "extra"]),
    ).rejects.toMatchObject({
      code: "InputHashMismatch",
    });
    expect(journal.getRun(RUN)?.status).toBe("errored");
  });

  it("journals a multi-arg op's inputHash over {op, args} and short-circuits its replay", async () => {
    // The full round trip of a multi-arg op: `files.grep(pattern, glob?)` has a positional args
    // array, and the key is
    // `{op, args}`. The second half proves a replay hit makes zero driver calls — journalized world
    // reads are exactly what makes resume immune to disk changes between the run and the resume.
    const hits = [{ path: "src/a.ts", line: 12, text: "// TODO" }];
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
    });
    const live = setup({ journal });
    const p = live.engine.worldRead("world-read#1", "grep", ["TODO", "*.ts"]);
    expect(live.driver.worldReads[0]?.op).toBe("grep");
    expect(live.driver.worldReads[0]?.args).toEqual(["TODO", "*.ts"]);
    live.driver.worldReads[0]?.deferred.resolve(hits);
    await expect(p).resolves.toEqual(hits);
    expect(journal.getNode(RUN, "world-read#1", 1)?.inputHash).toBe(
      inputHash({ op: "grep", args: ["TODO", "*.ts"] }),
    );

    // Replay over the same journal: hit, no dispatch.
    const replay = setup({ journal });
    const replayed = replay.engine.worldRead("world-read#1", "grep", ["TODO", "*.ts"]);
    expect(replay.driver.worldReads).toHaveLength(0);
    await expect(replayed).resolves.toEqual(hits);
  });

  it("distinguishes an omitted trailing optional from a present one (shorter args array)", async () => {
    // `grep("TODO")` and `grep("TODO", "*.ts")` must be two different journal keys. The lowering
    // packs a **shorter array** when the default is omitted (not an undefined hole), and
    // canonicalJson feeds the length into the hash, so this property is automatic — it is pinned
    // because if it were lost, a "grep with a glob added" would hit a
    // "grep without a glob" record, and the failure point is in the resume, far from the cause.
    expect(inputHash({ op: "grep", args: ["TODO"] })).not.toBe(
      inputHash({ op: "grep", args: ["TODO", "*.ts"] }),
    );
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
    });
    journal.putNode({
      runId: RUN,
      siteId: "world-read#1",
      ordinal: 1,
      kind: "world-read",
      inputHash: inputHash({ op: "grep", args: ["TODO"] }),
      status: "completed",
      result: [],
    });
    const { engine } = setup({ journal });
    await expect(engine.worldRead("world-read#1", "grep", ["TODO", "*.ts"])).rejects.toMatchObject({
      code: "InputHashMismatch",
    });
  });

  it("settles the node failed on a driver WorldReadCapExceeded, keeping the run alive", async () => {
    // The cap overflow is **node-level**: the script can catch it and narrow the pattern, so the run
    // must stay alive,
    // and this code must never be folded into DriverError — the two have different operability (see
    // the WorkflowErrorCode comment).
    const { engine, driver, journal } = setup();
    const p = engine.worldRead("world-read#1", "grep", [".", undefined]);
    driver.worldReads[0]?.deferred.reject(
      new WorkflowError(
        "WorldReadCapExceeded",
        "grep 命中超过 2000 条；请缩窄 pattern 或加一个 glob",
      ),
    );
    await expect(p).rejects.toMatchObject({ code: "WorldReadCapExceeded" });
    const node = journal.getNode(RUN, "world-read#1", 1);
    expect(node?.status).toBe("failed");
    expect(node?.error?.code).toBe("WorldReadCapExceeded");
    // The run is not dragged down by this rejection; the script can continue (that is the whole
    // point of node-level).
    expect(journal.getRun(RUN)?.status).toBe("running");
  });

  it("replays a journaled cap failure as the same structured rejection", async () => {
    // Failed nodes are journaled too (a replay reliability requirement: the script may already have
    // observed this rejection and branched on it).
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
    });
    journal.putNode({
      runId: RUN,
      siteId: "world-read#1",
      ordinal: 1,
      kind: "world-read",
      inputHash: inputHash({ op: "git-diff", args: [] }),
      status: "failed",
      error: { code: "WorldReadCapExceeded", message: "git.diff 超过 512KB" },
    });
    const { engine, driver } = setup({ journal });
    await expect(engine.worldRead("world-read#1", "git-diff", [])).rejects.toMatchObject({
      code: "WorldReadCapExceeded",
    });
    expect(driver.worldReads).toHaveLength(0);
  });
});

describe("WorkflowEngine — lenient submit decode (real-model stringifies tool args)", () => {
  // Uses a real subset validator: these scenarios need real type decisions (object/number/anyOf),
  // which the fake required-only validator cannot express. Real models (GLM-5.3 in production)
  // often pass submit_result's result as a JSON string instead of an object;
  // the engine must leniently parse it schema-aware — see scheduler.normalizeSubmit.
  const realValidate: ValidateFn = (schema, value) => validate(schema as JsonSchema, value);

  const objectSchema: JsonSchema = {
    type: "object",
    required: ["title", "bullet_points"],
    properties: {
      title: { type: "string" },
      bullet_points: { type: "array", items: { type: "string" } },
    },
  };
  const specs = (schema: JsonSchema) =>
    new Map<string, AskSpec>([["ask#1", { typed: true, schema }]]);

  it("parses a stringified JSON object submit and journals the parsed OBJECT, not the string", async () => {
    const { engine, driver, journal } = setup({
      askSpecs: specs(objectSchema),
      validate: realValidate,
    });
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "do it");
    await flush();

    engine.askSubmitAttempted(inst("ask#1"), '{"title":"x","bullet_points":["a"]}');

    expect(driver.submitResponses.at(-1)?.verdict.kind).toBe("accept");
    await expect(p).resolves.toEqual({ title: "x", bullet_points: ["a"] });

    const node = journal.getNode(RUN, "ask#1", 1);
    expect(node?.status).toBe("completed");
    // What is persisted is the parsed object, not the raw string.
    expect(node?.result).toEqual({ title: "x", bullet_points: ["a"] });
    expect(typeof node?.result).toBe("object");
  });

  it("repairs when a stringified submit parses to JSON of the wrong shape (not accepted)", async () => {
    const { engine, driver, journal } = setup({
      askSpecs: specs(objectSchema),
      validate: realValidate,
    });
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "do it");
    void p.catch(() => {}); // eventually rejects due to repair exhaustion
    await flush();

    engine.askSubmitAttempted(inst("ask#1"), '{"unexpected":1}'); // parses to an object but misses a required field

    const last = driver.submitResponses.at(-1)?.verdict;
    expect(last?.kind).toBe("reject");
    expect(last?.kind === "reject" && last.violations.length).toBeGreaterThan(0);
    // Not yet settled: still the running record from admission.
    expect(journal.getNode(RUN, "ask#1", 1)?.status).toBe("running");
  });

  it("reports POST-parse violations when a stringified object misses a required field", async () => {
    // bug: when JSON.parse succeeded but the parsed value still failed validation, repair used to
    // report pre-parse violations (`$: expected object, got string`),
    // leaving the model nothing to fix (re-quote / double-encode / degenerate to "{}"), failing with
    // ValidationFailed after 3 attempts (dwfrun-60c20069).
    const { engine, driver } = setup({ askSpecs: specs(objectSchema), validate: realValidate });
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "do it");
    void p.catch(() => {});
    await flush();

    engine.askSubmitAttempted(inst("ask#1"), '{"title":"x"}'); // parses to an object but misses bullet_points

    const last = driver.submitResponses.at(-1)?.verdict;
    expect(last?.kind).toBe("reject");
    // The violation must point at the parsed object's path, not the root-level
    // "expected object, got string".
    expect(last?.kind === "reject" && last.violations).toContainEqual({
      path: "$.bullet_points",
      expected: "present",
      got: "missing",
    });
    expect(
      last?.kind === "reject" &&
        last.violations.some((v) => v.path === "$" && v.expected === "object"),
    ).toBe(false);
  });

  it("reports POST-parse violations on the nested path when a stringified array field has wrong item shape", async () => {
    // Mirrors a production Critique/gaps failure (dwfrun-bc01726f): the schema wants string[], the
    // model submitted a nested array,
    // and the whole thing was serialized into a string. The violation must land on the nested path
    // $.bullet_points[0], not the root-level string.
    const { engine, driver } = setup({ askSpecs: specs(objectSchema), validate: realValidate });
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "do it");
    void p.catch(() => {});
    await flush();

    engine.askSubmitAttempted(inst("ask#1"), '{"title":"x","bullet_points":[["a"]]}');

    const last = driver.submitResponses.at(-1)?.verdict;
    expect(last?.kind).toBe("reject");
    expect(last?.kind === "reject" && last.violations).toContainEqual({
      path: "$.bullet_points[0]",
      expected: "string",
      got: "array(1)",
    });
    expect(
      last?.kind === "reject" &&
        last.violations.some((v) => v.path === "$" && v.expected === "object"),
    ).toBe(false);
  });

  it("repairs on a non-JSON string submit (JSON.parse throws → original violations)", async () => {
    const { engine, driver, journal } = setup({
      askSpecs: specs(objectSchema),
      validate: realValidate,
    });
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "do it");
    void p.catch(() => {});
    await flush();

    engine.askSubmitAttempted(inst("ask#1"), "hello"); // JSON.parse throws

    const last = driver.submitResponses.at(-1)?.verdict;
    expect(last?.kind).toBe("reject");
    // Reports the original raw-value violation (expected object but got string).
    expect(last?.kind === "reject" && last.violations.some((v) => v.expected === "object")).toBe(
      true,
    );
    expect(journal.getNode(RUN, "ask#1", 1)?.status).toBe("running");
  });

  it("preserves a legitimately-string result: raw string that validates is NOT parsed", async () => {
    // anyOf string|null accepts a bare string → straight accept → no parsing. "42" must stay "42"
    // and never become the number 42.
    const stringSchema: JsonSchema = { anyOf: [{ type: "string" }, { type: "null" }] };
    const { engine, driver, journal } = setup({
      askSpecs: specs(stringSchema),
      validate: realValidate,
    });
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "do it");
    await flush();

    engine.askSubmitAttempted(inst("ask#1"), "42");

    expect(driver.submitResponses.at(-1)?.verdict.kind).toBe("accept");
    await expect(p).resolves.toBe("42");
    const node = journal.getNode(RUN, "ask#1", 1);
    expect(node?.result).toBe("42");
    expect(typeof node?.result).toBe("string");
  });

  it("parses a number-string when the schema expects a number", async () => {
    const numberSchema: JsonSchema = { type: "number" };
    const { engine, driver, journal } = setup({
      askSpecs: specs(numberSchema),
      validate: realValidate,
    });
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "do it");
    await flush();

    engine.askSubmitAttempted(inst("ask#1"), "42");

    expect(driver.submitResponses.at(-1)?.verdict.kind).toBe("accept");
    await expect(p).resolves.toBe(42);
    const node = journal.getNode(RUN, "ask#1", 1);
    expect(node?.result).toBe(42);
    expect(typeof node?.result).toBe("number");
  });
});

// report (execution-engine.md's "Progressive results"): fire-and-forget, no driver round trip, but
// **persisted to the journal**.
// This group pins three things: the write-once node shape, replay dedup, and the two caps.
describe("WorkflowEngine — report", () => {
  it("journals one already-settled node and emits one event", () => {
    const { engine, journal, driver } = setup();
    engine.report("report#1", { finding: "dup impl", paths: ["a.ts", "b.ts"] });

    const node = journal.getNode(RUN, "report#1", 1);
    // Written once, already settled, no actor fields, result is the item — the sole exception to
    // the "two writes" rule.
    expect(node).toMatchObject({
      kind: "report",
      status: "completed",
      result: { finding: "dup impl", paths: ["a.ts", "b.ts"] },
    });
    expect(node?.inputHash).toBe(inputHash({ finding: "dup impl", paths: ["a.ts", "b.ts"] }));
    expect(node !== undefined && "actorSeq" in node).toBe(false);
    expect(driver.eventsOfType("report")).toEqual([
      {
        type: "report",
        instance: inst("report#1"),
        item: { finding: "dup impl", paths: ["a.ts", "b.ts"] },
      },
    ]);
  });

  it("assigns per-site ordinals so one site reported twice is two nodes", () => {
    const { engine, journal, driver } = setup();
    engine.report("report#1", "first");
    engine.report("report#1", "second");
    engine.report("report#2", "other-site");

    expect(journal.getNode(RUN, "report#1", 1)?.result).toBe("first");
    expect(journal.getNode(RUN, "report#1", 2)?.result).toBe("second");
    expect(journal.getNode(RUN, "report#2", 1)?.result).toBe("other-site");
    expect(driver.eventsOfType("report")).toHaveLength(3);
  });

  it("ignores reports after the run settles (like log)", () => {
    const { engine, journal, driver } = setup();
    engine.complete("done");
    engine.report("report#1", "too late");

    expect(journal.getNode(RUN, "report#1", 1)).toBeUndefined();
    expect(driver.eventsOfType("report")).toEqual([]);
  });

  it("skips a journaled report on replay: no event, no re-append", () => {
    // The script re-runs, so every report call executes again. Journaled (siteId, ordinal) pairs
    // are silently skipped —
    // otherwise after a resume the Results panel would show the same finding twice, which is
    // precisely why report journals at all.
    const journal = new InMemoryJournalStore();
    const first = setup({ journal });
    first.engine.report("report#1", { n: 1 });
    first.engine.report("report#1", { n: 2 });
    first.engine.complete("ok");

    const before = journal.listEvents(RUN, { types: "all", reportItems: "all" }).length;
    const resumed = setup({ journal });
    resumed.engine.report("report#1", { n: 1 });
    resumed.engine.report("report#1", { n: 2 });

    expect(resumed.driver.eventsOfType("report")).toEqual([]);
    expect(
      journal.listNodes(RUN, { kinds: "all", withResult: true }).filter((n) => n.kind === "report"),
    ).toHaveLength(2);
    // Resume adds exactly one run-started; report appends not a single event again.
    expect(journal.listEvents(RUN, { types: "all", reportItems: "all" }).length).toBe(before + 1);
  });

  it("fails the run with InputHashMismatch when a replayed item differs", () => {
    // This comparison is **defensive** (a report derives from values already pinned in the
    // journal), but an offset here means the whole
    // replay is unreliable — readers of the Results panel must never see that unknowingly.
    const journal = new InMemoryJournalStore();
    setup({ journal }).engine.report("report#1", { n: 1 });

    const resumed = setup({ journal });
    resumed.engine.report("report#1", { n: 999 });

    return expect(resumed.engine.settled).resolves.toMatchObject({
      status: "errored",
      error: { code: "InputHashMismatch" },
    });
  });

  it("hashes canonically, so key order in the item is not a mismatch", () => {
    // inputHash goes through canonicalJson (keys sorted by code point), so a changed literal key
    // order in the script is not
    // treated as a purity violation. That is the right tolerance for "defensive, not load-bearing".
    const journal = new InMemoryJournalStore();
    setup({ journal }).engine.report("report#1", { a: 1, b: 2 });

    const resumed = setup({ journal });
    resumed.engine.report("report#1", { b: 2, a: 1 });

    expect(resumed.driver.eventsOfType("report")).toEqual([]);
    expect(journal.getRun(RUN)?.status).toBe("running");
  });

  it("fails the run with ReportCapExceeded on the item past the cap (65,537th)", () => {
    const { engine, journal } = setup();
    expect(REPORT_CAPS.maxItemsPerRun).toBe(65_536);
    for (let i = 0; i < REPORT_CAPS.maxItemsPerRun; i += 1) engine.report("report#1", i);
    expect(journal.getRun(RUN)?.status).toBe("running");

    engine.report("report#1", "one too many");

    expect(journal.countNodes(RUN, "report")).toBe(REPORT_CAPS.maxItemsPerRun);
    return expect(engine.settled).resolves.toMatchObject({
      status: "errored",
      error: { code: "ReportCapExceeded" },
    });
  });

  it("fails the run with ReportCapExceeded on an oversized item, journaling nothing", () => {
    const { engine, journal } = setup();
    engine.report("report#1", "x".repeat(REPORT_CAPS.maxItemSerializedBytes));

    // The cap applies before persistence: not a single byte of the overflowing item should reach
    // the journal.
    expect(journal.getNode(RUN, "report#1", 1)).toBeUndefined();
    return expect(engine.settled).resolves.toMatchObject({
      status: "errored",
      error: { code: "ReportCapExceeded" },
    });
  });

  it("accepts an item of exactly the per-item limit", () => {
    const { engine, journal } = setup();
    expect(REPORT_CAPS.maxItemSerializedBytes).toBe(1024 * 1024);
    // JSON's two quotes also count in the bytes: the body is two bytes short, and serialized it is
    // exactly at the limit.
    engine.report("report#1", "x".repeat(REPORT_CAPS.maxItemSerializedBytes - 2));

    expect(journal.getNode(RUN, "report#1", 1)?.status).toBe("completed");
    expect(journal.getRun(RUN)?.status).toBe("running");
  });

  it("fails the run with ReportCapExceeded when its reports would pass the per-run byte limit, counted across resume", () => {
    // A run genuinely filling 1 GiB cannot be built in a unit test, so the journal reports a
    // near-cap byte sum at resume: this pins two things at once — the count is restored from
    // sumResultBytes, and the cap accumulates per run and blocks before persistence.
    const nearlyFull = REPORT_CAPS.maxBytesPerRun - 50;
    class NearlyFullJournal extends InMemoryJournalStore {
      override sumResultBytes(runId: string, kind: NodeKind): number {
        return super.sumResultBytes(runId, kind) + nearlyFull;
      }
    }
    const journal = new NearlyFullJournal();
    const first = setup({ journal });
    first.engine.report("report#1", "a"); // 3 bytes; the first life does not read sumResultBytes
    first.engine.stop("user");

    const resumed = setup({ journal });
    resumed.engine.report("report#1", "a"); // hit, skipped
    // 3 + nearlyFull + 42 = cap - 5: it fits.
    resumed.engine.report("report#1", "x".repeat(40));
    expect(journal.getRun(RUN)?.status).toBe("running");
    // 10 more bytes would exceed it: the whole run fails, and this one is not persisted.
    resumed.engine.report("report#1", "y".repeat(8));

    expect(journal.countNodes(RUN, "report")).toBe(2);
    return expect(resumed.engine.settled).resolves.toMatchObject({
      status: "errored",
      error: { code: "ReportCapExceeded", message: expect.stringContaining("limit per run") },
    });
  });

  it("measures the cap in UTF-8 bytes, not characters", () => {
    // A CJK findings document's character count is one third of its byte count; counting characters
    // would render the cap meaningless.
    const { engine, journal } = setup();
    // 3 bytes per character plus JSON's two quotes: just over the line.
    const chars = Math.ceil(REPORT_CAPS.maxItemSerializedBytes / 3);
    engine.report("report#1", "结".repeat(chars));

    expect(journal.getNode(RUN, "report#1", 1)).toBeUndefined();
    return expect(engine.settled).resolves.toMatchObject({
      status: "errored",
      error: { code: "ReportCapExceeded" },
    });
  });

  it("restores the report count across resume so the cap is run-level", () => {
    // The cap is run-level, so the count must stay continuous across resumes — otherwise a run
    // resumed over and over could report without limit.
    const journal = new InMemoryJournalStore();
    const first = setup({ journal });
    for (let i = 0; i < REPORT_CAPS.maxItemsPerRun; i += 1) first.engine.report("report#1", i);
    first.engine.stop("user");

    // Resume: the script re-runs, the first 65,536 all hit and skip, and the next one is **new** —
    // the cap must still block it.
    const resumed = setup({ journal });
    for (let i = 0; i < REPORT_CAPS.maxItemsPerRun; i += 1) resumed.engine.report("report#1", i);
    expect(resumed.driver.eventsOfType("report")).toEqual([]);
    resumed.engine.report("report#1", "one past the cap");

    return expect(resumed.engine.settled).resolves.toMatchObject({
      status: "errored",
      error: { code: "ReportCapExceeded" },
    });
  });

  it("fails the run loudly when the item is not a JSON value", () => {
    // Runtime guardrail (the compile-time serializability diagnostics are suspenders). canonicalJson
    // is total — it would
    // silently fold undefined into "null", quietly landing a broken item in the journal. So the probe
    // uses JSON.stringify: returning undefined / throwing both get caught as one loud failure.
    const { engine, journal } = setup();
    engine.report("report#1", undefined);

    expect(journal.getNode(RUN, "report#1", 1)).toBeUndefined();
    return expect(engine.settled).resolves.toMatchObject({ status: "errored" });
  });

  it("fails the run loudly on a cyclic item instead of blowing the stack", () => {
    // canonicalJson recurses infinitely on a cycle and blows the stack — that is a crash, not a
    // readable failure, so the probe
    // must run first. This case is the proof of that ordering.
    const { engine, journal } = setup();
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    expect(() => engine.report("report#1", cyclic)).not.toThrow();

    expect(journal.getNode(RUN, "report#1", 1)).toBeUndefined();
    return expect(engine.settled).resolves.toMatchObject({
      status: "errored",
      error: { code: "DriverError" },
    });
  });
});

// enterPhase (docs/dynamic-workflow/presentation.md): control flow passes through a
// `phase("…")` marker. Same posture as log — synchronous, no driver round trip, no-op after
// settlement — but counted by name.
describe("WorkflowEngine — enterPhase", () => {
  it("emits phase-entered with a per-name ordinal and writes no journal row", () => {
    const { engine, journal, driver } = setup();
    engine.enterPhase("plan");
    engine.enterPhase("verify");
    engine.enterPhase("plan");
    expect(driver.eventsOfType("phase-entered")).toEqual([
      { type: "phase-entered", name: "plan", ordinal: 1 },
      { type: "phase-entered", name: "verify", ordinal: 1 },
      // Re-entering the same name is the second round: the analyzer also reads the second
      // same-name marker as a back edge.
      { type: "phase-entered", name: "plan", ordinal: 2 },
    ]);
    // Markers are not sites: no dwf_node rows, and no site's ordinal is consumed.
    expect(journal.listNodes(RUN, { kinds: "all", withResult: true })).toEqual([]);
  });

  it("trims the name, drops an empty one, and does not share ordinals with sites", () => {
    const { engine, driver } = setup();
    engine.enterPhase("  plan  ");
    engine.enterPhase("   ");
    engine.report("report#1", "x");
    engine.enterPhase("report#1");
    expect(driver.eventsOfType("phase-entered")).toEqual([
      { type: "phase-entered", name: "plan", ordinal: 1 },
      // A phase name that happens to look like a site id: its count starts at 1, and report#1's
      // node ordinals are unaffected.
      { type: "phase-entered", name: "report#1", ordinal: 1 },
    ]);
  });

  it("is a no-op after the run settled", () => {
    const { engine, driver } = setup();
    engine.complete("done");
    engine.enterPhase("late");
    expect(driver.eventsOfType("phase-entered")).toEqual([]);
  });
});

/**
 * A thin wrapper: keeps a reference to the **raw object** received by `appendEvent` (the in-memory
 * journal clones on its own,
 * so the stored copy is no longer the one the engine passed in). Used to pin "the journal and emit
 * receive the same object" —
 * bootstrap's createJournalSequenceCapture checks ordinals precisely by reference equality.
 */
class CapturingJournal extends InMemoryJournalStore {
  readonly appended: RunEvent[] = [];

  override appendEvent(runId: string, event: RunEvent): StoredEvent {
    this.appended.push(event);
    return super.appendEvent(runId, event);
  }
}

// Birth phase coordinates (docs/dynamic-workflow/presentation.md): an instance records the phase
// current **at the moment its ordinal is minted**,
// and the birth event carries `phaseName`. The minting point and the event emission point can be
// separated (the hold rule), so the stamp can only come from the minting moment.
describe("WorkflowEngine — 出生阶段坐标（phaseName）", () => {
  it("stamps the actor and the nodes minted after a phase marker", async () => {
    const { engine, driver } = setup();
    engine.enterPhase("规划");
    const actor = engine.createActor("actor#1", "planner");
    void engine.ask("ask#1", actor, "do it");
    void engine.worldRead("world-read#1", "glob", ["src/**"]);
    await flush();

    expect(driver.eventsOfType("actor-created")[0]).toMatchObject({ phaseName: "规划" });
    // ask and world-read take two different admission paths (scheduler / the engine itself), and
    // both stamps come from the same minting point.
    expect(
      driver.eventsOfType("node-queued").map((e) => [refToString(e.instance), e.phaseName]),
    ).toEqual([
      ["ask#1@1", "规划"],
      ["world-read#1@1", "规划"],
    ]);
  });

  it("leaves instances born before any marker unstamped", async () => {
    const { engine, driver } = setup();
    const actor = engine.createActor("actor#1");
    void engine.ask("ask#1", actor, "do it");
    engine.enterPhase("规划");
    await flush();

    // "Unstamped" means the whole key is absent, not undefined: readers (schema / reducer)
    // distinguish the two.
    expect(driver.eventsOfType("actor-created")[0]).not.toHaveProperty("phaseName");
    expect(driver.eventsOfType("node-queued")[0]).not.toHaveProperty("phaseName");
  });

  it("carries the birth phase even when the queue event lands after a later marker", async () => {
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
    });
    journal.putActor({ runId: RUN, siteId: "actor#1", ordinal: 1 });
    // The previous life only recorded seq0 = ask#2@1. This run's earlier ask#1 is fresh and gets
    // held by the hold rule,
    // only enqueueing once seq0 is released — by then control flow has already moved past B.
    journal.putNode({
      runId: RUN,
      siteId: "ask#2",
      ordinal: 1,
      kind: "ask",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorSeq: 0,
      inputHash: inputHash("B"),
      status: "completed",
      result: "r2",
    });

    const { engine, driver } = setup({ journal });
    const actor = engine.createActor("actor#1");
    engine.enterPhase("A");
    const pA = engine.ask("ask#1", actor, "A"); // ordinal minted at A, but not enqueued
    expect(driver.eventsOfType("node-queued")).toEqual([]);
    engine.enterPhase("B");
    const pB = engine.ask("ask#2", actor, "B"); // hits seq0 → releases it, then ask#1's turn
    await flush();

    const queued = driver.eventsOfType("node-queued");
    expect(queued).toHaveLength(1);
    expect(refToString(queued[0]!.instance)).toBe("ask#1@1");
    // The event is emitted after B's marker, yet the stamp is still the birth-time A: the stamp
    // comes from the minting point, not the emission point.
    expect(driver.events.indexOf(queued[0]!)).toBeGreaterThan(
      driver.events.findIndex((e) => e.type === "phase-entered" && e.name === "B"),
    );
    expect(queued[0]!.phaseName).toBe("A");
    // The hit node born at B within the same re-run is stamped B.
    expect(driver.eventsOfType("node-settled")[0]).toMatchObject({
      cached: true,
      phaseName: "B",
    });

    engine.askTurnEnded(inst("ask#1"), "RA");
    await expect(Promise.all([pA, pB])).resolves.toEqual(["RA", "r2"]);
  });

  it("stamps a replay-cached node-settled with the phase current at that point of the re-run", async () => {
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
    });
    journal.putActor({ runId: RUN, siteId: "actor#1", ordinal: 1 });
    journal.putNode({
      runId: RUN,
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorSeq: 0,
      inputHash: inputHash("A"),
      status: "completed",
      result: "r1",
    });

    const { engine, driver } = setup({ journal });
    // The re-run walks the markers along the same trajectory, so the hit node gets the same stamp
    // as in the previous life.
    engine.enterPhase("规划");
    const actor = engine.createActor("actor#1");
    await expect(engine.ask("ask#1", actor, "A")).resolves.toBe("r1");

    expect(driver.startAskCount()).toBe(0);
    expect(driver.eventsOfType("actor-created")[0]).toMatchObject({ phaseName: "规划" });
    // A hit node has no node-queued; this cached settle is its birth event.
    expect(driver.eventsOfType("node-queued")).toEqual([]);
    expect(driver.eventsOfType("node-settled")[0]).toMatchObject({
      cached: true,
      phaseName: "规划",
    });
  });

  it("a replayed ask's cached node-settled repeats its birth facts and names no predecessor session", async () => {
    // Plain resume (no imported cache): the hit rows were produced by this run itself, and the
    // exchange happened in this run's session,
    // so there is no sourceSessionId; the birth facts are still carried — the read surface uses
    // them to attribute nodes to subagents
    // (docs/execution-engine.md "Events"). Failed rows are likewise short-circuit-replayed, and
    // likewise carry them.
    const journal = new InMemoryJournalStore();
    journal.createRun({ runId: RUN, caps: { maxConcurrency: 16 }, spentTokens: 0, status: "running" });
    journal.putActor({ runId: RUN, siteId: "actor#1", ordinal: 1 });
    const row = (siteId: string, seq: number, instructions: string): NodeRecord => ({
      runId: RUN,
      siteId,
      ordinal: 1,
      kind: "ask",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorSeq: seq,
      inputHash: inputHash(instructions),
      status: "completed",
      result: `r-${siteId}`,
    });
    journal.putNode(row("ask#1", 0, "first task"));
    journal.putNode({
      ...row("ask#2", 1, "second task"),
      status: "failed",
      error: new WorkflowError("DriverError", "boom").toJSON(),
    });

    const { engine, driver } = setup({ journal });
    const actor = engine.createActor("actor#1");
    await expect(engine.ask("ask#1", actor, "first task")).resolves.toBe("r-ask#1");
    await expect(engine.ask("ask#2", actor, "second task")).rejects.toMatchObject({ code: "DriverError" });

    expect(driver.startAskCount()).toBe(0);
    const facts = { kind: "ask", actor: { siteId: "actor#1", ordinal: 1 } };
    expect(driver.eventsOfType("node-settled")).toEqual([
      {
        type: "node-settled",
        instance: { siteId: "ask#1", ordinal: 1 },
        outcome: "ok",
        cached: true,
        ...facts,
        actorSeq: 0,
        instructionsHead: "first task",
      },
      {
        type: "node-settled",
        instance: { siteId: "ask#2", ordinal: 1 },
        outcome: "failed",
        cached: true,
        error: expect.objectContaining({ code: "DriverError" }),
        ...facts,
        actorSeq: 1,
        instructionsHead: "second task",
      },
    ]);
  });

  it("stamps an ask's node-dispatched with its own birth phases, not a live node-settled", async () => {
    const { engine, driver } = setup();
    engine.enterPhase("规划");
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "do it");
    await flush();
    engine.askTurnEnded(inst("ask#1"), "RA");
    await expect(p).resolves.toBe("RA");

    // The dispatch repeats the birth facts, and both phase names are present (each taken from the
    // instance's / actor's minting point).
    expect(driver.eventsOfType("node-dispatched")[0]).toMatchObject({
      phaseName: "规划",
      actorPhaseName: "规划",
    });
    // The other node-* events still do not carry it (the reducer carries them forward following the
    // actorSiteId precedent).
    expect(driver.eventsOfType("node-settled")[0]).not.toHaveProperty("phaseName");
  });

  it("dispatches with the birth phases even after the script walked into later phases", async () => {
    // The dispatch is held up by session creation while the script walks through two markers: the
    // stamp must still be the birth-time one, not the current phase.
    const { engine, driver } = setup({ deferSessions: true });
    engine.enterPhase("A");
    const actor = engine.createActor("actor#1", "planner");
    const p = engine.ask("ask#1", actor, "do it");
    await flush();
    expect(driver.eventsOfType("node-dispatched")).toEqual([]);

    engine.enterPhase("B");
    engine.enterPhase("C");
    driver.sessionDeferrals[0]!.resolve({ id: "session:actor#1@1" });
    await flush();

    const dispatched = driver.eventsOfType("node-dispatched");
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({ phaseName: "A", actorPhaseName: "A" });
    // The dispatch genuinely lands after C's marker (otherwise the assertion above would only hold
    // by coincidence).
    expect(driver.events.indexOf(dispatched[0]!)).toBeGreaterThan(
      driver.events.findIndex((e) => e.type === "phase-entered" && e.name === "C"),
    );

    engine.askTurnEnded(inst("ask#1"), "RA");
    await expect(p).resolves.toBe("RA");
  });

  it("leaves the dispatch of an unstamped instance and of a world read bare", async () => {
    const { engine, driver } = setup();
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "do it");
    void engine.worldRead("world-read#1", "glob", ["src/**"]);
    // The marker comes after both instances were born: they are not in the birth table, so neither
    // dispatch may grow a phase name.
    engine.enterPhase("规划");
    await flush();

    // world-read dispatches synchronously while the ask waits a microtask round to create its
    // session, so the world read comes first.
    const dispatched = driver.eventsOfType("node-dispatched");
    expect(dispatched.map((e) => refToString(e.instance))).toEqual(["world-read#1@1", "ask#1@1"]);
    for (const event of dispatched) {
      expect(event).not.toHaveProperty("phaseName");
      expect(event).not.toHaveProperty("actorPhaseName");
    }

    engine.askTurnEnded(inst("ask#1"), "RA");
    await expect(p).resolves.toBe("RA");
  });

  it("hands the journal and the driver the same stamped object", async () => {
    const journal = new CapturingJournal();
    const { engine, driver } = setup({ journal });
    engine.enterPhase("规划");
    const actor = engine.createActor("actor#1");
    void engine.ask("ask#1", actor, "do it");
    await flush();

    expect(journal.appended).toHaveLength(driver.events.length);
    journal.appended.forEach((event, i) => {
      expect(event).toBe(driver.events[i]);
    });
    // The stamped ones must especially be the same object: stamping builds a new object, and both
    // paths must share it.
    // Three: actor-created, node-queued, and the birth-fact-repeating node-dispatched.
    expect(journal.appended.filter((e) => "phaseName" in e && e.phaseName === "规划")).toHaveLength(
      3,
    );
  });
});

/**
 * The dispatch repeats the birth facts (the `node-dispatched` row of docs/execution-engine.md
 * "Events"): the bounded read surface admits instances by
 * "started running" rather than "queued", so this event must be self-sufficient — the instance's
 * birth facts plus its subagent's.
 */
describe("WorkflowEngine — node-dispatched 重复出生事实", () => {
  it("repeats exactly what the instance's node-queued and its actor-created carried", async () => {
    const { engine, driver } = setup();
    engine.enterPhase("规划");
    const actor = engine.createActor("actor#1", "planner");
    const p = engine.ask("ask#1", actor, "  写一份调研大纲  ");
    await flush();

    const created = driver.eventsOfType("actor-created")[0]!;
    const queued = driver.eventsOfType("node-queued")[0]!;
    const dispatched = driver.eventsOfType("node-dispatched")[0]!;
    expect(dispatched).toEqual({
      type: "node-dispatched",
      instance: queued.instance,
      kind: queued.kind,
      actor: queued.actor,
      actorName: created.name,
      actorPhaseName: created.phaseName,
      phaseName: queued.phaseName,
      instructionsHead: queued.instructionsHead,
    });
    // Verbatim identical, not merely shape-identical: the instruction head is the one computed at
    // admission (trimmed on both ends, no ellipsis).
    expect(dispatched.instructionsHead).toBe("写一份调研大纲");
    expect(dispatched.actorName).toBe("planner");

    engine.askTurnEnded(inst("ask#1"), "RA");
    await expect(p).resolves.toBe("RA");
  });

  it("omits the name of an anonymous subagent and keeps a world read's dispatch bare", async () => {
    const { engine, driver } = setup();
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "do it");
    void engine.worldRead("world-read#1", "glob", ["src/**"]);
    await flush();

    // Anonymous actor: `actor-created`'s name is empty (the whole key absent once serialized), and
    // the dispatch likewise must not invent one.
    expect(driver.eventsOfType("actor-created")[0]!.name).toBeUndefined();
    const [world, ask] = driver.eventsOfType("node-dispatched");
    expect(ask).toEqual({
      type: "node-dispatched",
      instance: inst("ask#1"),
      kind: "ask",
      actor: { siteId: "actor#1", ordinal: 1 },
      instructionsHead: "do it",
    });
    // A world-read's dispatch carries no birth facts: it directly follows its own node-queued and
    // has no subagent.
    expect(world).toEqual({ type: "node-dispatched", instance: inst("world-read#1") });

    engine.askTurnEnded(inst("ask#1"), "RA");
    await expect(p).resolves.toBe("RA");
  });

  it("carries the facts of the new life when a running row is re-queued on resume", async () => {
    const journal = new InMemoryJournalStore();
    journal.createRun({ runId: RUN, caps: { maxConcurrency: 16 }, spentTokens: 0, status: "running" });
    journal.putActor({ runId: RUN, siteId: "actor#1", ordinal: 1 });
    // The previous life crashed mid-execution: this row is running, and the re-run must re-dispatch
    // it by its recorded actorSeq.
    journal.putNode({
      runId: RUN,
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorSeq: 0,
      inputHash: inputHash("do it"),
      status: "running",
    });

    const { engine, driver } = setup({ journal });
    engine.enterPhase("重跑");
    const actor = engine.createActor("actor#1", "planner");
    const p = engine.ask("ask#1", actor, "do it");
    await flush();

    // The new life is born once more, and the dispatch carries the copy this life's node-queued
    // carried.
    const queued = driver.eventsOfType("node-queued")[0]!;
    const dispatched = driver.eventsOfType("node-dispatched")[0]!;
    expect(queued.phaseName).toBe("重跑");
    expect(dispatched).toMatchObject({
      kind: queued.kind,
      actor: queued.actor,
      actorName: "planner",
      actorPhaseName: "重跑",
      phaseName: "重跑",
      instructionsHead: queued.instructionsHead,
    });

    engine.askTurnEnded(inst("ask#1"), "RA");
    await expect(p).resolves.toBe("RA");
  });
});

describe("run-launched：发起 run 那一轮的锚点（docs/execution-engine.md「Token telemetry for subagents」）", () => {
  const make = (journal: InMemoryJournalStore) =>
    new WorkflowEngine({
      runId: RUN,
      driver: new FakeDriver(journal),
      caps: { maxConcurrency: 16 },
      askSpecs: untypedSpecs("ask#1"),
      validate: () => [],
      toolCallId: "tool-1",
      parentSessionId: "parent-1",
      launch: { inputId: "launch-input-1" },
    });

  it("建 run 那一世紧跟首条 run-started 记一条 run-launched，携 inputId / toolCallId / parentSessionId", () => {
    const journal = new InMemoryJournalStore();
    make(journal);
    expect(
      journal
        .listEvents(RUN, { types: "all", reportItems: "all" })
        .map((stored) => stored.event.type),
    ).toEqual(["run-started", "run-launched"]);
    expect(journal.listEvents(RUN, { types: "all", reportItems: "all" })[1]?.event).toEqual({
      type: "run-launched",
      inputId: "launch-input-1",
      toolCallId: "tool-1",
      parentSessionId: "parent-1",
    });
  });

  it("同一 journal 上重放（resume）只再发 run-started，不再发第二条 run-launched", () => {
    const journal = new InMemoryJournalStore();
    make(journal);
    make(journal);
    expect(
      journal
        .listEvents(RUN, { types: "all", reportItems: "all" })
        .map((stored) => stored.event.type),
    ).toEqual(["run-started", "run-launched", "run-started"]);
  });

  it("没有 launch 入参就不记锚点（CLI / 旧宿主装配）", () => {
    const journal = new InMemoryJournalStore();
    new WorkflowEngine({
      runId: RUN,
      driver: new FakeDriver(journal),
      caps: { maxConcurrency: 16 },
      askSpecs: untypedSpecs("ask#1"),
      validate: () => [],
    });
    expect(
      journal
        .listEvents(RUN, { types: "all", reportItems: "all" })
        .map((stored) => stored.event.type),
    ).toEqual(["run-started"]);
  });

  it("launch 携 phaseNames 时 run-launched 原样带上声明的阶段表（侧栏迷你轨道的站点来源）", () => {
    const journal = new InMemoryJournalStore();
    new WorkflowEngine({
      runId: RUN,
      driver: new FakeDriver(journal),
      caps: { maxConcurrency: 16 },
      askSpecs: untypedSpecs("ask#1"),
      validate: () => [],
      launch: { inputId: "launch-input-2", phaseNames: ["Research", "Write"] },
    });
    expect(journal.listEvents(RUN, { types: "all", reportItems: "all" })[1]?.event).toEqual({
      type: "run-launched",
      inputId: "launch-input-2",
      phaseNames: ["Research", "Write"],
    });
  });

  // The subagent model of this run (docs/dynamic-workflow/launch.md) rides with the anchor and the
  // phase table: zero SQL, recorded only in the life that
  // creates the run. The engine **does not read it** — the model surface of a subagent session is
  // entirely host-side (bootstrap's
  // workflow-actor-model.ts); the host reads the same canonical string back from the event header,
  // and both resume and the two read surfaces restore from it.
  it("launch 携 subagentModel 时 run-launched 原样带上规范串（档位段在内），resume 不再记第二条", () => {
    const journal = new InMemoryJournalStore();
    const withModel = () =>
      new WorkflowEngine({
        runId: RUN,
        driver: new FakeDriver(journal),
        caps: { maxConcurrency: 16 },
        askSpecs: untypedSpecs("ask#1"),
        validate: () => [],
        launch: { inputId: "launch-input-3", subagentModel: "zhipu/glm-5.3-flash$high" },
      });
    withModel();
    expect(journal.listEvents(RUN, { types: "all", reportItems: "all" })[1]?.event).toEqual({
      type: "run-launched",
      inputId: "launch-input-3",
      // The tier segment travels verbatim: `$high` is the half the user spoke aloud; the engine
      // transcribes it literally without parsing.
      subagentModel: "zhipu/glm-5.3-flash$high",
    });

    // The resumed life does not record it again (the same gate as the anchor): a run's subagent
    // model is therefore unique across lifecycles.
    withModel();
    expect(
      journal
        .listEvents(RUN, { types: "all", reportItems: "all" })
        .filter((stored) => stored.event.type === "run-launched"),
    ).toHaveLength(1);
  });

  // The script-named model binding table (docs/dynamic-workflow/launch.md "Models the script names")
  // rides with the subagent model
  // under the same rules: provided by the submitter, recorded once in the run-creating life, not
  // read by the engine; the host consults it by persona name when creating sessions.
  it("launch 携 modelBindings 时 run-launched 原样带上整张表，resume 不再记第二条", () => {
    const journal = new InMemoryJournalStore();
    const bindings = {
      "GLM-5.3-Flash": "zhipu/GLM-5.3-Flash$high",
      "GLM-5.3$high": "zhipu/GLM-5.3$high",
    };
    const withBindings = () =>
      new WorkflowEngine({
        runId: RUN,
        driver: new FakeDriver(journal),
        caps: { maxConcurrency: 16 },
        askSpecs: untypedSpecs("ask#1"),
        validate: () => [],
        launch: { inputId: "launch-input-4", modelBindings: bindings },
      });
    withBindings();
    expect(journal.listEvents(RUN, { types: "all", reportItems: "all" })[1]?.event).toEqual({
      type: "run-launched",
      inputId: "launch-input-4",
      modelBindings: bindings,
    });
    withBindings();
    expect(
      journal
        .listEvents(RUN, { types: "all", reportItems: "all" })
        .filter((stored) => stored.event.type === "run-launched"),
    ).toHaveLength(1);
  });

  it("launch 不带 modelBindings 时整个键缺席", () => {
    const journal = new InMemoryJournalStore();
    make(journal);
    expect(
      "modelBindings" in journal.listEvents(RUN, { types: "all", reportItems: "all" })[1]!.event,
    ).toBe(false);
  });

  it("launch 不带 subagentModel 时整个键缺席（缺席即子代理跑在会话模型上）", () => {
    const journal = new InMemoryJournalStore();
    make(journal);
    // A key persisted with an undefined value would make the read side interpret "not set" as "set
    // to an empty model"; in AmendWorkflow's
    // three states those are different meanings.
    expect(
      "subagentModel" in journal.listEvents(RUN, { types: "all", reportItems: "all" })[1]!.event,
    ).toBe(false);
  });

  // This run's script file (the Provenance of docs/dynamic-workflow/launch.md "Script files") follows
  // the same per-item rules as the subagent
  // model: zero SQL, not read by the engine, recorded once in the run-creating life. The host reads
  // it back from the event header and hands it to the model surface.
  it("launch 携 scriptPath 时 run-launched 原样带上绝对路径，resume 不再记第二条", () => {
    const journal = new InMemoryJournalStore();
    const withPath = () =>
      new WorkflowEngine({
        runId: RUN,
        driver: new FakeDriver(journal),
        caps: { maxConcurrency: 16 },
        askSpecs: untypedSpecs("ask#1"),
        validate: () => [],
        launch: {
          inputId: "launch-input-4",
          scriptPath: "/repo/.zcode/workflow-drafts/audit.dwf.ts",
        },
      });
    withPath();
    expect(journal.listEvents(RUN, { types: "all", reportItems: "all" })[1]?.event).toEqual({
      type: "run-launched",
      inputId: "launch-input-4",
      scriptPath: "/repo/.zcode/workflow-drafts/audit.dwf.ts",
    });

    // The resumed life does not record it again (the same gate as the anchor and the subagent
    // model): a run's script file is unique across lifecycles.
    withPath();
    expect(
      journal
        .listEvents(RUN, { types: "all", reportItems: "all" })
        .filter((stored) => stored.event.type === "run-launched"),
    ).toHaveLength(1);
  });

  it("launch 不带 scriptPath 时整个键缺席（缺席即这个 run 没有可编辑的脚本文件）", () => {
    const journal = new InMemoryJournalStore();
    make(journal);
    // Same argument as subagentModel: a key persisted with an undefined value would make the read
    // side interpret "no file" as
    // "a file with an empty path", and the model surface decides which sentence to say based on that.
    expect(
      "scriptPath" in journal.listEvents(RUN, { types: "all", reportItems: "all" })[1]!.event,
    ).toBe(false);
  });

  it("scriptPath 与子代理模型、阶段表同车时四者共存于同一条 run-launched", () => {
    const journal = new InMemoryJournalStore();
    new WorkflowEngine({
      runId: RUN,
      driver: new FakeDriver(journal),
      caps: { maxConcurrency: 16 },
      askSpecs: untypedSpecs("ask#1"),
      validate: () => [],
      launch: {
        inputId: "launch-input-5",
        phaseNames: ["Research"],
        subagentModel: "zhipu/glm-5.3-flash$high",
        scriptPath: "/repo/.zcode/workflow-drafts/audit.dwf.ts",
      },
    });
    expect(journal.listEvents(RUN, { types: "all", reportItems: "all" })[1]?.event).toEqual({
      type: "run-launched",
      inputId: "launch-input-5",
      phaseNames: ["Research"],
      subagentModel: "zhipu/glm-5.3-flash$high",
      scriptPath: "/repo/.zcode/workflow-drafts/audit.dwf.ts",
    });
  });

  it("phaseAlongside 与阶段表同车落 journal，缺席时键不出现（引擎两者都不读）", () => {
    const journal = new InMemoryJournalStore();
    new WorkflowEngine({
      runId: RUN,
      driver: new FakeDriver(journal),
      caps: { maxConcurrency: 16 },
      askSpecs: untypedSpecs("ask#1"),
      validate: () => [],
      launch: {
        inputId: "launch-input-3",
        phaseNames: ["A", "B", "C"],
        phaseAlongside: [[], [0], []],
      },
    });
    expect(journal.listEvents(RUN, { types: "all", reportItems: "all" })[1]?.event).toEqual({
      type: "run-launched",
      inputId: "launch-input-3",
      phaseNames: ["A", "B", "C"],
      phaseAlongside: [[], [0], []],
    });

    const straight = new InMemoryJournalStore();
    new WorkflowEngine({
      runId: RUN,
      driver: new FakeDriver(straight),
      caps: { maxConcurrency: 16 },
      askSpecs: untypedSpecs("ask#1"),
      validate: () => [],
      launch: { inputId: "launch-input-4", phaseNames: ["A"] },
    });
    expect(
      Object.hasOwn(
        straight.listEvents(RUN, { types: "all", reportItems: "all" })[1]!.event,
        "phaseAlongside",
      ),
    ).toBe(false);
  });
});

describe("用量沿 lineage 累计（docs/execution-engine.md「Usage across the lineage」）", () => {
  const eventTypes = (journal: InMemoryJournalStore) =>
    journal
      .listEvents(RUN, { types: "all", reportItems: "all" })
      .map((stored) => stored.event.type);
  const make = (
    journal: InMemoryJournalStore,
    opts: { inheritedTokens?: number; launch?: { inputId: string } } = {},
  ) => {
    const driver = new FakeDriver(journal);
    const engine = new WorkflowEngine({
      runId: RUN,
      driver,
      caps: { maxConcurrency: 16 },
      askSpecs: untypedSpecs("ask#1"),
      validate: () => [],
      resumedFrom: "run-a",
      ...(opts.inheritedTokens === undefined ? {} : { inheritedTokens: opts.inheritedTokens }),
      ...(opts.launch === undefined ? {} : { launch: opts.launch }),
    });
    return { driver, engine };
  };

  it("inheritedTokens 是新 run 的起点：行值即前驱总量，run-started 之后紧跟一条同值的 usage-updated", () => {
    const journal = new InMemoryJournalStore();
    const { driver } = make(journal, { inheritedTokens: 300 });
    expect(journal.getRun(RUN)?.spentTokens).toBe(300);
    expect(eventTypes(journal)).toEqual(["run-started", "usage-updated"]);
    expect(journal.listEvents(RUN, { types: "all", reportItems: "all" })[1]?.event).toEqual({
      type: "usage-updated",
      spentTokens: 300,
    });
    // The projection gets the same event via driver.emit: run-started zeroes the usage, and this one
    // immediately puts the inherited value back.
    expect(driver.events.at(-1)).toEqual({ type: "usage-updated", spentTokens: 300 });
  });

  it("带 launch 时顺序是 run-started → run-launched → usage-updated（锚点仍紧跟首条 run-started）", () => {
    const journal = new InMemoryJournalStore();
    make(journal, { inheritedTokens: 300, launch: { inputId: "launch-1" } });
    expect(eventTypes(journal)).toEqual(["run-started", "run-launched", "usage-updated"]);
  });

  it("live turn 在继承值之上累加；事件载荷与行值始终相等", async () => {
    const journal = new InMemoryJournalStore();
    const { driver, engine } = make(journal, { inheritedTokens: 300 });
    const actor = engine.createActor("actor#1");
    void engine.ask("ask#1", actor, "do it").catch(() => {});
    await flush();
    engine.askStats(inst("ask#1"), { tokens: 50, toolCalls: 0, turns: 1 });
    expect(driver.events.at(-1)).toEqual({ type: "usage-updated", spentTokens: 350 });
    expect(journal.getRun(RUN)?.spentTokens).toBe(350);
    engine.stop("user");
  });

  it("继承值为零或缺席时不发 post-start usage-updated（reset 已经说了零）", () => {
    const zero = new InMemoryJournalStore();
    make(zero, { inheritedTokens: 0 });
    expect(eventTypes(zero)).toEqual(["run-started"]);
    const absent = new InMemoryJournalStore();
    make(absent);
    expect(absent.getRun(RUN)?.spentTokens).toBe(0);
    expect(eventTypes(absent)).toEqual(["run-started"]);
  });

  it("resume 恢复行值后同样紧跟一条 usage-updated，让第二世的投影不从零起显示", () => {
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 7,
      status: "stopped",
      stopReason: "user",
    });
    const { driver } = make(journal);
    expect(eventTypes(journal)).toEqual(["run-started", "usage-updated"]);
    expect(driver.events).toEqual([
      { type: "run-started", runId: RUN, caps: { maxConcurrency: 16 } },
      { type: "usage-updated", spentTokens: 7 },
    ]);
    expect(journal.getRun(RUN)?.spentTokens).toBe(7);
  });
});
