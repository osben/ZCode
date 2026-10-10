/**
 * SQLite implementation of `JournalStorePort` (dwf_* tables).
 *
 * The port is synchronous and repository-shaped, matching node:sqlite's DatabaseSync.
 * The engine therefore needs no async gap for persistence, and replay determinism does
 * not depend on the storage implementation.
 *
 * Dependency direction with @zcode/dynamic-workflow: `import type` only. The port
 * belongs to the domain package and this file is its adapter; runtime imports from the
 * domain package are forbidden (`implements` is erased at compile time).
 *
 * Transactions are not part of the port surface. When writes must be atomic with session
 * writes, the driver composes them with `begin immediate`.
 */

import type { DatabaseSync } from "node:sqlite";
import type {
  ActorRecord,
  Caps,
  JournalStorePort,
  ListEventsOptions,
  NodeRecord,
  RunEvent,
  RunRecord,
  RunSettlementRecord,
  RunStatus,
  StoredEvent,
} from "@zcode/dynamic-workflow";
import { encodeJson } from "../json.js";
// Artifact reads live in a separate module: they need only a db handle and share no
// state with run/actor/node/event reads or writes. Their two queries also have extensive
// reasoning about the source, ordering, and cursor semantics.
import {
  listArtifactItems,
  listArtifactRows,
  type DwfArtifactItem,
  type DwfArtifactItemsQuery,
} from "./dwf-journal-artifacts.js";
import {
  decodeActor,
  decodeEvent,
  decodeNode,
  decodeRun,
  encodeResultJson,
  encodeRunSettlement,
  type DwfActorRow,
  type DwfEventRow,
  type DwfNodeRow,
  type DwfWorldNodeRow,
  type DwfRunDetailRow,
  type DwfRunListItem,
  type DwfRunRow,
  type DwfRunSessionListItem,
} from "./dwf-journal-codecs.js";
import {
  countNodesByStatus,
  getRunRow,
  listRecentLogEvents,
  listRunLifeSpans,
  listRuns,
  listRunsByParentSession,
  listWorldNodes,
  type DwfListRunsQuery,
  type DwfNodeStatusCounts,
  type DwfRunIntrospectionQueries,
  type DwfRunLifeSpan,
} from "./dwf-journal-introspection.js";

export type { DwfArtifactItem, DwfArtifactItemsQuery } from "./dwf-journal-artifacts.js";
// The run-introspection read surface (DwfRunIntrospectionQueries and its SQL) is in
// dwf-journal-introspection.ts to satisfy max-lines; keep exporting the types here so
// existing importers do not need to change paths.
export type {
  DwfListRunsQuery,
  DwfNodeStatusCounts,
  DwfRunIntrospectionQueries,
  DwfRunLifeSpan,
} from "./dwf-journal-introspection.js";

class SqliteDwfJournalStore implements JournalStorePort, DwfRunIntrospectionQueries {
  constructor(private readonly db: DatabaseSync) {}

