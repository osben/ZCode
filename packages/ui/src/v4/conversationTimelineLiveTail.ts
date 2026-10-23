import type { ConversationTurnRenderUnit } from "@/v4/conversationTurnRenderUnits.js";

export interface ConversationTimelineLiveTailSplit {
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

/**
 * 时间线最后一个回合的摘要（spec：docs/ui/side-pane-full-view.md）。
 * 运行状态、运行时长和最终回答取自同一个 render unit，供完整视图浮窗一次性使用，
 * 避免运行状态与回答来自两个数据源时先后不一致。
 */
export interface ConversationLatestTurnSummary {
  /** 最后一个回合的 turnId；同一轮运行中和结束后不变。 */
  readonly turnKey: string | null;
  readonly running: boolean;
  /** 运行中最后一个 work segment 的时长，与流式消息「工作中 N 秒」同值。 */
  readonly workDurationMs: number | undefined;
  /** 已结束回合的最终回答；运行中或回答未完成时为 null。 */
  readonly answer: { readonly rowId: number; readonly text: string } | null;
}

export function resolveConversationLatestTurnSummary(
  units: readonly ConversationTurnRenderUnit[],
): ConversationLatestTurnSummary {
  const unit = units.at(-1);
  if (!unit) return { turnKey: null, running: false, workDurationMs: undefined, answer: null };
  const running = unit.isRunning;
  const row = unit.latestAssistantTextRow;
  return {
    turnKey: unit.key,
    running,
    workDurationMs: running ? unit.workSegments?.at(-1)?.workStatus?.durationMs : undefined,
    answer:
      !running && row?.state === "complete" && row.text.trim()
        ? { rowId: row.rowId, text: row.text }
        : null,
  };
}

export function isSameConversationLatestTurnSummary(
  a: ConversationLatestTurnSummary,
  b: ConversationLatestTurnSummary,
): boolean {
  return (
    a.turnKey === b.turnKey &&
    a.running === b.running &&
    a.workDurationMs === b.workDurationMs &&
    a.answer?.rowId === b.answer?.rowId &&
    a.answer?.text === b.answer?.text
  );
}
