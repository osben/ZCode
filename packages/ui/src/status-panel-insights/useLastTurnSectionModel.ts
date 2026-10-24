import { useMemo } from "react";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { selectLastFileChangeTurn } from "@/review-last-turn/index.js";
import type { LastTurnSectionModel } from "./contract.js";
import { buildLastTurnSectionModel, lastTurnHeaderFacts } from "./models.js";

/**
 * The rows window changes on every streamed delta, while the memoised status panel is guarded by
 * stable-reference tests; the model keeps its identity until one of the header's primitive facts changes.
 */
export function useLastTurnSectionModel(
  rows: readonly ConversationRow[] | undefined,
): LastTurnSectionModel | null {
  const facts = lastTurnHeaderFacts(rows ? selectLastFileChangeTurn(rows) : null);
  const rowId = facts?.rowId;
  const entityId = facts?.entityId;
  const running = facts?.running;
  const files = facts?.files;
  const additions = facts?.additions;
  const deletions = facts?.deletions;
  const fileChangesState = facts?.fileChangesState;
  return useMemo(
    () =>
      rowId === undefined ||
      running === undefined ||
      files === undefined ||
      additions === undefined ||
      deletions === undefined
        ? null
        : buildLastTurnSectionModel({
            rowId,
            entityId,
            running,
            files,
            additions,
            deletions,
            fileChangesState,
          }),
    [rowId, entityId, running, files, additions, deletions, fileChangesState],
  );
}
