// ============================================================
// Dynamic Workflow Run: merged projection of user-facing artifacts (journal rows → port artifacts).
// ============================================================
// dynamic-workflow-run-observation.ts reached oxlint's 400-line max-lines limit, so the artifact merge logic
// ({@link artifactsOf} and its private decoder) was moved here. The observation module still re-exports it unchanged, so its four
// callers (snapshot / getRunDetail / listArtifacts / saved-workflows hub) need no changes.
//
// ⚠ Terminology: artifact here means an output **published for the user** through `artifact.*` (a journal
// row with `kind = "artifact"`), not the engine-internal `RunSettlement.artifact` (the script's top-level return value, called
// `output` / `result` at the port). The same word has two meanings.

import type { DwfRunIntrospectionQueries } from "@zcode/adapters/storage";
import type {
  DynamicWorkflowRunArtifact,
  DynamicWorkflowRunArtifactKind,
  DynamicWorkflowRunArtifactVersion,
} from "@zcode/contracts";
import type { JournalStorePort } from "@zcode/dynamic-workflow";

/**
 * **User-facing artifacts** in terminal snapshots and `getRunDetail`'s `artifacts`.
 *
 * ⚠ Terminology: artifact here means an output published for the user through `artifact.*` (a journal row with `kind = "artifact"`),
 * **not** the engine-internal `RunSettlement.artifact` (the script's top-level return value, called `output` /
 * `result` at the port). The same word has two meanings.
 *
 * Data access follows the same rules as the observation surface's `reportsOf`: the journal is the **durable home** of version history (the memory-only
 * `workflowRuns.artifacts` projection contains only latest metadata and is empty after cold recovery). Failed / canceled runs must still return artifacts they already published (a run that dies at step 12 still delivered the earlier chart).
 *
 * `listArtifactRows` is not on the engine's {@link JournalStorePort} (the engine never enumerates or aggregates), so connect it through
 * capability detection. If unavailable, omit the entire field instead of throwing; injected test stores and implementations without introspection queries must remain usable.
 *
 * Merge rules:
 *   - Include only `completed` rows. Failed publishes do not claim an ID or version; counting one in version
 *     history would make UI version 3 point to bytes that never existed.
 *   - Sort rows with the same ID by `version` ascending. Top-level `title` / `contentType` / `sourcePath` / `spec` values come from the **latest version**,
 *     so readers interested only in the current state need not inspect versions themselves.
 *   - `itemCount` = number of `report` rows tagged with this ID (the data count for prebuilt dashboards and the UI refresh signal).
 *     Content artifacts always have 0.
 *
 * If introspection is unavailable, omit the whole field: an empty array implies the run completed
 * but produced nothing, while omission means artifacts are not supported for this run.
 */
export function artifactsOf(
  runId: string,
  journal: JournalStorePort,
): { artifacts?: readonly DynamicWorkflowRunArtifact[] } {
  const candidate = journal as Partial<DwfRunIntrospectionQueries>;
  if (typeof candidate.listArtifactRows !== "function") return {};
  const rows = candidate.listArtifactRows(runId);
  if (rows.length === 0) return {};

  // id → version accumulator. Insertion order = first-seen order, which is the port contract's `artifacts` order.
  const byId = new Map<
    string,
    { kind: DynamicWorkflowRunArtifactKind; versions: DynamicWorkflowRunArtifactVersion[] }
  >();
  for (const row of rows) {
    if (row.status !== "completed") continue;
    const record = row.result;
    if (record === null || typeof record !== "object") continue;
    const version = artifactVersionOf(record as Record<string, unknown>);
    if (version === undefined) continue;
    const id =
      typeof row.artifactId === "string" && row.artifactId.length > 0
        ? row.artifactId
        : stringField(record as Record<string, unknown>, "id");
    const kind = artifactKindOf((record as Record<string, unknown>).kind);
    if (id === undefined || kind === undefined) continue;
    const bucket = byId.get(id);
    if (bucket === undefined) byId.set(id, { kind, versions: [version] });
    else bucket.versions.push(version);
  }
  if (byId.size === 0) return {};

  // Query label counts only when a **prebuilt dashboard actually exists**: content artifact
  // `itemCount` is always 0. The hub can have 50 rows per page and calls this function once per
  // row, so this short circuit keeps runs without dashboards from issuing that group by at all.
  const needsTally = [...byId.values()].some((bucket) => PRESET_ARTIFACT_KINDS.has(bucket.kind));
  const itemCounts = needsTally ? tagItemCounts(runId, journal) : undefined;
  const artifacts = [...byId].map(([id, bucket]) => {
    const versions = [...bucket.versions].sort((left, right) => left.version - right.version);
    // Latest version = row with the highest version number. A bucket cannot be empty; construction adds at least one row.
    const latest = versions[versions.length - 1]!;
    // Flags are sticky by ID (the engine includes them on later versions); any version can set one because rows from older CLIs lack this key.
    const primary = versions.some((version) => version.primary === true);
    return {
      id,
      kind: bucket.kind,
      ...(latest.title === undefined ? {} : { title: latest.title }),
      ...(latest.description === undefined ? {} : { description: latest.description }),
      ...(latest.contentType === undefined ? {} : { contentType: latest.contentType }),
      ...(latest.sourcePath === undefined ? {} : { sourcePath: latest.sourcePath }),
      ...(latest.spec === undefined ? {} : { spec: latest.spec }),
      version: latest.version,
      versions,
      itemCount: itemCounts?.get(id) ?? 0,
      ...(primary ? { primary: true as const } : {}),
    } satisfies DynamicWorkflowRunArtifact;
  });
  // Put deliverables first and preserve first-publish order for the rest:
  // define order here once; snapshots / GetWorkflowRun / hub / v4 queries all read from here, so no limit can truncate it.
  // `Array.prototype.sort` has been stable since ES2019, preserving the relative order of non-primary items.
  artifacts.sort((left, right) => Number(right.primary === true) - Number(left.primary === true));
  return { artifacts };
}

