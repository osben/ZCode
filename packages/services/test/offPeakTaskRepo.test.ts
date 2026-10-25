import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OffPeakTaskRepo,
  OFF_PEAK_CLAIM_STALE_MS,
  isOffPeakBoundSessionConflict,
} from "../src/session/offPeakTaskRepo.js";
import type { ZCodeOffPeakTaskCreateParams } from "@zcode/shared";

// Fixed base time so claim / reclaim assertions are reproducible.
const NOW = 1_700_000_000_000;
const MINUTE = 60_000;

function makeParams(
  overrides: Partial<ZCodeOffPeakTaskCreateParams> = {},
): ZCodeOffPeakTaskCreateParams {
  return {
    title: "夜间重构",
    prompt: "把 utils 目录的重复代码抽公共函数",
    permissionMode: "default",
    modelSelection: { providerId: "account:zai-offpeak-idle-plan", modelId: "GLM-5.2" },
    workspacePath: "/tmp/ws",
    ...overrides,
  };
}

// Reason for the fix (same as automationRepo.test.ts): this previously used setDataBaseDir(tempDir)
// to redirect the global _dataBaseDir, but when vitest threads run test files concurrently the
// global value is overwritten between files, leaving a concurrency window where writes could land
// in the real database. Switched to dependency injection: the repo receives dbPath as a constructor
// argument and raw SQL uses the same dbPath, avoiding the global singleton.
function buildTempDbPath(tempDir: string): string {
  return join(tempDir, "tasks-index.sqlite");
}

