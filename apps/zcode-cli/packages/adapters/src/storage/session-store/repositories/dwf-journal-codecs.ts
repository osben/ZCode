/**
 * Row-to-record mappings for dwf_* journal tables.
 *
 * Record types are imported from @zcode/dynamic-workflow using `import type` only: ports belong
 * in the domain package, and the SQLite store is just an adapter for it, so runtime dependencies
 * on the domain package are forbidden.
 *
 * Decoding rule: when a nullable column is NULL, **omit the key** (do not write undefined or null).
 * Contract tests compare whole records with toEqual, so optional fields absent from input must
 * remain absent on output.
 */

import type {
  ActorRecord,
  AskStats,
  Caps,
  NodeKind,
  NodeRecord,
  NodeRecordStatus,
  PersonaSpec,
  RunEvent,
  RunRecord,
  RunSettlementRecord,
  RunStatus,
  StoredEvent,
  WorkflowErrorJson,
  WorldReadInput,
} from "@zcode/dynamic-workflow";
import { decodeJson, encodeJson } from "../json.js";

/**
 * The **physical** vocabulary for `dwf_run.status` (the CHECK set in migration 0019; do not migrate).
 * The engine's logical vocabulary is `RunStatus` (`errored` / `stopped`); their mapping lives only here:
 *
 * | Logical state           | Physical status | failure_json                                      |
 * | ----------------------- | ----------- | --------------------------------------------------- |
 * | stopped{reason, error?} | cancelled   | `{"stopReason": …, "error"?: WorkflowErrorJson}` envelope |
 * | errored{error}          | failed      | WorkflowErrorJson as-is                              |
 * | completed/pending/running | same      | unchanged                                            |
 *
 * Decoding (no backfill for historical rows): `cancelled` -> stopped, with reason from the
 * envelope's stopReason, defaulting to `user` when absent (older rows); `failed` + code
 * `Interrupted` -> stopped(interrupted) (older orphan-cleanup rows); all other `failed` -> errored.
 * Accepted imprecision: historical cancelled rows without a reason decode as user, including rows stopped by TaskStop.
 */
export type DwfRunPhysicalStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

type RunStopReason = NonNullable<RunRecord["stopReason"]>;

/**
 * Envelope in failure_json for stopped rows (distinguished from WorkflowErrorJson by the
 * `stopReason` key). `supersededBy` is written together with `stopReason: "superseded"`; because
 * the entire envelope is rewritten, it lives here without a migration.
 */
interface DwfStoppedEnvelope {
  stopReason: RunStopReason;
  supersededBy?: string;
  error?: WorkflowErrorJson;
}

/** Logical terminal-state tuple: status + stop reason (and successor) + structured failure. */
interface DwfRunSettlementFields {
  status: RunStatus;
  stopReason?: RunStopReason;
  supersededBy?: string;
  failure?: WorkflowErrorJson;
}

const INTERRUPTED_CODE = "Interrupted";
// Allowlist for envelope sniffing: omitting any value makes its envelope undecodable and the row falls back to stopped(user).
const STOP_REASONS: ReadonlySet<string> = new Set([
  "user",
  "model",
  "provider",
  "interrupted",
  "superseded",
]);

/** Logical status (and settlement) -> physical column value. The sole write-side entry point, shared by createRun/updateRunStatus. */
export function encodeRunSettlement(
  status: RunStatus,
  settlement?: Pick<RunSettlementRecord, "stopReason" | "supersededBy" | "failure">,
): { status: DwfRunPhysicalStatus; failureJson: string | null } {
  switch (status) {
    case "stopped": {
      const envelope: DwfStoppedEnvelope = { stopReason: settlement?.stopReason ?? "user" };
      if (settlement?.supersededBy !== undefined) envelope.supersededBy = settlement.supersededBy;
      if (settlement?.failure !== undefined) envelope.error = settlement.failure;
      return { status: "cancelled", failureJson: JSON.stringify(envelope) };
    }
    case "errored":
      return { status: "failed", failureJson: encodeJson(settlement?.failure) };
    case "completed":
      return { status: "completed", failureJson: encodeJson(settlement?.failure) };
    case "pending":
    case "running":
      return { status, failureJson: null };
  }
}

