// D48 first-class row marker: repository contract for offPeakTaskId as a persisted task meta field (MR1, no UI behavior change).
// Mirrors the three invariants of cronAutomationId: meta_json is the source of truth + the index column as fallback,
// preserving the existing value when a runtime snapshot lacks the marker, and bootstrap idempotently backfilling existing off-peak sessions.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { setDataBaseDir } from "#src/paths.js";
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";
import { OffPeakTaskRepo } from "#src/session/offPeakTaskRepo.js";

let repo: TaskIndexRepo;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "zcode-task-index-off-peak-marker-"));
  setDataBaseDir(tempDir);
  repo = new TaskIndexRepo();
});

afterEach(async () => {
  repo.close();
  setDataBaseDir(null);
  if (process.platform === "win32") {
    // Windows needs to wait for SQLite to release the file handle to avoid EPERM during temp dir cleanup.
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  rmSync(tempDir, { recursive: true, force: true });
});

function task(params: { taskId: string; offPeakTaskId?: string }): ZCodeTaskMeta {
  return {
    taskId: params.taskId,
    traceId: `trace-${params.taskId}`,
    title: params.taskId,
    workspacePath: "/workspace/project",
    createdAt: 10,
    updatedAt: 20,
    mode: "default",
    status: "running",
    ...(params.offPeakTaskId ? { offPeakTaskId: params.offPeakTaskId } : {}),
  };
}

function getRepoDatabase(target: TaskIndexRepo): {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
  };
} {
  return (
    target as unknown as {
      getDatabase(): {
        prepare(sql: string): {
          run(...params: unknown[]): unknown;
          get(...params: unknown[]): unknown;
        };
      };
    }
  ).getDatabase();
}

