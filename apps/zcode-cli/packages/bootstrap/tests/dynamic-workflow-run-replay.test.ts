// Settlement source for cold replay of a dwf run (docs/dynamic-workflow/presentation.md "Cold replay"):
// when the row is in a terminal state, the trailing `run-settled` of the replay is always minted from the row —
// the one stored in the journal (old or new vocabulary alike) yields;
// when the tail has no settlement (process death / orphan convergence only touched the row), one is appended.
//
// Why this was fixed (2026-09-15, verified on desktop): a `run-settled` written before the 2026-09-14
// terminal-vocabulary refactor carries the old terms
// cancelled / failed; the event payload is replayed verbatim, the reducer cannot recognize it, and the run stays in running.
// Here we persist byte-identical bytes into a real SQLite journal (appendEvent stores JSON as-is),
// pinning that after replay + reducer the run must be terminal.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSqliteSessionStore, type DwfRunSessionListItem } from "@zcode/adapters/storage";
import type { JournalStorePort, RunEvent } from "@zcode/dynamic-workflow";
import { reduceWorkflowRunsState, type WorkflowRunsState } from "@zcode/shared/zcode-protocol-v4";
import { toProgressPayload } from "../src/app/dynamic-workflow-run-launch.js";
import { replayRunProgress } from "../src/app/dynamic-workflow-run-replay.js";
import { mintActorSessionId } from "../src/app/workflow-driver.js";
import { resolveDynamicWorkflowJournalStore } from "../src/app/dynamic-workflow-run-service.js";

const PARENT = "sess_replay_parent";
// Third argument of cold replay: this process's concurrency ceiling, which only lands on the `run-started` payload
// (docs/dynamic-workflow/concurrency.md "Two bounds on a run").
// The cases here only look at settlement, so a fixed value suffices; the live side (toProgressPayload) passes
// the same value so the byte-for-byte contract holds.
const CEILING = 6;

type Journal = JournalStorePort & {
  listRunsByParentSession(parentSessionId: string, limit: number): DwfRunSessionListItem[];
};

let tempRoot: string;
let store: ReturnType<typeof createSqliteSessionStore>;
let journal: Journal;

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "zcode-dwf-replay-"));
  store = createSqliteSessionStore({ dbPath: join(tempRoot, "session.sqlite") });
  const resolved = resolveDynamicWorkflowJournalStore(store as never);
  if (resolved === undefined) throw new Error("sqlite store must expose the dwf journal");
  journal = resolved as Journal;
});

afterEach(async () => {
  await store.close?.();
  await rm(tempRoot, { force: true, recursive: true });
});

function createRun(runId: string): void {
  journal.createRun({
    runId,
    parentSessionId: PARENT,
    cwd: "/repo",
    toolCallId: `call-${runId}`,
    scriptText: "const a = agent('a');",
    scriptHash: "sha-a",
    caps: { maxConcurrency: 4 },
    spentTokens: 0,
    status: "running",
  });
  journal.appendEvent(runId, {
    type: "run-started",
    runId,
    caps: { maxConcurrency: 4 },
  } as RunEvent);
  journal.appendEvent(runId, {
    type: "actor-created",
    actor: { siteId: "actor#1", ordinal: 1 },
    name: "a",
  } as RunEvent);
}

/** Settlement event in the old vocabulary: `appendEvent` stores JSON as-is, so what lands is the pre-2026-09-14 bytes. */
function appendLegacySettle(runId: string, status: "cancelled" | "failed", error?: unknown): void {
  journal.appendEvent(runId, {
    type: "run-settled",
    status,
    ...(error === undefined ? {} : { error }),
  } as unknown as RunEvent);
}

function rowOf(runId: string): DwfRunSessionListItem {
  const row = journal.listRunsByParentSession(PARENT, 8).find((item) => item.runId === runId);
  if (row === undefined) throw new Error(`row missing for ${runId}`);
  return row;
}

function reduce(runId: string): WorkflowRunsState["runs"][number] {
  let state: WorkflowRunsState | undefined;
  for (const payload of replayRunProgress(rowOf(runId), journal, CEILING)) {
    state = reduceWorkflowRunsState(state, payload) ?? state;
  }
  const run = state?.runs.find((item) => item.runId === runId);
  if (run === undefined) throw new Error("run not projected");
  return run;
}

