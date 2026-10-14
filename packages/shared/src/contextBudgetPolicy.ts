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
}

function toPositiveInt(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

export function getAutoCompactOutputReserveTokens(maxOutputTokens?: number): number {
  return Math.min(
    toPositiveInt(maxOutputTokens) ?? DEFAULT_AUTOCOMPACT_OUTPUT_RESERVE_TOKENS,
    PREFLIGHT_AUTOCOMPACT_OUTPUT_RESERVE_TOKENS,
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
}: ZCodeContextBudgetWindowInput): number {
  const windowTokens = toPositiveInt(contextWindow);
  if (windowTokens === undefined) {
    return 0;
  }
  const effectiveWindow = Math.max(
    0,
    windowTokens - Math.min(getAutoCompactOutputReserveTokens(maxOutputTokens), windowTokens),
  );
  return Math.max(0, effectiveWindow - AUTOCOMPACT_BUFFER_TOKENS);
}

/** Token count at which old tool results start being cleared (microcompact onset). */
export function getMicrocompactThresholdTokens(input: ZCodeContextBudgetWindowInput): number {
  return Math.max(
    0,
    Math.floor(getAutoCompactThresholdTokens(input) * DEFAULT_MICROCOMPACT_THRESHOLD_RATIO) -
      DEFAULT_MICROCOMPACT_THRESHOLD_BUFFER_TOKENS,
  );
}

export function resolveContextBudgetTone({
  contextWindow,
  maxOutputTokens,
  usedTokens,
}: ZCodeContextBudgetWindowInput & { usedTokens: number }): ZCodeContextBudgetTone {
  const used = toPositiveInt(usedTokens);
  if (used === undefined) {
    return "normal";
  }
  if (used >= getAutoCompactThresholdTokens({ contextWindow, maxOutputTokens })) {
    return "critical";
  }
  if (used >= getMicrocompactThresholdTokens({ contextWindow, maxOutputTokens })) {
    return "warning";
  }
  return "normal";
}
