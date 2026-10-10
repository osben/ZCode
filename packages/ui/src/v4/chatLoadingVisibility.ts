import type {
  ActiveWorkSummary,
  ConversationRow,
  PendingInteraction,
} from "@zcode/shared/zcode-protocol-v4";

/**
 * While waiting for user action, the dialog/question card is already the only progress feedback, so do not show loading too.
 * Recognize only permission confirmation and AskUserQuestion here; other userInput semantics such as ExitPlanMode remain separate.
 * workspaceHookReview no longer blocks chat after the soft gate.
 */
export function hasChatLoadingBlockingInteraction(
  interactions: readonly PendingInteraction[],
): boolean {
  return interactions.some(
    (interaction) =>
      interaction.payload.kind === "permission" ||
      (interaction.payload.kind === "userInput" &&
        interaction.payload.toolName === "AskUserQuestion"),
  );
}

export function hasChatLoadingBlockingActiveWork(
  activeWorks: readonly ActiveWorkSummary[],
): boolean {
  return activeWorks.some((work) => work.kind === "compact" || work.kind === "goalVerifier");
}

function hasChatLoadingBlockingMaintenanceRow(rows: readonly ConversationRow[]): boolean {
  return rows.some(
    (row) =>
      row.kind === "timelineMarker" &&
      ((row.marker.type === "compact" && row.marker.status === "running") ||
        (row.marker.type === "goalVerify" && row.marker.outcome === "running")),
  );
}

export function shouldShowTurnChatLoading({
  blockedByActiveWork,
  blockedByInteraction,
  isLastTurn,
  isRunning,
  rows,
}: {
  blockedByActiveWork: boolean;
  blockedByInteraction: boolean;
  isLastTurn: boolean;
  isRunning: boolean;
  rows: readonly ConversationRow[];
}): boolean {
  if (!isLastTurn || !isRunning || blockedByActiveWork || blockedByInteraction) {
    return false;
  }

  // pendingInteractions / activeWorks are authoritative, but during recovery or event reordering
  // only row state may be available first. Row-level fallback prevents bottom loading from briefly flashing back after permission, compact, or goal-verifier rows appear.
  return (
    !rows.some((row) => row.kind === "toolCall" && row.status === "pendingApproval") &&
    !hasChatLoadingBlockingMaintenanceRow(rows)
  );
}
