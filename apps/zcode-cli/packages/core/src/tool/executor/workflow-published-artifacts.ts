/**
 * One-line model-side projection of a workflow run's **user-facing artifacts**, shared
 * in three places: the `<artifacts>` section in completion notifications
 * (background-tasks.ts), the manifest payload's `artifacts[]` (same module), and the
 * `<artifacts>` section in GetWorkflowRun model text (handlers/get-workflow-run.ts).
 *
 * ⚠ Terminology: an artifact in this file is an **output published by the script through
 * `artifact.*` for users**—a file, markdown text, or a chart / table / metric / dashboard
 * populated by `report` tags. This is **different from** `serializeWorkflowArtifact` in
 * the neighboring workflow-artifact.ts: that artifact is the script's top-level return
 * value (`RunSettlement.artifact` internally), intended for the model. Both appear in
 * completion notifications (`<result>` and `<artifacts>`), so they deliberately live in
 * separate files.
 *
 * Keep the one-line format in one place: all three consumers are the same model, and
 * divergent formats could make it think notification artifacts and GetWorkflowRun
 * artifacts are different things.
 */

/** All model-side facts for one artifact. The three input shapes differ; their intersection is represented by this structure. */
interface PublishedArtifactSummary {
  id: string;
  kind: string;
  version: number;
  title?: string;
  contentType?: string;
  /** Byte size of the latest version of a content artifact (file / markdown); built-in dashboards have no bytes. */
  bytes?: number;
  /** Number of `report` tags received by a built-in dashboard (its data volume); always 0 for content artifacts. */
  itemCount?: number;
  /** The run's deliverable: it leads the list and its row is marked `primary`. */
  primary?: true;
  /** This sentence enters the manifest only for the deliverable; the completion card renders it as a text row. */
  description?: string;
}

/** Limit for the deliverable `description` in the manifest (`ARTIFACT_CAPS.maxDescriptionLength`, matching shared's zod schema). */
const WORKFLOW_ARTIFACT_DESCRIPTION_MAX_CHARS = 500;

/**
 * Put the deliverable first and preserve the original order of the rest (stable sort).
 * All three lists pass through this before truncation, so the deliverable is never cut.
 * The port's `artifactsOf` is already sorted; sort again here for snapshot and
 * notification paths, which use the projection order.
 */
function primaryFirst<T extends { primary?: true }>(artifacts: readonly T[]): T[] {
  return [...artifacts].sort(
    (left, right) => Number(right.primary === true) - Number(left.primary === true),
  );
}

/** Maximum rows in the completion notification's `<artifacts>` section. Deliberately matches the payload limit (≤ 8). */
export const WORKFLOW_ARTIFACTS_NOTIFICATION_MAX_LINES = 8;
/** Limit for the `<artifacts>` section in `GetWorkflowRun` (bounded at 32, the per-run `ARTIFACT_CAPS` limit). */
export const WORKFLOW_ARTIFACTS_INTROSPECTION_MAX_LINES = 32;
/** Title limit in the manifest payload (`ARTIFACT_CAPS.maxTitleLength`, matching shared's zod schema). */
const WORKFLOW_ARTIFACT_TITLE_MAX_CHARS = 120;
/** id limit (`ARTIFACT_CAPS.maxIdLength`, matching shared's zod schema). */
const WORKFLOW_ARTIFACT_ID_MAX_CHARS = 64;
/** contentType limit (matching shared's zod schema; no valid MIME type is this long). */
const WORKFLOW_ARTIFACT_CONTENT_TYPE_MAX_CHARS = 255;

/** Four built-in dashboard types: they have no bytes, and their data volume is the number of report tags. */
const PRESET_ARTIFACT_KINDS: ReadonlySet<string> = new Set(["chart", "table", "metrics", "board"]);

/**
 * Convert one artifact to one row: `- {id} ({kind}, v{version}, {contentType}, {bytes} bytes): {title}`.
 *
 * Omit absent parts entirely instead of leaving blanks: `(file, v2, , : )` looks like
 * corrupt data. For built-in dashboards, show `{n} items` instead of bytes: a chart's
 * “size” is its number of points, and bytes are meaningless because it has none. If
 * `title` is absent, omit the colon too (the facade's default title is the id, so
 * repeating it adds no information).
 *
 * Deliberately **omit `uri`**: the model cannot read the tool-artifact store. To get the
 * content, use `GetWorkflowRun` or ask a subagent to read the original workspace path.
 */
