import type { ConversationTurnRenderUnit } from "@/v4/conversationTurnRenderUnits.js";

interface ConversationTimelineLiveTailSplit {
  virtualizedUnits: readonly ConversationTurnRenderUnit[];
  liveUnit: ConversationTurnRenderUnit | null;
  liveUnitIndex: number | null;
}

/**
 * When a running turn stays in an absolutely positioned virtual row, the body DOM grows first,
 * then ResizeObserver updates totalSize/scrollTop on the next frame, making the trailing ChatLoading jump around.
 * Split only the actual last running unit into a normal-flow live tail; historical or stale running rows remain virtualized
 * to avoid expanding the persistent DOM.
 */
export function splitConversationTimelineLiveTail(
  units: readonly ConversationTurnRenderUnit[],
): ConversationTimelineLiveTailSplit {
  const liveUnitIndex = units.length - 1;
  const liveUnit = units[liveUnitIndex];
  if (!liveUnit?.isRunning) {
    return { virtualizedUnits: units, liveUnit: null, liveUnitIndex: null };
  }
  return {
    virtualizedUnits: units.slice(0, liveUnitIndex),
    liveUnit,
    liveUnitIndex,
  };
}
