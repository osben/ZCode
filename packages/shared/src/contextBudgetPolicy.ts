/**
 * Context-budget math shared by the CLI auto-compact policy and the composer context meter, so
 * UI warning states fire at the same token counts the runtime actually compacts at.
 *
 * The CLI modules (`apps/zcode-cli/packages/core/src/compact/policy.ts`, `microcompact.ts`)
 * re-export these constants; do not duplicate the numbers elsewhere.
 */

export const DEFAULT_COMPACT_CONTEXT_WINDOW = 200_000;
/** Normal requests default to a 32K output budget; auto-compact reserves the same target. */
export const DEFAULT_AUTOCOMPACT_OUTPUT_RESERVE_TOKENS = 32_000;
/** Hard cap on the reserved output budget so compaction never fires later than preflight allows. */
export const PREFLIGHT_AUTOCOMPACT_OUTPUT_RESERVE_TOKENS = 21_000;
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
export const DEFAULT_MICROCOMPACT_THRESHOLD_RATIO = 0.9;
export const DEFAULT_MICROCOMPACT_THRESHOLD_BUFFER_TOKENS = 2_000;

export type ZCodeContextBudgetTone = "normal" | "warning" | "critical";

export interface ZCodeContextBudgetWindowInput {
  contextWindow: number;
  maxOutputTokens?: number;
  bufferTokens?: number;
}

function toPositiveInt(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function toNonNegativeInt(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
}

export function getAutoCompactOutputReserveTokens(maxOutputTokens?: number): number {
  return Math.min(
    toNonNegativeInt(maxOutputTokens) ?? DEFAULT_AUTOCOMPACT_OUTPUT_RESERVE_TOKENS,
    PREFLIGHT_AUTOCOMPACT_OUTPUT_RESERVE_TOKENS,
  );
}

/** Effective input-side budget after reserving room for the next model output. */
export function getEffectiveContextWindowSize({
  contextWindow,
  maxOutputTokens,
}: ZCodeContextBudgetWindowInput): number {
  const windowTokens = toPositiveInt(contextWindow);
  if (windowTokens === undefined) {
    return 0;
  }
  return Math.max(
    0,
    windowTokens - Math.min(getAutoCompactOutputReserveTokens(maxOutputTokens), windowTokens),
  );
}

/**
 * Token count at which the next model step triggers a full summary compaction.
 * The provider window is shared by input and output; compaction can only free input space, so
 * the output reserve is subtracted before the safety buffer.
 */
export function getAutoCompactThresholdTokens({
  contextWindow,
  maxOutputTokens,
  bufferTokens,
}: ZCodeContextBudgetWindowInput): number {
  const buffer = toNonNegativeInt(bufferTokens) ?? AUTOCOMPACT_BUFFER_TOKENS;
  return Math.max(0, getEffectiveContextWindowSize({ contextWindow, maxOutputTokens }) - buffer);
}

/**
 * Token count at which old tool results start being cleared (microcompact onset), derived from an
 * effective auto-compact threshold. Mirrors the runtime's
 * `buildDefaultMicrocompactThreshold`: `min(floor(auto × 0.9), auto − 2K)`, clamped at 0.
 */
export function getMicrocompactThresholdFromAutoTokens(autoCompactThreshold: number): number {
  return Math.max(
    0,
    Math.min(
      Math.floor(autoCompactThreshold * DEFAULT_MICROCOMPACT_THRESHOLD_RATIO),
      autoCompactThreshold - DEFAULT_MICROCOMPACT_THRESHOLD_BUFFER_TOKENS,
    ),
  );
}

/** Token count at which old tool results start being cleared (microcompact onset). */
export function getMicrocompactThresholdTokens(input: ZCodeContextBudgetWindowInput): number {
  return getMicrocompactThresholdFromAutoTokens(getAutoCompactThresholdTokens(input));
}

export function resolveContextBudgetTone({
  autoCompactThresholdTokens,
  microcompactThresholdTokens,
  contextWindow,
  maxOutputTokens,
  usedTokens,
}: ZCodeContextBudgetWindowInput & {
  usedTokens: number;
  /**
   * Authoritative auto-compact threshold projected by the runtime (v4 snapshot
   * `usage.contextWindow.autoCompactThresholdTokens`). `null` means auto-compact is disabled.
   * `undefined` (field absent, e.g. legacy sessions) falls back to the default-policy estimate.
   */
  autoCompactThresholdTokens?: number | null;
  /**
   * Authoritative runtime microcompact trigger, null when disabled. An absent legacy field is
   * unknown and does not establish that opt-in microcompact is enabled.
   */
  microcompactThresholdTokens?: number | null;
}): ZCodeContextBudgetTone {
  const used = toPositiveInt(usedTokens);
  if (used === undefined) {
    return "normal";
  }
  const criticalThreshold =
    autoCompactThresholdTokens === null
      ? null
      : typeof autoCompactThresholdTokens === "number"
        ? Math.max(0, Math.floor(autoCompactThresholdTokens))
        : getAutoCompactThresholdTokens({ contextWindow, maxOutputTokens });
  if (criticalThreshold !== null && used >= criticalThreshold) {
    return "critical";
  }
  const warningThreshold =
    microcompactThresholdTokens === null || microcompactThresholdTokens === undefined
      ? null
      : typeof microcompactThresholdTokens === "number"
        ? Math.max(0, Math.floor(microcompactThresholdTokens))
        : getMicrocompactThresholdFromAutoTokens(criticalThreshold ?? 0);
  if (warningThreshold !== null && used >= warningThreshold) {
    return "warning";
  }
  return "normal";
}
