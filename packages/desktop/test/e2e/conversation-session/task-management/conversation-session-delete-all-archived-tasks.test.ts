import { access, mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TID_TASK_DELETE_CONFIRM, TID_TASK_DELETE_DIALOG } from "@zcode/shared/test-ids";
import { DEFAULT_WORKSPACE, clearAppData, waitForWorkspaceApp } from "#e2e/helpers/desktop-app";
import { restartIntoWorkspacePreservingProfile } from "#e2e/helpers/model-provider-restart-runtime";

const home = process.env.ZCODE_E2E_HOME_DIR!;
const prefix = "e2e-bulk-archive-";
const control = `${prefix}active`;
// prefix0 的附件被保留的普通任务引用。
const sharedOwner = `${prefix}0`;
const artifactDir = join(home, ".zcode/cli/artifacts", sharedOwner);

describe("TSL39：一键删除全部归档任务", () => {
  after(async () => {
    await clearAppData();
  });
  it("取消不写入，确认删除折叠组的全部 25 条并保留被引用附件与普通任务", async function () {
    this.timeout(240000);
    // 修复原因：直接运行 wdio 时默认 HOME 是 `.e2e-home`（无 runId 后缀），旧守卫只认
    // `.e2e-home-*`，在 CI/本地单跑时误报；两种隔离目录名都只存在于 E2E runner。
    if (!home || !/^\.e2e-home(?:-|$)/u.test(basename(home)))
      throw new Error("isolated E2E HOME required");
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 45000);
    // 旧夹具依赖已移除的 runner 开关，且只有 Host 摘要，无法验证当前 CLI 删除命令。
    // 在进程退出后准备两库完整历史，冷启读取；执行阶段只经真实 UI 发送删除。
    await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE, {
      afterElectronProcessExit: async () => {
        const db = new DatabaseSync(join(home, ".zcode/v2/tasks-index.sqlite"));
        const cli = new DatabaseSync(join(home, ".zcode/cli/db/db.sqlite"));
        try {
          const existing = db
            .prepare("SELECT project_id FROM project_roots WHERE root_path=? LIMIT 1")
            .get(DEFAULT_WORKSPACE) as { project_id: string } | undefined;
          // A fresh profile (the Linux container) has no project row for the default workspace yet.
          const project = existing ?? { project_id: "e2e-bulk-project" };
          if (!existing) {
            db.prepare(
              "INSERT INTO projects(project_id,host_id,name,position,deleted,created_at,updated_at) VALUES(?,'local','E2E bulk',0,0,1,1)",
            ).run(project.project_id);
            db.prepare(
              "INSERT INTO project_roots(project_id,root_path,position,is_primary) VALUES(?,?,0,1)",
            ).run(project.project_id, DEFAULT_WORKSPACE);
          }
          const now = Date.now();
          for (let i = 0; i < 26; i++) {
            const id = i === 25 ? control : `${prefix}${i}`;
            const title = `E2E_BULK_ARCHIVE_${i}`,
              archived = i === 25 ? 0 : 1;
            cli
              .prepare(
                "INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated,title_source,last_outcome) VALUES(?,?,?,?,?,'1',?,?,'custom','completed')",
              )
              .run(id, "e2e-bulk-cli-scope", id, DEFAULT_WORKSPACE, title, now, now);
            db.prepare(
              "INSERT INTO tasks(workspace_key,workspace_path,task_id,title,provider,created_at,updated_at,host_id,root_path,project_id,archived,cli_title,cli_title_source,cli_created_at,cli_updated_at,cli_last_outcome,cli_deleted,meta_json) VALUES(?,?,?,?,'glm',?,?,'local',?,?,?,?, 'custom',?,?,'completed',0,?)",
            ).run(
              DEFAULT_WORKSPACE,
              DEFAULT_WORKSPACE,
              id,
              title,
              now,
              now,
              DEFAULT_WORKSPACE,
              project.project_id,
              archived,
              title,
              now,
              now,
              JSON.stringify({
                taskId: id,
                traceId: id,
                title,
                workspacePath: DEFAULT_WORKSPACE,
                createdAt: now,
                updatedAt: now,
                mode: "build",
                // Real task meta always carries provider; the fork erase lists tombstones by provider.
                provider: "glm",
                archived: Boolean(archived),
              }),
            );
          }
          // 普通任务引用 prefix0 的附件：预检须列出保留附件，删除后文件仍在。
          cli
            .prepare(
              "INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES('e2e-bulk-ref-msg',?,1,1,?)",
            )
            .run(control, JSON.stringify({ role: "user" }));
          cli
            .prepare(
              "INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES('e2e-bulk-ref-part','e2e-bulk-ref-msg',?,1,1,?)",
            )
            .run(
              control,
              JSON.stringify({ type: "file", url: `zcode-artifact://${sharedOwner}/shared` }),
            );
          await mkdir(artifactDir, { recursive: true });
          await writeFile(join(artifactDir, "shared.png"), "E2E_BULK_SHARED_ATTACHMENT");
          await writeFile(join(artifactDir, "private.txt"), "E2E_BULK_PRIVATE_ATTACHMENT");
        } finally {
          db.close();
          cli.close();
        }
      },
    });
    await browser.execute(() => {
      (
        window as typeof window & { __testActions: { setLocale(value: string): void } }
      ).__testActions.setLocale("zh-CN");
    });
    expect(readCounts()).toEqual({
      archived: 25,
      deleted: 0,
      active: 1,
      cliRows: 26,
      cliDeleted: 0,
    });
    const removedVisitKey = `zcode-browser-recent-visits:${JSON.stringify([DEFAULT_WORKSPACE, "", `${prefix}0`])}`;
    const retainedVisitKey = `zcode-browser-recent-visits:${JSON.stringify([DEFAULT_WORKSPACE, "", control])}`;
    await browser.execute(
      (keys) => {
        const visit = JSON.stringify([
          {
            url: "https://example.test/browser-history",
            title: "Browser history",
            faviconUrl: null,
            lastVisitedAt: Date.now(),
          },
        ]);
        localStorage.setItem(keys.removed, visit);
        localStorage.setItem(keys.retained, visit);
      },
      { removed: removedVisitKey, retained: retainedVisitKey },
    );
    await $('[data-testid="task-settings-button"]').click();
    await $('[data-testid="settings-section-nav-archives"]').click();
    await $('[data-testid="archive-management"]').waitForDisplayed();
    // 分组收起没有行 DOM；批量目标必须来自完整权威集合，不能只删除已渲染行。
    expect(await $$('[data-testid="archive-task"]').length).toBe(0);
    // wdio also seeds the 25 archived row-authority tasks for this spec, so "delete all" covers every
    // archived row in the index, not only this spec's 25.
    const archivedTotal = countAllArchived();
    expect(archivedTotal).toBeGreaterThanOrEqual(25);
    const removeAll = $('[data-testid="archive-delete-all"]');
    await removeAll.click();
    // The fork keeps its own permanent-delete dialog (specs/session-deletion-cascade.md), not upstream's preflight confirm.
    const confirmation = $(`[data-testid="${TID_TASK_DELETE_DIALOG}"]`);
    await expect(confirmation).toHaveText(
      expect.stringContaining(`删除 ${archivedTotal} 个会话？`),
    );
    await browser.keys("Escape");
    await confirmation.waitForExist({ reverse: true });
    const historyAfterCancel = await browser.execute(
      (key) => localStorage.getItem(key),
      removedVisitKey,
    );
    expect(historyAfterCancel).not.toBeNull();
    expect(readCounts()).toEqual({
      archived: 25,
      deleted: 0,
      active: 1,
      cliRows: 26,
      cliDeleted: 0,
    });
    await removeAll.click();
    await expect(confirmation).toHaveText(
      expect.stringContaining(`删除 ${archivedTotal} 个会话？`),
    );
    const confirmButton = $(`[data-testid="${TID_TASK_DELETE_CONFIRM}"]`);
    await expect(confirmButton).toHaveText(`删除 ${archivedTotal} 个会话`);
    await expect(confirmButton).toBeEnabled({ wait: 60000 });
    await browser.saveScreenshot(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "delete-all-archived-tasks-confirm.png"),
    );
    await confirmButton.click();
    // 永久删除走存储控制面，无需冷恢复 25 个 Agent runtime。
    await browser.waitUntil(() => readCounts().cliRows === 1, { timeout: 120000 });
    // The fork keeps scrubbed tombstone rows in the task index and erases the CLI rows.
    expect(readCounts()).toEqual({
      archived: 0,
      deleted: 25,
      active: 1,
      cliRows: 1,
      cliDeleted: 0,
    });
    // 被保留会话引用的附件留下，同一会话的独占附件删除。
    await access(join(artifactDir, "shared.png"));
    await expect(access(join(artifactDir, "private.txt"))).rejects.toThrow();
    await expect(removeAll).toBeDisabled();
    const visitsAfterDelete = await browser.execute(
      (keys) => ({
        removed: localStorage.getItem(keys.removed),
        retained: localStorage.getItem(keys.retained),
      }),
      { removed: removedVisitKey, retained: retainedVisitKey },
    );
    expect(visitsAfterDelete.removed).toBeNull();
    expect(visitsAfterDelete.retained).not.toBeNull();
    expect(await $$('[data-testid="archive-group"]').length).toBe(0);
    await browser.saveScreenshot(
      join(process.env.ZCODE_E2E_ARTIFACT_DIR!, "delete-all-archived-tasks.png"),
    );
  });
});