  createRun(record: RunRecord): void {
    const now = Date.now();
    // Logical → physical (zero-migration terminal-state encoding; see the header of dwf-journal-codecs.ts).
    const settlement = encodeRunSettlement(record.status, record);
    try {
      this.db
        .prepare(
          `
          insert into dwf_run (
            id, parent_session_id, cwd, name, script_text, script_hash, tool_call_id,
            args_json, resumed_from, caps_max_concurrency,
            spent_tokens, status, failure_json, result_json, time_created, time_updated
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          record.runId,
          record.parentSessionId ?? null,
          record.cwd ?? null,
          // name shares the metadata path with scriptText / cwd: write it only when the
          // run is created; no later writer touches it (updateRunStatus deliberately
          // omits this column).
          record.name ?? null,
          record.scriptText ?? null,
          record.scriptHash ?? null,
          record.toolCallId ?? null,
          // Arguments share the metadata path with scriptText: write them only when the
          // run is created, and never update them later. Resume must replay the approved
          // version.
          encodeJson(record.args),
          // Lineage is also write-once metadata: revisions supersede without touching
          // the predecessor row, so the source of this run's revision is recorded only
          // when the run is created.
          record.resumedFrom ?? null,
          // Unlike the columns above, caps are not write-once metadata. `updateRunCaps`
          // is the second writer: a revision changing only `max_concurrency` applies to
          // a live run in place, and resume uses the value stored on the row.
          record.caps.maxConcurrency,
          record.spentTokens,
          settlement.status,
          settlement.failureJson,
          encodeResultJson(record.result),
          now,
          now,
        );
    } catch (error) {
      // A duplicate run is a caller contract error and merits a clear message. Propagate other failures (FK, disk, constraints) unchanged.
      if (this.getRun(record.runId) !== undefined) {
        throw new Error(`dwf journal: run already exists: ${record.runId}`, { cause: error });
      }
      throw error;
    }
  }

  getRun(runId: string): RunRecord | undefined {
    const row = this.db.prepare("select * from dwf_run where id = ?").get(runId) as
      | DwfRunRow
      | undefined;
    return row ? decodeRun(row) : undefined;
  }

  updateRunStatus(runId: string, status: RunStatus, settlement?: RunSettlementRecord): void {
    const now = Date.now();
    // A non-terminal state has no settlement. When resume returns a run to running, clear
    // the previous failure_json / result_json: the engine's resume branch has no
    // settlement fields, and the terminal-state rule “absent key = do not touch” would
    // otherwise leave an Interrupted failure written by orphan recovery alongside the
    // running status. Clear contradictory settlement data too (a non-terminal state
    // carrying failure/result); contract tests pin this behavior for both implementations.
    if (status === "pending" || status === "running") {
      const { changes } = this.db
        .prepare(
          `
          update dwf_run set
            status = ?,
            failure_json = null,
            result_json = null,
            time_updated = ?
          where id = ?
          `,
        )
        .run(status, now, runId);
      this.assertRunTouched(changes, runId);
      return;
    }
    // Write terminal state and artifact **in one operation**: separate UPDATEs create a
    // crash window that can leave a run “completed but with empty result_json”—the data
    // loss case that migration 0020 closes.
    //
    // **Replace the entire `failure_json` column** (do not coalesce). Orphan recovery by
    // a second desktop instance may write failed + Interrupted for a run still active in
    // this process; the engine can then complete normally. Coalescing would preserve the
    // external failure, leaving a row that says both “completed” and “interrupted”. The
    // settlement payload is the **complete truth** about the outcome: stopped always
    // writes its envelope, errored writes its failure (absence means NULL and is the
    // truth), and completed writes NULL.
    //
    // Keep coalesce for `result_json`: for artifacts, “absent = leave unchanged” (see
    // the contract case “keeps an already-settled artifact when a later write omits it”).
    // A repeated settlement without an artifact must not erase the existing one.
    const encoded = encodeRunSettlement(status, settlement);
    const { changes } = this.db
      .prepare(
        `
        update dwf_run set
          status = ?,
          failure_json = ?,
          result_json = coalesce(?, result_json),
          time_updated = ?
        where id = ?
        `,
      )
      .run(encoded.status, encoded.failureJson, encodeResultJson(settlement?.result), now, runId);
    this.assertRunTouched(changes, runId);
  }

  updateRunUsage(runId: string, spentTokens: number): void {
    const { changes } = this.db
      .prepare("update dwf_run set spent_tokens = ?, time_updated = ? where id = ?")
      .run(spentTokens, Date.now(), runId);
    this.assertRunTouched(changes, runId);
  }

  /**
   * Update this run's concurrency cap in place.
   * A narrow write like `updateRunUsage`: it includes **only caps_max_concurrency**.
   * Status, usage, and settlement envelopes have their own write paths; including them
   * here could roll back a settlement when changing the cap. No migration is needed;
   * this method is simply a second writer for an existing column.
   */
  updateRunCaps(runId: string, caps: Caps): void {
    const { changes } = this.db
      .prepare("update dwf_run set caps_max_concurrency = ?, time_updated = ? where id = ?")
      .run(caps.maxConcurrency, Date.now(), runId);
    this.assertRunTouched(changes, runId);
  }

  /**
   * All **non-terminal** runs under one parent session. Deliberately keep this off
   * `JournalStorePort`: the engine never looks up runs by parent session. This query is
   * only for host-side orphan recovery—a run in a killed process remains `running` until
   * the next app construction for that session settles it
   * (`bootstrap/src/app/dynamic-workflow-run-service.ts` calls this by capability probe).
   *
   * This method only runs a query: the terminal-state set is an **index-friendly
   * prefilter** here, while the service remains authoritative and checks its own set
   * after reading the rows. `parent_session_id` is required; without it, cleanup could
   * mark a sibling session's **active** run as dead (they share one SQLite database but
   * have separate in-memory registries). SQL `= ?` does not match `NULL`, so rows without
   * a parent session belong to no session and are not touched by recovery.
   */
  listNonTerminalRuns(parentSessionId: string): RunRecord[] {
    // Physical terminal states (failed / cancelled are persisted forms of logical errored / stopped; no migration).
    const rows = this.db
      .prepare(
        `
        select * from dwf_run
        where parent_session_id = ?
          and status not in ('completed', 'failed', 'cancelled')
        order by id
        `,
      )
      .all(parentSessionId) as unknown as DwfRunRow[];
    return rows.map(decodeRun);
  }

  // ---- Host-side run introspection: SQL and its rationale live in dwf-journal-introspection.ts; delegate from here.

  listRuns(query: DwfListRunsQuery): DwfRunListItem[] {
    return listRuns(this.db, query);
  }

  getRunRow(runId: string): DwfRunDetailRow | undefined {
    return getRunRow(this.db, runId);
  }

  countNodesByStatus(runId: string): DwfNodeStatusCounts {
    return countNodesByStatus(this.db, runId);
  }

  listRecentLogEvents(runId: string, limit: number): StoredEvent[] {
    return listRecentLogEvents(this.db, runId, limit);
  }

  listRunLifeSpans(runId: string): DwfRunLifeSpan[] {
    return listRunLifeSpans(this.db, runId);
  }

  listRunsByParentSession(parentSessionId: string, limit: number): DwfRunSessionListItem[] {
    return listRunsByParentSession(this.db, parentSessionId, limit);
  }

  putActor(record: ActorRecord): void {
    const now = Date.now();
    this.db
      .prepare(
        `
        insert into dwf_actor (
          run_id, site_id, ordinal, name, persona_json, session_id, resolved_model,
          time_created, time_updated
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(run_id, site_id, ordinal) do update set
          name = excluded.name,
          persona_json = excluded.persona_json,
          session_id = excluded.session_id,
          resolved_model = excluded.resolved_model,
          time_updated = excluded.time_updated
        `,
      )
      .run(
        record.runId,
        record.siteId,
        record.ordinal,
        record.name ?? null,
        encodeJson(record.persona),
        record.sessionId ?? null,
        record.resolvedModel ?? null,
        now,
        now,
      );
  }

  getActor(runId: string, siteId: string, ordinal: number): ActorRecord | undefined {
    const row = this.db
      .prepare("select * from dwf_actor where run_id = ? and site_id = ? and ordinal = ?")
      .get(runId, siteId, ordinal) as DwfActorRow | undefined;
    return row ? decodeActor(row) : undefined;
  }

  listActors(runId: string): ActorRecord[] {
    const rows = this.db
      .prepare("select * from dwf_actor where run_id = ? order by id")
      .all(runId) as unknown as DwfActorRow[];
    return rows.map(decodeActor);
  }

  putNode(record: NodeRecord): void {
    // Admission (running) → settlement → stats backfill all use the same upsert, keyed by (run_id, site_id, ordinal).
    const now = Date.now();
    this.db
      .prepare(
        `
        insert into dwf_node (
          run_id, site_id, ordinal, kind, actor_site_id, actor_ordinal, actor_seq,
          input_hash, status, result_json, error_json, stats_json, message_boundary,
          artifact_id, input_json, time_created, time_updated
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(run_id, site_id, ordinal) do update set
          kind = excluded.kind,
          actor_site_id = excluded.actor_site_id,
          actor_ordinal = excluded.actor_ordinal,
          actor_seq = excluded.actor_seq,
          input_hash = excluded.input_hash,
          status = excluded.status,
          result_json = excluded.result_json,
          error_json = excluded.error_json,
          stats_json = excluded.stats_json,
          message_boundary = excluded.message_boundary,
          artifact_id = excluded.artifact_id,
          input_json = excluded.input_json,
          time_updated = excluded.time_updated
        `,
      )
      .run(
        record.runId,
        record.siteId,
        record.ordinal,
        record.kind,
        record.actorSiteId ?? null,
        record.actorOrdinal ?? null,
        record.actorSeq ?? null,
        record.inputHash,
        record.status,
        encodeResultJson(record.result),
        encodeJson(record.error),
        encodeJson(record.stats),
        // Driver backfill column like stats_json: upsert replaces the whole row, so the
        // writer must call getNode first and rewrite the full record (contract tests pin
        // this read-modify-write shape).
        record.messageBoundary ?? null,
        // Artifact id and kind are identity columns that the **engine includes in both
        // writes** (running admission and completed/failed settlement use the same id).
        // Since upsert replaces the whole row, omitting them once erases artifact
        // ownership from the settlement row and makes it disappear from the “artifacts
        // in this run” read surface.
        record.artifactId ?? null,
        // Migration 0030: bounded input, like kind / artifact_id, is a column included
        // in both engine writes. Upsert replaces the full row, so omitting it at
        // settlement would reset the op / args recorded at admission to NULL.
        encodeJson(record.input),
        now,
        now,
      );
  }

  getNode(runId: string, siteId: string, ordinal: number): NodeRecord | undefined {
    const row = this.db
      .prepare("select * from dwf_node where run_id = ? and site_id = ? and ordinal = ?")
      .get(runId, siteId, ordinal) as DwfNodeRow | undefined;
    return row ? decodeNode(row) : undefined;
  }

  listNodes(runId: string): NodeRecord[] {
    const rows = this.db
      .prepare("select * from dwf_node where run_id = ? order by id")
      .all(runId) as unknown as DwfNodeRow[];
    return rows.map(decodeNode);
  }

  listArtifactRows(runId: string): NodeRecord[] {
    return listArtifactRows(this.db, runId);
  }

  listWorldNodes(runId: string): DwfWorldNodeRow[] {
    return listWorldNodes(this.db, runId);
  }

  listArtifactItems(
    runId: string,
    artifactId: string,
    query: DwfArtifactItemsQuery,
  ): DwfArtifactItem[] {
    return listArtifactItems(this.db, runId, artifactId, query);
  }

  appendEvent(runId: string, event: RunEvent): StoredEvent {
    // Return the exact time_created value to the caller: reading the row back gives the
    // same value through decodeEvent. Without it, the append path would expose an event
    // with no timestamp until it was read again.
    const timeCreated = Date.now();
    // Allocate the sequence number and write in one statement: reading MAX(sequence)+1
    // separately before inserting could race across processes (under WAL, zcode allows
    // multiple Agents to share one database) and assign duplicate sequence numbers.
    const row = this.db
      .prepare(
        `
        insert into dwf_event (run_id, sequence, type, payload_json, time_created)
        values (
          ?,
          coalesce((select max(sequence) + 1 from dwf_event where run_id = ?), 0),
          ?, ?, ?
        )
        returning sequence
        `,
      )
      .get(runId, runId, event.type, JSON.stringify(event), timeCreated) as
      | Pick<DwfEventRow, "sequence">
      | undefined;
    if (row === undefined) {
      throw new Error(`dwf journal: event insert returned no sequence for run: ${runId}`);
    }
    return { sequence: row.sequence, event, timeCreated };
  }

  listEvents(runId: string, opts?: ListEventsOptions): StoredEvent[] {
    // Push both cursor and limit into SQL. Reading the full journal and slicing here
    // would load the whole journal into memory on every page, defeating pagination. The
    // cursor means “strictly greater than” (matching the in-memory implementation).
    const after = opts?.afterSequence;
    const limit = opts?.limit;
    const where = after === undefined ? "run_id = ?" : "run_id = ? and sequence > ?";
    const params: Array<string | number> = after === undefined ? [runId] : [runId, after];
    // SQLite uses `limit -1` for “unlimited”, so omitted and explicit limits share one statement shape.
    const rows = this.db
      .prepare(`select * from dwf_event where ${where} order by sequence limit ?`)
      .all(...params, limit === undefined ? -1 : Math.max(0, limit)) as unknown as DwfEventRow[];
    return rows.map(decodeEvent);
  }

  /** An UPDATE affecting zero rows means “unknown run”; SQLite does not report this as an error, so detect it explicitly and fail loudly. */
  private assertRunTouched(changes: number | bigint, runId: string): void {
    if (Number(changes) === 0) throw new Error(`dwf journal: unknown run: ${runId}`);
  }
}

  /** Open a dwf journal view on an existing session database; migration `0019_dwf_journal` creates the tables. */
export function createDwfJournalStore(db: DatabaseSync): JournalStorePort {
  return new SqliteDwfJournalStore(db);
}