describe("TaskIndexRepo off-peak marker (D48)", () => {
  it("syncTaskMeta 持久化 offPeakTaskId 并投影到索引列", async () => {
    await repo.syncTaskMeta({ meta: task({ taskId: "s-1", offPeakTaskId: "offpeak-1" }) });

    const meta = await repo.getTaskMeta({
      workspacePath: "/workspace/project",
      taskId: "s-1",
    });
    expect(meta?.offPeakTaskId).toBe("offpeak-1");

    const row = getRepoDatabase(repo)
      .prepare(`SELECT off_peak_task_id FROM tasks WHERE task_id = ?`)
      .get("s-1") as { off_peak_task_id: string | null };
    expect(row.off_peak_task_id).toBe("offpeak-1");
  });

  it("运行态快照不带标记时保全已有 offPeakTaskId", async () => {
    await repo.syncTaskMeta({ meta: task({ taskId: "s-2", offPeakTaskId: "offpeak-2" }) });
    // The runtime protocol snapshot's meta carries no off-peak marker; the sync must not wipe out the ownership.
    await repo.syncTaskMeta({ meta: task({ taskId: "s-2" }) });

    const meta = await repo.getTaskMeta({
      workspacePath: "/workspace/project",
      taskId: "s-2",
    });
    expect(meta?.offPeakTaskId).toBe("offpeak-2");
  });

  it("meta_json 缺字段时以索引列兜底（backfill 只写列即可生效）", async () => {
    await repo.syncTaskMeta({ meta: task({ taskId: "s-3" }) });
    getRepoDatabase(repo)
      .prepare(`UPDATE tasks SET off_peak_task_id = ? WHERE task_id = ?`)
      .run("offpeak-3", "s-3");

    const meta = await repo.getTaskMeta({
      workspacePath: "/workspace/project",
      taskId: "s-3",
    });
    expect(meta?.offPeakTaskId).toBe("offpeak-3");
  });

  it("bootstrap 幂等回填存量 off-peak 会话的标记", async () => {
    // Legacy shape: off_peak_tasks is already bound to the session, but the tasks row predates the marker and has none.
    // Do one repo operation first to trigger lazy initialization so getRepoDatabase can get a handle.
    await repo.syncTaskMeta({ meta: task({ taskId: "s-legacy" }) });
    const offPeakRepo = new OffPeakTaskRepo();
    await offPeakRepo.create(
      {
        title: "legacy",
        prompt: "legacy",
        permissionMode: "build",
        workspacePath: "/workspace/project",
        modelSelection: { providerId: "account:zai-offpeak-idle-plan", modelId: "GLM-5.2" },
      },
      { offPeakTaskId: "offpeak-legacy" },
    );
    getRepoDatabase(repo)
      .prepare(`UPDATE off_peak_tasks SET session_id = ? WHERE off_peak_task_id = ?`)
      .run("s-legacy", "offpeak-legacy");
    getRepoDatabase(repo)
      .prepare(`UPDATE tasks SET off_peak_task_id = NULL WHERE task_id = ?`)
      .run("s-legacy");
    repo.close();

    // Re-run bootstrap (equivalent to the first start after an upgrade): the backfill must hit and be repeatable.
    repo = new TaskIndexRepo();
    const meta = await repo.getTaskMeta({
      workspacePath: "/workspace/project",
      taskId: "s-legacy",
    });
    expect(meta?.offPeakTaskId).toBe("offpeak-legacy");

    offPeakRepo.close();
  });

  it("回填不覆盖已有标记且对无关任务无副作用", async () => {
    // Tasks with an existing explicit marker (different value) and plain tasks must not be rewritten by the backfill.
    await repo.syncTaskMeta({ meta: task({ taskId: "s-4", offPeakTaskId: "offpeak-explicit" }) });
    await repo.syncTaskMeta({ meta: task({ taskId: "s-plain" }) });
    const offPeakRepo = new OffPeakTaskRepo();
    await offPeakRepo.create(
      {
        title: "other",
        prompt: "other",
        permissionMode: "build",
        workspacePath: "/workspace/project",
        modelSelection: { providerId: "account:zai-offpeak-idle-plan", modelId: "GLM-5.2" },
      },
      { offPeakTaskId: "offpeak-other" },
    );
    getRepoDatabase(repo)
      .prepare(`UPDATE off_peak_tasks SET session_id = ? WHERE off_peak_task_id = ?`)
      .run("s-4", "offpeak-other");
    repo.close();

    repo = new TaskIndexRepo();
    const explicit = await repo.getTaskMeta({
      workspacePath: "/workspace/project",
      taskId: "s-4",
    });
    expect(explicit?.offPeakTaskId).toBe("offpeak-explicit");
    const plain = await repo.getTaskMeta({
      workspacePath: "/workspace/project",
      taskId: "s-plain",
    });
    expect(plain?.offPeakTaskId).toBeUndefined();

    offPeakRepo.close();
  });
});

