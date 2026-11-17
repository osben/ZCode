#!/usr/bin/env -S pnpm exec tsx
/**
 * Produces the Node side of the dwf_* cross-runtime goldens (rust-cli node-store, W2).
 *
 * Input: packages/rust-cli/crates/node-store/fixtures/dwf/scenario.json (shared by the Rust tests).
 * Output, in the same fixtures directory:
 * - node-written.sqlite: the scenario written by Node's SQLite journal store (`createDwfJournalStore`)
 *   on a freshly migrated database. Rust reads it (direction 1).
 * - node-expected.json: what Node's own readers return for that database. Rust must reproduce it
 *   (direction 1), and Node's readers must reproduce it on the Rust-written database (direction 2,
 *   apps/zcode-cli/packages/adapters/tests/dwf-rust-goldens.test.ts).
 *
 * The scenario is read by both runtimes, so its ops are typed as a discriminated union on `op`: a
 * misspelled field fails here instead of silently producing an absent value on both sides.
 *
 * Timestamps are not compared (the journal's clocks are wall-clock); the scenario's `now` is only a
 * label. The stale expected file is removed first, so a crash mid-run cannot leave it beside a new
 * database. Run from the repository root with:
 *   pnpm exec tsx scripts/rust-cli/dwf-journal-goldens.ts
 * (from a worktree without node_modules, run it by absolute path from the checkout that has them).
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createSessionTaskLink } from "../../apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/script-workflow-activities.ts";
import { createDwfJournalStore } from "../../apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/dwf-journal.ts";
import { SQLITE_MIGRATIONS } from "../../apps/zcode-cli/packages/adapters/src/storage/session-store/migrations.ts";
import {
  applySqliteSchemaMigration,
  ensureSqliteSchemaMigrationTable,
} from "../../packages/shared/src/sqlite-migrations/index.ts";

// Type-only imports: erased at runtime, so the script needs no domain package resolution, and the
// journal calls below check against the same records Node's engine uses.
import type {
  ActorRecord,
  Caps,
  NodeRecord,
  RunEvent,
  RunRecord,
  RunSettlementRecord,
  RunStatus,
} from "../../apps/zcode-cli/packages/dynamic-workflow/src/engine/types.ts";

/** The createSession input fields that the session row takes (`parentID` is optional). */
type SessionInput = {
  id: string;
  projectID: string;
  parentID?: string;
  slug: string;
  directory: string;
  title: string;
  version: string;
};

/** Every allowed createSession input key. Typed, so a key added to SessionInput must be listed here. */
const SESSION_INPUT_FIELDS: Record<keyof SessionInput, true> = {
  id: true,
  projectID: true,
  parentID: true,
  slug: true,
  directory: true,
  title: true,
  version: true,
};

/**
 * Checks a createSession input at run time. The scenario is JSON cast to its type, so the type alone
 * cannot catch a misspelled key: an unknown key throws, and so does a missing required field.
 */
function checkSessionInput(input: SessionInput): SessionInput {
  const unknownKeys = Object.keys(input).filter((key) => !Object.hasOwn(SESSION_INPUT_FIELDS, key));
  if (unknownKeys.length > 0) {
    throw new Error(`createSession: unknown input field(s): ${unknownKeys.join(", ")}`);
  }
  for (const key of ["id", "projectID", "slug", "directory", "title", "version"] as const) {
    if (typeof input[key] !== "string") {
      throw new Error(`createSession: input.${key} must be a string`);
    }
  }
  if (input.parentID !== undefined && typeof input.parentID !== "string") {
    throw new Error("createSession: input.parentID must be a string when set");
  }
  return input;
}

/**
 * The shared scenario, as a discriminated union on `op`. The fields are Node's record names, so a
 * misspelled key fails the type check of the journal call it feeds.
 */
type ScenarioOp =
  | { op: "createSession"; now: number; input: SessionInput }
  | { op: "createRun"; now: number; record: RunRecord }
  | {
      op: "updateRunStatus";
      now: number;
      runId: string;
      status: RunStatus;
      settlement?: RunSettlementRecord;
    }
  | { op: "updateRunUsage"; now: number; runId: string; spentTokens: number }
  | { op: "updateRunCaps"; now: number; runId: string; caps: Caps }
  | { op: "updateRunScript"; now: number; runId: string; scriptText: string; scriptHash: string }
  | { op: "putActor"; now: number; record: ActorRecord }
  | { op: "putNode"; now: number; record: NodeRecord }
  | { op: "appendEvent"; now: number; runId: string; event: RunEvent }
  | {
      op: "workflowActorLink";
      now: number;
      id: string;
      childSessionId: string;
      parentSessionId: string;
      path: string;
      status: string;
    };

interface Scenario {
  description: string;
  ops: ScenarioOp[];
}

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "../../packages/rust-cli/crates/node-store/fixtures/dwf");
const databasePath = join(fixtures, "node-written.sqlite");
const expectedPath = join(fixtures, "node-expected.json");