describe("OffPeakTaskRepo 状态机与调度守卫", () => {
  let tempDir: string | null = null;
  let dbPath: string;
  let repo: OffPeakTaskRepo;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "zcode-off-peak-repo-"));
    dbPath = buildTempDbPath(tempDir);
    repo = new OffPeakTaskRepo(dbPath);
  });

  afterEach(() => {
    repo.close();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("persists the project execution directory snapshot across repository reopen", async () => {
    const created = await repo.create(
      makeParams({ projectId: "project-a", hostId: "local", additionalDirectories: ["/extra"] }),
      { now: NOW },
    );
    expect(created).toMatchObject({
      projectId: "project-a",
      hostId: "local",
      additionalDirectories: ["/extra"],
    });
    repo.close();
    expect(await repo.get(created.offPeakTaskId)).toMatchObject({
      workspacePath: "/tmp/ws",
      projectId: "project-a",
      additionalDirectories: ["/extra"],
    });
  });

  it("create + list + get：新建即 queued，字段与 workspaceKey 规则正确", async () => {
    const created = await repo.create(
      makeParams({
        modelSelection: {
          providerId: "account:zai-offpeak-idle-plan",
          modelId: "GLM-5.2",
          options: { reasoningLevel: "high" },
        },
        workspaceIdentity: " remote-1 ",
      }),
      {
        now: NOW,
        serverTicketId: "ticket-1",
        queuePosition: 3,
        registeredAt: NOW,
      },
    );
    expect(created.status).toBe("queued");
    expect(created.title).toBe("夜间重构");
    expect(created.permissionMode).toBe("default");
    expect(created.modelSelection).toEqual({
      providerId: "account:zai-offpeak-idle-plan",
      modelId: "GLM-5.2",
      options: { reasoningLevel: "high" },
    });
    // workspaceKey = workspaceIdentity?.trim() || workspacePath
    expect(created.workspaceKey).toBe("remote-1");
    expect(created.serverTicketId).toBe("ticket-1");
    expect(created.queuePosition).toBe(3);
    expect(created.registeredAt).toBe(NOW);
    expect(created.queuedAt).toBe(NOW);
    expect(created.schedulable).toBe(false);
    expect(created.conversationId).toBeUndefined();
    expect(created.sessionId).toBeUndefined();

    expect(await repo.list()).toHaveLength(1);
    expect((await repo.get(created.offPeakTaskId))?.offPeakTaskId).toBe(created.offPeakTaskId);
    // Selection options support sparse edits: after a round-trip, removing the reasoning leaf must not write back the default value.
    expect((await repo.get(created.offPeakTaskId))?.modelSelection?.options?.reasoningLevel).toBe(
      "high",
    );
    const edited = await repo.updateEditableFields(
      created.offPeakTaskId,
      {
        modelSelection: {
          providerId: "account:zai-offpeak-idle-plan",
          modelId: "GLM-5.2",
          options: { reasoningLevel: "max" },
        },
      },
      { now: NOW + 5 },
    );
    expect(edited?.modelSelection.options?.reasoningLevel).toBe("max");
    const cleared = await repo.updateEditableFields(
      created.offPeakTaskId,
      { modelSelection: { providerId: "account:zai-offpeak-idle-plan", modelId: "GLM-5.2" } },
      { now: NOW + 6 },
    );
    expect(cleared?.modelSelection.options?.reasoningLevel).toBeUndefined();
    // Mock-first creation without a ticket is allowed too
    const bare = await repo.create(makeParams(), { now: NOW + 1 });
    expect(bare.serverTicketId).toBeUndefined();
  });

  it.each([true, false])("编辑只更新新版选择，保留旧列回滚快照（存量=%s）", async (hasLegacy) => {
    const created = await repo.create(makeParams(), { now: NOW, serverTicketId: "bound-ticket" });
    const db = new DatabaseSync(dbPath);
    try {
      const legacy = {
        model: hasLegacy ? "GLM-5.2" : null,
        thought_level: hasLegacy ? "high" : null,
      };
      db.prepare(
        "UPDATE off_peak_tasks SET model = ?, thought_level = ? WHERE off_peak_task_id = ?",
      ).run(legacy.model, legacy.thought_level, created.offPeakTaskId);
      const readLegacy = () =>
        db
          .prepare("SELECT model, thought_level FROM off_peak_tasks WHERE off_peak_task_id = ?")
          .get(created.offPeakTaskId);

      const titleOnly = await repo.updateEditableFields(created.offPeakTaskId, { title: "新标题" });
      expect(readLegacy()).toEqual(legacy);
      expect(titleOnly).toMatchObject({
        title: "新标题",
        modelSelection: makeParams().modelSelection,
      });

      const selection = {
        providerId: "account:zai-offpeak-idle-plan",
        modelId: "GLM-5.3",
        options: { reasoningLevel: "max" },
      };
      await repo.updateEditableFields(created.offPeakTaskId, { modelSelection: selection });
      // Freezes staging@790884b1ce, where rowToTask reads the old columns; a round-trip through the new codec must not replace the original-value evidence.
      expect(readLegacy()).toEqual(legacy);
      expect(
        await repo.updateEditableFields(created.offPeakTaskId, { modelSelection: null }),
      ).toBeNull();
      repo.close();
      repo = new OffPeakTaskRepo(dbPath);
      expect(await repo.get(created.offPeakTaskId)).toMatchObject({
        title: "新标题",
        modelSelection: selection,
        serverTicketId: "bound-ticket",
        status: "queued",
      });
      expect(readLegacy()).toEqual(legacy);
    } finally {
      db.close();
    }
  });

  it("旧 Selection 损坏时保留任务、隔离调度，且不拖垮其他记录", async () => {
    const legacy = await repo.create(makeParams({ title: "旧任务" }), {
      now: NOW,
      schedulable: true,
    });
    const healthy = await repo.create(
      makeParams({
        title: "正常任务",
        modelSelection: {
          providerId: "account:zai-offpeak-idle-plan",
          modelId: "GLM-5.2",
          options: { reasoningLevel: "max" },
        },
      }),
      { now: NOW + 1, schedulable: true },
    );
    repo.close();
    const db = new DatabaseSync(dbPath);
    db.prepare(
      `UPDATE off_peak_tasks
       SET model = 'GLM-5.2', thought_level = 'high', model_selection = NULL
       WHERE off_peak_task_id = ?`,
    ).run(legacy.offPeakTaskId);
    db.close();

    const listed = await repo.list();
    expect(listed).toHaveLength(2);
    const legacyTask = listed.find((task) => task.offPeakTaskId === legacy.offPeakTaskId);
    expect(legacyTask?.modelSelection).toBeUndefined();
    expect(legacyTask).toMatchObject({
      modelSelectionIssue: {
        code: "repair-required",
      },
    });
    expect((await repo.claimDue(NOW + MINUTE)).map((task) => task.offPeakTaskId)).toEqual([
      healthy.offPeakTaskId,
    ]);
  });

  it("D50 绑定会话：create 写 session_id、conversation_id 仍空；list 联查 tasks 表回填 sessionTitle", async () => {
    const bound = await repo.create(makeParams({ boundSessionId: "sess-bound" }), { now: NOW });
    expect(bound.sessionId).toBe("sess-bound");
    expect(bound.modelSelection).toEqual(makeParams().modelSelection);
    expect(bound.conversationId).toBeUndefined();
    expect(bound.sessionTitle).toBeUndefined();

    // The database-level migration already created an empty tasks table: no error when no bound rows exist.
    expect((await repo.list())[0]?.sessionTitle).toBeUndefined();

    // Once the tasks-index tasks table exists in the same database, list joins the current title by (workspace_key, task_id); the single-row get does not.
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare(
        `INSERT INTO tasks (workspace_key, task_id, title, workspace_path, created_at, updated_at) VALUES (?, ?, ?, '/tmp/ws', 1, 1)`,
      ).run("/tmp/ws", "sess-bound", "重构 utils 的工作会话");
    } finally {
      db.close();
    }
    const listed = await repo.list();
    expect(listed.find((task) => task.offPeakTaskId === bound.offPeakTaskId)?.sessionTitle).toBe(
      "重构 utils 的工作会话",
    );
    expect((await repo.get(bound.offPeakTaskId))?.sessionTitle).toBeUndefined();

    // First-run markRunning: conversation_id is backfilled with the session id, session_id keeps its bound value.
    const running = await repo.markRunning(bound.offPeakTaskId, {
      startedAt: NOW + 1,
      conversationId: "sess-bound",
      sessionId: "sess-bound",
    });
    expect(running?.conversationId).toBe("sess-bound");
    expect(running?.sessionId).toBe("sess-bound");
  });

  it("D50-4 存储层兜底：同工作区同会话第二个未终态绑定任务被唯一索引拒绝，终态后可再建", async () => {
    const first = await repo.create(makeParams({ boundSessionId: "sess-a" }), { now: NOW });
    expect(await repo.hasActiveBoundTask("/tmp/ws", "sess-a")).toBe(true);
    expect(await repo.hasActiveBoundTask("/tmp/ws", "sess-b")).toBe(false);
    expect(await repo.hasActiveBoundTask("/other", "sess-a")).toBe(false);

    let conflict: unknown;
    try {
      await repo.create(makeParams({ boundSessionId: "sess-a" }), { now: NOW + 1 });
    } catch (error) {
      conflict = error;
    }
    expect(isOffPeakBoundSessionConflict(conflict)).toBe(true);
    expect(isOffPeakBoundSessionConflict(new Error("other"))).toBe(false);

    // Unbound tasks (session_id NULL) never conflict with each other.
    await repo.create(makeParams(), { now: NOW + 2 });
    await repo.create(makeParams(), { now: NOW + 3 });

    await repo.markTerminal(first.offPeakTaskId, { status: "cancelled", endedAt: NOW + 4 });
    expect(await repo.hasActiveBoundTask("/tmp/ws", "sess-a")).toBe(false);
    const again = await repo.create(makeParams({ boundSessionId: "sess-a" }), { now: NOW + 5 });
    expect(again.sessionId).toBe("sess-a");
  });

  it("claimDue：只认领 queued 且 schedulable=1；FIFO 按 queued_at；single-flight", async () => {
    const a = await repo.create(makeParams({ title: "A" }), { now: NOW });
    const b = await repo.create(makeParams({ title: "B" }), { now: NOW + 1 });
    const c = await repo.create(makeParams({ title: "C" }), { now: NOW + 2 });

    // With schedulable=0 nothing is claimed (coarse valve off, §7.6)
    expect(await repo.claimDue(NOW + MINUTE)).toHaveLength(0);

    await repo.updateSchedulingSnapshot(b.offPeakTaskId, { schedulable: true });
    await repo.updateSchedulingSnapshot(a.offPeakTaskId, { schedulable: true });
    await repo.updateSchedulingSnapshot(c.offPeakTaskId, { schedulable: true });
    // paused tasks are not claimed
    await repo.setPaused(c.offPeakTaskId, true);

    const claimed = await repo.claimDue(NOW + MINUTE);
    expect(claimed.map((t) => t.title)).toEqual(["A", "B"]); // FIFO by queued_at
    // Already claimed in-flight; a second claim returns nothing (single-flight)
    expect(await repo.claimDue(NOW + MINUTE + 1)).toHaveLength(0);
  });

  it("claimDue：认领超时（持有者崩溃）后被回收并可重新认领", async () => {
    const a = await repo.create(makeParams(), { now: NOW });
    await repo.updateSchedulingSnapshot(a.offPeakTaskId, { schedulable: true });
    await repo.claimDue(NOW);
    expect(await repo.claimDue(NOW + OFF_PEAK_CLAIM_STALE_MS - 1)).toHaveLength(0);
    const reclaimed = await repo.claimDue(NOW + OFF_PEAK_CLAIM_STALE_MS + 1);
    expect(reclaimed.map((t) => t.offPeakTaskId)).toEqual([a.offPeakTaskId]);
  });

  it("markRunning：queued→running 回填 conversation/session/ticket 并释放认领；续跑保留首段 started_at", async () => {
    const a = await repo.create(makeParams(), { now: NOW });
    await repo.updateSchedulingSnapshot(a.offPeakTaskId, { schedulable: true });
    await repo.claimDue(NOW);

    const running = await repo.markRunning(a.offPeakTaskId, {
      startedAt: NOW + MINUTE,
      conversationId: "conv-1",
      sessionId: "sess-1",
      serverTicketId: "ticket-1",
    });
    expect(running?.status).toBe("running");
    expect(running?.startedAt).toBe(NOW + MINUTE);
    expect(running?.conversationId).toBe("conv-1");
    expect(running?.sessionId).toBe("sess-1");
    expect(running?.serverTicketId).toBe("ticket-1");
    // Claim already released: the running status itself blocks duplicate claims
    expect(await repo.claimDue(NOW + 2 * MINUTE)).toHaveLength(0);

    // 3h expiry auto-resume (D26): running→queued→markRunning again; session reused, started_at keeps the first segment
    const backToQueue = await repo.recoverInterrupted(NOW + 10 * MINUTE);
    expect(backToQueue).toBe(1);
    await repo.updateSchedulingSnapshot(a.offPeakTaskId, {
      schedulable: true,
      serverTicketId: "ticket-2",
    });
    await repo.claimDue(NOW + 11 * MINUTE);
    const resumed = await repo.markRunning(a.offPeakTaskId, {
      startedAt: NOW + 12 * MINUTE,
    });
    expect(resumed?.startedAt).toBe(NOW + MINUTE); // keeps the first segment
    expect(resumed?.sessionId).toBe("sess-1"); // session is not lost
    expect(resumed?.serverTicketId).toBe("ticket-2"); // new segment, new ticket
  });

  it("markRunning 守卫：paused/终态不可入 running（迟到派发结果作废）", async () => {
    const a = await repo.create(makeParams(), { now: NOW });
    await repo.setPaused(a.offPeakTaskId, true);
    expect(await repo.markRunning(a.offPeakTaskId, { startedAt: NOW })).toBeNull();

    await repo.setPaused(a.offPeakTaskId, false);
    await repo.markTerminal(a.offPeakTaskId, {
      status: "cancelled",
      endedAt: NOW,
    });
    expect(await repo.markRunning(a.offPeakTaskId, { startedAt: NOW })).toBeNull();
    expect((await repo.get(a.offPeakTaskId))?.status).toBe("cancelled");
  });

  it("markTerminal：终态不可逆出；迟到二次迁移被拒绝", async () => {
    const a = await repo.create(makeParams(), { now: NOW });
    const done = await repo.markTerminal(a.offPeakTaskId, {
      status: "completed",
      endedAt: NOW + MINUTE,
      filesChanged: 5,
    });
    expect(done?.status).toBe("completed");
    expect(done?.endedAt).toBe(NOW + MINUTE);
    expect(done?.filesChanged).toBe(5);
    expect(done?.schedulable).toBe(false);

    // Terminal states cannot transition into each other (late OffPeakRunResult fallback: return null and drop)
    expect(
      await repo.markTerminal(a.offPeakTaskId, {
        status: "failed",
        endedAt: NOW + 2 * MINUTE,
      }),
    ).toBeNull();
    expect((await repo.get(a.offPeakTaskId))?.status).toBe("completed");
    // Terminal states are no longer claimed
    await repo.updateSchedulingSnapshot(a.offPeakTaskId, { schedulable: true });
    expect(await repo.claimDue(NOW + 3 * MINUTE)).toHaveLength(0);
  });

  it("markTerminal：permanent 派发错误原子记录失败原因与尝试次数", async () => {
    const task = await repo.create(makeParams(), { now: NOW });
    await repo.updateSchedulingSnapshot(task.offPeakTaskId, { schedulable: true });
    await repo.claimDue(NOW);

    const failed = await repo.markTerminal(task.offPeakTaskId, {
      status: "failed",
      endedAt: NOW + 1,
      failureReason: "workspace model unavailable",
      dispatchError: "workspace model unavailable",
    });

    expect(failed).toMatchObject({
      status: "failed",
      failureReason: "workspace model unavailable",
      schedulable: false,
    });
    expect(await repo.claimDue(NOW + 2)).toHaveLength(0);
  });

  it("初始化时把历史 awaiting_approval 行迁移为 running", async () => {
    const a = await repo.create(makeParams(), { now: NOW });
    await repo.updateSchedulingSnapshot(a.offPeakTaskId, { schedulable: true });
    await repo.claimDue(NOW);
    await repo.markRunning(a.offPeakTaskId, { startedAt: NOW });
    repo.close();

    const db = new DatabaseSync(dbPath);
    db.prepare(
      `UPDATE off_peak_tasks SET status = 'awaiting_approval' WHERE off_peak_task_id = ?`,
    ).run(a.offPeakTaskId);
    db.close();

    repo = new OffPeakTaskRepo(dbPath);
    expect((await repo.get(a.offPeakTaskId))?.status).toBe("running");
  });

  it("setPaused：queued ⇄ paused；认领在途与非 queued 状态不可 Pause", async () => {
    const a = await repo.create(makeParams(), { now: NOW });
    const paused = await repo.setPaused(a.offPeakTaskId, true);
    expect(paused?.status).toBe("paused");
    // A repeated Pause on a paused task is a no-op
    expect(await repo.setPaused(a.offPeakTaskId, true)).toBeNull();
    const continued = await repo.setPaused(a.offPeakTaskId, false);
    expect(continued?.status).toBe("queued");

    // In-flight claims cannot be paused (dispatch window race)
    await repo.updateSchedulingSnapshot(a.offPeakTaskId, { schedulable: true });
    await repo.claimDue(NOW);
    expect(await repo.setPaused(a.offPeakTaskId, true)).toBeNull();

    // running cannot be paused (running only supports cancel)
    await repo.markRunning(a.offPeakTaskId, { startedAt: NOW });
    expect(await repo.setPaused(a.offPeakTaskId, true)).toBeNull();
  });

  it("releaseClaim：派发失败释放锁、累计 attempt_count；任务留在 queued 可再认领（无 skip，D21）", async () => {
    const a = await repo.create(makeParams(), { now: NOW });
    await repo.updateSchedulingSnapshot(a.offPeakTaskId, { schedulable: true });
    await repo.claimDue(NOW);
    await repo.releaseClaim(a.offPeakTaskId, {
      error: "no host available",
      now: NOW + 1,
    });

    const got = await repo.get(a.offPeakTaskId);
    expect(got?.status).toBe("queued");
    // Immediately claimable again (backoff policy lives in the scheduler layer; the repo has no time gate)
    const reclaimed = await repo.claimDue(NOW + 2);
    expect(reclaimed).toHaveLength(1);
  });

  it("recoverInterrupted：running 置回 queued，保留 session 供 resume；清理超时认领", async () => {
    const running = await repo.create(makeParams({ title: "R" }), { now: NOW });
    await repo.updateSchedulingSnapshot(running.offPeakTaskId, {
      schedulable: true,
    });
    await repo.claimDue(NOW);
    await repo.markRunning(running.offPeakTaskId, {
      startedAt: NOW,
      sessionId: "sess-r",
      conversationId: "conv-r",
    });

    const untouched = await repo.create(makeParams({ title: "Q" }), {
      now: NOW + 2,
    });
    const done = await repo.create(makeParams({ title: "D" }), {
      now: NOW + 3,
    });
    await repo.markTerminal(done.offPeakTaskId, {
      status: "completed",
      endedAt: NOW + 3,
    });

    const recovered = await repo.recoverInterrupted(NOW + 10 * MINUTE);
    expect(recovered).toBe(1);

    const r = await repo.get(running.offPeakTaskId);
    expect(r?.status).toBe("queued");
    expect(r?.queuedAt).toBe(NOW); // keeps the original queue position
    expect(r?.sessionId).toBe("sess-r"); // resume depends on it
    expect((await repo.get(untouched.offPeakTaskId))?.status).toBe("queued");
    expect((await repo.get(done.offPeakTaskId))?.status).toBe("completed");
  });

  it("markSettled + listUnsettledTerminal：终态核销 outbox（D22）", async () => {
    const a = await repo.create(makeParams({ title: "A" }), { now: NOW });
    const b = await repo.create(makeParams({ title: "B" }), { now: NOW + 1 });
    // Non-terminal states cannot be settled
    await repo.markSettled(a.offPeakTaskId, NOW + 1);
    expect((await repo.get(a.offPeakTaskId))?.settledAt).toBeUndefined();

    await repo.markTerminal(a.offPeakTaskId, {
      status: "completed",
      endedAt: NOW + MINUTE,
    });
    await repo.markTerminal(b.offPeakTaskId, {
      status: "failed",
      endedAt: NOW + 2 * MINUTE,
    });

    expect((await repo.listUnsettledTerminal()).map((t) => t.title)).toEqual(["A", "B"]);

    await repo.markSettled(a.offPeakTaskId, NOW + 3 * MINUTE);
    expect((await repo.get(a.offPeakTaskId))?.settledAt).toBe(NOW + 3 * MINUTE);
    expect((await repo.listUnsettledTerminal()).map((t) => t.title)).toEqual(["B"]);
  });

  it("markHistoryDeleted：只隐藏已启动任务的 History，且重复调用幂等（D37）", async () => {
    const queued = await repo.create(makeParams({ title: "Q" }), { now: NOW });
    const queuedResult = await repo.markHistoryDeleted(queued.offPeakTaskId, {
      now: NOW + 1,
    });
    expect(queuedResult?.historyDeletedAt).toBeUndefined();

    const running = await repo.create(makeParams({ title: "R" }), {
      now: NOW + 2,
    });
    await repo.updateSchedulingSnapshot(running.offPeakTaskId, {
      schedulable: true,
    });
    await repo.claimDue(NOW + 2);
    await repo.markRunning(running.offPeakTaskId, {
      startedAt: NOW + 2,
      conversationId: "conv-r",
      sessionId: "sess-r",
    });
    await repo.markTerminal(running.offPeakTaskId, {
      status: "completed",
      endedAt: NOW + MINUTE,
      filesChanged: 4,
    });

    const deleted = await repo.markHistoryDeleted(running.offPeakTaskId, {
      now: NOW + 2 * MINUTE,
    });
    expect(deleted?.historyDeletedAt).toBe(NOW + 2 * MINUTE);
    expect(deleted).toMatchObject({
      status: "completed",
      conversationId: "conv-r",
      sessionId: "sess-r",
      startedAt: NOW + 2,
      endedAt: NOW + MINUTE,
      filesChanged: 4,
    });

    const repeated = await repo.markHistoryDeleted(running.offPeakTaskId, {
      now: NOW + 3 * MINUTE,
    });
    expect(repeated?.historyDeletedAt).toBe(NOW + 2 * MINUTE);
  });

  it("countNonTerminal：终态与已删除不计入（创建上限本地预判）", async () => {
    const a = await repo.create(makeParams(), { now: NOW });
    const b = await repo.create(makeParams(), { now: NOW + 1 });
    await repo.setPaused(b.offPeakTaskId, true); // paused counts (the D30-2 quota includes Paused)
    const c = await repo.create(makeParams(), { now: NOW + 2 });
    expect(await repo.countNonTerminal()).toBe(3);

    await repo.markTerminal(a.offPeakTaskId, {
      status: "cancelled",
      endedAt: NOW + 3,
    });
    expect(await repo.countNonTerminal()).toBe(2);
    await repo.delete(c.offPeakTaskId);
    expect(await repo.countNonTerminal()).toBe(1);
    expect(await repo.get(c.offPeakTaskId)).toBeNull();
  });

  it("requeueForContinuation：3102 续跑回队保留 session；paused/终态拒绝", async () => {
    const a = await repo.create(makeParams(), {
      now: NOW,
      offPeakTaskId: "offpeak-fixed-id",
    });
    expect(a.offPeakTaskId).toBe("offpeak-fixed-id"); // externally specified primary key (ticket first, persisted second)
    await repo.updateSchedulingSnapshot(a.offPeakTaskId, {
      schedulable: true,
      queuePosition: 1,
    });
    await repo.claimDue(NOW);
    await repo.markRunning(a.offPeakTaskId, {
      startedAt: NOW,
      conversationId: "conv-1",
      sessionId: "sess-1",
      serverTicketId: "ticket-1",
    });

    const requeued = await repo.requeueForContinuation(a.offPeakTaskId, {
      now: NOW + 1,
    });
    expect(requeued?.status).toBe("queued");
    expect(requeued?.sessionId).toBe("sess-1"); // resume depends on it
    expect(requeued?.conversationId).toBe("conv-1");
    expect(requeued?.startedAt).toBe(NOW); // keeps the first segment's start time
    expect(requeued?.schedulable).toBe(false); // refreshed by polling after the next ticket is taken
    expect(requeued?.queuePosition).toBeUndefined();

    // paused tasks cannot be requeued
    await repo.setPaused(a.offPeakTaskId, true);
    expect(await repo.requeueForContinuation(a.offPeakTaskId)).toBeNull();
    await repo.setPaused(a.offPeakTaskId, false);
    // Terminal states cannot be requeued
    await repo.markTerminal(a.offPeakTaskId, {
      status: "cancelled",
      endedAt: NOW + 2,
    });
    expect(await repo.requeueForContinuation(a.offPeakTaskId)).toBeNull();
  });

  it("listNonTerminal + create schedulable：取号即 ready 随建随派", async () => {
    const ready = await repo.create(makeParams({ title: "R" }), {
      now: NOW,
      serverTicketId: "t-1",
      schedulable: true,
    });
    const waiting = await repo.create(makeParams({ title: "W" }), {
      now: NOW + 1,
    });
    const done = await repo.create(makeParams({ title: "D" }), {
      now: NOW + 2,
    });
    await repo.markTerminal(done.offPeakTaskId, {
      status: "completed",
      endedAt: NOW + 3,
    });

    expect((await repo.listNonTerminal()).map((t) => t.title)).toEqual(["R", "W"]);
    // Tasks that are ready at ticket time can be claimed without waiting for the poller
    const claimed = await repo.claimDue(NOW + 4);
    expect(claimed.map((t) => t.offPeakTaskId)).toEqual([ready.offPeakTaskId]);
    expect(waiting.schedulable).toBe(false);
  });

  it("updateSchedulingSnapshot：只覆盖显式字段；重新取号更新 server_ticket_id", async () => {
    const a = await repo.create(makeParams(), {
      now: NOW,
      serverTicketId: "ticket-1",
      queuePosition: 5,
    });
    await repo.updateSchedulingSnapshot(a.offPeakTaskId, {
      queuePosition: 2,
      nextPollAt: NOW + MINUTE,
    });
    let got = await repo.get(a.offPeakTaskId);
    expect(got?.serverTicketId).toBe("ticket-1"); // fields not passed stay untouched
    expect(got?.queuePosition).toBe(2);
    expect(got?.nextPollAt).toBe(NOW + MINUTE);

    // Expired ticket gets a new one (D26: same task_id, new ticket)
    await repo.updateSchedulingSnapshot(a.offPeakTaskId, {
      serverTicketId: "ticket-2",
      registeredAt: NOW + 2 * MINUTE,
      schedulable: false,
      queuePosition: null,
    });
    got = await repo.get(a.offPeakTaskId);
    expect(got?.serverTicketId).toBe("ticket-2");
    expect(got?.registeredAt).toBe(NOW + 2 * MINUTE);
    expect(got?.queuePosition).toBeUndefined();
  });
});