/** Physical column value -> logical terminal-state tuple. The sole read-side entry point, shared by full-record and list queries. */
function decodeRunSettlement(
  status: DwfRunPhysicalStatus,
  failureJson: string | null,
): DwfRunSettlementFields {
  const raw = decodeJson<Record<string, unknown>>(failureJson);
  switch (status) {
    case "cancelled": {
      const fields: DwfRunSettlementFields = { status: "stopped", stopReason: "user" };
      if (raw !== undefined && isStoppedEnvelope(raw)) {
        fields.stopReason = raw.stopReason;
        if (typeof raw.supersededBy === "string" && raw.supersededBy.length > 0) {
          fields.supersededBy = raw.supersededBy;
        }
        if (raw.error !== undefined) fields.failure = raw.error;
      }
      return fields;
    }
    case "failed": {
      const failure = raw as WorkflowErrorJson | undefined;
      if (failure?.code === INTERRUPTED_CODE) {
        return { status: "stopped", stopReason: "interrupted", failure };
      }
      return failure === undefined ? { status: "errored" } : { status: "errored", failure };
    }
    case "completed": {
      const failure = raw as WorkflowErrorJson | undefined;
      return failure === undefined ? { status: "completed" } : { status: "completed", failure };
    }
    case "pending":
    case "running":
      return { status };
  }
}

function isStoppedEnvelope(
  value: Record<string, unknown>,
): value is DwfStoppedEnvelope & Record<string, unknown> {
  return typeof value.stopReason === "string" && STOP_REASONS.has(value.stopReason);
}

/**
 * Logical status filter -> SQL predicate (push down `listRuns` statuses). `stopped` and `errored`
 * share physical `failed` column values; distinguish them by the code in `failure_json`, using
 * SQLite json_extract in SQL rather than fetching a page and filtering afterward (which would
 * distort the limit and truncation detection).
 */
export function encodeRunStatusPredicate(statuses: readonly RunStatus[]): {
  sql: string;
  params: string[];
} {
  const clauses: string[] = [];
  const params: string[] = [];
  for (const status of statuses) {
    switch (status) {
      case "stopped":
        clauses.push(
          "(status = 'cancelled' or (status = 'failed' and json_extract(failure_json, '$.code') = ?))",
        );
        params.push(INTERRUPTED_CODE);
        break;
      case "errored":
        clauses.push(
          "(status = 'failed' and coalesce(json_extract(failure_json, '$.code'), '') <> ?)",
        );
        params.push(INTERRUPTED_CODE);
        break;
      default:
        clauses.push("status = ?");
        params.push(status);
    }
  }
  return { sql: clauses.length === 0 ? "0" : `(${clauses.join(" or ")})`, params };
}

export interface DwfRunRow {
  args_json: string | null;
  caps_max_concurrency: number;
  cwd: string | null;
  failure_json: string | null;
  id: string;
  name: string | null;
  parent_session_id: string | null;
  result_json: string | null;
  /** amend-resume lineage pointer (added by a later migration). The narrow projection selects it too; see {@link DwfRunMetadataRow}. */
  resumed_from: string | null;
  script_hash: string | null;
  script_text: string | null;
  /** Run-level token usage (formerly called budget_spent; same number, no longer described as a budget). */
  spent_tokens: number;
  /** Physical vocabulary (see the mapping table in the header); logical status is decoded from this and failure_json by {@link decodeRunSettlement}. */
  status: DwfRunPhysicalStatus;
  time_created: number;
  time_updated: number;
  tool_call_id: string | null;
}

/**
 * **Metadata columns** of dwf_run (excluding potentially large result_json). List queries select
 * only these columns: decoding result_json for a 50-row page would load all those artifacts into
 * memory, though the list view does not display them.
 *
 * Physical `failed` can mean errored or stopped(interrupted), so logical status can be decoded
 * only together with failure_json. That is a small structured object (code + message + envelope),
 * safe to decode per row. List rows still **omit** the `failure` field.
 *
 * The arguments are a small JSON object validated against a declaration, and the GUI hub's run
 * history rows display them. Only failure/result are unbounded artifact columns.
 *
 * `resumed_from` belongs in this projection (it is not one of the omitted large columns): it is a
 * short string, and the decoding rule "absent = not a revision" requires selecting the column.
 * If omitted, `row.resumed_from` is undefined in the narrow query and takes a different branch
 * from NULL, causing list rows to contain a key with value undefined.
 */
export type DwfRunMetadataRow = Omit<DwfRunRow, "result_json">;

 /** Journal row timestamps. `RunRecord` deliberately omits time (the engine does not care), but read views report created/updated. */
export interface DwfRunTimestamps {
  timeCreated: number;
  timeUpdated: number;
}

/**
 * A list-query row: run metadata + timestamps, **excluding** failure/result. The detail row is a
 * superset, so list and get read paths can share label and ownership derivation.
 */
export type DwfRunListItem = Omit<RunRecord, "failure" | "result"> & DwfRunTimestamps;

 /** A detail-query row: complete `RunRecord` (including failure/result) + timestamps. */
export type DwfRunDetailRow = RunRecord & DwfRunTimestamps;