function countAllArchived() {
  const db = new DatabaseSync(join(home, ".zcode/v2/tasks-index.sqlite"), { readOnly: true });
  try {
    return (
      db
        .prepare("SELECT count(*) AS n FROM tasks WHERE archived=1 AND deleted=0 AND cli_deleted=0")
        .get() as { n: number }
    ).n;
  } finally {
    db.close();
  }
}

function readCounts() {
  const db = new DatabaseSync(join(home, ".zcode/v2/tasks-index.sqlite"), { readOnly: true });
  const cli = new DatabaseSync(join(home, ".zcode/cli/db/db.sqlite"), { readOnly: true });
  try {
    return {
      ...(db
        .prepare(
          "SELECT sum(archived=1 AND deleted=0) AS archived, sum(deleted=1) AS deleted, sum(task_id=? AND archived=0 AND deleted=0) AS active FROM tasks WHERE task_id LIKE ?",
        )
        .get(control, `${prefix}%`) as { archived: number; deleted: number; active: number }),
      ...(cli
        .prepare(
          "SELECT count(*) AS cliRows, sum(time_deleted IS NOT NULL) AS cliDeleted FROM session WHERE id LIKE ?",
        )
        .get(`${prefix}%`) as { cliRows: number; cliDeleted: number }),
    };
  } finally {
    db.close();
    cli.close();
  }
}
