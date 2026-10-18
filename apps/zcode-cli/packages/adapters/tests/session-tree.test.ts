import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMessageId,
  createProjectId,
  createSessionId,
  type ModelId,
  type ModelProviderId,
  type SessionId,
  type SessionTaskType,
} from "@zcode/contracts";
import { createSqliteSessionStore, openStartupSqliteSessionStore } from "../src/storage/index.js";

// specs/session-deletion-cascade.md §4–§5: permanent erase of a session tree.

const tempRoots: string[] = [];

/** Raw SQL sees the stored (prefixed) id. */
const raw = (name: string): string => String(createSessionId(name));

afterEach(async () => {
  while (tempRoots.length > 0) {
    await rm(tempRoots.pop()!, { force: true, recursive: true });
  }
});

async function openStore() {
  const root = await mkdtemp(join(tmpdir(), "zcode-session-tree-"));
  tempRoots.push(root);
  const dbPath = join(root, "db.sqlite");
  const store = createSqliteSessionStore({ dbPath });
  // Second connection: raw seeding of tables the store has no convenient writer for, and
  // orphan checks that must not go through the code under test.
  const raw = new DatabaseSync(dbPath);
  raw.exec("pragma foreign_keys = on");
  return {
    store,
    raw,
    close() {
      raw.close();
      store.close();
    },
  };
}

type Store = Awaited<ReturnType<typeof openStore>>["store"];

async function seedSession(
  store: Store,
  id: string,
  taskType: SessionTaskType,
  parentID?: string,
): Promise<SessionId> {
  const sessionID = createSessionId(id);
  await store.createSession({
    id: sessionID,
    projectID: createProjectId("tree"),
    ...(parentID ? { parentID: createSessionId(parentID) } : {}),
    taskType,
    slug: id,
    directory: "/home/dev/project",
    path: "/home/dev/project",
    title: id,
    version: "0.1.0",
  });
  await store.saveMessage({
    id: createMessageId(`${id}-message`),
    sessionID,
    role: "user",
    time: { created: 1_700_000_000_000 },
    agent: "zcode-agent",
    model: {
      providerID: "test-provider" as ModelProviderId,
      modelID: "test-model" as ModelId,
    },
  });
  return sessionID;
}

function insertWorkflowRun(raw: DatabaseSync, id: string, parentSessionId: string) {
  raw
    .prepare(
      `insert into workflow_run (id, name, cwd, script_hash, status, parent_session_id, time_created, time_updated)
       values (?, 'wf', '/home/dev/project', 'hash', 'completed', ?, 1, 1)`,
    )
    .run(id, parentSessionId);
  raw
    .prepare(
      `insert into workflow_event (id, run_id, sequence, type, time_created) values (?, ?, 1, 'x', 1)`,
    )
    .run(`${id}-event`, id);
}

function insertDwfRun(raw: DatabaseSync, id: string, parentSessionId: string) {
  raw
    .prepare(
      `insert into dwf_run (id, parent_session_id, cwd, caps_max_concurrency, status, time_created, time_updated)
       values (?, ?, '/home/dev/project', 1, 'completed', 1, 1)`,
    )
    .run(id, parentSessionId);
  raw
    .prepare(
      `insert into dwf_event (run_id, sequence, type, payload_json, time_created) values (?, 1, 'x', '{}', 1)`,
    )
    .run(id);
}

function insertInputHistory(raw: DatabaseSync, id: string, sessionId: string) {
  raw
    .prepare(
      `insert into input_history (id, project_id, session_id, text, kind, time_created)
       values (?, 'tree', ?, 'typed text', 'prompt', 1)`,
    )
    .run(id, sessionId);
}

function countRows(raw: DatabaseSync, table: string, where = "1 = 1"): number {
  const row = raw.prepare(`select count(*) as n from ${table} where ${where}`).get() as {
    n: number;
  };
  return Number(row.n);
}

/**
 * parent (interactive)
 * ├─ chat (side chat, archived) ── nested-sub (subagent of the side chat)
 * ├─ sub (subagent)
 * ├─ wf-child (workflow_child)
 * └─ fork-of-parent (fork, independent)
 * other (interactive, unrelated)
 */