// D48-A: put a task into the off-peak system group when it first gains the marker (mirroring ensureCronGroupMembership),
// plus bootstrap completing membership for existing rows backfilled by the MR1 column.
describe("TaskIndexRepo off-peak group membership (D48-A)", () => {
  const OFF_PEAK_GROUP_ID = "zcode-default-group-off-peak";

  function membershipRow(taskId: string): { group_id: string } | undefined {
    return getRepoDatabase(repo)
      .prepare(`SELECT group_id FROM task_group_members WHERE task_id = ?`)
      .get(taskId) as { group_id: string } | undefined;
  }

  it("首次获得标记时写入分组行、顶层排序与成员关系", async () => {
    await repo.syncTaskMeta({ meta: task({ taskId: "m-1", offPeakTaskId: "offpeak-m1" }) });

    const group = getRepoDatabase(repo)
      .prepare(`SELECT group_id, title, color FROM task_groups WHERE group_id = ?`)
      .get(OFF_PEAK_GROUP_ID) as { title: string; color: string } | undefined;
    expect(group?.title).toBe("off-peak");
    expect(group?.color).toBe("purple");
    expect(membershipRow("m-1")?.group_id).toBe(OFF_PEAK_GROUP_ID);
    const order = getRepoDatabase(repo)
      .prepare(
        `SELECT node_key FROM task_group_view_node_orders WHERE node_type = 'group' AND node_key = ?`,
      )
      .get(OFF_PEAK_GROUP_ID);
    expect(order).toBeTruthy();
  });

  it("用户已手动分组的任务不被拖回闲时组", async () => {
    await repo.syncTaskMeta({ meta: task({ taskId: "m-2" }) });
    getRepoDatabase(repo)
      .prepare(
        `INSERT INTO task_groups (group_id, title, color, created_at, updated_at)
         VALUES ('custom-group', 'Custom', 'green', 1, 1)`,
      )
      .run();
    getRepoDatabase(repo)
      .prepare(
        `INSERT INTO task_group_members (
          group_id, workspace_key, workspace_path, workspace_identity, task_id,
          sort_order, added_at, created_at, updated_at
        ) VALUES ('custom-group', '/workspace/project', '/workspace/project', NULL, 'm-2', NULL, 1, 1, 1)`,
      )
      .run();
    // First time gaining the marker: OR IGNORE must not override the membership the user arranged manually.
    await repo.syncTaskMeta({ meta: task({ taskId: "m-2", offPeakTaskId: "offpeak-m2" }) });

    expect(membershipRow("m-2")?.group_id).toBe("custom-group");
  });

  it("bootstrap 为 MR1 列回填的存量标记行补成员关系", async () => {
    // Legacy shape: the marker exists only in the projected column (MR1 backfill); meta_json has no field and membership was never written.
    await repo.syncTaskMeta({ meta: task({ taskId: "m-3" }) });
    getRepoDatabase(repo)
      .prepare(`UPDATE tasks SET off_peak_task_id = ? WHERE task_id = ?`)
      .run("offpeak-m3", "m-3");
    expect(membershipRow("m-3")).toBeUndefined();
    repo.close();

    repo = new TaskIndexRepo();
    await repo.getTaskMeta({ workspacePath: "/workspace/project", taskId: "m-3" });
    expect(membershipRow("m-3")?.group_id).toBe(OFF_PEAK_GROUP_ID);
  });

  it("远程 workspace 存量行不回填成员关系（暂不支持远程闲时任务）", async () => {
    // CR-01 scenario: the legacy remote row's workspace_key is already a remote identity, but the workspace_identity
    // column is missing. If the backfill did not skip it, recomputing a local key from workspacePath would cross-write membership.
    const remoteKey = "remote:ssh:10.0.0.8:2222:dev:/workspace/project";
    await repo.syncTaskMeta({ meta: task({ taskId: "m-remote" }) });
    getRepoDatabase(repo)
      .prepare(
        `UPDATE tasks SET workspace_key = ?, workspace_identity = NULL, off_peak_task_id = ?
         WHERE task_id = ?`,
      )
      .run(remoteKey, "offpeak-remote", "m-remote");
    repo.close();

    repo = new TaskIndexRepo();
    // Trigger lazy initialization so the bootstrap backfill finishes; assert there is no remote-key membership and no cross-written local-key membership.
    await repo.getTaskMeta({ workspacePath: "/workspace/project", taskId: "m-remote" });
    expect(membershipRow("m-remote")).toBeUndefined();
  });

  it("远程 workspace 会话首次获得标记也不归组（暂不支持远程闲时任务）", async () => {
    await repo.syncTaskMeta({
      meta: {
        ...task({ taskId: "m-remote-sync", offPeakTaskId: "offpeak-remote-sync" }),
        workspaceIdentity: "remote:ssh:10.0.0.8:2222:dev:/workspace/project",
      },
    });

    expect(membershipRow("m-remote-sync")).toBeUndefined();
  });
});
