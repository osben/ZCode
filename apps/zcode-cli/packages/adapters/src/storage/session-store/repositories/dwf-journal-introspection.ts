/**
 * dwf-journal.ts reached oxlint's max-lines limit (400 lines), so the host-side **run introspection
 * read surface** (`DwfRunIntrospectionQueries` and its SQL) moved here. Public exports still come
 * from dwf-journal.ts; `SqliteDwfJournalStore` only delegates.
 *
 * This uses the same split as dwf-journal-artifacts.ts: these queries need only a db handle and
 * share no state with run/actor/node/event writes or reads, while each has substantial rationale
 * for its data source and sort order. The engine's `JournalStorePort` write surface does not belong
 * here; there are no writers in this file.
 */

import type { DatabaseSync } from "node:sqlite";
import type { NodeRecord, NodeRecordStatus, RunStatus, StoredEvent } from "@zcode/dynamic-workflow";
import type { DwfArtifactItem, DwfArtifactItemsQuery } from "./dwf-journal-artifacts.js";
import type { DwfEventPageQuery } from "./dwf-journal-pages.js";
import {
  decodeEvent,
  decodeNode,
  decodeRunDetailRow,
  decodeRunListItem,
  decodeRunSessionListItem,
  type DwfEventRow,
  type DwfNodeRow,
  type DwfWorldNodeRow,
  type DwfRunDetailRow,
  type DwfRunListItem,
  type DwfRunMetadataRow,
  type DwfRunRow,
  type DwfRunSessionListItem,
  type DwfRunSessionRow,
  encodeRunStatusPredicate,
} from "./dwf-journal-codecs.js";

   /** Query options for {@link DwfRunIntrospectionQueries.listRuns}. */
export interface DwfListRunsQuery {
  /**
   * Project key. Literal equality against `dwf_run.cwd` (stored as-is by writes and queried as-is by reads).
   *
   * **Optional**: when omitted, do not add a cwd predicate and list across all projects. Global
   * workflow history spans every project where it has been launched (the `scope: "global"` variant
   * of `workflows/runs`); project-scoped variants still pass cwd and behave exactly as before.
   */
  cwd?: string;
  /**
   * Maximum returned rows, **required**. The caller owns clamping (the tool surface clamps to
   * [1, 50]); the storage layer must not guess a default. An unbounded enumeration query is the one
   * shape that must not exist here.
   *
   * But **do not add another ceiling here** (such as `Math.min(50, limit)`). The caller may
   * legitimately pass "clamped maximum + 1": the run service fetches one extra row to detect
   * `truncated` (that extra row is not included in the page). A hard cap of 50 would silently drop
   * the probe row, so `truncated` would be permanently absent at **exactly** limit = 50—the page
   * size where users most need to know there is more, and no test at another limit would catch it.
   */
  limit: number;
  /** Optional status subset. Omitted means no filter; an empty array means "match no statuses" (return an empty page). */
  statuses?: readonly RunStatus[];
  /**
   * Optional run name (literal equality with `dwf_run.name`). The GUI hub associates run history by
   * "workflow name = run name," so push the filter into SQL rather than filtering a page afterward;
   * otherwise a frequently run workflow can push others off-page and make the card's "last run" wrong.
   */
  name?: string;
}

   /** Three-state counts for dwf_node (all `NodeRecordStatus` values; all three keys are always present). */
export interface DwfNodeStatusCounts {
  completed: number;
  failed: number;
  running: number;
}

/**
 * Start and end (epoch milliseconds) of one **life** of a run, from one `run-started` event through its final event.
 *
 * A life is one interval when the engine is alive. A crashed or stopped life has no `run-settled`,
 * so its end is defined by the last event recorded in that life—the last time it did anything.
 * Both timestamps come from `dwf_event.time_created` (the event log's sole clock for "how long
 * ago" values), so their difference never crosses clocks.
 */
export interface DwfRunLifeSpan {
  startedAt: number;
  lastActivityAt: number;
}

/**
 * Host-side run introspection query surface (data source for the read-only `ListWorkflowRuns` and `GetWorkflowRun` tools).
 *
 * Deliberately **do not widen** the engine's `JournalStorePort`; the rationale is identical to
 * {@link SqliteDwfJournalStore.listNonTerminalRuns}: the engine reads/writes only its own row by
 * runId, never enumerates runs or aggregates counts. Adding these to the domain port would require
 * every journal implementation (including the engine's in-memory implementation) to support work
 * the engine does not perform.
 *
 * Consumers detect capability (`typeof journal.listRuns === "function"`) to decide whether the
 * tool is available, so this interface is the **sole** source of signatures between host and
 * adapter. Duplicating signatures in both places would let them drift, silently downgrading the
 * tool to "this session lacks the capability."
 */
