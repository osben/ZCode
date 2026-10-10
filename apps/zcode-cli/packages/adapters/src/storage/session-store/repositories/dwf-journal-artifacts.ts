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
import { decodeNode, type DwfEventRow, type DwfNodeRow } from "./dwf-journal-codecs.js";

   /** Pagination options for {@link listArtifactItems} (cursor = journal sequence). */
export interface DwfArtifactItemsQuery {
  /**
   * Return only entries with a sequence **strictly greater** than this value. The cursor is the last sequence
   * read, not an offset, with exactly the same semantics as `listEvents`; the board hook already uses this cursor.
   */
  afterSequence?: number;
  /**
   * Maximum items per page, **required**. The storage layer does not guess a default for callers; an unbounded
   * query is the one shape this API must never have.
   *
   * But **do not add another cap here** (such as `Math.min(500, limit)`). Callers may validly pass “clamped
   * limit + 1” to determine `hasMore` (the extra row is not included in the page). A hard cap would silently drop
   * that probe row, making `hasMore` absent whenever limit equals the cap. This is the same reasoning as the
   * truncation-probe row for `DwfListRunsQuery.limit`.
   */
  limit: number;
}

/**
 * A `report` entry for a preset artifact, **identified by journal sequence**.
 *
 * Why the key is sequence rather than (siteId, ordinal): the UI's incremental-read cursor uses journal sequence
 * (`afterSequence`), matching the run-event query, but dwf_node has no sequence. Return the site coordinates too;
 * the reveal animation needs a React key stable across refetches, and both sequence and coordinates provide one.
 */
export interface DwfArtifactItem {
  /** Original reported item (arbitrary JSON; `REPORT_CAPS` bounds it on write). */
  item: unknown;
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
): DwfArtifactItem[] {
  // limit ≤ 0 means an empty page (`listEvents`'s `limit -1` convention for “all” does not apply here; the
  // board's read surface is always bounded). Enforce a floor here, but no ceiling; see {@link DwfArtifactItemsQuery}.limit.
  if (query.limit <= 0) return [];
  const after = query.afterSequence;
  const cursor = after === undefined ? "" : " and sequence > ?";
  const rows = db
    .prepare(
      `
      select sequence, payload_json from dwf_event
      where run_id = ?
        and type = 'report'
        and json_extract(payload_json, '$.artifactId') = ?${cursor}
      order by sequence
      limit ?
      `,
    )
    .all(
      runId,
      artifactId,
      ...(after === undefined ? [] : [after]),
      query.limit,
    ) as unknown as Pick<DwfEventRow, "payload_json" | "sequence">[];
  return rows.map((row) => {
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
}
