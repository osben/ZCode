import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSqliteSessionMigrationsAsync } from "../src/storage/session-store/migration-runner.js";
import { createForkAcpSessionBindingStore } from "../src/storage/session-store/fork-acp-session-binding.js";

// specs/acp-agent-runtime.md "S5": fork migration 9003_fork_session_acp_binding owns the table; the store
// reads and writes one row per ZCode session and never touches upstream session rows.
const MODE_OPTION = {
  id: "mode",
  name: "Mode",
  description: null,
  category: "mode",
  currentValue: "build",
  options: [
    { value: "build", name: "Build", description: null, group: null },
    { value: "plan", name: "Plan", description: "Read-only planning", group: null },
  ],
};

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

  // specs/acp-agent-runtime.md "S6": migration 9004 adds the config columns to the fork table.
  it("adds both config columns to a database that already applied 9003", async () => {
    const dbPath = await openSessionDatabase();
    const db = new DatabaseSync(dbPath);
    try {
      // Roll the database back to its state after 9003: no config columns, no 9004 ledger row.
      db.exec("alter table fork_acp_session_binding drop column config_options");
      db.exec("alter table fork_acp_session_binding drop column config_choices");
      db.prepare("delete from schema_migration where id = ?").run("9004_fork_session_acp_config");
      const ledgerBefore = db
        .prepare("select id, checksum from schema_migration order by id")
        .all() as { id: string; checksum: string }[];

      await runSqliteSessionMigrationsAsync(db, dbPath);

      const columns = db
        .prepare("pragma table_info(fork_acp_session_binding)")
        .all()
        .map((row) => row.name);
      expect(columns).toEqual(expect.arrayContaining(["config_options", "config_choices"]));
      const ledgerAfter = db
        .prepare("select id, checksum from schema_migration order by id")
        .all() as { id: string; checksum: string }[];
      expect(ledgerAfter.map((row) => row.id)).toContain("9004_fork_session_acp_config");
      // Every earlier ledger row, upstream ones included, keeps its checksum.
      expect(ledgerAfter.filter((row) => row.id !== "9004_fork_session_acp_config")).toEqual(ledgerBefore);
    } finally {
      db.close();
    }
  });

  it("round-trips offered options and chosen values", async () => {
    const store = createForkAcpSessionBindingStore(await openSessionDatabase());
    expect(await store.readConfig("zcode-1")).toEqual({ agentId: undefined, offered: undefined, choices: {} });

    // Without a binding row the config writes have nothing to update.
    await store.writeOffered("zcode-1", [MODE_OPTION]);
    await store.writeChoice("zcode-1", "mode", "plan");
    expect((await store.readConfig("zcode-1")).offered).toBeUndefined();

    await store.write("zcode-1", BINDING);
    await store.writeOffered("zcode-1", [MODE_OPTION]);
    await store.writeChoice("zcode-1", "mode", "plan");
    await store.writeChoice("zcode-1", "model", "fast");
    expect(await store.readConfig("zcode-1")).toEqual({
      agentId: "opencode",
      offered: [MODE_OPTION],
      choices: { mode: "plan", model: "fast" },
    });
  });

  it("keeps offered options and choices when the binding is upserted", async () => {
    const store = createForkAcpSessionBindingStore(await openSessionDatabase());
    await store.write("zcode-1", BINDING);
    await store.writeOffered("zcode-1", [MODE_OPTION]);
    await store.writeChoice("zcode-1", "mode", "plan");

    await store.write("zcode-1", { ...BINDING, acpSessionId: "acp-session-2" });

    expect(await store.readConfig("zcode-1")).toMatchObject({
      offered: [MODE_OPTION],
      choices: { mode: "plan" },
    });
  });

  it("drops offered options and choices with the binding", async () => {
    const store = createForkAcpSessionBindingStore(await openSessionDatabase());
    await store.write("zcode-1", BINDING);
    await store.writeOffered("zcode-1", [MODE_OPTION]);
    await store.writeChoice("zcode-1", "mode", "plan");

    await store.clear("zcode-1");
    await store.write("zcode-1", BINDING);

    expect(await store.readConfig("zcode-1")).toEqual({ agentId: "opencode", offered: undefined, choices: {} });
  });

  it("treats malformed stored config as absent", async () => {
    const dbPath = await openSessionDatabase();
    const store = createForkAcpSessionBindingStore(dbPath);
    await store.write("zcode-1", BINDING);
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare(
        "update fork_acp_session_binding set config_options = ?, config_choices = ? where session_id = ?",
      ).run("{not json", JSON.stringify(["plan"]), "zcode-1");
    } finally {
      db.close();
    }

    expect(await store.readConfig("zcode-1")).toEqual({ agentId: "opencode", offered: undefined, choices: {} });
    await store.writeChoice("zcode-1", "mode", "plan");
    expect((await store.readConfig("zcode-1")).choices).toEqual({ mode: "plan" });
  });
});
