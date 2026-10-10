// ============================================================
// Protocol vocabulary for user-facing artifacts
// ============================================================
// ⚠ Terminology:
// artifact here means **output the script publishes for users through `artifact.*`** — a file, a markdown block,
// or a preconfigured board fed by the `report` stream. It is **not the same** as `serializeWorkflowArtifact` in the sibling
// `workflow-artifact.ts` (singular): that artifact is the engine's internal term for the script's top-level return value
// (`RunSettlement.artifact`), intended for the **model**. The filenames differ by only one s; use
// this comment to distinguish them rather than relying on the filename.
//
// This module contains only schemas and parameter/result shapes for three v4 queries. The **summary** element in the state key
// (`workflowRuns[].artifacts`) also lives here instead of workflow-runs.ts: it shares the `kind` enum and the rule to omit
// spec/bytes/items with all three queries; splitting these would eventually cause them to drift.
//
// Layering: bytes never enter any schema (except chunked base64 in `workflowRunArtifactRead`).
// The journal is authoritative — `workflowRuns.artifacts` is only a “did it change?” signal.

import { z } from "zod";

import { PROTOCOL_V4_LIMITS } from "./core.js";

/**
 * User-facing artifact kinds: the six members of the `artifact.*` facade.
 *
 * Two families: content members (`file` / `markdown`) have bytes and version history; preconfigured boards
 * (`chart` / `table` / `metrics` / `board`) have no bytes, and every data point is a tagged
 * `report` journal row (a board is a projection of the journal).
 *
 * Closed enum. Adding a value is a **breaking** protocol skew (older readers reject the whole frame), like `workflowRuns[].status`.
 */
export const workflowRunArtifactKindSchema = z.enum([
  "file",
  "markdown",
  "chart",
  "table",
  "metrics",
  "board",
]);
export type WorkflowRunArtifactKind = z.infer<typeof workflowRunArtifactKindSchema>;

/** Display limits for artifact fields. These numbers are the contract; matching engine-side limits are in `ARTIFACT_CAPS`. */
export const WORKFLOW_ARTIFACT_LIMITS = {
  maxIdLength: 64,
  maxTitleLength: 120,
  maxDescriptionLength: 500,
  /** ≤ 16 versions per ID (`ARTIFACT_CAPS.maxVersionsPerArtifact`). */
  maxVersions: 16,
  /** Maximum entries in one `workflowRunArtifactData` page; `limit` is clamped by the gateway. */
  maxItemsPerPage: 500,
  /** Default page size used by the gateway when callers omit limit. */
  defaultItemsPerPage: 200,
} as const;

/**
 * **Metadata** for one artifact version (zod mirror of `ArtifactVersionRecord` in journal `dwf_node.result_json`).
 * Bytes are not included — `uri` points to the tool-artifact store, and bytes are read through
 * `workflowRunArtifactRead`.
 *
 * `publishedAt` is **required**: the driver always writes `Date.now()` to each record (the engine
 * has no clock, so the pure package-side TS type remains optional). Requiring it here surfaces a missing version timestamp at the protocol
 * boundary instead of letting the UI version selector sort an undefined value.
 */
export const workflowRunArtifactVersionSchema = z
  .object({
    version: z.number().int().positive().max(WORKFLOW_ARTIFACT_LIMITS.maxVersions),
    title: z.string().min(1).max(WORKFLOW_ARTIFACT_LIMITS.maxTitleLength).optional(),
    description: z.string().min(1).max(WORKFLOW_ARTIFACT_LIMITS.maxDescriptionLength).optional(),
    contentType: z.string().min(1).max(128).optional(),
    /** Byte size of this version in the store (content artifacts only). */
    bytes: z.number().int().nonnegative().optional(),
    /** Store's `zcode-artifact://…`; **CLI-side only**, not readable by the model or renderer. */
    uri: z.string().min(1).max(512).optional(),
    /** Original workspace-relative path (`file` only); the card's “Show in workspace” action locates it with this. */
    sourcePath: z.string().min(1).max(1024).optional(),
    /** Canonical spec for a preconfigured board. Its shape is interpreted by the UI's four renderers; the protocol does not duplicate it. */
    spec: z.unknown().optional(),
    /** Publication time (epoch milliseconds). */
    publishedAt: z.number().int().nonnegative(),
    /** This version is a run deliverable; stamped by the engine and stable by ID. */
    primary: z.literal(true).optional(),
  })
  .strict();
export type WorkflowRunArtifactVersion = z.infer<typeof workflowRunArtifactVersionSchema>;

/**
 * **All** versions of one artifact + count of tagged reports feeding it. Element in the `workflowRunArtifacts` query,
 * and the durable read path for cold recovery and hub details.
 *
 * Top-level `title` / `description` / `contentType` / `sourcePath` / `spec` use values from the **latest version**:
 * readers interested only in “what it is now” do not need to inspect `versions`. Matches contracts'
 * `DynamicWorkflowRunArtifact` (a TS mirror there, wire validation here).
 */
