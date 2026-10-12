/**
 * Reason for the split: journal-contract.ts hit the oxlint max-lines cap (400 lines), so the run-record cases
 * (create run / settlement bag / metadata columns / usage) were moved into this file;
 * the public surface is still exported from journal-contract.ts (`runJournalStoreContract` calls each topic's
 * registration functions in the original order).
 *
 * Note: only `it(...)` cases are registered here, with no new describe — the suite's grouping and case order
 * must remain verbatim identical to before the split.
 */

import { expect, it } from "vitest";
import type { JournalStorePort } from "../engine/index.js";
import { baseRun } from "./journal-contract-helpers.js";

export function registerRunCases(factory: () => JournalStorePort): void {
  it("creates and reads back a run record", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    expect(store.getRun("r1")).toMatchObject({ runId: "r1", status: "running", spentTokens: 0 });
    expect(store.getRun("missing")).toBeUndefined();
  });

  it("rejects duplicate run creation loudly", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    expect(() => store.createRun(baseRun("r1"))).toThrow();
  });

  it("updates run status and failure", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    store.updateRunStatus("r1", "errored", {
      failure: { code: "ReportCapExceeded", message: "cap" },
    });
    const run = store.getRun("r1");
    expect(run?.status).toBe("errored");
    expect(run?.failure).toEqual({ code: "ReportCapExceeded", message: "cap" });
    expect(run?.stopReason).toBeUndefined();
  });

  // Three terminal states (docs/execution-engine.md): stopped is written in one shot together with its stopReason,
  // provider / interrupted carry a failure, user / model do not. Both implementations must read back
  // field-for-field identically — the SQLite-side physical columns still use the old terms
  // (cancelled + the failure_json envelope); encoding/decoding is its own business.
  it("settles a stopped run with its reason and a ProviderStop failure", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    const failure = {
      code: "ProviderStop" as const,
      message: "Sign-in to BigModel expired.",
      providerStop: {
        kind: "auth" as const,
        reason: "auth_failed",
        providerId: "account:bigmodel-coding-plan",
        modelId: "GLM-5.3",
        providerCode: "1006",
        subagent: "verify@2",
        phase: "Verify",
        rawMessage: "[1006] token expired",
      },
    };
    store.updateRunStatus("r1", "stopped", { stopReason: "provider", failure });
    const run = store.getRun("r1");
    expect(run?.status).toBe("stopped");
    expect(run?.stopReason).toBe("provider");
    expect(run?.failure).toEqual(failure);
    expect(run?.result).toBeUndefined();
  });

  it("settles a stopped run without a failure and reads the reason back", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    store.updateRunStatus("r1", "stopped", { stopReason: "model" });
    const run = store.getRun("r1");
    expect(run?.status).toBe("stopped");
    expect(run?.stopReason).toBe("model");
    expect(run?.failure).toBeUndefined();
  });

  it("settles an interrupted run with its Interrupted failure", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    store.updateRunStatus("r1", "stopped", {
      stopReason: "interrupted",
      failure: { code: "Interrupted", message: "owner process exited" },
    });
    const run = store.getRun("r1");
    expect(run?.status).toBe("stopped");
    expect(run?.stopReason).toBe("interrupted");
    expect(run?.failure?.code).toBe("Interrupted");
  });

  // Why the settlement bag exists: the terminal status and the artifact must be written in one shot.
  // Writing them in two shots opens a crash window that produces a run that is "completed but with an
  // unrecoverable artifact".
  it("settles a completed run together with its artifact", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    store.updateRunStatus("r1", "completed", { result: { answer: 42, notes: ["a", "b"] } });
    const run = store.getRun("r1");
    expect(run?.status).toBe("completed");
    expect(run?.result).toEqual({ answer: 42, notes: ["a", "b"] });
    expect(run?.failure).toBeUndefined();
  });

  // The artifact is the script's top-level return value — any JSON value, not just a record.
  it.each([
    ["a string artifact", "plain text answer"],
    ["an array artifact", [1, "two", { three: true }]],
    ["a number artifact", 7],
    ["a boolean artifact", false],
    // `null` is a valid artifact and must come back as-is, not collapse into "no result".
    ["a null artifact", null],
  ])("round-trips %s", (_label, artifact) => {
    const store = factory();
    store.createRun(baseRun("r1"));
    store.updateRunStatus("r1", "completed", { result: artifact });
    const run = store.getRun("r1");
    expect(run?.status).toBe("completed");
    expect("result" in (run ?? {})).toBe(true);
    expect(run?.result).toEqual(artifact);
  });

  it("leaves result absent for an errored settlement", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    store.updateRunStatus("r1", "errored", { failure: { code: "DriverError", message: "boom" } });
    const run = store.getRun("r1");
    expect(run?.status).toBe("errored");
    expect(run?.failure).toEqual({ code: "DriverError", message: "boom" });
    expect(run?.result).toBeUndefined();
  });

  // An omitted settlement bag = "do not touch failure or result". This covers both the engine's own
  // `running` writes and historical rows persisted before 0020.
  it("leaves result absent when no settlement bag is passed", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    store.updateRunStatus("r1", "completed");
    expect(store.getRun("r1")!.result).toBeUndefined();
    expect(store.getRun("r1")?.status).toBe("completed");
  });

  // Storage side of rule three (apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md "Engine ownership").
  // Bug root cause (2026-09-04): orphan reconciliation from a second desktop instance wrote a terminal failure
  // onto a run still alive in this process's engine, and the engine then completed normally — but the old
  // "absent = do not touch" semantics (SQLite's coalesce) left that foreign failure in place, so the row said
  // both "completed" and "interrupted". The failure triple is therefore **rewritten as a whole**; the artifact is unchanged.
  it("clears a stale failure when a later settlement completes the run", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    store.updateRunStatus("r1", "stopped", {
      stopReason: "interrupted",
      failure: { code: "Interrupted", message: "foreign reconcile" },
    });
    store.updateRunStatus("r1", "completed", { result: { done: true } });
    const run = store.getRun("r1");
    expect(run?.status).toBe("completed");
    expect(run?.failure).toBeUndefined();
    expect(run?.stopReason).toBeUndefined();
    expect(run?.result).toEqual({ done: true });
  });

  it("clears an errored failure when a later settlement completes the run", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    store.updateRunStatus("r1", "errored", { failure: { code: "DriverError", message: "boom" } });
    store.updateRunStatus("r1", "completed", { result: { done: true } });
    const run = store.getRun("r1");
    expect(run?.status).toBe("completed");
    expect(run?.failure).toBeUndefined();
    expect(run?.result).toEqual({ done: true });
  });

  it("keeps an already-settled artifact when a later write omits it", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    store.updateRunStatus("r1", "completed", { result: { kept: true } });
    store.updateRunStatus("r1", "completed");
    expect(store.getRun("r1")!.result).toEqual({ kept: true });
  });

  // amend stops the predecessor: `superseded` and the successor id are persisted in the same write and read back
  // in the same envelope (docs/execution-engine.md "Amend-resume"). Without that value in the sniffing whitelist,
  // the whole envelope fails to decode and the row degrades to user.
  it("round-trips stopped(superseded) together with supersededBy", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    store.updateRunStatus("r1", "stopped", { stopReason: "superseded", supersededBy: "r2" });
    const run = store.getRun("r1");
    expect(run?.status).toBe("stopped");
    expect(run?.stopReason).toBe("superseded");
    expect(run?.supersededBy).toBe("r2");
    expect(run?.failure).toBeUndefined();
    // The other reasons carry no successor pointer.
    store.createRun(baseRun("r3"));
    store.updateRunStatus("r3", "stopped", { stopReason: "model" });
    expect(store.getRun("r3")?.supersededBy).toBeUndefined();
  });

  // resume semantics: when flipping a run back to a non-terminal status, leftover settlement residue from the
  // previous life must be cleared along with it. The engine's resume branch writes
  // `updateRunStatus(runId, "running")` (no settlement bag), and under the "absent key = do not touch"
  // terminal-state semantics, a run that orphan reconciliation had turned into failed+Interrupted would come
  // back with a stale failure_json coexisting with running — the journal snapshot read surface would report
  // both "running" and "failed". So a non-terminal write means **clearing**, not preserving.
  it("clears failure and stopReason when flipping a stopped run back to a non-terminal status", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    store.updateRunStatus("r1", "stopped", {
      stopReason: "interrupted",
      failure: { code: "Interrupted", message: "killed" },
    });
    store.updateRunStatus("r1", "running");
    const run = store.getRun("r1");
    expect(run?.status).toBe("running");
    expect(run?.failure).toBeUndefined();
    expect(run?.stopReason).toBeUndefined();
    expect(run?.supersededBy).toBeUndefined();
  });

  it("clears result when flipping a completed run back to a non-terminal status", () => {
    // A completed run is not in the resumable set, but the port semantics are defined by status category,
    // not by caller preference: non-terminal = no settlement. Giving the semantics exceptions would only leak
    // the gate's knowledge into the storage layer.
    const store = factory();
    store.createRun(baseRun("r1"));
    store.updateRunStatus("r1", "completed", { result: { stale: true } });
    store.updateRunStatus("r1", "pending");
    const run = store.getRun("r1");
    expect(run?.status).toBe("pending");
    expect(run?.result).toBeUndefined();
  });

  it("ignores a settlement bag on a non-terminal write (cleared, not stored)", () => {
    // A non-terminal write carrying a settlement bag is a contradictory request from the caller: a "running"
    // run has no settlement. The semantics are defined as clear-first, so the two implementations do not each
    // invent their own interpretation of the contradiction.
    const store = factory();
    store.createRun(baseRun("r1"));
    store.updateRunStatus("r1", "running", { failure: { code: "DriverError", message: "x" } });
    expect(store.getRun("r1")?.failure).toBeUndefined();
  });

  // createRun must also honor this field: the in-memory implementation clones the whole record, and if SQLite
  // does not write this column, the same record stored in both implementations and read back would diverge.
  // The engine only creates runs as running, but the port's semantics should not have this hole.
  it("creates and reads back a run carrying an artifact", () => {
    const store = factory();
    store.createRun({ ...baseRun("r1"), status: "completed", result: { seeded: true } });
    expect(store.getRun("r1")!.result).toEqual({ seeded: true });
  });

  // name is the run's display label (`input.name` → createRun → dwf_run.name), on the same metadata path as
  // scriptText/cwd. Both implementations have createRun/getRun, so it belongs to the contract: if SQLite omits
  // this column, the same record stored in both implementations and read back would diverge (the same argument
  // once made verbatim for the result column).
  it("round-trips a run name and keeps it absent when unnamed", () => {
    const store = factory();
    store.createRun({ ...baseRun("named"), name: "nightly triage" });
    store.createRun(baseRun("unnamed"));

    expect(store.getRun("named")?.name).toBe("nightly triage");
    const unnamed = store.getRun("unnamed");
    expect(unnamed?.name).toBeUndefined();
    // An absent optional field must come back absent as-is, not become name: null / name: undefined.
    expect(unnamed !== undefined && "name" in unnamed).toBe(false);
  });

  // The args (`dwf_run.args_json`, migration 0026) share the same createRun metadata path as scriptText / name,
  // with an even stronger reason to belong to the contract: resume **replays** the stored args, so if SQLite
  // omits this column, the restored run would silently run once with `{}` — "A was approved, B was restored".
  it("round-trips the run args and keeps them absent when the run had none", () => {
    const store = factory();
    store.createRun({
      ...baseRun("with-args"),
      args: { target: "packages/core", depth: 3, nested: { deep: true } },
    });
    store.createRun(baseRun("no-args"));

    expect(store.getRun("with-args")?.args).toEqual({
      target: "packages/core",
      depth: 3,
      nested: { deep: true },
    });
    const bare = store.getRun("no-args");
    // An absent optional field comes back absent as-is (old rows from before 0026 take exactly this path):
    // at the record level, "no args" and "empty args bag" stay distinguishable, so the sandbox side can
    // uniformly read absence as `{}`.
    expect(bare?.args).toBeUndefined();
    expect(bare !== undefined && "args" in bare).toBe(false);
  });

  it("keeps the run args across a status settlement", () => {
    const store = factory();
    store.createRun({ ...baseRun("r-args"), args: { keep: "me" } });
    store.updateRunStatus("r-args", "completed", { result: "done" });
    // resume can read it back because the settlement UPDATE does not touch this column.
    expect(store.getRun("r-args")?.args).toEqual({ keep: "me" });
  });

  // Settlement only changes status and artifact: name is not on updateRunStatus's write surface (if the
  // SQLite-side UPDATE included name, the run would lose its name upon settlement).
  it("keeps the run name across a status settlement", () => {
    const store = factory();
    store.createRun({ ...baseRun("r1"), name: "keeps its name" });
    store.updateRunStatus("r1", "completed", { result: "done" });
    expect(store.getRun("r1")?.name).toBe("keeps its name");
  });

  // toolCallId is the id of the CreateWorkflow tool call that started the run — the persistent anchor for the
  // tool card join and for resume after a restart (docs/execution-engine.md). It shares the same
  // createRun metadata path as scriptText/cwd and belongs to the contract: if SQLite omits this column,
  // the discovery query after a restart cannot recover the association key.
  it("round-trips the originating toolCallId and keeps it absent when not given", () => {
    const store = factory();
    store.createRun({ ...baseRun("anchored"), toolCallId: "call-42" });
    store.createRun(baseRun("bare"));

    expect(store.getRun("anchored")?.toolCallId).toBe("call-42");
    const bare = store.getRun("bare");
    expect(bare?.toolCallId).toBeUndefined();
    // An absent optional field must come back absent as-is, not become toolCallId: null / undefined.
    expect(bare !== undefined && "toolCallId" in bare).toBe(false);
  });

  // Settlement only changes status and artifact: toolCallId is not on updateRunStatus's write surface.
  it("keeps the toolCallId across a status settlement and across a resume flip", () => {
    const store = factory();
    store.createRun({ ...baseRun("r1"), toolCallId: "call-7" });
    store.updateRunStatus("r1", "stopped", { stopReason: "user" });
    expect(store.getRun("r1")?.toolCallId).toBe("call-7");
    // When resume flips the run back to running it clears the settlement; the anchor must be preserved as-is.
    store.updateRunStatus("r1", "running");
    expect(store.getRun("r1")?.toolCallId).toBe("call-7");
  });

  // resumedFrom is the lineage pointer of amend-resume (which predecessor run this run was amended from,
  // docs/execution-engine.md). It shares the same createRun metadata path as toolCallId / args, and the reason
  // it belongs to the contract is that it is a **liveness dependency**: the plain resume after an amended run
  // crashes relies on reading this pointer back to rebuild the ImportedCache; if SQLite omits this column, the
  // restored run would downgrade all unconsumed cache into live reruns.
  it("round-trips the resumedFrom lineage pointer and keeps it absent for a fresh run", () => {
    const store = factory();
    store.createRun({ ...baseRun("amended"), resumedFrom: "run-predecessor" });
    store.createRun(baseRun("fresh"));

    expect(store.getRun("amended")?.resumedFrom).toBe("run-predecessor");
    const fresh = store.getRun("fresh");
    expect(fresh?.resumedFrom).toBeUndefined();
    // An absent optional field must come back absent as-is (NULL decodes into an absent key, not null /
    // undefined) — the vast majority of runs are not amendments, so this is the common path.
    expect(fresh !== undefined && "resumedFrom" in fresh).toBe(false);
  });

  // Neither settlement nor the resume flip is on lineage's write surface: chained amendments must trace back
  // through this pointer to ancestors at any depth; if any link loses the pointer at settlement, the chain
  // breaks there.
  it("keeps resumedFrom across a status settlement and across a resume flip", () => {
    const store = factory();
    store.createRun({ ...baseRun("r1"), resumedFrom: "run-a" });
    store.updateRunStatus("r1", "stopped", { stopReason: "user" });
    expect(store.getRun("r1")?.resumedFrom).toBe("run-a");
    store.updateRunStatus("r1", "running");
    expect(store.getRun("r1")?.resumedFrom).toBe("run-a");
  });

  it("isolates a stored artifact from later mutation of the caller's object", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    const artifact = { nested: { value: 1 } };
    store.updateRunStatus("r1", "completed", { result: artifact });
    artifact.nested.value = 999;
    // r1 was createRun'd two lines ago, so getRun must hit; a non-null assertion is used instead of ?. because
    // the subsequent .nested.value chained access would otherwise be unsafe optional chaining in lint's eyes
    // (when ?. short-circuits to undefined, it would throw outright).
    expect((store.getRun("r1")!.result as { nested: { value: number } }).nested.value).toBe(1);
  });

  it("settles an artifact and a failure independently on separate runs", () => {
    const store = factory();
    store.createRun(baseRun("ok"));
    store.createRun(baseRun("bad"));
    store.updateRunStatus("ok", "completed", { result: "done" });
    store.updateRunStatus("bad", "errored", {
      failure: { code: "DriverError", message: "stop" },
    });
    expect(store.getRun("ok")?.result).toBe("done");
    expect(store.getRun("ok")?.failure).toBeUndefined();
    expect(store.getRun("bad")?.result).toBeUndefined();
    expect(store.getRun("bad")?.failure?.code).toBe("DriverError");
  });

  it("throws when updating an unknown run", () => {
    const store = factory();
    expect(() => store.updateRunStatus("nope", "completed")).toThrow();
  });

  it("persists accumulated usage without disturbing status or failure", () => {
    // Usage is a write path independent of run settlement: every askStats accumulation must be persisted,
    // otherwise resume would start over from zero usage (the latent bug of phase 1.5).
    const store = factory();
    store.createRun(baseRun("r1"));
    store.updateRunUsage("r1", 4200);
    expect(store.getRun("r1")).toMatchObject({ spentTokens: 4200, status: "running" });
    expect(store.getRun("r1")?.failure).toBeUndefined();

    // Writing usage again on an already-settled run (including one with a failure) must not rewrite the status or the failure reason.
    store.updateRunStatus("r1", "errored", {
      failure: { code: "DriverError", message: "over" },
    });
    store.updateRunUsage("r1", 5100);
    const run = store.getRun("r1");
    expect(run?.spentTokens).toBe(5100);
    expect(run?.status).toBe("errored");
    expect(run?.failure).toEqual({ code: "DriverError", message: "over" });
  });

  it("throws when updating the usage of an unknown run", () => {
    const store = factory();
    expect(() => store.updateRunUsage("nope", 1)).toThrow();
  });

  // The **second writer** of `caps_max_concurrency` (docs/dynamic-workflow/concurrency.md
  // "Two bounds on a run"): an amendment that only changes `max_concurrency` acts in place on the live run,
  // while resume carries over the caps in the row — without persisting, the restored run would still have the
  // old cap. A narrow write in the same family as usage: touches only this column; status / usage /
  // settlement bag are all left untouched.
  it("retunes the concurrency cap without disturbing status, usage or failure", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    store.updateRunUsage("r1", 4200);
    store.updateRunCaps("r1", { maxConcurrency: 2 });
    expect(store.getRun("r1")).toMatchObject({
      caps: { maxConcurrency: 2 },
      spentTokens: 4200,
      status: "running",
    });

    // Writing the cap again on an already-settled run (including one with a failure) must not rewrite the status or the failure reason.
    store.updateRunStatus("r1", "errored", {
      failure: { code: "DriverError", message: "over" },
    });
    store.updateRunCaps("r1", { maxConcurrency: 7 });
    const run = store.getRun("r1");
    expect(run?.caps).toEqual({ maxConcurrency: 7 });
    expect(run?.status).toBe("errored");
    expect(run?.failure).toEqual({ code: "DriverError", message: "over" });
  });

  it("throws when retuning the caps of an unknown run", () => {
    const store = factory();
    expect(() => store.updateRunCaps("nope", { maxConcurrency: 1 })).toThrow();
  });
}
