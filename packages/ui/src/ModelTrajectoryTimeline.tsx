import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, type RefObject } from "react";
import type { ZCodeModelTrajectoryMessage, ZCodeModelTrajectoryRecord } from "@zcode/services";
import {
  type TrajectoryInputContext,
  type TrajectorySearchMatch,
  type TrajectorySearchTimelineItem,
} from "@/ModelTrajectorySearch.js";
import {
  applyTrajectorySearchHighlights,
  clearTrajectorySearchHighlights,
  isTrajectorySearchTargetMounted,
  scrollTrajectorySearchRangeIntoView,
} from "@/ModelTrajectorySearchHighlight.js";
import { CallCard, type IntlShape } from "@/ModelTrajectoryPaneParts.js";

export function ModelTrajectoryTimeline({
  items,
  searchQuery,
  searchMatches,
  activeSearchMatch,
  intl,
  scrollContainerRef,
}: {
  items: TrajectorySearchTimelineItem[];
  searchQuery: string;
  searchMatches: TrajectorySearchMatch[];
  activeSearchMatch: TrajectorySearchMatch | null;
  intl: IntlShape;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
}) {
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollContainerRef.current,
    getItemKey: (index) => items[index]?.key ?? index,
    estimateSize: () => 240,
    overscan: 3,
  });
  // Switching search results collapses the old match and expands the new one; during this transition, prevent the virtualizer from repeatedly
  // correcting the scroll anchor on each measurement callback. The text-level positioning below performs one scroll after the layout stabilizes.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => !searchQuery;
  const roleWidthLabels = ["system", "user", "assistant", "tool"].map((role) =>
    intl.formatMessage({ id: `modelTrajectory.role.${role}` }),
  );
  const virtualItems = virtualizer.getVirtualItems();
  const firstVirtualItem = virtualItems[0];
  const lastVirtualItem = virtualItems.at(-1);
  const topSpacerHeight = firstVirtualItem?.start ?? 0;
  const bottomSpacerHeight = lastVirtualItem ? virtualizer.getTotalSize() - lastVirtualItem.end : 0;
  // Track only the mounted set. Adding `start` to the dependencies would reschedule precise scrolling after every dynamic measurement.
  const mountedRowsKey = virtualItems.map((item) => item.key).join("|");

  useEffect(() => () => clearTrajectorySearchHighlights(), []);

  useEffect(() => {
    const root = scrollContainerRef.current;
    if (
      !activeSearchMatch ||
      !root ||
      isTrajectorySearchTargetMounted(root, activeSearchMatch.expansionKey)
    ) {
      return;
    }
    // Skip call-level pre-scrolling when the target is already mounted; otherwise the subsequent text-level positioning causes two jumps.
    virtualizer.scrollToIndex(activeSearchMatch.callIndex, { align: "center" });
  }, [activeSearchMatch, scrollContainerRef, virtualizer]);

  useEffect(() => {
    const root = scrollContainerRef.current;
    if (!root || !searchQuery) {
      clearTrajectorySearchHighlights();
      return;
    }
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      virtualizer.measure();
      secondFrame = window.requestAnimationFrame(() => {
        const activeRange = applyTrajectorySearchHighlights({
          root,
          query: searchQuery,
          matches: searchMatches,
          activeMatch: activeSearchMatch,
        });
        if (activeRange) scrollTrajectorySearchRangeIntoView(activeRange, root);
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
    };
  }, [
    activeSearchMatch,
    mountedRowsKey,
    scrollContainerRef,
    searchMatches,
    searchQuery,
    virtualizer,
  ]);

  return (
    <ol
      data-trajectory-timeline=""
      className="grid grid-cols-[max-content_minmax(0,1fr)_auto] gap-x-2"
    >
      {roleWidthLabels.map((label) => (
        <li
          key={label}
          aria-hidden="true"
          className="invisible col-start-1 row-start-1 h-0 overflow-hidden whitespace-nowrap font-mono text-ui-sm"
        >
          {label}
        </li>
      ))}
      {topSpacerHeight > 0 ? (
        <li aria-hidden="true" className="col-span-full" style={{ height: topSpacerHeight }} />
      ) : null}
      {virtualItems.map((virtualItem) => {
        const item = items[virtualItem.index];
        if (!item) return null;
        return (
          <li
            key={item.key}
            ref={virtualizer.measureElement}
            data-index={virtualItem.index}
            data-trajectory-virtual-row=""
            className="col-span-full grid w-full grid-cols-subgrid"
          >
            <CallCard
              record={item.record}
              index={virtualItem.index}
              inputMessages={item.inputMessages}
              inputContext={item.inputContext}
              expansionKeyPrefix={item.key}
              intl={intl}
            />
          </li>
        );
      })}
      {bottomSpacerHeight > 0 ? (
        <li aria-hidden="true" className="col-span-full" style={{ height: bottomSpacerHeight }} />
      ) : null}
    </ol>
  );
}