export const workflowRunArtifactSchema = z
  .object({
    id: z.string().min(1).max(WORKFLOW_ARTIFACT_LIMITS.maxIdLength),
    kind: workflowRunArtifactKindSchema,
    title: z.string().min(1).max(WORKFLOW_ARTIFACT_LIMITS.maxTitleLength).optional(),
    description: z.string().min(1).max(WORKFLOW_ARTIFACT_LIMITS.maxDescriptionLength).optional(),
    contentType: z.string().min(1).max(128).optional(),
    sourcePath: z.string().min(1).max(1024).optional(),
    spec: z.unknown().optional(),
    /** Latest version number (= version of the final item in `versions`). */
    version: z.number().int().positive().max(WORKFLOW_ARTIFACT_LIMITS.maxVersions),
    /** Versions in ascending order. Failed publications are **excluded**: failure rows do not claim ID / kind / version. */
    versions: z.array(workflowRunArtifactVersionSchema).max(WORKFLOW_ARTIFACT_LIMITS.maxVersions),
    /** Number of `report` entries tagged with this ID (preconfigured board data count; always 0 for content artifacts). */
    itemCount: z.number().int().nonnegative(),
    /** Run deliverable (at most one); the list begins with it. */
    primary: z.literal(true).optional(),
  })
  .strict();
export type WorkflowRunArtifact = z.infer<typeof workflowRunArtifactSchema>;

/**
 * Element in `workflowRuns[].artifacts`: **latest-version metadata only**.
 *
 * Intentionally omits `versions` / `spec` / `sourcePath` / `uri`, as well as bytes and entries: this is a high-frequency state key,
 * and its readers only need to know which artifacts exist, their current versions, and whether they changed. To inspect content, fetch it as needed through queries
 * (`workflowRunArtifacts` for full metadata, `workflowRunArtifactData` for board entries,
 * `workflowRunArtifactRead` for bytes) — the journal remains authoritative.
 *
 * `itemCount` acts as a **refresh signal**: when the board hook sees it change, it fetches deltas using `afterSequence`.
 * Putting raw tagged reports in the snapshot could make the state frame reach 2 MB in the worst case (256 entries × 32 KB).
 */
export const workflowRunArtifactSummarySchema = z
  .object({
    id: z.string().min(1).max(WORKFLOW_ARTIFACT_LIMITS.maxIdLength),
    kind: workflowRunArtifactKindSchema,
    title: z.string().min(1).max(WORKFLOW_ARTIFACT_LIMITS.maxTitleLength).optional(),
    version: z.number().int().positive().max(WORKFLOW_ARTIFACT_LIMITS.maxVersions),
    contentType: z.string().min(1).max(128).optional(),
    bytes: z.number().int().nonnegative().optional(),
    itemCount: z.number().int().nonnegative().optional(),
    /** Run deliverable (at most one). UI uses it to order and select presentation; absent means it is not a deliverable. */
    primary: z.literal(true).optional(),
  })
  .strict();
export type WorkflowRunArtifactSummary = z.infer<typeof workflowRunArtifactSummarySchema>;

// ── v4 query ①: workflowRunArtifacts (artifact list) ──
// Same family as workflowRunEvents: read-only, stateless, safe to retry after timeout, and intentionally not a v4 command.
// Likewise **omits** atSeq / atLogEpoch: it reads the journal, unrelated to the conversation log, so there is no staleness to guard against
// (full rationale is in transport.ts after the workflowRunEvents result schema).
// New methods are naturally skew-safe — older Desktop clients never call them.
export const v4ConversationWorkflowRunArtifactsParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    runId: z.string().min(1),
  })
  .strict();
export type V4ConversationWorkflowRunArtifactsParams = z.infer<
  typeof v4ConversationWorkflowRunArtifactsParamsSchema
>;

export const v4ConversationWorkflowRunArtifactsResultSchema = z
  .object({
    /** In first-seen order (= ordinal of the first artifact row for this ID in the journal). */
    artifacts: z.array(workflowRunArtifactSchema),
  })
  .strict();
export type V4ConversationWorkflowRunArtifactsResult = z.infer<
  typeof v4ConversationWorkflowRunArtifactsResultSchema
>;

// ── v4 query ②: workflowRunArtifactData (preconfigured board data) ──
// Intentionally **does not reuse** workflowRunEvents: that would scan the entire journal to filter entries for one ID.
// cursor = journal sequence (same semantics as the event log; `afterSequence` is exclusive).
export const v4ConversationWorkflowRunArtifactDataParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    runId: z.string().min(1),
    artifactId: z.string().min(1).max(WORKFLOW_ARTIFACT_LIMITS.maxIdLength),
    /** Fetch only entries with sequence greater than this value; absent means start from the beginning. */
    afterSequence: z.number().int().nonnegative().optional(),
    /** Defaults to 200 and is clamped to [1, 500] — both handled by the gateway (storage must not invent or re-clamp page sizes). */
    limit: z.number().int().positive().max(WORKFLOW_ARTIFACT_LIMITS.maxItemsPerPage).optional(),
  })
  .strict();