/**
 * A session-list query row: {@link DwfRunListItem} + `failure`, **still excluding result**.
 *
 * Why not use {@link DwfRunListItem} directly: the session-list surface (`listRunsForSession` ->
 * `/dwf list`) reports failureCode/failureMessage, and `resumable` means "failed with code
 * Interrupted." Omitting failure_json would classify every interrupted run as non-resumable,
 * a silent wrong answer rather than a missing display column.
 *
 * Why still omit result_json: that column is genuinely unbounded (the script's top-level return
 * value), and list views never display artifacts. failure_json is a small structured object
 * (code + message), safe to decode per row.
 */
export type DwfRunSessionRow = DwfRunMetadataRow;

 /** Record shape for {@link DwfRunSessionRow}. */
export type DwfRunSessionListItem = DwfRunListItem & Pick<RunRecord, "failure">;

export interface DwfActorRow {
  id: number;
  name: string | null;
  ordinal: number;
  persona_json: string | null;
  resolved_model: string | null;
  run_id: string;
  session_id: string | null;
  site_id: string;
  time_created: number;
  time_updated: number;
}

export interface DwfNodeRow {
  actor_ordinal: number | null;
  actor_seq: number | null;
  actor_site_id: string | null;
  /**
   * ID of a user-facing artifact (added by a later migration). Rows with `kind = 'artifact'` carry
   * the artifact they published/declared; labeled rows with `kind = 'report'` carry the predefined
   * artifact they feed. Other rows are NULL.
   * Note: unrelated to `RunSettlement.artifact` (the script's top-level return value).
   */
  artifact_id: string | null;
  error_json: string | null;
  id: number;
  input_hash: string;
  /** Bounded `{op, args}` for world-read/world-run rows (added by a later migration); other and older rows are NULL. */
  input_json: string | null;
  kind: NodeKind;
  /** Length of the actor session message log after ask settlement (count offset, added by a later migration). */
  message_boundary: number | null;
  ordinal: number;
  result_json: string | null;
  run_id: string;
  site_id: string;
  stats_json: string | null;
  status: NodeRecordStatus;
  time_created: number;
  time_updated: number;
}

/**
 * A workspace-read row: `NodeRecord` for world-read/world-run (**without `result`**; the body has
 * its own read path by (siteId, ordinal)) + journal timestamps + `result_json` byte size (the
 * listing can report "how large" without decoding the body).
 */
export interface DwfWorldNodeRow extends Omit<NodeRecord, "result">, DwfRunTimestamps {
  /** UTF-8 byte length of `result_json`; absent if the row is unsettled or settlement failed. */
  resultBytes?: number;
  /**
   * Element count when the body is a JSON array (file count for `glob`, match count for `grep`,
   * path count for `git.changedFiles`). Computed by SQLite JSON functions in the query; the body
   * itself is not loaded.
   */
  resultCount?: number;
  /** `exitCode` from a settled `world.run` body; absent for other ops and unsettled rows. */
  exitCode?: number;
  /** UTF-8 byte lengths of `stdout`/`stderr` after `world.run` settles. */
  stdoutBytes?: number;
  stderrBytes?: number;
}

export interface DwfEventRow {
  id: number;
  payload_json: string;
  run_id: string;
  sequence: number;
  time_created: number;
  type: string;
}

/**
 * Dedicated encoding for the `result` column. `null` is a valid ask result (`ask<T | null>` can
 * return it), while shared encodeJson maps both undefined and null to SQL NULL; then a persisted
 * `result: null` would read back as "no result." Here only undefined maps to SQL NULL.
 */
export function encodeResultJson(value: unknown): string | null {
  if (value === undefined) return null;
  const text = JSON.stringify(value);
  return text === undefined ? null : text;
}

/**
 * Shared decoder for run metadata. Full-record and list rows both start here, so the two read paths
 * cannot diverge on which optional columns count as absent.
 */
function decodeRunMetadata(row: DwfRunMetadataRow): Omit<RunRecord, "failure" | "result"> {
  const caps: Caps = { maxConcurrency: row.caps_max_concurrency };

  const settlement = decodeRunSettlement(row.status, row.failure_json);
  const record: Omit<RunRecord, "failure" | "result"> = {
    runId: row.id,
    caps,
    spentTokens: row.spent_tokens,
    status: settlement.status,
  };
  if (settlement.stopReason !== undefined) record.stopReason = settlement.stopReason;
  if (settlement.supersededBy !== undefined) record.supersededBy = settlement.supersededBy;
  if (row.parent_session_id !== null) record.parentSessionId = row.parent_session_id;
  if (row.cwd !== null) record.cwd = row.cwd;
  // Rows from before this column was added have name=NULL (new column, no backfill); decode as an **absent key** so readers use the script's first-line fallback.
  if (row.name !== null) record.name = row.name;
  // Older persisted rows have no value in this column (NULL means absent); decode as an absent key so historical runs still read as before.
  if (row.tool_call_id !== null) record.toolCallId = row.tool_call_id;
  if (row.script_text !== null) record.scriptText = row.script_text;
  if (row.script_hash !== null) record.scriptHash = row.script_hash;
  // Older rows and every non-revision run (the vast majority) have NULL here; decode as an **absent key**.
  // Readers use this to decide whether this run needs its import cache rebuilt.
  if (row.resumed_from !== null) record.resumedFrom = row.resumed_from;
  // Older persisted rows have no value in this column (NULL means absent): decode as an **absent
  // key**, not `{}`, so "no arguments" remains distinguishable from "empty object" in the record.
  // The sandbox consistently reads absence as `{}` (invariant 7).
  if (row.args_json !== null) record.args = JSON.parse(row.args_json) as Record<string, unknown>;
  return record;
}