/**
 * Count labeled report rows by ID (`kind = "report" ∧ artifact_id = ?`—the dashboard's data count).
 *
 * The SQLite implementation ships `countTaggedReports` (a pushed-down `group by` that reads no
 * rows); stores without it (the engine's in-memory implementation, test doubles) fall back to
 * reading report-row **metadata** (without items) and counting in memory—both paths return the
 * same number. Fix: this used to read the entire node table with every report item into memory
 * before counting (docs/execution-engine.md "Reading the journal").
 */
function tagItemCounts(runId: string, journal: JournalStorePort): ReadonlyMap<string, number> {
  const candidate = journal as Partial<DwfRunIntrospectionQueries>;
  if (typeof candidate.countTaggedReports === "function")
    return candidate.countTaggedReports(runId);
  const counts = new Map<string, number>();
  for (const node of journal.listNodes(runId, { kinds: ["report"], withResult: false })) {
    if (node.artifactId === undefined) continue;
    counts.set(node.artifactId, (counts.get(node.artifactId) ?? 0) + 1);
  }
  return counts;
}

const ARTIFACT_KINDS: ReadonlySet<string> = new Set<DynamicWorkflowRunArtifactKind>([
  "file",
  "markdown",
  "chart",
  "table",
  "metrics",
  "board",
]);

/** The four prebuilt dashboards: only these receive data through tagged `report` rows; content artifact `itemCount` is always 0. */
const PRESET_ARTIFACT_KINDS: ReadonlySet<string> = new Set<DynamicWorkflowRunArtifactKind>([
  "chart",
  "table",
  "metrics",
  "board",
]);

function artifactKindOf(value: unknown): DynamicWorkflowRunArtifactKind | undefined {
  return typeof value === "string" && ARTIFACT_KINDS.has(value)
    ? (value as DynamicWorkflowRunArtifactKind)
    : undefined;
}

/**
 * Convert an `ArtifactVersionRecord` in `dwf_node.result_json` to a port version item. The row shape comes from the engine and
 * driver, but it has passed through JSON and may come from an older CLI, so narrow every field defensively: discard the whole row if `version`
 * is not a positive integer (the UI cannot locate or read bytes for a version without a version number).
 */
function artifactVersionOf(
  record: Record<string, unknown>,
): DynamicWorkflowRunArtifactVersion | undefined {
  const version = record.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return undefined;
  const bytes = record.bytes;
  // The driver always writes `publishedAt`, though it is optional in the engine type. Use 0 when it is absent instead of dropping the row:
  // an artifact without a timestamp is still viewable, while dropping it would leave a gap in the UI's version numbers.
  const publishedAt = typeof record.publishedAt === "number" ? record.publishedAt : 0;
  const title = stringField(record, "title");
  const description = stringField(record, "description");
  const contentType = stringField(record, "contentType");
  const uri = stringField(record, "uri");
  const sourcePath = stringField(record, "sourcePath");
  return {
    version,
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(contentType === undefined ? {} : { contentType }),
    ...(typeof bytes === "number" && Number.isFinite(bytes) ? { bytes } : {}),
    ...(uri === undefined ? {} : { uri }),
    ...(sourcePath === undefined ? {} : { sourcePath }),
    ...(record.spec === undefined ? {} : { spec: record.spec }),
    publishedAt,
    ...(record.primary === true ? { primary: true as const } : {}),
  };
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}
