import type { BotTopicPreparation } from "@zcode/shared";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import {
  sameItems,
  type ConversationTurnRenderUnit,
  type ConversationTurnRenderUnitsPartition,
} from "@/v4/conversationTurnRenderUnits.js";
import { withTopicPreparationMessages } from "@/v4/topicPreparationRenderUnits.js";

// Cached by the history array for the case where preparation messages hang on the last history
// item (empty tail): the same material reuses the same array, so downstream derivations cached
// by the history reference are not invalidated every time.
const topicPreparationHistories = new WeakMap<
  readonly ConversationTurnRenderUnit[],
  {
    pending: readonly BotTopicPreparation[];
    history: readonly ConversationTurnRenderUnit[];
  }
>();

/**
 * Bot topic-preparation messages hang on the last of all units; the result is the same as
 * calling withTopicPreparationMessages on history ++ tail. With no pending material the result
 * is necessarily empty — return directly without scanning rows (the common case for streaming
 * frames); with material present, compute over the whole window only during bot topic
 * preparation.
 */
export function withTopicPreparationUnits(
  units: ConversationTurnRenderUnitsPartition,
  rows: readonly ConversationRow[],
  items: readonly BotTopicPreparation[],
): ConversationTurnRenderUnitsPartition {
  if (items.length === 0) return units;
  const all = [...units.history, ...units.tail];
  const merged = withTopicPreparationMessages(all, rows, items);
  if (merged === all) return units;
  if (units.tail.length > 0 || units.history.length === 0) {
    return { history: units.history, tail: merged.slice(units.history.length) };
  }
  const pending = merged.at(-1)?.topicPreparations ?? [];
  const cached = topicPreparationHistories.get(units.history);
  if (cached && sameItems(cached.pending, pending)) return { history: cached.history, tail: [] };
  topicPreparationHistories.set(units.history, { pending, history: merged });
  return { history: merged, tail: [] };
}

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
 *
 * The input is partitioned into "history + tail": the last running turn is usually the only
 * tail unit, so the virtual list uses the history array directly — its reference is stable
 * across streaming frames and the virtualizer and TOC are not rebuilt on every token.
 */
export function splitConversationTimelineLiveTail(
  units: ConversationTurnRenderUnitsPartition,
): ConversationTimelineLiveTailSplit {
  const { history, tail } = units;
  const liveUnit = tail.at(-1) ?? history.at(-1);
  if (!liveUnit?.isRunning) {
    return {
      virtualizedUnits: tail.length === 0 ? history : [...history, ...tail],
      liveUnit: null,
      liveUnitIndex: null,
    };
  }
  return {
    virtualizedUnits:
      tail.length === 0
        ? history.slice(0, -1)
        : tail.length === 1
          ? history
          : [...history, ...tail.slice(0, -1)],
    liveUnit,
    liveUnitIndex: history.length + tail.length - 1,
  };
}

/**
 * Summary of the timeline's last turn (spec: docs/ui/side-pane-full-view.md).
 * Running state, elapsed time, and the final answer come from the same render unit, consumed
 * in one shot by the full-view popover, so running state and answer can never disagree by
 * coming from two sources.
 */
export interface ConversationLatestTurnSummary {
  /** turnId of the last turn; stable while the turn runs and after it ends. */
  readonly turnKey: string | null;
  readonly running: boolean;
  /** Duration of the last work segment while running; same value as the streaming message's
   *   "working Ns". */
  readonly workDurationMs: number | undefined;
  /** Final answer of a finished turn; null while running or before the answer completes. */
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