export type V4ConversationWorkflowRunArtifactDataParams = z.infer<
  typeof v4ConversationWorkflowRunArtifactDataParamsSchema
>;

export const v4ConversationWorkflowRunArtifactDataResultSchema = z
  .object({
    items: z.array(
      z
        .object({
          /** Journal sequence; return it as `afterSequence` for the next page cursor. */
          sequence: z.number().int().nonnegative(),
          /** report site that produced this entry (for example, `report#1`). */
          siteId: z.string().min(1).max(64),
          ordinal: z.number().int().nonnegative(),
          /**
           * Original entry value, **not serialized for preview**: the board's pure functions need field-path access
           * (`ChartSpec.x.field` can be timing.after), which is impossible with pretty-printed JSON text.
           * Each entry is already bounded on the wire by `REPORT_CAPS.maxItemSerializedBytes` (32 KB) and event-payload limits,
           * so do not add another limit here.
           */
          item: z.unknown(),
        })
        .strict(),
    ),
    /** This page reached limit and more entries remain (gateway determines this by fetching one extra). */
    hasMore: z.boolean(),
  })
  .strict();
export type V4ConversationWorkflowRunArtifactDataResult = z.infer<
  typeof v4ConversationWorkflowRunArtifactDataResultSchema
>;

// ── v4 query ③: workflowRunArtifactRead (content artifact bytes) ──
// **Matches `v4AttachmentRead*` exactly**: ≤ 512 KiB per chunk (the same constant, PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes,
// not a new one), preserving the existing Host→CLI proof of ≤ 1 MiB per request.
//
// Intentionally does not reuse attachmentRead: that authorizes by a conversation user row, while artifacts are not attached to any message
// row. Authorization runs on the CLI side: sessionId must equal the run's parentSessionId and
// (artifactId, version) must have a completed journal row before its uri is used to read from the store.
// IDs sent by the renderer **never** become paths directly — same rule as attachmentRead.
export const v4ConversationWorkflowRunArtifactReadParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    runId: z.string().min(1),
    artifactId: z.string().min(1).max(WORKFLOW_ARTIFACT_LIMITS.maxIdLength),
    version: z.number().int().positive().max(WORKFLOW_ARTIFACT_LIMITS.maxVersions),
    offset: z.number().int().nonnegative(),
    limit: z.number().int().positive().max(PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes),
  })
  .strict();
export type V4ConversationWorkflowRunArtifactReadParams = z.infer<
  typeof v4ConversationWorkflowRunArtifactReadParamsSchema
>;

export const v4ConversationWorkflowRunArtifactReadResultSchema = z
  .object({
    /** base64 (without the data: prefix); decoded length ≤ attachmentChunkMaxBytes. */
    dataBase64: z.string(),
    /**
     * contentType for this version, read from the journal record (driver derives it from the extension table, with optional override by `opts.contentType`)
     * — the UI uses it for **exact-match** renderer dispatch. Unlike attachmentRead, this deliberately does not restrict
     * mediaType to image/video/pdf: valid artifact types are the driver's 17-extension table plus
     * application/octet-stream; further restrictions would make markdown and office files unreadable.
     */
    mediaType: z.string().min(1).max(128),
    /** Total bytes in this version (≤ ARTIFACT_CAPS.maxFileBytes = attachmentMaxBytes). */
    totalBytes: z.number().int().nonnegative().max(PROTOCOL_V4_LIMITS.attachmentMaxBytes),
    /** Offset of the next chunk; null when this chunk reaches the end. */
    nextOffset: z.number().int().positive().nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const decodedBytes = decodedBase64ByteLength(value.dataBase64);
    if (decodedBytes === null) {
      context.addIssue({ code: "custom", message: "invalid base64", path: ["dataBase64"] });
      return;
    }
    if (decodedBytes > PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes) {
      context.addIssue({
        code: "too_big",
        maximum: PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes,
        origin: "string",
        inclusive: true,
        message: "workflow artifact read chunk exceeds decoded byte limit",
        path: ["dataBase64"],
      });
    }
    if (value.nextOffset !== null && value.nextOffset > value.totalBytes) {
      context.addIssue({
        code: "custom",
        message: "nextOffset exceeds totalBytes",
        path: ["nextOffset"],
      });
    }
  });
export type V4ConversationWorkflowRunArtifactReadResult = z.infer<
  typeof v4ConversationWorkflowRunArtifactReadResultSchema
>;

/**
 * Decoded byte count for a base64 string; returns null for invalid input.
 *
 * Identical to the private helper of the same name in transport.ts instead of importing it: that file does not export it,
 * and importing it would create a cycle — transport.ts → snapshot.ts → workflow-runs.ts → this module. Duplicating ten lines of arithmetic
 * is simpler than introducing a new public module; if the copies drift, both sides' superRefine tests fail.
 */
function decodedBase64ByteLength(value: string): number | null {
  if (value.length === 0) return 0;
  if (value.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}