async function seedFamily(h: Awaited<ReturnType<typeof openStore>>) {
  const { store, raw: db } = h;
  const parent = await seedSession(store, "parent", "interactive");
  await seedSession(store, "chat", "selection_side_chat", "parent");
  await store.updateSession({ id: createSessionId("chat"), timeArchived: 100 });
  await seedSession(store, "nested-sub", "subagent_child", "chat");
  await seedSession(store, "sub", "subagent_child", "parent");
  await seedSession(store, "wf-child", "workflow_child", "parent");
  const fork = await seedSession(store, "fork-of-parent", "fork", "parent");
  const other = await seedSession(store, "other", "interactive");
  insertWorkflowRun(db, "run-1", raw("parent"));
  insertDwfRun(db, "dwf-1", raw("parent"));
  insertInputHistory(db, "hist-parent", raw("parent"));
  insertInputHistory(db, "hist-other", raw("other"));
  insertDwfRun(db, "dwf-other", raw("other"));
  return { parent, fork, other };
}

describe("session tree count and erase", () => {
  it("counts descendants through child task types only, archived and nested included, forks excluded", async () => {
    const h = await openStore();
    try {
      const { parent, other } = await seedFamily(h);
      await expect(h.store.countSessionTree!({ rootIds: [parent] })).resolves.toEqual({
        total: 5,
        sideChats: 1,
        subagents: 2,
        workflowSessions: 1,
        workflowRuns: 2,
      });
      await expect(
        h.store.countSessionTree!({ rootIds: [parent, other, createSessionId("missing")] }),
      ).resolves.toMatchObject({ total: 6, workflowRuns: 3 });
      await expect(h.store.countSessionTree!({ rootIds: [] })).resolves.toEqual({
        total: 0,
        sideChats: 0,
        subagents: 0,
        workflowSessions: 0,
        workflowRuns: 0,
      });
    } finally {
      h.close();
    }
  });

  it("does not double count a root that is also a descendant of another root", async () => {
    const h = await openStore();
    try {
      const { parent } = await seedFamily(h);
      const counts = await h.store.countSessionTree!({
        rootIds: [parent, createSessionId("sub")],
      });
      expect(counts.total).toBe(5);
    } finally {
      h.close();
    }
  });

  it("runs with foreign keys enforced on the store connection", async () => {
    const h = await openStore();
    try {
      await seedSession(h.store, "fk-probe", "interactive");
      // A cascade only fires when the store handle itself enforces foreign keys: delete the session
      // through the erase path and require its message to disappear with it.
      await h.store.deleteSessionTree!({ rootIds: [createSessionId("fk-probe")] });
      expect(countRows(h.raw, "message", `session_id = '${raw("fk-probe")}'`)).toBe(0);
    } finally {
      h.close();
    }
  });

  it("erases the whole tree and every dependent row, leaving forks and unrelated sessions", async () => {
    const h = await openStore();
    try {
      const { parent, fork } = await seedFamily(h);
      const { erasedIds } = await h.store.deleteSessionTree!({ rootIds: [parent] });
      expect([...erasedIds].map(String).sort()).toEqual(
        ["chat", "nested-sub", "parent", "sub", "wf-child"].map(raw).sort(),
      );

      const treeIds = `(${["parent", "chat", "nested-sub", "sub", "wf-child"]
        .map((name) => `'${raw(name)}'`)
        .join(", ")})`;
      expect(countRows(h.raw, "session", `id in ${treeIds}`)).toBe(0);
      expect(countRows(h.raw, "message", `session_id in ${treeIds}`)).toBe(0);
      expect(countRows(h.raw, "workflow_run", "id = 'run-1'")).toBe(0);
      expect(countRows(h.raw, "workflow_event", "run_id = 'run-1'")).toBe(0);
      expect(countRows(h.raw, "dwf_run", "id = 'dwf-1'")).toBe(0);
      expect(countRows(h.raw, "dwf_event", "run_id = 'dwf-1'")).toBe(0);
      expect(countRows(h.raw, "input_history", "id = 'hist-parent'")).toBe(0);
      expect(countRows(h.raw, "session_task_link", `child_session_id in ${treeIds}`)).toBe(0);

      // Untouched: the fork (keeps a dangling parent_id), the unrelated session and its rows.
      expect(await h.store.getSession(fork)).not.toBeNull();
      expect(countRows(h.raw, "message", `session_id = '${raw("fork-of-parent")}'`)).toBe(1);
      expect(countRows(h.raw, "session", `id = '${raw("other")}'`)).toBe(1);
      expect(countRows(h.raw, "message", `session_id = '${raw("other")}'`)).toBe(1);
      expect(countRows(h.raw, "input_history", "id = 'hist-other'")).toBe(1);
      expect(countRows(h.raw, "dwf_run", "id = 'dwf-other'")).toBe(1);
    } finally {
      h.close();
    }
  });

  it("is idempotent and skips ids that no longer exist", async () => {
    const h = await openStore();
    try {
      const { parent } = await seedFamily(h);
      await h.store.deleteSessionTree!({ rootIds: [parent] });
      await expect(
        h.store.deleteSessionTree!({ rootIds: [parent, createSessionId("never-existed")] }),
      ).resolves.toEqual({ erasedIds: [] });
      await expect(h.store.deleteSessionTree!({ rootIds: [] })).resolves.toEqual({ erasedIds: [] });
    } finally {
      h.close();
    }
  });

  it("handles more roots than a single SQL statement binds", async () => {
    const h = await openStore();
    try {
      const roots: SessionId[] = [];
      for (let index = 0; index < 1200; index += 1) {
        const id = createSessionId(`bulk-${index}`);
        h.raw
          .prepare(
            `insert into session (id, project_id, slug, directory, path, title, version, time_created, time_updated)
             values (?, 'tree', ?, '/p', '/p', 't', '0', 1, 1)`,
          )
          .run(id, id);
        roots.push(id);
      }
      const { erasedIds } = await h.store.deleteSessionTree!({ rootIds: roots });
      expect(erasedIds).toHaveLength(1200);
      expect(countRows(h.raw, "session", "id like 'sess_bulk-%'")).toBe(0);
    } finally {
      h.close();
    }
  });

  it("rolls back every table when a later step fails", async () => {
    const h = await openStore();
    try {
      const { parent } = await seedFamily(h);
      // A trigger on the final step forces a failure after workflow/dwf/input rows were removed.
      h.raw.exec(
        `create trigger fail_session_delete before delete on session
         begin select raise(abort, 'injected failure'); end`,
      );
      await expect(h.store.deleteSessionTree!({ rootIds: [parent] })).rejects.toThrow();
      h.raw.exec("drop trigger fail_session_delete");
      expect(countRows(h.raw, "session", `id = '${raw("parent")}'`)).toBe(1);
      expect(countRows(h.raw, "workflow_run", "id = 'run-1'")).toBe(1);
      expect(countRows(h.raw, "dwf_run", "id = 'dwf-1'")).toBe(1);
      expect(countRows(h.raw, "input_history", "id = 'hist-parent'")).toBe(1);
    } finally {
      h.close();
    }
  });

  it("cascades message rows on the production async startup path too", async () => {
    // The protocol entrypoint opens the store with openStartupSqliteSessionStore, not the sync constructor.
    const root = await mkdtemp(join(tmpdir(), "zcode-session-tree-startup-"));
    tempRoots.push(root);
    const dbPath = join(root, "db.sqlite");
    const store = await openStartupSqliteSessionStore({ dbPath });
    const inspect = new DatabaseSync(dbPath);
    try {
      await seedSession(store, "startup-root", "interactive");
      await seedSession(store, "startup-child", "subagent_child", "startup-root");
      expect(countRows(inspect, "message", `session_id = '${raw("startup-child")}'`)).toBe(1);
      await store.deleteSessionTree!({ rootIds: [createSessionId("startup-root")] });
      // Only `delete from session` runs for these tables, so their rows vanishing proves the cascade.
      expect(countRows(inspect, "session", `id in ('${raw("startup-root")}', '${raw("startup-child")}')`)).toBe(0);
      expect(countRows(inspect, "message", `session_id like 'sess_startup-%'`)).toBe(0);
    } finally {
      inspect.close();
      store.close();
    }
  });
});