export function decodeRun(row: DwfRunRow): RunRecord {
  const record: RunRecord = decodeRunMetadata(row);
  const { failure } = decodeRunSettlement(row.status, row.failure_json);
  if (failure !== undefined) record.failure = failure;
  // Older persisted rows have no value (the new column is NULL): decode as an **absent key**, not
  // an undefined value or an error, or no historical run would read after upgrade. `result: null`
  // follows the same JSON.parse path, so valid null artifacts still appear in records (the same
  // convention as node result_json).
  if (row.result_json !== null) record.result = JSON.parse(row.result_json);
  return record;
}

  /** List row: metadata + timestamps. */
export function decodeRunListItem(row: DwfRunMetadataRow): DwfRunListItem {
  return {
    ...decodeRunMetadata(row),
    timeCreated: row.time_created,
    timeUpdated: row.time_updated,
  };
}

/** Detail row: full record + timestamps. */
export function decodeRunDetailRow(row: DwfRunRow): DwfRunDetailRow {
  return { ...decodeRun(row), timeCreated: row.time_created, timeUpdated: row.time_updated };
}

/** Session-list row: metadata + timestamps + failure (do not decode result_json; that column is not selected). */
export function decodeRunSessionListItem(row: DwfRunSessionRow): DwfRunSessionListItem {
  const item: DwfRunSessionListItem = decodeRunListItem(row);
  const { failure } = decodeRunSettlement(row.status, row.failure_json);
  if (failure !== undefined) item.failure = failure;
  return item;
}

export function decodeActor(row: DwfActorRow): ActorRecord {
  const record: ActorRecord = {
    runId: row.run_id,
    siteId: row.site_id,
    ordinal: row.ordinal,
  };
  if (row.name !== null) record.name = row.name;
  const persona = decodeJson<PersonaSpec>(row.persona_json);
  if (persona !== undefined) record.persona = persona;
  if (row.session_id !== null) record.sessionId = row.session_id;
  // Rows from before this column was added have NULL here; decode as an **absent key** so historical actor records still read.
  if (row.resolved_model !== null) record.resolvedModel = row.resolved_model;
  return record;
}

export function decodeNode(row: DwfNodeRow): NodeRecord {
  const record: NodeRecord = {
    runId: row.run_id,
    siteId: row.site_id,
    ordinal: row.ordinal,
    kind: row.kind,
    inputHash: row.input_hash,
    status: row.status,
  };
  if (row.actor_site_id !== null) record.actorSiteId = row.actor_site_id;
  if (row.actor_ordinal !== null) record.actorOrdinal = row.actor_ordinal;
  if (row.actor_seq !== null) record.actorSeq = row.actor_seq;
  if (row.result_json !== null) record.result = JSON.parse(row.result_json);
  const error = decodeJson<WorkflowErrorJson>(row.error_json);
  if (error !== undefined) record.error = error;
  const stats = decodeJson<AskStats>(row.stats_json);
  if (stats !== undefined) record.stats = stats;
  // Older rows, non-ask nodes, and asks whose driver has not written the boundary yet are NULL -> absent key.
  // `0` is a **valid boundary** (copy zero messages), so check `!== null`, not truthiness.
  if (row.message_boundary !== null) record.messageBoundary = row.message_boundary;
  // Older rows and every report/ask/world-* row that is neither an artifact row nor labeled are
  // NULL -> decode as an **absent key** (not an undefined value). Dashboard queries filter by
  // matching artifact_id; a key set to undefined would fail the full-record toEqual contract test.
  if (row.artifact_id !== null) record.artifactId = row.artifact_id;
  // Rows before 0030 and ask/report/artifact rows are NULL -> absent key (readers then fall back to static labels).
  const input = decodeJson<WorldReadInput>(row.input_json);
  if (input !== undefined) record.input = input;
  return record;
}

export function decodeEvent(row: DwfEventRow): StoredEvent {
  return {
    sequence: row.sequence,
    event: JSON.parse(row.payload_json) as RunEvent,
    // The only clock in the event log: row age and the subagent's last-action time both derive
    // from it. The column is always populated since 0019, so write it unconditionally here.
    timeCreated: row.time_created,
  };
}