export function formatPublishedArtifactLine(artifact: PublishedArtifactSummary): string {
  // Put `primary` right after the kind: `- report (markdown, primary, v2, …)`. This tells the model which artifact to deliver to the user first.
  const parts = artifact.primary === true ? [artifact.kind, "primary"] : [artifact.kind];
  parts.push(`v${artifact.version}`);
  if (artifact.contentType !== undefined && artifact.contentType.length > 0) {
    parts.push(artifact.contentType);
  }
  if (PRESET_ARTIFACT_KINDS.has(artifact.kind)) {
    if (artifact.itemCount !== undefined) {
      parts.push(`${artifact.itemCount} item${artifact.itemCount === 1 ? "" : "s"}`);
    }
  } else if (artifact.bytes !== undefined) {
    parts.push(`${artifact.bytes} bytes`);
  }
  const head = `- ${artifact.id} (${parts.join(", ")})`;
  const title = artifact.title?.trim();
  return title === undefined || title.length === 0 ? head : `${head}: ${title}`;
}

/** The three values needed for an `<artifacts count shown>` section, matching the `<reports>` section's shape. */
interface WorkflowArtifactsNotificationSection {
  /** **Actual total count** (not the number of listed rows). */
  count: number;
  /** Number of rows actually listed; less than count means the list is partial. */
  shown: number;
  preview: string;
}

/**
 * Convert an artifact list into an `<artifacts>` section for a completion notification or `GetWorkflowRun`.
 *
 * Use the same rule as `<reports>`: `count` is always the actual total, and `count ≠ shown`
 * signals that the list is partial and the full set can be retrieved by run id. Return
 * `undefined` for zero items so the caller omits the entire section instead of emitting
 * an empty `<artifacts>`.
 */
export function buildWorkflowArtifactsNotificationSection(
  artifacts: readonly PublishedArtifactSummary[] | undefined,
  maxLines: number,
): WorkflowArtifactsNotificationSection | undefined {
  if (artifacts === undefined || artifacts.length === 0) return undefined;
  const lines = primaryFirst(artifacts).slice(0, maxLines).map(formatPublishedArtifactLine);
  return { count: artifacts.length, shown: lines.length, preview: lines.join("\n") };
}

/** One entry in the manifest payload (`WorkflowNotificationMeta.artifacts`); shared's zod uses the same limits. */
interface WorkflowArtifactManifestEntry {
  id: string;
  kind: "file" | "markdown" | "chart" | "table" | "metrics" | "board";
  title?: string;
  version: number;
  contentType?: string;
  primary?: true;
  /** Present only on the `primary` entry (the completion card displays it on the deliverable row; other chips have no room or need for it). */
  description?: string;
}

/**
 * Build `artifacts` and `artifactsTruncated` for the manifest payload.
 *
 * This shares the source with the section above but has a **different shape**: the GUI
 * renders each entry as a chip (icon + truncated title), so the payload carries
 * structured fields instead of a formatted row. Deliberately omit `bytes` / `itemCount`:
 * they do not fit on a chip, and the side panel shows all details. Truncate **before
 * construction** because the payload travels in the turnHeader row; if it exceeds the
 * limit, zod rejects the entire row when persisted.
 *
 * Drop any entry whose `kind` is not one of the six literals (do not infer or normalize
 * it). The GUI has no icon for an unknown chip kind, and passing it through would make
 * zod reject the entire payload, removing all the other chips too.
 *
 * Return `undefined` for zero items so the caller omits both fields.
 */
