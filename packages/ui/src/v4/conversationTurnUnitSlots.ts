import type { ReactNode } from "react";
import type { UserInputRow } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationTurnRenderUnit } from "@/v4/conversationTurnRenderUnitTypes.js";
import { buildConversationTurnWorkSegments } from "@/v4/conversationTurnWorkSegments.js";

/**
 * Attach a session-level context row (worktree setup/created) as the second timeline item:
 * on the first unit it renders right after that unit's user inputs, so the first user message
 * stays above it before and after admission. With no transcript rows yet (reserved session,
 * frozen submission), the slot becomes its own timeline-only unit instead of a header row,
 * keeping the "message preview, then worktree line" order stable through the swap
 * (specs/composer-worktree-setup-steps.md, Timeline presentation).
 */
export function withAfterFirstUserInputSlot(
  units: ConversationTurnRenderUnit[],
  slot: ReactNode,
): ConversationTurnRenderUnit[] {
  if (!slot) return units;
  if (units.length === 0) {
    return [
      {
        key: "first-user-input-slot",
        turnId: "first-user-input-slot",
        afterFirstUserInputSlot: slot,
        visibleUserInputs: [],
        assistantWorkRows: [],
        assistantHistoryRows: [],
        assistantFollowingRows: [],
        assistantTailRows: [],
        browserTurnEndRows: [],
        hookInvocations: [],
        assistantTextRows: [],
        leadingBoundaryRows: [],
        flowItems: [],
        renderRows: [],
        isLastTurn: true,
        isRunning: false,
        assistantHistoryDefaultOpen: false,
        timelineOnly: true,
      },
    ];
  }
  const [first, ...rest] = units;
  if (!first) return units;
  return [{ ...first, afterFirstUserInputSlot: slot }, ...rest];
}

/**
 * Prepend the optimistic first-submission user turn as its own timeline-only unit
 * (specs/first-submission-instant-ux.md, P1): a pixel-real user bubble rendered in the
 * same commit as the Send click, before any Host round-trip. The unit stays first while
 * the authoritative projection has not produced the real row; the caller hides the row
 * (reconcile, not gate) when a real realUser row reaches the window. Work segments are
 * derived through the normal builder so the turn group renders the bubble exactly like
 * a projected user row.
 */
export function withOptimisticFirstInputRow(
  units: ConversationTurnRenderUnit[],
  row: UserInputRow | null,
): ConversationTurnRenderUnit[] {
  if (!row) return units;
  const isLastTurn = units.length === 0;
  const workSegments = buildConversationTurnWorkSegments({
    key: "optimistic-first-input",
    orderedRows: [row],
    assistantTailRows: [],
    isRunning: false,
    isLastTurn,
    isInterrupted: false,
    forceOpenHistory: false,
    timelineOnly: true,
  });
  return [
    {
      key: "optimistic-first-input",
      turnId: row.turnId,
      visibleUserInputs: [row],
      assistantWorkRows: [],
      assistantHistoryRows: [],
      assistantFollowingRows: [],
      assistantTailRows: [],
      browserTurnEndRows: [],
      hookInvocations: [],
      assistantTextRows: [],
      leadingBoundaryRows: [],
      flowItems: workSegments.flatMap((segment) => segment.flowItems),
      workSegments,
      renderRows: [row],
      isLastTurn,
      isRunning: false,
      assistantHistoryDefaultOpen: false,
      timelineOnly: true,
    },
    ...units,
  ];
}
