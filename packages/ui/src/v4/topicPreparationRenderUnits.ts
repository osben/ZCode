import type { BotTopicPreparation as Preparation } from "@zcode/shared";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationTurnRenderUnit } from "@/v4/conversationTurnRenderUnits.js";

export function pendingTopicPreparations(
  items: readonly Preparation[],
  rows: readonly ConversationRow[],
) {
  const acceptedIds = new Set<string>();
  for (const row of rows) {
    if (row.kind !== "userInput" || !row.botGroupSource) continue;
    acceptedIds.add(row.botGroupSource.messageId);
    for (const message of row.botGroupSource.messages ?? []) acceptedIds.add(message.messageId);
  }
  // Failed preparations are no longer projected as temporary messages; they are removed along
  // with their source to avoid leaving empty turns or error blocks behind.
  return items.filter((item) => item.status !== "failed" && !acceptedIds.has(item.messageId));
}

/** Preparation messages enter the existing turn's message flow and the height-measure/scroll pipeline; no fake CLI accepted rows are created. */
export function withTopicPreparationMessages(
  units: ConversationTurnRenderUnit[],
  rows: readonly ConversationRow[],
  items: readonly Preparation[],
): ConversationTurnRenderUnit[] {
  const pending = pendingTopicPreparations(items, rows);
  if (!pending.length) return units;
  const last = units.at(-1);
  if (last) return [...units.slice(0, -1), { ...last, topicPreparations: pending }];
  // With no CLI messages yet, create only a local display unit; no task, turn, or editable
  // fake message is produced.
  return [
    {
      key: "topic-preparation",
      turnId: "topic-preparation",
      topicPreparations: pending,
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