describe("replayRunProgress — 结算按行铸造", () => {
  it("旧词表 run-settled{cancelled}（行已译成 stopped）→ 回放尾部是行铸的 stopped，reducer 落终态且可恢复", () => {
    createRun("dwfrun-legacy-cancelled");
    appendLegacySettle("dwfrun-legacy-cancelled", "cancelled");
    journal.updateRunStatus("dwfrun-legacy-cancelled", "stopped", { stopReason: "user" });

    const payloads = replayRunProgress(rowOf("dwfrun-legacy-cancelled"), journal, CEILING);
    const stored = journal.listEvents("dwfrun-legacy-cancelled", {
      types: "all",
      reportItems: "all",
    });
    // One in, one out: the stored settlement is replaced, not appended — the count matches the journal,
    // and the watermark reuses the replaced entry's sequence.
    expect(payloads).toHaveLength(stored.length);
    const last = payloads.at(-1);
    expect(last).toMatchObject({
      eventType: "run-settled",
      sequence: stored.at(-1)?.sequence,
      payload: { status: "stopped", stopReason: "user", resumable: true },
    });
    expect(
      payloads.some((payload) => (payload.payload as { status?: unknown }).status === "cancelled"),
    ).toBe(false);

    const run = reduce("dwfrun-legacy-cancelled");
    expect(run.status).toBe("stopped");
    expect(run.stopReason).toBe("user");
    expect(run.resumable).toBe(true);
  });

  it("旧词表 run-settled{failed}（行是 errored）→ errored，失败文案来自行", () => {
    createRun("dwfrun-legacy-failed");
    appendLegacySettle("dwfrun-legacy-failed", "failed", { code: "DriverError", message: "boom" });
    journal.updateRunStatus("dwfrun-legacy-failed", "errored", {
      failure: { code: "DriverError", message: "boom" },
    });

    const run = reduce("dwfrun-legacy-failed");
    expect(run.status).toBe("errored");
    expect(run.error).toBe("boom");
    expect(run.resumable).toBeUndefined();
  });

  it("当前词表：行铸的结算与存着的那条逐字节相同（live 与冷回放同一份字节的契约不变）", () => {
    createRun("dwfrun-current");
    journal.updateRunStatus("dwfrun-current", "stopped", { stopReason: "model" });
    journal.appendEvent("dwfrun-current", {
      type: "run-settled",
      status: "stopped",
      stopReason: "model",
    } as RunEvent);

    const row = rowOf("dwfrun-current");
    const live = journal
      .listEvents("dwfrun-current", { types: "all", reportItems: "all" })
      .map((entry) =>
        toProgressPayload({
          event: entry.event,
          runId: row.runId,
          sequence: entry.sequence,
          toolCallId: row.toolCallId!,
          concurrencyCeiling: CEILING,
        }),
      );
    expect(JSON.stringify(replayRunProgress(row, journal, CEILING))).toBe(JSON.stringify(live));
  });

  it("行是终态而事件流没有结算（孤儿收敛只改了行）→ 追加一条 interrupted 结算，sequence = 最后一条 + 1", () => {
    createRun("dwfrun-orphan");
    journal.updateRunStatus("dwfrun-orphan", "stopped", {
      stopReason: "interrupted",
      failure: { code: "Interrupted", message: "owner exited" },
    });

    const stored = journal.listEvents("dwfrun-orphan", { types: "all", reportItems: "all" });
    const payloads = replayRunProgress(rowOf("dwfrun-orphan"), journal, CEILING);
    expect(payloads).toHaveLength(stored.length + 1);
    expect(payloads.at(-1)).toMatchObject({
      eventType: "run-settled",
      sequence: (stored.at(-1)?.sequence ?? 0) + 1,
      payload: { status: "stopped", stopReason: "interrupted", resumable: true },
    });
    expect(reduce("dwfrun-orphan").status).toBe("stopped");
  });

  it("中途的上一世结算（cancel → resume）原样保留，只替换尾部那条", () => {
    createRun("dwfrun-resumed");
    appendLegacySettle("dwfrun-resumed", "cancelled");
    journal.appendEvent("dwfrun-resumed", {
      type: "run-started",
      runId: "dwfrun-resumed",
      caps: { maxConcurrency: 4 },
    } as RunEvent);
    journal.updateRunStatus("dwfrun-resumed", "completed");
    journal.appendEvent("dwfrun-resumed", { type: "run-settled", status: "completed" } as RunEvent);

    const payloads = replayRunProgress(rowOf("dwfrun-resumed"), journal, CEILING);
    const settles = payloads.filter((payload) => payload.eventType === "run-settled");
    expect(settles.map((payload) => (payload.payload as { status: string }).status)).toEqual([
      "cancelled",
      "completed",
    ]);
    expect(reduce("dwfrun-resumed").status).toBe("completed");
  });

  // ── Subagent model of this run (docs/dynamic-workflow/launch.md) ───────────
  // It lives in the same `run-launched` as the launch anchor (zero SQL; the dwf_run table has no such column):
  // the live side takes the canonical string from the launch input and hangs it on the `run-started` payload,
  // and cold replay reads it back from the same event. Both sides must produce the same key,
  // otherwise the projection before and after a restart would no longer be byte-identical.
  it("run-launched 上的 subagentModel 进 run-started 载荷；冷回放与 live 逐字节相等", () => {
    const SUBAGENT = "zhipu/glm-5.3-flash$high";
    createRun("dwfrun-subagent");
    journal.appendEvent("dwfrun-subagent", {
      type: "run-launched",
      inputId: "input-origin",
      subagentModel: SUBAGENT,
    } as RunEvent);
    journal.updateRunStatus("dwfrun-subagent", "completed");
    journal.appendEvent("dwfrun-subagent", {
      type: "run-settled",
      status: "completed",
    } as RunEvent);

    const row = rowOf("dwfrun-subagent");
    const payloads = replayRunProgress(row, journal, CEILING);
    const started = payloads.find((payload) => payload.eventType === "run-started");
    expect(started?.payload).toMatchObject({
      subagentModel: SUBAGENT,
      concurrencyCeiling: CEILING,
    });
    // Derived fields hang only on run-started: attaching them to other events would just repeat the same
    // run-level fact in every payload.
    // `run-launched` itself doesn't count — that payload is the verbatim event content, and the model
    // string was already written into it.
    for (const payload of payloads) {
      if (payload.eventType === "run-started" || payload.eventType === "run-launched") continue;
      expect("subagentModel" in payload.payload).toBe(false);
    }

    // The live side uses the same minting chain and the same value → byte-identical (the only contract of this module).
    const live = journal
      .listEvents("dwfrun-subagent", { types: "all", reportItems: "all" })
      .map((entry) =>
        toProgressPayload({
          event: entry.event,
          runId: row.runId,
          sequence: entry.sequence,
          toolCallId: row.toolCallId!,
          launchInputId: "input-origin",
          concurrencyCeiling: CEILING,
          subagentModel: SUBAGENT,
        }),
      );
    expect(JSON.stringify(payloads)).toBe(JSON.stringify(live));
  });

  it("run-launched 没带子代理模型：run-started 载荷整个不带这个键", () => {
    createRun("dwfrun-no-subagent");
    journal.appendEvent("dwfrun-no-subagent", {
      type: "run-launched",
      inputId: "input-origin",
    } as RunEvent);
    const started = replayRunProgress(rowOf("dwfrun-no-subagent"), journal, CEILING).find(
      (payload) => payload.eventType === "run-started",
    );
    // Absent rather than an empty string: readers use this to tell whether the run ever set a subagent model.
    expect("subagentModel" in started!.payload).toBe(false);
  });

  // ── Models named by the script (docs/dynamic-workflow/launch.md "Models the script names") ──────────
  // The binding table lives in the same `run-launched`; the derived `model` of actor-created uses it to map
  // a persona's name to the canonical string.
  // Cold replay reads the same table back from the same event; payloads on both sides are byte-identical.
  it("actor-created 载荷的派生 model 来自 run-launched 的绑定表；冷回放与 live 逐字节相等", () => {
    const BINDINGS = { "GLM-5.3-Flash": "zhipu/GLM-5.3-Flash" };
    createRun("dwfrun-bindings");
    journal.appendEvent("dwfrun-bindings", {
      type: "run-launched",
      inputId: "input-origin",
      modelBindings: BINDINGS,
    } as RunEvent);
    journal.appendEvent("dwfrun-bindings", {
      type: "actor-created",
      actor: { siteId: "actor#7", ordinal: 1 },
      name: "评审员",
      persona: { name: "评审员", model: "GLM-5.3-Flash" },
    } as RunEvent);
    journal.appendEvent("dwfrun-bindings", {
      type: "actor-created",
      actor: { siteId: "actor#8", ordinal: 1 },
      name: "旁观者",
      persona: { name: "旁观者" },
    } as RunEvent);

    const row = rowOf("dwfrun-bindings");
    const payloads = replayRunProgress(row, journal, CEILING);
    // createRun itself also creates a subagent (no model); here we only look at the two added by this case.
    const created = payloads.filter(
      (payload) =>
        payload.eventType === "actor-created" &&
        ["评审员", "旁观者"].includes(String(payload.payload.name)),
    );
    expect(created[0]?.payload).toMatchObject({ model: "zhipu/GLM-5.3-Flash" });
    expect("model" in created[1]!.payload).toBe(false);

    const live = journal
      .listEvents("dwfrun-bindings", { types: "all", reportItems: "all" })
      .map((entry) =>
        toProgressPayload({
          event: entry.event,
          runId: row.runId,
          sequence: entry.sequence,
          toolCallId: row.toolCallId!,
          launchInputId: "input-origin",
          concurrencyCeiling: CEILING,
          modelBindings: BINDINGS,
        }),
      );
    expect(JSON.stringify(payloads)).toBe(JSON.stringify(live));
  });

  // ── node-dispatched of ask (apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md "Events") ─────
  // It repeats the instance's birth facts and names a subagent, so like actor-created it gets `actorSessionId`
  // filled in at the seam.
  // Cold replay walks the same minting chain, so the envelope must match exactly — otherwise the projection
  // before and after a restart could admit different instances into the table.
  it("ask 的 node-dispatched 带出生事实与 actorSessionId；冷回放与 live 逐字节相等", () => {
    const actor = { siteId: "actor#1", ordinal: 1 };
    createRun("dwfrun-dispatch");
    journal.appendEvent("dwfrun-dispatch", {
      type: "node-dispatched",
      instance: { siteId: "ask#1", ordinal: 1 },
      kind: "ask",
      actor,
      actorName: "planner",
      actorPhaseName: "Prepare",
      phaseName: "Work",
      instructionsHead: "写一份调研大纲",
    } as RunEvent);
    // world-read dispatch on the same journal: no actor, so it must not grow a session id.
    journal.appendEvent("dwfrun-dispatch", {
      type: "node-dispatched",
      instance: { siteId: "world-read#1", ordinal: 1 },
    } as RunEvent);

    const row = rowOf("dwfrun-dispatch");
    const payloads = replayRunProgress(row, journal, CEILING);
    const [ask, world] = payloads.filter((payload) => payload.eventType === "node-dispatched");
    expect(ask).toMatchObject({
      actorSessionId: mintActorSessionId("dwfrun-dispatch", actor),
      payload: {
        instance: { siteId: "ask#1", ordinal: 1 },
        kind: "ask",
        actor,
        actorName: "planner",
        actorPhaseName: "Prepare",
        phaseName: "Work",
        instructionsHead: "写一份调研大纲",
      },
    });
    // Mints the same id as actor-created: the two events describe the same subagent's same transcript.
    const created = payloads.find((payload) => payload.eventType === "actor-created");
    expect(ask?.actorSessionId).toBe(created?.actorSessionId);
    expect(world).toMatchObject({ payload: { instance: { siteId: "world-read#1", ordinal: 1 } } });
    expect("actorSessionId" in world!).toBe(false);

    const live = journal
      .listEvents("dwfrun-dispatch", { types: "all", reportItems: "all" })
      .map((entry) =>
        toProgressPayload({
          event: entry.event,
          runId: row.runId,
          sequence: entry.sequence,
          toolCallId: row.toolCallId!,
          concurrencyCeiling: CEILING,
        }),
      );
    expect(JSON.stringify(payloads)).toBe(JSON.stringify(live));
  });

  it("ask 的缓存结算带出生事实与 actorSessionId；world 与 live 的结算不补；冷回放与 live 逐字节相等", () => {
    const actor = { siteId: "actor#1", ordinal: 1 };
    createRun("dwfrun-cached");
    // Import hit: the answer is read from the predecessor's session.
    journal.appendEvent("dwfrun-cached", {
      type: "node-settled",
      instance: { siteId: "ask#1", ordinal: 1 },
      outcome: "ok",
      cached: true,
      kind: "ask",
      actor,
      actorSeq: 0,
      instructionsHead: "调研",
      sourceSessionId: "sess-predecessor",
    } as RunEvent);
    // Replay hit: the answer was produced by this run itself.
    journal.appendEvent("dwfrun-cached", {
      type: "node-settled",
      instance: { siteId: "ask#2", ordinal: 1 },
      outcome: "ok",
      cached: true,
      kind: "ask",
      actor,
      actorSeq: 1,
    } as RunEvent);
    // Two without a subagent: world-read's cached settlement, and a live settlement (not a birth event,
    // so no subagent is named).
    journal.appendEvent("dwfrun-cached", {
      type: "node-settled",
      instance: { siteId: "world-read#1", ordinal: 1 },
      outcome: "ok",
      cached: true,
    } as RunEvent);
    journal.appendEvent("dwfrun-cached", {
      type: "node-settled",
      instance: { siteId: "ask#3", ordinal: 1 },
      outcome: "ok",
    } as RunEvent);

    const row = rowOf("dwfrun-cached");
    const payloads = replayRunProgress(row, journal, CEILING);
    const settles = payloads.filter((payload) => payload.eventType === "node-settled");
    const own = mintActorSessionId("dwfrun-cached", actor);
    expect(settles.map((payload) => payload.actorSessionId)).toEqual([
      own,
      own,
      undefined,
      undefined,
    ]);
    // Payload verbatim: the predecessor session stays in the payload (what the engine sent); the derived
    // field sits outside the payload.
    expect(settles[0]).toMatchObject({
      payload: { kind: "ask", actor, actorSeq: 0, sourceSessionId: "sess-predecessor" },
    });
    expect("actorSessionId" in settles[2]!).toBe(false);
    expect("actorSessionId" in settles[3]!).toBe(false);

    const live = journal
      .listEvents("dwfrun-cached", { types: "all", reportItems: "all" })
      .map((entry) =>
        toProgressPayload({
          event: entry.event,
          runId: row.runId,
          sequence: entry.sequence,
          toolCallId: row.toolCallId!,
          concurrencyCeiling: CEILING,
        }),
      );
    expect(JSON.stringify(payloads)).toBe(JSON.stringify(live));

    // Reduction surface: both cached settlements are attributed to the subagent; the last one is this run's
    // own replay hit, and its sessionId points back to this run.
    const run = reduce("dwfrun-cached");
    expect(run.nodes.filter((node) => node.actorSiteId === "actor#1").map((node) => node.siteId)).toEqual([
      "ask#1",
      "ask#2",
    ]);
    expect(run.actors[0]?.sessionId).toBe(own);
  });

  it("行不是终态（本会话真在飞的 run 由调用方排除；这里是另一进程的）→ 事件原样回放，不追加结算", () => {
    createRun("dwfrun-live");
    const stored = journal.listEvents("dwfrun-live", { types: "all", reportItems: "all" });
    const payloads = replayRunProgress(rowOf("dwfrun-live"), journal, CEILING);
    expect(payloads).toHaveLength(stored.length);
    expect(payloads.some((payload) => payload.eventType === "run-settled")).toBe(false);
    expect(reduce("dwfrun-live").status).toBe("running");
  });
});
