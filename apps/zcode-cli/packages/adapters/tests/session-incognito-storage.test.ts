import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  createProjectId,
  createSessionId,
  type CreateSessionInput,
  type SessionId,
} from "@zcode/contracts";
import { INCOGNITO_LOCKDOWN_PROFILE } from "@zcode/shared";
import { runSqliteSessionMigrations } from "../src/storage/session-store/migration-runner.js";
import { createSession, getSession } from "../src/storage/session-store/repositories/sessions.js";

// specs/incognito-session.md "Session storage": fork migration 9001_fork_session_incognito adds
// session.fork_incognito (NULL = normal session), set once and never cleared.
const MIGRATION_ID = "9001_fork_session_incognito";
const profile = { ...INCOGNITO_LOCKDOWN_PROFILE, skills: true };

describe("session incognito storage", () => {
  const databases: DatabaseSync[] = [];
  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
  });

  function openDb(): DatabaseSync {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    runSqliteSessionMigrations(db, ":memory:");
    return db;
  }

  function sessionInput(
    id: SessionId,
    extra: Partial<CreateSessionInput> = {},
  ): CreateSessionInput {
    return {
      id,
      projectID: createProjectId("incognito-project"),
      slug: "incognito",
      directory: "/workspace/app",
      title: "Incognito",
      version: "0.16.9",
      time: { created: 1, updated: 2 },
      ...extra,
    };
  }

  it("adds a nullable fork_incognito column and records the fork ledger row", () => {
    const db = openDb();
    const column = db
      .prepare("SELECT \"notnull\", dflt_value FROM pragma_table_info('session') WHERE name = ?")
      .get("fork_incognito");
    expect(column).toEqual({ notnull: 0, dflt_value: null });
    expect(db.prepare("SELECT id FROM schema_migration WHERE id = ?").get(MIGRATION_ID)).toEqual({
      id: MIGRATION_ID,
    });
  });

  it("round-trips the profile; a normal session stays NULL", () => {
    const db = openDb();
    const incognitoId = createSessionId("incognito");
    const normalId = createSessionId("normal");

    expect(createSession(db, sessionInput(incognitoId, { incognito: profile })).incognito).toEqual(
      profile,
    );
    expect(createSession(db, sessionInput(normalId)).incognito).toBeUndefined();
    expect(db.prepare("SELECT fork_incognito FROM session WHERE id = ?").get(normalId)).toEqual({
      fork_incognito: null,
    });
  });

  it("lets a profile land after a NULL insert, then never changes or clears it", () => {
    const db = openDb();
    const id = createSessionId("set-once");

    createSession(db, sessionInput(id));
    expect(createSession(db, sessionInput(id, { incognito: profile })).incognito).toEqual(profile);
    expect(
      createSession(db, sessionInput(id, { incognito: INCOGNITO_LOCKDOWN_PROFILE })).incognito,
    ).toEqual(profile);
    expect(createSession(db, sessionInput(id)).incognito).toEqual(profile);
  });

  it("keeps the profile through an upstream-shaped upsert that does not know the column", () => {
    const db = openDb();
    const id = createSessionId("upstream-upsert");
    createSession(db, sessionInput(id, { incognito: profile }));

    db.prepare(
      `insert into session (id, project_id, task_type, slug, directory, title, version, time_created, time_updated)
       values (?, 'p', 'interactive', 's', '/workspace/app', 'Renamed', '0.16.9', 1, 3)
       on conflict(id) do update set title = excluded.title, time_updated = excluded.time_updated`,
    ).run(id);

    expect(getSession(db, id)).toMatchObject({ title: "Renamed", incognito: profile });
  });

  it("reads a stored profile this build cannot parse as lockdown, not as a normal session", () => {
    const db = openDb();
    const id = createSessionId("damaged");
    createSession(db, sessionInput(id));
    db.prepare("UPDATE session SET fork_incognito = ? WHERE id = ?").run(
      JSON.stringify({ ...profile, version: 2 }),
      id,
    );

    expect(getSession(db, id)?.incognito).toEqual(INCOGNITO_LOCKDOWN_PROFILE);
  });

  it("tolerates ledger rows from another build and does not rerun its own migration", () => {
    const db = openDb();
    db.prepare(
      "INSERT INTO schema_migration (id, checksum, app_version, time_applied) VALUES (?, ?, ?, ?)",
    ).run("9002_fork_future_feature", "unknown-checksum", "9.9.9", 1);

    expect(() => runSqliteSessionMigrations(db, ":memory:")).not.toThrow();
    expect(
      db.prepare("SELECT count(*) AS n FROM schema_migration WHERE id = ?").get(MIGRATION_ID),
    ).toEqual({ n: 1 });
  });
});