/** Node's ALL_EVENTS (journal-read-types.ts): every event type, every report item. */
const ALL_EVENTS = { types: "all", reportItems: "all" } as const;
const SESSION_PARENT = "sess_parent";

// Fresh outputs only: the directory exists before anything is written, and the stale expected file
// goes first, so a crash mid-run cannot leave it beside a new database.
mkdirSync(fixtures, { recursive: true });
rmSync(expectedPath, { force: true });
rmSync(databasePath, { force: true });

const scenario = JSON.parse(readFileSync(join(fixtures, "scenario.json"), "utf8")) as Scenario;

const db = new DatabaseSync(databasePath);
// Same bootstrap the Node journal tests use: the migrated schema, then the journal store over it.
db.exec("BEGIN IMMEDIATE");
ensureSqliteSchemaMigrationTable(db);
for (const migration of SQLITE_MIGRATIONS) applySqliteSchemaMigration(db, migration);
db.exec("COMMIT");

// Pin: the ledger checksum Node wrote for 0019 must equal fork-upstream-migrations.json.
const ledger = db
  .prepare("select id, checksum from schema_migration where id = '0019_dwf_journal'")
  .get() as { id: string; checksum: string } | undefined;
const pinned = JSON.parse(
  readFileSync(join(here, "../../fork-upstream-migrations.json"), "utf8"),
) as {
  sets: Record<string, Array<{ id: string; checksum: string }>>;
};
const pinnedEntry = pinned.sets.cli.find((entry) => entry.id === "0019_dwf_journal");
if (!ledger || !pinnedEntry || ledger.checksum !== pinnedEntry.checksum) {
  throw new Error(`0019 ledger checksum ${ledger?.checksum} != pinned ${pinnedEntry?.checksum}`);
}

const journal = createDwfJournalStore(db) as ReturnType<typeof createDwfJournalStore> & {
  listNonTerminalRuns(parentSessionId: string): unknown[];
};
const runIds: string[] = [];

for (const op of scenario.ops) {
  switch (op.op) {
    case "createSession": {
      const input = checkSessionInput(op.input);
      db.prepare(
        `insert into session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.id,
        input.projectID,
        input.parentID ?? null,
        input.slug,
        input.directory,
        input.title,
        input.version,
        op.now,
        op.now,
      );
      break;
    }
    case "createRun":
      journal.createRun(op.record);
      runIds.push(op.record.runId);
      break;
    case "updateRunStatus":
      journal.updateRunStatus(op.runId, op.status, op.settlement);
      break;
    case "updateRunUsage":
      journal.updateRunUsage(op.runId, op.spentTokens);
      break;
    case "updateRunCaps":
      journal.updateRunCaps(op.runId, op.caps);
      break;
    case "updateRunScript":
      journal.updateRunScript(op.runId, op.scriptText, op.scriptHash);
      break;
    case "putActor":
      journal.putActor(op.record);
      break;
    case "putNode":
      journal.putNode(op.record);
      break;
    case "appendEvent":
      journal.appendEvent(op.runId, op.event);
      break;
    case "workflowActorLink":
      await createSessionTaskLink(db, {
        id: op.id,
        childSessionId: op.childSessionId,
        parentSessionId: op.parentSessionId,
        path: op.path,
        role: "workflow_actor",
        status: op.status,
      });
      break;
    default: {
      // Exhaustiveness: an op added to ScenarioOp without a branch fails the type check here, and an
      // unknown op at run time throws instead of being skipped.
      const unhandled: never = op;
      throw new Error(`unknown scenario op: ${JSON.stringify(unhandled)}`);
    }
  }
}

const stripTimes = (event: { sequence: number; event: unknown }) => ({
  sequence: event.sequence,
  event: event.event,
});

const runs = runIds.map((runId) => journal.getRun(runId));
const actors: Record<string, unknown[]> = {};
const nodes: Record<string, unknown[]> = {};
const events: Record<string, unknown[]> = {};
for (const runId of runIds) {
  actors[runId] = journal.listActors(runId, { withPersona: true });
  nodes[runId] = journal.listNodes(runId, { kinds: "all", withResult: true });
  events[runId] = journal.listEvents(runId, ALL_EVENTS).map(stripTimes);
}
const taskLinks = db
  .prepare(
    `select id, root_workflow_run_id, parent_link_id, activity_id, parent_session_id, child_session_id,
            role, depth, path, phase, label, agent_type, model, status
     from session_task_link order by id`,
  )
  .all()
  .map((row) => ({ ...row }));

const expected = {
  checksums: { "0019_dwf_journal": ledger.checksum },
  runIds,
  runs,
  actors,
  nodes,
  events,
  nonTerminalByParent: { [SESSION_PARENT]: journal.listNonTerminalRuns(SESSION_PARENT) },
  taskLinks,
};

db.close();
writeFileSync(expectedPath, `${JSON.stringify(expected, null, 2)}\n`);
process.stdout.write(`wrote ${databasePath}\nwrote ${expectedPath}\n`);