interface ReconstructedTrajectoryRecord {
  /** For "reconstructed", request.messages is the full input; otherwise it is the record as received. */
  record: ZCodeModelTrajectoryRecord;
  inputContext: TrajectoryInputContext;
}

/**
 * Chain input deltas in time order. A delta's base is the nearest preceding record with the same requestId,
 * and its full input must have exactly sharedPrefixCount messages. Reconstructed arrays reuse the base's message
 * objects; no message is copied.
 */
export function reconstructTrajectoryRecords(
  records: readonly ZCodeModelTrajectoryRecord[],
): ReconstructedTrajectoryRecord[] {
  // Full input per requestId seen so far. Entries are set after each record, so a lookup finds the nearest preceding one.
  // null marks a record whose full input is unknown; it shadows older records that share the requestId.
  const fullInputs = new Map<string, readonly ZCodeModelTrajectoryMessage[] | null>();

  return records.map((record) => {
    const delta = record.inputDeltaOf;
    if (!delta) {
      fullInputs.set(record.requestId, record.request.messages);
      return { record, inputContext: "full" };
    }

    const base = fullInputs.get(delta.previousRequestId);
    if (!base || base.length !== delta.sharedPrefixCount) {
      fullInputs.set(record.requestId, null);
      return { record, inputContext: "base-missing" };
    }

    const messages = [...base, ...record.request.messages];
    fullInputs.set(record.requestId, messages);
    return {
      record: { ...record, request: { ...record.request, messages } },
      inputContext: "reconstructed",
    };
  });
}

export function resolveTrajectoryTimelineItems(records: ZCodeModelTrajectoryRecord[]) {
  let previousConversationMessageCount = 0;

  return reconstructTrajectoryRecords(records).map(({ record, inputContext }, index) => {
    if (inputContext === "base-missing") {
      // The record holds only the messages after its base, and the base's output may be the only copy of its assistant rows,
      // so every delta row is shown without the assistant filter. The count still advances by the base length the host
      // reported, so later main-session items keep counting correctly.
      const deltaMessages = record.request.messages;
      previousConversationMessageCount =
        (record.inputDeltaOf?.sharedPrefixCount ?? 0) + deltaMessages.length;
      return {
        key: `${record.requestId}:${index}`,
        record,
        inputMessages: deltaMessages,
        inputContext,
      };
    }

    const resolvedInput = resolveTrajectoryInputMessages({
      index,
      previousConversationMessageCount,
      record,
    });
    previousConversationMessageCount = resolvedInput.nextConversationMessageCount;

    return {
      key: `${record.requestId}:${index}`,
      record,
      inputMessages: resolvedInput.inputMessages,
      inputContext,
    };
  });
}

export function resolveTrajectoryInputMessages({
  record,
  index,
  previousConversationMessageCount,
}: {
  record: ZCodeModelTrajectoryRecord;
  index: number;
  previousConversationMessageCount: number;
}): {
  inputMessages: ZCodeModelTrajectoryRecord["request"]["messages"];
  nextConversationMessageCount: number;
} {
  const messages = record.request.messages;
  const usesConversationDelta = shouldUseConversationDelta(record);
  const deltaMessages = usesConversationDelta
    ? computeDeltaMessages(messages, previousConversationMessageCount, index)
    : messages;

  return {
    // Show the full initial context in the first item; later main-session items show only new non-assistant messages (assistant output appears in the preceding Output).
    // Auxiliary requests such as sidecar/compact have their own prompt. Do not apply the main-session message-count delta, or the title-generation prompt may be hidden.
    inputMessages: usesConversationDelta
      ? index === 0
        ? deltaMessages
        : deltaMessages.filter((message) => message.role !== "assistant")
      : deltaMessages,
    nextConversationMessageCount: usesConversationDelta
      ? messages.length
      : previousConversationMessageCount,
  };
}

function shouldUseConversationDelta(record: ZCodeModelTrajectoryRecord): boolean {
  const kind = record.callSource?.kind;
  return kind === undefined || kind === "main" || kind === "subagent";
}

function computeDeltaMessages(
  messages: ZCodeModelTrajectoryRecord["request"]["messages"],
  previousMessageCount: number,
  index: number,
): ZCodeModelTrajectoryRecord["request"]["messages"] {
  if (index === 0) return messages;
  if (messages.length > previousMessageCount) return messages.slice(previousMessageCount);
  if (messages.length < previousMessageCount) return messages;
  return [];
}
