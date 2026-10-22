import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSqliteSessionMigrationsAsync } from "../src/storage/session-store/migration-runner.js";
import { createForkAcpSessionBindingStore } from "../src/storage/session-store/fork-acp-session-binding.js";

// specs/acp-agent-runtime.md "S5": fork migration 9003_fork_session_acp_binding owns the table; the store
// reads and writes one row per ZCode session and never touches upstream session rows.
const BINDING = {
  agentId: "opencode",
  acpSessionId: "acp-session-1",
  cwd: "/workspace/app",
  launchKey: "digest-of-launch",
};

describe("fork ACP session binding storage", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function openSessionDatabase(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "zcode-acp-binding-"));
    dirs.push(dir);
    const dbPath = join(dir, "session.sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      await runSqliteSessionMigrationsAsync(db, dbPath);
    } finally {
      db.close();
    }
    return dbPath;
  }

  it("creates the binding table in the session database through the fork migration", async () => {
    const dbPath = await openSessionDatabase();
    const db = new DatabaseSync(dbPath);
    try {
      const columns = db
        .prepare("pragma table_info(fork_acp_session_binding)")
        .all()
        .map((row) => row.name);
      expect(columns).toEqual(
        expect.arrayContaining(["session_id", "agent_id", "acp_session_id", "cwd", "launch_key"]),
      );
      const applied = db
        .prepare("select id from schema_migration where id = ?")
        .get("9003_fork_session_acp_binding");
      expect(applied).toBeDefined();
    } finally {
      db.close();
    }
  });

  it("reads, replaces and clears one binding per ZCode session", async () => {
    const store = createForkAcpSessionBindingStore(await openSessionDatabase());

    expect(await store.read("zcode-1")).toBeUndefined();
    await store.write("zcode-1", BINDING);
    expect(await store.read("zcode-1")).toEqual(BINDING);

    await store.write("zcode-1", { ...BINDING, acpSessionId: "acp-session-2" });
    expect((await store.read("zcode-1"))?.acpSessionId).toBe("acp-session-2");
    expect(await store.read("zcode-2")).toBeUndefined();

    await store.clear("zcode-1");
    expect(await store.read("zcode-1")).toBeUndefined();
  });
});
