// ============================================================
// User-facing artifacts portion of the workflowRuns reducer
// ============================================================
// Split out of workflow-runs-reducer.ts to meet the max-lines limit, following workflow-runs-concurrency.ts:
// the main reducer now only dispatches the switch, and the three artifact rules live here. Same constraints: pure functions, no clock, no I/O.
//
// ⚠ Terminology: artifact in this module means output published by a script through
// `artifact.*` for **users**. The artifact in `serializeWorkflowArtifact` (workflow-artifact.ts, singular), called by `resultPreview` in the main reducer, has a **different meaning**:
// the engine's name for a script's top-level return value, which is shown to the model. The two are unrelated.
//
// Each of the three rules has its own key; this is the most important distinction in this module:
//   artifact-published ⇒ upsert by **artifact id**. Republishing the same id creates a new version and must update the same card;
//                        versions of one id come from different **site instances**, so do not use the (siteId, ordinal) key from nodes/actors/reports here.
//   artifact-failed    ⇒ leave state unchanged (the main reducer has a single return for this case). A failed record claims no id, kind,
//                        or version, so there is nothing to upsert.
//   report(artifactId) ⇒ increment itemCount for that id. Deduplicate by (siteId, ordinal), because this is a report
//                        and its identity remains the report's identity.

import {
  WORKFLOW_ARTIFACT_LIMITS,
  type WorkflowRunArtifactKind,
  type WorkflowRunArtifactSummary,
} from "./workflow-artifacts.js";

/** The six supported artifact kinds. The reducer does not validate the schema, so it keeps this closed set for classification. */
const ARTIFACT_KINDS: ReadonlySet<string> = new Set<WorkflowRunArtifactKind>([
  "file",
  "markdown",
  "chart",
  "table",
  "metrics",
  "board",
]);

/**
 * Convert `ArtifactVersionRecord` from an `artifact-published` payload to the snapshot's **latest-version metadata**.
 *
 * Drop `versions` / `spec` / `description` / `uri` / `sourcePath` / `publishedAt`: snapshots are
 * high-frequency state keys, and readers only need to know which artifacts exist, their current version, and whether they changed. Fetch full metadata through
 * `workflowRunArtifacts` and bytes through `workflowRunArtifactRead`; the journal remains authoritative.
 *
 * Without any of `id` / `kind` / `version`, the artifact cannot be displayed (return undefined and only advance the watermark): a card with an
 * unknown kind has neither an icon nor a renderer. Include other fields when present; omit each key when absent.
 */
export function workflowArtifactSummary(value: unknown): WorkflowRunArtifactSummary | undefined {
  if (!isPlainRecord(value)) return undefined;
  const id = nonEmptyString(value.id);
  const kind = nonEmptyString(value.kind);
  const version = value.version;
  if (id === undefined || kind === undefined || !ARTIFACT_KINDS.has(kind)) return undefined;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return undefined;
  const title = nonEmptyString(value.title);
  const contentType = nonEmptyString(value.contentType);
  const bytes = value.bytes;
  return {
    id: id.slice(0, WORKFLOW_ARTIFACT_LIMITS.maxIdLength),
    kind: kind as WorkflowRunArtifactKind,
    ...(title === undefined
      ? {}
      : { title: title.slice(0, WORKFLOW_ARTIFACT_LIMITS.maxTitleLength) }),
    version: Math.min(version, WORKFLOW_ARTIFACT_LIMITS.maxVersions),
    ...(contentType === undefined ? {} : { contentType: contentType.slice(0, 128) }),
    ...(typeof bytes === "number" && Number.isInteger(bytes) && bytes >= 0 ? { bytes } : {}),
    ...(value.primary === true ? { primary: true as const } : {}),
  };
}

/**
 * Upsert into the bounded artifact table by **artifact id**, while **preserving an existing entry's `itemCount`**.
 *
 * Preserving the count is the only substantive difference from `upsertBoundedByInstance` and the reason this function exists: a new version
 * has no `itemCount` (it comes from tagged reports, not from publication). Replacing the whole entry would reset the count on a dashboard receiving data;
 * its refresh signal would reset, and it would stop fetching incremental updates.
 *
 * Limit behavior matches the other three tables: reject new entries and continue updating existing ones.
 */
export function upsertBoundedByArtifactId(
  list: readonly WorkflowRunArtifactSummary[],
  entry: WorkflowRunArtifactSummary,
  limit: number,
): { list: WorkflowRunArtifactSummary[]; truncated: boolean } {
  const index = list.findIndex((item) => item.id === entry.id);
  if (index >= 0) {
    const previous = list[index]!;
    const next = [...list];
    next[index] = {
      ...entry,
      ...(previous.itemCount === undefined ? {} : { itemCount: previous.itemCount }),
    };
    return { list: next, truncated: false };
  }
  if (list.length >= limit) return { list: [...list], truncated: true };
  return { list: [...list, entry], truncated: false };
}

/**
 * A tagged `report` refers to an artifact: increment that id's `itemCount`.
 *
 * **Ignore the count** when the table has no such id (return the original table; the entry still goes into `reports`). This cannot happen at runtime:
 * the tag for `report(item, tag)` must be declared as a preset artifact or the engine calls failRun. This is defensive handling for out-of-order events or incomplete payloads;
 * an undercount is preferable to inventing a card with no spec that cannot be rendered.
 *
 * **The direction of count inaccuracy is intentional.** The deduplication key (siteId, ordinal) comes from the `reports` table, which rejects entries
 * after 64. Beyond that limit, a replayed tagged report cannot be recognized as a replay and may be counted twice. This direction is chosen because `itemCount` is only a
 * **refresh signal**: an extra incremental query with `afterSequence` that returns no rows is harmless. An undercount (for example, stopping all counting at the limit) would freeze the chart at point 64,
 * which defeats this feature. At the limit, `truncated` is set so readers know that both `reports` and `itemCount` are approximate; the journal has the **authoritative** count, paged through `workflowRunArtifactData`.
 */
export function countTaggedReport(
  list: readonly WorkflowRunArtifactSummary[] | undefined,
  artifactId: string,
): WorkflowRunArtifactSummary[] | undefined {
  if (list === undefined) return undefined;
  const index = list.findIndex((item) => item.id === artifactId);
  // Returning undefined means **leave this key unchanged**: the caller omits artifacts entirely, so an idempotent replay produces
  // a byte-for-byte identical run object and the top-level JSON comparison returns null.
  if (index < 0) return undefined;
  const previous = list[index]!;
  const next = [...list];
  next[index] = { ...previous, itemCount: (previous.itemCount ?? 0) + 1 };
  return next;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
