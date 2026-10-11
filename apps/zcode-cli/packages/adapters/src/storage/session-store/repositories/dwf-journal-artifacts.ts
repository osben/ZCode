/**
 * The two host read surfaces for user-facing **artifacts**.
 *
 * ⚠ Here, an artifact is a deliverable **published by a script for users** (file / markdown / preset board), not
 * `RunSettlement.artifact` (the script's top-level return value). Both meanings coexist.
 *
 * Why this lives **outside** `JournalStorePort`: the reasoning is exactly the same as for `listRuns`—the engine
 * follows its own ordinal chain through `listNodes` and is never responsible for “which artifacts this run has”
 * or “which items a board received.” Adding these to the domain port would require every journal implementation
 * (including the engine's in-memory implementation) to implement behavior the engine does not use. Consumers
 * probe capability (`typeof journal.listArtifactRows === "function"`) to determine whether the read surface is
 * available; `DwfRunIntrospectionQueries` is the single source of truth for signatures.
 *
 * Why this lives **outside** dwf-journal.ts: both queries need only a db handle and share no state with run/actor/node/event
 * reads or writes, while each carries a substantial explanation of its data source and ordering. This follows the
 * same separation as dwf-journal-codecs.ts.
 */

import type { DatabaseSync } from "node:sqlite";
import type { NodeRecord } from "@zcode/dynamic-workflow";
import { decodeNode, type DwfNodeRow } from "./dwf-journal-codecs.js";
import { listArtifactFieldItems } from "./dwf-journal-fields.js";
import { pageEventRows } from "./dwf-journal-pages.js";

/**
 * Pagination options for {@link listArtifactItems} (cursor = journal sequence). See dwf-journal-pages.ts for the two limits:
 * stop at `limit` items or when adding the next item would exceed `maxBytes`; always include the first item.
 *
 * Both are **required**, and the storage layer applies them exactly without adding its own ceiling: the gateway chooses and clamps page size; an unbounded
 * read query is the one shape this layer must never issue. This layer determines `hasMore` (whether rows remain after the page), so callers do not need
 * to guess by fetching an extra item.
 */
export interface DwfArtifactItemsQuery {
  /**
   * Return only entries with a sequence **strictly greater** than this value. The cursor is the last sequence
   * read, not an offset, with exactly the same semantics as `listEvents`; the board hook already uses this cursor.
   */
  afterSequence?: number;
  limit: number;
  maxBytes: number;
  /**
   * Select only these field paths (dwf-journal-fields.ts), with each value capped at `maxValueBytes`; when present, entries include
   * `fields` instead of `item`, and `maxBytes` counts the selected field values. Absent means the entire item.
   */
  fields?: { paths: readonly string[]; maxValueBytes: number };
}

/**
 * A `report` entry for a preset artifact, **identified by journal sequence**.
 *
 * Why the key is sequence rather than (siteId, ordinal): the UI's incremental-read cursor uses journal sequence
 * (`afterSequence`), matching the run-event query, but dwf_node has no sequence. Return the site coordinates too;
 * the reveal animation needs a React key stable across refetches, and both sequence and coordinates provide one.
 */
export interface DwfArtifactItem {
  /** Original reported item (arbitrary JSON; `REPORT_CAPS` bounds it on write). Absent when selecting fields only. */
  item?: unknown;
  /** Fields-only selection: path → value; paths that cannot be resolved are omitted. */
  fields?: Record<string, unknown>;
  ordinal: number;
  sequence: number;
  siteId: string;
}

/**
 * **Artifact rows** for this run (`kind = 'artifact'`), ordered by insertion (`order by id`).
 *
 * One row = one version (publishing the same id again creates a new row and preserves history), so callers group
 * by `artifactId` and read the version from each row's `result` (`ArtifactVersionRecord`). Ordering is **insertion
 * order**, not `order by artifact_id, ordinal`: version order is insertion order, and rows for the same id only
 * happen to be contiguous. Relying on that coincidence would make versions appear out of order for an interleaving script.
 *
 * Failed publications are included too (`status: "failed"` + `error`): the read surface must be able to report
 * “this publication failed.” Filtering them out would make a user-visible failure disappear from every surface.
 */
