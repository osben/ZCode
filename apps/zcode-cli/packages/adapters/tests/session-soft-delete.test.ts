import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProjectId, createSessionId } from "@zcode/contracts";
import { SqliteSessionStore } from "../src/storage/session-store/sqlite-session-store.js";

// Upstream tombstone (time_deleted) and fork permanent erase (deleteSessionTree) must both hold:
// a tombstoned session disappears from listings but keeps its rows; an erased tree is gone.
// See specs/session-database-migrations.md, "Soft delete and fork erase".

const roots: string[] = [];
const stores: SqliteSessionStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

let dbPath = "";

async function openStore(): Promise<SqliteSessionStore> {
  const root = await mkdtemp(join(tmpdir(), "zcode-soft-delete-"));
  roots.push(root);
  dbPath = join(root, "cli", "db", "db.sqlite");
  const store = await SqliteSessionStore.open({ dbPath });
  stores.push(store);
  return store;
}

async function createRoot(store: SqliteSessionStore, id: string) {
  await store.createSession({
    id: createSessionId(id),
    projectID: createProjectId("soft-delete-project"),
    slug: id,
    directory: "/repo/soft-delete",
    title: id,
    version: "3.16.1",
    time: { created: 1, updated: 2 },
  });
}

describe("soft delete (upstream tombstone) with fork erase", () => {
  it("hides a tombstoned session from listings without deleting its rows", async () => {
    const store = await openStore();
    await createRoot(store, "tombstone");
    await createRoot(store, "visible");
    await store.softDeleteSession(createSessionId("tombstone"), 500);
    await store.softDeleteSession(createSessionId("tombstone"), 900);

    const listed = await store.listSessions({ directory: "/repo/soft-delete", roots: true });
    expect(listed.map((session) => String(session.id))).toEqual(["sess_visible"]);
    // The row remains (tombstone, not erase); the first deletion time wins (coalesce).
    const raw = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(
        raw.prepare("select time_deleted from session where id = ?").get("sess_tombstone"),
      ).toEqual({ time_deleted: 500 });
    } finally {
      raw.close();
    }
  });

  it("erases a tree physically, independent of any tombstone", async () => {
    const store = await openStore();
    await createRoot(store, "erase_root");
    await store.softDeleteSession(createSessionId("erase_root"), 500);
    const result = await store.deleteSessionTree({
      rootIds: [createSessionId("erase_root")],
    });
    expect(result.erasedIds.map(String)).toEqual(["sess_erase_root"]);
    expect(await store.getSession(createSessionId("erase_root"))).toBeNull();
  });
});
