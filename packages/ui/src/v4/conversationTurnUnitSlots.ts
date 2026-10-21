import type { ReactNode } from "react";
import type { ConversationTurnRenderUnit } from "@/v4/conversationTurnRenderUnitTypes.js";

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