export function listArtifactRows(db: DatabaseSync, runId: string): NodeRecord[] {
  const rows = db
    .prepare("select * from dwf_node where run_id = ? and kind = 'artifact' order by id")
    .all(runId) as unknown as DwfNodeRow[];
  return rows.map(decodeNode);
}

/**
 * Count tagged reports for each declared artifact (`itemCount`, the dashboard's item count). Push `group by` down to SQLite;
 * `dwf_node_artifact_idx (run_id, artifact_id)` is designed for this query, so not a single row needs to be read. Previously the host loaded the entire
 * node table (including every report item) into memory and counted in JS; listing artifacts for a run with 65,536 reports decoded every item
 * on every query (docs/execution-engine.md, “Reading the journal”).
 */
export function countTaggedReports(db: DatabaseSync, runId: string): ReadonlyMap<string, number> {
  const rows = db
    .prepare(
      `
      select artifact_id, count(*) as total from dwf_node
      where run_id = ? and kind = 'report' and artifact_id is not null
      group by artifact_id
      `,
    )
    .all(runId) as unknown as { artifact_id: string; total: number | bigint }[];
  return new Map(rows.map((row) => [row.artifact_id, Number(row.total)]));
}

/**
 * Paginate `report` entries for a preset artifact in ascending journal sequence (the board's read surface).
 *
 * Read from **dwf_event rather than dwf_node**, even though both tables record the same tagged reports. The cursor
 * determines the choice: the UI incrementally fetches using event-log `sequence`, which dwf_node lacks; it has
 * only a composite (siteId, ordinal) coordinate. Inventing a total order from that would create a second cursor
 * semantic for the same data. The filter can therefore be pushed down as
 * `json_extract(payload_json, '$.artifactId') = ?`, which matches the expression index `dwf_event_artifact_idx` (0029).
 *
 * Include `type = 'report'` in the condition too: the `type` column is duplicated for pushdown (it also appears
 * in the payload). Without it, another event carrying `artifactId` could enter the board stream. Today only
 * `artifact-published` exists and uses nested `artifact.id`, not top-level `artifactId`, but that may change.
 *
 * Untagged reports are naturally excluded: their payloads have no `artifactId` key, so `json_extract` returns
 * NULL and SQL `= ?` does not match NULL.
 */
export function listArtifactItems(
  db: DatabaseSync,
  runId: string,
  artifactId: string,
  query: DwfArtifactItemsQuery,
): { items: DwfArtifactItem[]; hasMore: boolean } {
  if (query.fields !== undefined) {
    return listArtifactFieldItems(db, runId, artifactId, {
      ...(query.afterSequence === undefined ? {} : { afterSequence: query.afterSequence }),
      fields: query.fields.paths,
      limit: query.limit,
      maxBytes: query.maxBytes,
      maxValueBytes: query.fields.maxValueBytes,
    });
  }
  const { rows, hasMore } = pageEventRows(db, runId, query, {
    sql: " and type = 'report' and json_extract(payload_json, '$.artifactId') = ?",
    params: [artifactId],
  });
  const items = rows.map((row) => {
    // The payload is the `RunEvent` stringified as-is by appendEvent, so this narrow shape shares the same source as
    // `{ type: "report"; instance: InstanceRef; item: unknown; artifactId?: string }`.
    const payload = JSON.parse(row.payload_json) as {
      instance: { ordinal: number; siteId: string };
      item: unknown;
    };
    return {
      sequence: row.sequence,
      siteId: payload.instance.siteId,
      ordinal: payload.instance.ordinal,
      item: payload.item,
    };
  });
  return { items, hasMore };
}