export interface DwfRunIntrospectionQueries {
  countNodesByStatus(runId: string): DwfNodeStatusCounts;
  getRunRow(runId: string): DwfRunDetailRow | undefined;
  listArtifactItems(
    runId: string,
    artifactId: string,
    query: DwfArtifactItemsQuery,
  ): { items: DwfArtifactItem[]; hasMore: boolean };
  /** One page of the event log: item and byte limits (dwf-journal-pages.ts); the storage layer determines `hasMore`. */
  listEventPage(
    runId: string,
    query: DwfEventPageQuery,
  ): { events: StoredEvent[]; hasMore: boolean };
  listArtifactRows(runId: string): NodeRecord[];
  /** Number of tagged reports for each declared artifact (`group by artifact_id`, without reading the rows). */
  countTaggedReports(runId: string): ReadonlyMap<string, number>;
  listRecentLogEvents(runId: string, limit: number): StoredEvent[];
  listRuns(query: DwfListRunsQuery): DwfRunListItem[];
  /**
   * Active intervals for each generation of this run, in chronological order (the completion card's “Time” field; see
   * `docs/dynamic-workflow/transcript-and-notifications.md`, “How long it took”). A run can have multiple generations (one per resume),
   * and only the event log knows each generation's wall-clock interval.
   */
  listRunLifeSpans(runId: string): DwfRunLifeSpan[];
  /**
   * world-read / world-run rows for this run, ordered by insertion (`order by id`) and including journal timestamps
   * (the `workflowRunWorkspace` row in docs/dynamic-workflow/transcript-and-notifications.md). **Do not fetch
   * `result_json`**: this read surface is an index (op / args / status / time); a separate read surface fetches bodies by (siteId, ordinal)—
   * returning a page of 256 nodes with 256 KB of stdout each would load the entire journal into memory.
   */
  listWorldNodes(runId: string): DwfWorldNodeRow[];
}

/**
 * List runs by project (cwd), most recently updated first. As with
 * {@link SqliteDwfJournalStore.listNonTerminalRuns}, the engine never enumerates runs; this is a
 * host read-surface need (`ListWorkflowRuns` tool), so it does not belong in the domain port.
 *
 * Push cwd/statuses/order/limit **all into SQL**; `dwf_run_cwd_idx` (0021) exists for this shape.
 * Fetching all rows and filtering in JS would waste both the index and limit. cwd uses **literal**
 * equality: writes store `context.workingDirectory` as-is and reads query it as-is; normalizing a
 * path on only one side would create a mismatch.
 *
 * Rows use the narrow {@link DwfRunListItem} projection (without failure/result): list views do
 * not display artifacts, which can be large.
 */
export function listRuns(db: DatabaseSync, query: DwfListRunsQuery): DwfRunListItem[] {
  // An empty status set means "match no statuses," not "no filter"; the latter would silently
  // invalidate an explicit filter. Likewise, limit <= 0 returns an empty page (listEvents' `limit
  // -1` convention for fetching all does not apply here; this enumeration is always bounded).
  //
  // Enforce a floor here, but **no ceiling**: the caller may pass "tool-surface maximum + 1" as a
  // truncation probe row. Adding `Math.min(50, ...)` would permanently hide truncated at exactly
  // limit = 50. See {@link DwfListRunsQuery.limit}.
  if (query.statuses !== undefined && query.statuses.length === 0) return [];
  if (query.limit <= 0) return [];

  // Omitted cwd means no predicate: global workflow history spans all projects where it ran (the
  // global variant does not filter by cwd). If supplied, use literal equality via dwf_run_cwd_idx;
  // behavior remains unchanged.
  const cwdFilter = query.cwd === undefined ? "" : " and cwd = ?";
  // Logical status -> physical predicate (stopped/errored share physical failed and are distinguished
  // in SQL by failure_json code; see encodeRunStatusPredicate in dwf-journal-codecs.ts).
  const statusPredicate =
    query.statuses === undefined ? undefined : encodeRunStatusPredicate(query.statuses);
  const statusFilter = statusPredicate === undefined ? "" : ` and ${statusPredicate.sql}`;
  const nameFilter = query.name === undefined ? "" : " and name = ?";
  const rows = db
    .prepare(
      `
      select
        id, parent_session_id, cwd, name, script_text, script_hash, tool_call_id,
        args_json, resumed_from, caps_max_concurrency,
        spent_tokens, status, failure_json, time_created, time_updated
      from dwf_run
      where 1 = 1${cwdFilter}${statusFilter}${nameFilter}
      order by time_updated desc
      limit ?
      `,
    )
    .all(
      ...(query.cwd === undefined ? [] : [query.cwd]),
      ...(statusPredicate?.params ?? []),
      ...(query.name === undefined ? [] : [query.name]),
      query.limit,
    ) as unknown as DwfRunMetadataRow[];
  return rows.map(decodeRunListItem);
}

