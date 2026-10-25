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

    // Without a binding row the offered copy has nothing to update; the choice is pending (see below).
    await store.writeOffered("zcode-1", [MODE_OPTION]);
    await store.writeChoice("zcode-1", "opencode", "mode", "plan");
    expect((await store.readConfig("zcode-1")).offered).toBeUndefined();

    await store.write("zcode-1", BINDING);
    await store.writeOffered("zcode-1", [MODE_OPTION]);
    await store.writeChoice("zcode-1", "opencode", "mode", "plan");
    await store.writeChoice("zcode-1", "opencode", "model", "fast");
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
    await store.writeChoice("zcode-1", "opencode", "mode", "plan");

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
    await store.writeChoice("zcode-1", "opencode", "mode", "plan");

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
    await store.writeChoice("zcode-1", "opencode", "mode", "plan");
    expect((await store.readConfig("zcode-1")).choices).toEqual({ mode: "plan" });
  });

  it("serves repeated config reads from the store without opening the database again", async () => {
    const dbPath = await openSessionDatabase();
    const store = createForkAcpSessionBindingStore(dbPath);
    await store.write("zc-cache", BINDING);
    await store.writeOffered("zc-cache", [MODE_OPTION]);
    await store.readConfig("zc-cache");

    // An outside write the store did not make: a cached read must not see it, a database read would.
    const outside = new DatabaseSync(dbPath);
    try {
      outside.prepare("update fork_acp_session_binding set config_choices = ? where session_id = ?").run(
        JSON.stringify({ mode: "plan" }),
        "zc-cache",
      );
    } finally {
      outside.close();
    }
    expect((await store.readConfig("zc-cache")).choices).toEqual({});
  });

  it("drops the cached config on every write of the store", async () => {
    const dbPath = await openSessionDatabase();
    const store = createForkAcpSessionBindingStore(dbPath);
    await store.write("zc-write", BINDING);
    await store.writeOffered("zc-write", [MODE_OPTION]);
    expect((await store.readConfig("zc-write")).choices).toEqual({});

    await store.writeChoice("zc-write", "opencode", "mode", "plan");
    expect((await store.readConfig("zc-write")).choices).toEqual({ mode: "plan" });

    await store.clear("zc-write");
    expect(await store.readConfig("zc-write")).toMatchObject({
      agentId: undefined,
      offered: undefined,
      choices: {},
    });
  });

  // S6 readiness: a choice made before the first turn is pending until the binding exists.
  it("creates the pending choice table through migration 9005", async () => {
    const dbPath = await openSessionDatabase();
    const db = new DatabaseSync(dbPath);
    try {
      const columns = db
        .prepare("pragma table_info(fork_acp_session_choice)")
        .all()
        .map((row) => row.name);
      expect(columns).toEqual(
        expect.arrayContaining(["session_id", "agent_id", "config_choices", "updated_at"]),
      );
      expect(
        db.prepare("select id from schema_migration where id = ?").get("9005_fork_session_acp_pending_choice"),
      ).toBeDefined();
    } finally {
      db.close();
    }
  });

  it("keeps a choice made before the first turn pending and reads it as the session config", async () => {
    const store = createForkAcpSessionBindingStore(await openSessionDatabase());
    await store.writeChoice("zcode-1", "opencode", "mode", "plan");

    expect(await store.readConfig("zcode-1")).toEqual({
      agentId: "opencode",
      offered: undefined,
      choices: { mode: "plan" },
    });
  });

  it("moves pending choices into the binding in the binding write and drops the pending row", async () => {
    const dbPath = await openSessionDatabase();
    const store = createForkAcpSessionBindingStore(dbPath);
    await store.writeChoice("zcode-1", "opencode", "mode", "plan");
    await store.writeChoice("zcode-1", "opencode", "model", "fast");

    await store.write("zcode-1", BINDING);

    expect(await store.readConfig("zcode-1")).toEqual({
      agentId: "opencode",
      offered: undefined,
      choices: { mode: "plan", model: "fast" },
    });
    const db = new DatabaseSync(dbPath);
    try {
      expect(db.prepare("select count(*) as count from fork_acp_session_choice").get()).toEqual({
        count: 0,
      });
    } finally {
      db.close();
    }
  });

  it("drops a pending choice of another agent at the binding write", async () => {
    const store = createForkAcpSessionBindingStore(await openSessionDatabase());
    await store.writeChoice("zcode-1", "cursor", "mode", "plan");

    await store.write("zcode-1", BINDING);

    expect((await store.readConfig("zcode-1")).choices).toEqual({});
  });

  it("replaces the pending choices when another agent is chosen before the first turn", async () => {
    const store = createForkAcpSessionBindingStore(await openSessionDatabase());
    await store.writeChoice("zcode-1", "cursor", "mode", "plan");
    await store.writeChoice("zcode-1", "opencode", "model", "fast");

    expect(await store.readConfig("zcode-1")).toEqual({
      agentId: "opencode",
      offered: undefined,
      choices: { model: "fast" },
    });
  });

  it("refuses a choice for a binding of another agent", async () => {
    const store = createForkAcpSessionBindingStore(await openSessionDatabase());
    await store.write("zcode-1", BINDING);

    await expect(store.writeChoice("zcode-1", "cursor", "mode", "plan")).rejects.toThrow(
      "another agent",
    );
  });

  it("clears pending choices with the binding", async () => {
    const store = createForkAcpSessionBindingStore(await openSessionDatabase());
    await store.writeChoice("zcode-1", "opencode", "mode", "plan");

    await store.clear("zcode-1");

    expect(await store.readConfig("zcode-1")).toEqual({
      agentId: undefined,
      offered: undefined,
      choices: {},
    });
  });
});
