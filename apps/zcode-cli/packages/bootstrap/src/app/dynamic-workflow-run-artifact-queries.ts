// ============================================================
// Journal read surface for user-facing artifacts (shared data-access foundation for the three artifact methods on DynamicWorkflowRunPort).
// ============================================================
//
// ⚠ Terminology: artifact here means output a script publishes for **users** through `artifact.*`,
// not the engine's internal `RunSettlement.artifact` (the script's top-level return value).

import type { DwfArtifactItem, DwfRunIntrospectionQueries } from "@zcode/adapters/storage";
import type { DynamicWorkflowRunArtifactItem } from "@zcode/contracts";
import type { JournalStorePort, NodeRecord } from "@zcode/dynamic-workflow";
import { WORKFLOW_ARTIFACT_LIMITS } from "@zcode/shared/zcode-protocol-v4";

/**
 * Journal with the artifact read surface. The **single source** for its signature is adapters'
 * {@link DwfRunIntrospectionQueries} (`import type`, zero runtime dependency), following the same
 * rationale as `DynamicWorkflowIntrospectableJournal`: these queries are not on the engine's
 * {@link JournalStorePort} (the engine neither enumerates artifacts nor joins the event table), so
 * they can only be connected through capability detection.
 */
interface ArtifactReadableJournal
  extends JournalStorePort, Pick<DwfRunIntrospectionQueries, "listArtifactItems" | "listArtifactRows"> {}

/**
 * Whether the journal has the artifact read surface. **Intentionally a sibling of
 * `supportsRunIntrospection`, not an expansion of that capability to six methods.**
 *
 * The first four methods (listRuns / getRunRow / countNodesByStatus / listRecentLogEvents) form one
 * capability: the list needs one, details need the other three, and the whole capability should
 * degrade if any are missing. Artifact reads are a **later**, independent capability. A journal with
 * only the first four methods (an older adapter dist or an introspection-only test double) should
 * still support `ListWorkflowRuns` / `GetWorkflowRun`, just without artifacts. Combining the checks
 * would silently remove both already-working tools for these journals, far from the actual cause.
 */
export function supportsArtifactReads(journal: JournalStorePort): journal is ArtifactReadableJournal {
  const candidate = journal as Partial<DwfRunIntrospectionQueries>;
  return (
    typeof candidate.listArtifactItems === "function" &&
    typeof candidate.listArtifactRows === "function"
  );
}

/**
 * `report` entries for a built-in artifact, one page in ascending journal sequence order.
 *
 * The caller (gateway) supplies both bounds—count and bytes; the storage layer honors them exactly
 * without clamping and decides `hasMore` (docs/execution-engine.md, "Reading the journal"). An
 * out-of-range cursor returns an empty page instead of an error: reaching the end is a normal
 * pagination result, not an exception.
 */
export function listArtifactItemsFrom(
  journal: JournalStorePort,
  runId: string,
  artifactId: string,
  page: { afterSequence?: number; limit: number; maxBytes: number; fields?: readonly string[] },
): { items: DynamicWorkflowRunArtifactItem[]; hasMore: boolean } {
  if (!supportsArtifactReads(journal)) return { items: [], hasMore: false };
  const { items, hasMore } = journal.listArtifactItems(runId, artifactId, {
    ...(page.afterSequence === undefined ? {} : { afterSequence: page.afterSequence }),
    limit: page.limit,
    maxBytes: page.maxBytes,
    // Field projection only: value bounds are protocol constants the storage layer does not set itself.
    ...(page.fields === undefined
      ? {}
      : {
          fields: {
            paths: page.fields,
            maxValueBytes: WORKFLOW_ARTIFACT_LIMITS.maxFieldValueBytes,
          },
        }),
  });
  return { items: items.map(toArtifactItem), hasMore };
}

/**
 * Map one storage row to one port entry. Fields correspond one-to-one; intentionally **do not
 * serialize a preview**. The dashboard's pure functions read values by field path (for example,
 * `ChartSpec.x.field` = "timing.after"), which would not work on pretty-printed JSON text. Single
 * entries are bounded on the write side by `REPORT_CAPS.maxItemSerializedBytes`; a page is bounded
 * by `maxBytes`.
 */
function toArtifactItem(row: DwfArtifactItem): DynamicWorkflowRunArtifactItem {
  return {
    sequence: row.sequence,
    siteId: row.siteId,
    ordinal: row.ordinal,
    ...(row.fields === undefined ? { item: row.item } : { fields: row.fields }),
  };
}

/**
 * Artifact ID claimed by one artifact-node row.
 *
 * Prefer the `dwf_node.artifact_id` column (added by a newer indexed migration); use the record's `id`
 * only as a fallback. The engine writes both in the same putNode call and they are always equal, but
 * an older row with a NULL column must still be readable.
 */
export function artifactRowId(row: NodeRecord): string | undefined {
  if (typeof row.artifactId === "string" && row.artifactId.length > 0) return row.artifactId;
  const record = row.result;
  if (record === null || typeof record !== "object" || Array.isArray(record)) return undefined;
  const id = (record as Record<string, unknown>).id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}
