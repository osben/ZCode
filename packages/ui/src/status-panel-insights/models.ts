import { resolveContextBudgetTone } from "@zcode/shared";
import type { SessionUsageState, TurnHeaderRow } from "@zcode/shared/zcode-protocol-v4";
import type { ContextSectionModel, LastTurnSectionModel } from "./contract.js";

/**
 * Mirrors the composer mapping in `v4/composer/V4ComposerToolbar.tsx` (`taskUsage` + `usageTone`) and the
 * renderable gate in `chat-input-toolbar/contextUsage.tsx`; that upstream file stays untouched, and a unit
 * test pins both to the same tone.
 */
export function buildContextSectionModel(
  usage: SessionUsageState | null | undefined,
): ContextSectionModel | null {
  const contextWindow = usage?.contextWindow;
  if (!contextWindow) return null;
  const { usedTokens, maxTokens } = contextWindow;
  // Same gate as getRenderableTaskUsage: zero or invalid usage is an initialization placeholder, not 0%.
  if (
    !Number.isFinite(usedTokens) ||
    !Number.isFinite(maxTokens) ||
    usedTokens <= 0 ||
    maxTokens <= 0
  ) {
    return null;
  }
  const authoritativeThreshold =
    contextWindow.autoCompactThresholdAuthoritative === true
      ? contextWindow.autoCompactThresholdTokens
      : undefined;
  const tone = resolveContextBudgetTone({
    autoCompactThresholdTokens: authoritativeThreshold,
    contextWindow: maxTokens,
    microcompactThresholdTokens: contextWindow.microcompactThresholdTokens,
    usedTokens,
  });
  const autoCompactThresholdTokens =
    typeof authoritativeThreshold === "number" && authoritativeThreshold > 0
      ? authoritativeThreshold
      : null;
  return {
    usedTokens,
    maxTokens,
    usedRatio: Math.min(Math.max(usedTokens / maxTokens, 0), 1),
    tone,
    autoCompactThresholdTokens,
    tokensUntilAutoCompact:
      autoCompactThresholdTokens === null
        ? null
        : Math.max(autoCompactThresholdTokens - usedTokens, 0),
    breakdown: contextWindow.breakdown?.length ? contextWindow.breakdown : null,
    cumulative: {
      inputTokens: usage.cumulative.inputTokens,
      outputTokens: usage.cumulative.outputTokens,
      cacheReadTokens: usage.cumulative.cacheReadTokens,
    },
  };
}

/** Primitive facts of a turn header; the stable hook memoises on exactly these. */
export interface LastTurnHeaderFacts {
  rowId: number;
  entityId: string | undefined;
  running: boolean;
  files: number;
  additions: number;
  deletions: number;
  fileChangesState: "active" | "reverted" | undefined;
}

export function lastTurnHeaderFacts(header: TurnHeaderRow | null): LastTurnHeaderFacts | null {
  if (!header?.fileChanges) return null;
  return {
    rowId: header.rowId,
    entityId: header.entityId,
    running: header.state === "running",
    files: header.fileChanges.files,
    additions: header.fileChanges.additions,
    deletions: header.fileChanges.deletions,
    fileChangesState: header.fileChanges.state,
  };
}

export function buildLastTurnSectionModel(
  facts: LastTurnHeaderFacts | null,
): LastTurnSectionModel | null {
  if (!facts?.entityId || facts.files <= 0) return null;
  return {
    target: { rowId: facts.rowId, entityId: facts.entityId },
    files: facts.files,
    additions: facts.additions,
    deletions: facts.deletions,
    reverted: facts.fileChangesState === "reverted",
    // Same derivation as ConversationFileSummaryPanel, so SessionPane's request cache key matches the chat's.
    requestOptions: {
      cachePolicy: facts.running ? "in-flight" : "terminal",
      ...(facts.fileChangesState ? { fileChangesState: facts.fileChangesState } : {}),
    },
  };
}
