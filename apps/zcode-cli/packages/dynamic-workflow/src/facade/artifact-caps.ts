/**
 * Cap constants for artifacts.
 *
 * ⚠ Terminology: artifact here means a **user-facing output**—a file / markdown / preset dashboard
 * published by a script through `artifact.*`. It is not the engine's internal artifact
 * (`RunSettlement.artifact`, the typed output value in `analysis/artifact-types.ts`), which is the
 * top-level return value for the model.
 *
 * Like `report-caps.ts` / `world-read-caps.ts`, these live in their own module for the same reason:
 * **enforcement is split**. The engine core enforces ID and version counts (it knows how many
 * versions the journal has for an ID), while the driver enforces bytes and text lengths (only it
 * can read files and write to the store). Putting them in either side's module would imply one side
 * enforces them all. Since the numbers are contracts shared by both sides, keep named constants in
 * the pure package so engine and driver tests assert the same values instead of copying them.
 *
 * Overflow policy **splits by member family** (and error code): content members (`file` /
 * `markdown`) return promises that the script can catch, so exceeding a cap is a **node-level
 * rejection** (`ArtifactTooLarge` / `ArtifactVersionCapExceeded` / `ArtifactCapExceeded`). Preset
 * members return void and have no rejection channel, so the same cap fails the run for that family.
 * This follows the same reasoning as the world-read / report distinction.
 */

/** Artifact count, size, and text limits. These numbers are the contract (see this module's header). */
export const ARTIFACT_CAPS = {
  /** Maximum number of distinct artifact IDs in one run. */
  maxArtifactsPerRun: 32,
  /** Maximum number of versions per ID (each successful content-member publication is one version). */
  maxVersionsPerArtifact: 16,
  /** Maximum bytes for `artifact.file` (same as PROTOCOL_V4_LIMITS.attachmentMaxBytes). */
  maxFileBytes: 20 * 1024 * 1024,
  /** Maximum UTF-8 bytes for `artifact.markdown`. */
  maxMarkdownBytes: 256 * 1024,
  /** Maximum character count for `opts.title`. */
  maxTitleLength: 120,
  /** Maximum character count for `opts.description`. */
  maxDescriptionLength: 500,
  /** Maximum bytes for a preset spec after JSON normalization. */
  maxSpecSerializedBytes: 8 * 1024,
  /** Maximum character count for an artifact ID. */
  maxIdLength: 64,
} as const;

/**
 * Character set for a valid artifact ID: non-empty `[A-Za-z0-9_.-]`.
 *
 * Why so narrow: the ID is a **cross-surface identity** used as a key in the journal's
 * `dwf_node.artifact_id` column, the store's `toolCallId`, v4 query params, and the sidebar tab.
 * Slashes, spaces, or percent signs would require escaping in one of those places; resolving the
 * same escaping issue four times would create four different answers.
 *
 * No `g` flag: a global regex retains `lastIndex` between `test` calls, so testing the same ID twice would return different results.
 */
export const ARTIFACT_ID_PATTERN = /^[A-Za-z0-9_.-]+$/;