export function buildWorkflowArtifactsManifestSection(
  artifacts: readonly PublishedArtifactSummary[] | undefined,
): { artifacts: WorkflowArtifactManifestEntry[]; artifactsTruncated?: true } | undefined {
  if (artifacts === undefined || artifacts.length === 0) return undefined;
  const entries: WorkflowArtifactManifestEntry[] = [];
  // Add the deliverable first so the limit of 8 can never remove it.
  for (const artifact of primaryFirst(artifacts)) {
    if (entries.length >= WORKFLOW_ARTIFACTS_NOTIFICATION_MAX_LINES) break;
    const kind = manifestArtifactKind(artifact.kind);
    // id is the chip's identity key; truncating it would invent an artifact that does
    // not exist, so an oversized id must drop the entire entry, like an unknown kind.
    // A malformed row should not take other chips with it, but passing it through would
    // make zod reject the whole payload.
    if (kind === undefined || artifact.id.length === 0) continue;
    if (artifact.id.length > WORKFLOW_ARTIFACT_ID_MAX_CHARS) continue;
    // Version is part of the chip's identifying key, and shared's zod requires a positive integer; drop the entire entry otherwise.
    if (!Number.isInteger(artifact.version) || artifact.version < 1) continue;
    const title = artifact.title?.trim();
    // contentType is only decorative on the chip; omit this field if it is too long instead of dropping the entire entry.
    const contentType =
      artifact.contentType !== undefined &&
      artifact.contentType.length <= WORKFLOW_ARTIFACT_CONTENT_TYPE_MAX_CHARS
        ? artifact.contentType
        : undefined;
    const description = artifact.primary === true ? artifact.description?.trim() : undefined;
    entries.push({
      id: artifact.id,
      kind,
      ...(title === undefined || title.length === 0
        ? {}
        : { title: title.slice(0, WORKFLOW_ARTIFACT_TITLE_MAX_CHARS) }),
      version: artifact.version,
      ...(contentType === undefined ? {} : { contentType }),
      ...(artifact.primary === true ? { primary: true as const } : {}),
      ...(description === undefined || description.length === 0
        ? {}
        : { description: description.slice(0, WORKFLOW_ARTIFACT_DESCRIPTION_MAX_CHARS) }),
    });
  }
  if (entries.length === 0) return undefined;
  // Report truncation accurately: entries removed by the limit or filtered by kind both
  // count as “more items not shown”. Therefore compare displayed count with total count,
  // rather than checking whether the limit was reached.
  const truncated = entries.length < artifacts.length;
  return { artifacts: entries, ...(truncated ? { artifactsTruncated: true as const } : {}) };
}

const MANIFEST_ARTIFACT_KINDS: readonly WorkflowArtifactManifestEntry["kind"][] = [
  "file",
  "markdown",
  "chart",
  "table",
  "metrics",
  "board",
];

function manifestArtifactKind(kind: string): WorkflowArtifactManifestEntry["kind"] | undefined {
  return MANIFEST_ARTIFACT_KINDS.find((known) => known === kind);
}

/**
 * Convert artifacts from snapshots / port details into this module's input shape.
 * `bytes` exists only on version entries (the port deliberately omits it at the top
 * level), so read it from the **latest version**, which is the one the list describes.
 *
 * Validate the shape defensively: input comes from another package (a port
 * implementation or a row restored after restart), and one malformed entry should not
 * remove the entire section. Skip entries with invalid shapes.
 */
export function toPublishedArtifactSummaries(
  value: unknown,
): PublishedArtifactSummary[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const summaries: PublishedArtifactSummary[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : undefined;
    const kind = typeof record.kind === "string" ? record.kind : undefined;
    const version = typeof record.version === "number" ? record.version : undefined;
    if (id === undefined || kind === undefined || version === undefined) continue;
    const versions = Array.isArray(record.versions) ? record.versions : undefined;
    const latest = versions?.[versions.length - 1];
    const bytes =
      latest !== null &&
      typeof latest === "object" &&
      typeof (latest as Record<string, unknown>).bytes === "number"
        ? ((latest as Record<string, unknown>).bytes as number)
        : undefined;
    summaries.push({
      id,
      kind,
      version,
      ...(typeof record.title === "string" ? { title: record.title } : {}),
      ...(typeof record.contentType === "string" ? { contentType: record.contentType } : {}),
      ...(bytes === undefined ? {} : { bytes }),
      ...(typeof record.itemCount === "number" ? { itemCount: record.itemCount } : {}),
      ...(record.primary === true ? { primary: true as const } : {}),
      ...(typeof record.description === "string" ? { description: record.description } : {}),
    });
  }
  return summaries.length === 0 ? undefined : summaries;
}
