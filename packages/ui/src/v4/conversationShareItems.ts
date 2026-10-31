import {
  buildConversationTurnNavigatorItems,
  type BuildConversationTurnNavigatorItemsOptions,
  type ConversationTurnNavigatorItem,
} from "@/v4/conversationTurnNavigatorHelpers.js";
import type { ConversationTurnRenderUnit } from "@/v4/conversationTurnRenderUnits.js";

/** Share selection is a full product turn; the question navigator only lists realUser turns and cannot substitute for the share catalog. */
export function buildConversationShareItems(
  units: readonly ConversationTurnRenderUnit[],
  options: BuildConversationTurnNavigatorItemsOptions,
): ConversationTurnNavigatorItem[] {
  const queries = buildConversationTurnNavigatorItems(units, options);
  // Filtering all queries per turn is quadratic in long conversations; one grouping pass preserves the original query order.
  const queriesByUnit = new Map<number, ConversationTurnNavigatorItem[]>();
  for (const query of queries) {
    const group = queriesByUnit.get(query.unitIndex);
    if (group) group.push(query);
    else queriesByUnit.set(query.unitIndex, [query]);
  }
  return units.flatMap((unit, unitIndex) => {
    const existing = queriesByUnit.get(unitIndex);
    if (existing) return existing;
    if (
      !unit.header ||
      unit.timelineOnly ||
      (!unit.assistantTextRows.length &&
        !unit.workflowLaunch &&
        !unit.header.originMeta?.workflowNotification)
    )
      return [];
    return [
      {
        key: `${unit.key}:share`,
        turnId: unit.turnId,
        unitIndex,
        rowId: unit.header.rowId,
        userPreview:
          unit.header.originMeta?.title ?? unit.workflowLaunch?.name ?? options.userFallbackPreview,
        assistantPreview:
          unit.assistantTextRows
            .map((row) => row.text)
            .join("\n")
            .slice(0, 320) || options.assistantEmptyPreview,
        assistantPreviewKind: "text" as const,
        isRunning: unit.isRunning,
        // Mirrors the navigator helper: a turn counts as pinned when any assistant text row is pinned.
        isPinned: unit.assistantTextRows.some((row) => row.pinnedAt !== undefined),
      },
    ];
  });
}
