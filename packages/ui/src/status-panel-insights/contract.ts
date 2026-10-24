/**
 * status-panel-insights contract (specs/status-panel-context-and-last-turn.md). The Context and Last turn
 * status panel sections read the v4 projection (`usage`, `turnHeader.fileChanges`, `fileChanges` RPC); they
 * never write, persist or cache those facts as their own truth.
 */
import type { ZCodeContextBudgetTone, ZCodeContextUsageBreakdownItem } from "@zcode/shared";
import type {
  ConversationRowTarget,
  V4ConversationFileChangesResult,
} from "@zcode/shared/zcode-protocol-v4";
import type { ConversationFileChangesRequestOptions } from "@/v4/conversationRowContext.js";

/** Context section facts derived from `snapshot.usage`; null means the section is not rendered. */
export interface ContextSectionModel {
  usedTokens: number;
  maxTokens: number;
  /** used / max, clamped to [0, 1]. */
  usedRatio: number;
  /** Same tone rule and inputs as the composer context indicator. */
  tone: ZCodeContextBudgetTone;
  /** Authoritative auto-compact threshold; null when the runtime did not report one or disabled it. */
  autoCompactThresholdTokens: number | null;
  /** Tokens left before auto-compact; null under the same condition as the threshold. */
  tokensUntilAutoCompact: number | null;
  /** Runtime source breakdown, present only when the projection carries one. */
  breakdown: readonly ZCodeContextUsageBreakdownItem[] | null;
  cumulative: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
}

/** Latest turn with file changes, reduced to primitives so its identity changes only with them. */
export interface LastTurnSectionModel {
  target: ConversationRowTarget;
  files: number;
  additions: number;
  deletions: number;
  reverted: boolean;
  /** Request options derived exactly as the chat's turn file summary derives them (shared request cache). */
  requestOptions: ConversationFileChangesRequestOptions;
}

/** SessionPane's gated per-turn detail reader (same value the chat row context receives). */
export type LastTurnFetchFileChanges = (
  target: ConversationRowTarget,
  options: ConversationFileChangesRequestOptions,
) => Promise<V4ConversationFileChangesResult>;