/**
 * Full row for one run + journal timestamps. `getRun` returns a `RunRecord` without timestamps
 * (the engine does not care), but the detail view reports createdAt/updatedAt and **must read the
 * journal directly**; after an entry evaporates, an in-memory snapshot would report a false start time.
 */
export function getRunRow(db: DatabaseSync, runId: string): DwfRunDetailRow | undefined {
  const row = db.prepare("select * from dwf_run where id = ?").get(runId) as DwfRunRow | undefined;
  return row ? decodeRunDetailRow(row) : undefined;
}

/**
 * Aggregate node counts by status for this run. Count in SQL: the detail view needs only three
 * numbers, so reading all dwf_node rows and counting them would be a more expensive way to get the
 * same answer (node count has no bound beyond the general limit).
 *
 * All three keys are always present (missing nodes mean 0): downstream sums them directly for
 * nodesObserved, and a missing key would turn "no nodes yet" into NaN. The vocabulary is the three
 * values of `NodeRecordStatus`; `queued` exists only in event phases, not in persisted rows.
 */
export function countNodesByStatus(db: DatabaseSync, runId: string): DwfNodeStatusCounts {
  const rows = db
    .prepare("select status, count(*) as total from dwf_node where run_id = ? group by status")
    .all(runId) as unknown as { status: NodeRecordStatus; total: number }[];
  const counts: DwfNodeStatusCounts = { running: 0, completed: 0, failed: 0 };
  for (const row of rows) counts[row.status] = Number(row.total);
  return counts;
}

/**
 * Return the last N `log` events for this run, in chronological order (sequence ascending).
 *
 * Fetch with `order by sequence desc limit ?`, then reverse in JS. For a long run, dwf_event is
 * its largest table; loading the entire journal for a few tail entries is exactly what pagination
 * is meant to prevent. Push type filtering down too; the `type` column is stored redundantly for
 * this purpose (it is also present in payload_json).
 */
export function listRecentLogEvents(db: DatabaseSync, runId: string, limit: number): StoredEvent[] {
  if (limit <= 0) return [];
  const rows = db
    .prepare(
      "select * from dwf_event where run_id = ? and type = 'log' order by sequence desc limit ?",
    )
    .all(runId, limit) as unknown as DwfEventRow[];
  return rows.reverse().map(decodeEvent);
}

/**
 * Activity intervals for each life of this run (`run-started` time -> that life's final event time), ordered by time.
 *
 * See `docs/dynamic-workflow/transcript-and-notifications.md`, “How long it took,” for the definition: the completion card duration is the sum of **active**
 * intervals across the lineage, with a separate interval for every generation of a run. Gaps between generations (process stopped, not yet resumed)
 * contain no activity and must not be counted.
 *
 * One SQL query, and **no payload decoding**: `lead()` pairs each life's start with the next life's
 * start to form intervals; a correlated subquery finds the timestamp of the highest sequence in
 * each interval. Both predicates use `unique(run_id, sequence)`; the `type` column is redundant
 * specifically for this filtering (also present in payload_json). An 18k-event run therefore reads
 * only a few rows instead of decoding 2.8 MB of payload into memory—the reason this read surface
 * deliberately avoids `listEvents`.
 *
 * The subquery always has a result (each interval contains its own `run-started`), so normal rows
 * do not return null; still narrow defensively because this crosses a storage boundary and null
 * would silently become NaN milliseconds.
 */
export function listRunLifeSpans(db: DatabaseSync, runId: string): DwfRunLifeSpan[] {
  const rows = db
    .prepare(
      `
      with lives as (
        select sequence, time_created,
               lead(sequence) over (order by sequence) as next_sequence
        from dwf_event
        where run_id = ? and type = 'run-started'
      )
      select
        l.time_created as started_at,
        (
          select e.time_created
          from dwf_event e
          where e.run_id = ?
            and e.sequence >= l.sequence
            and (l.next_sequence is null or e.sequence < l.next_sequence)
          order by e.sequence desc
          limit 1
        ) as last_activity_at
      from lives l
      order by l.sequence
      `,
    )
    .all(runId, runId) as unknown as { started_at: number; last_activity_at: number | null }[];
  return rows.map((row) => ({
    startedAt: Number(row.started_at),
    lastActivityAt:
      typeof row.last_activity_at === "number"
        ? Number(row.last_activity_at)
        : Number(row.started_at),
  }));
}

/**
 * Runs under one parent session (most recently updated first, up to limit rows). This is the
 * service/host enumeration surface (`DynamicWorkflowRunPort.listRunsForSession` -> discovery query
 * after UI restart): the `workflowRuns` projection does not survive process boundaries, so tool
 * card joins and Resume button availability must be reconstructed from this table.
 *
 * Same family as {@link SqliteDwfJournalStore.listNonTerminalRuns}: a narrow host query, deliberately
 * outside the engine's JournalStorePort. No index: dwf_run row counts are on the order of workflow
 * runs per session (single to low double digits), so a full scan is acceptable. If that scale
 * changes, the index should be (parent_session_id, time_updated).
 *
 * Rows use the narrow {@link DwfRunSessionListItem} projection: **do not select `result_json`**—it
 * is the script's top-level return value and genuinely unbounded, while list views never display
 * artifacts. `failure_json` must be selected: the session list reports failureCode, and
 * `resumable` means "failed with code Interrupted." Omitting it would silently classify every
 * interrupted run as non-resumable. Return timestamps with the row (`RunRecord` deliberately has none).
 */
export function listRunsByParentSession(
  db: DatabaseSync,
  parentSessionId: string,
  limit: number,
): DwfRunSessionListItem[] {
  const rows = db
    .prepare(
      `
      select
        id, parent_session_id, cwd, name, script_text, script_hash, tool_call_id,
        args_json, resumed_from, caps_max_concurrency,
        spent_tokens, status, failure_json, time_created, time_updated
      from dwf_run
      where parent_session_id = ?
      order by time_updated desc, id desc
      limit ?
      `,
    )
    .all(parentSessionId, Math.max(0, limit)) as unknown as DwfRunSessionRow[];
  return rows.map(decodeRunSessionListItem);
}

export function listWorldNodes(db: DatabaseSync, runId: string): DwfWorldNodeRow[] {
  const rows = db
    .prepare(
      `
      select
        run_id, site_id, ordinal, kind, actor_site_id, actor_ordinal, actor_seq, input_hash,
        status, error_json, stats_json, message_boundary, artifact_id, input_json,
        length(cast(result_json as blob)) as result_bytes,
        case when json_type(result_json) = 'array' then json_array_length(result_json) end
          as result_count,
        case when json_type(result_json) = 'object' then json_extract(result_json, '$.exitCode') end
          as exit_code,
        case when json_type(result_json) = 'object'
          then length(cast(json_extract(result_json, '$.stdout') as blob)) end as stdout_bytes,
        case when json_type(result_json) = 'object'
          then length(cast(json_extract(result_json, '$.stderr') as blob)) end as stderr_bytes,
        time_created, time_updated
      from dwf_node
      where run_id = ? and kind in ('world-read', 'world-run')
      order by id
      `,
    )
    .all(runId) as unknown as (Omit<DwfNodeRow, "id" | "result_json"> & {
    result_bytes: number | null;
    result_count: number | null;
    exit_code: number | null;
    stdout_bytes: number | null;
    stderr_bytes: number | null;
  })[];
  return rows.map((row) => {
    const record = decodeNode({ ...row, id: 0, result_json: null });
    return {
      ...record,
      timeCreated: row.time_created,
      timeUpdated: row.time_updated,
      ...(row.result_bytes === null ? {} : { resultBytes: row.result_bytes }),
      ...(row.result_count === null ? {} : { resultCount: row.result_count }),
      ...(typeof row.exit_code === "number" ? { exitCode: row.exit_code } : {}),
      ...(row.stdout_bytes === null ? {} : { stdoutBytes: row.stdout_bytes }),
      ...(row.stderr_bytes === null ? {} : { stderrBytes: row.stderr_bytes }),
    };
  });
}
