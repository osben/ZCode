import type { QueueItem, QueueState } from "@zcode/shared/zcode-protocol-v4";

export interface PendingGuideQueueProjection {
  pendingGuides: readonly QueueItem[];
  visibleQueue: QueueState;
}

/**
 * CLI reliably carries guide and future queue entries in the same queue fact; the old UI rendered
 * queue.items directly, mistakenly showing a guide waiting for model-step injection as the next turn's message. This only separates display
 * by authoritative admitted delivery; it does not copy or rewrite accepted input state.
 */
export function projectPendingGuideQueue(queue: QueueState): PendingGuideQueueProjection {
  const pendingGuides: QueueItem[] = [];
  const visibleItems: QueueItem[] = [];
  for (const item of queue.items) {
    if (item.delivery.admitted === "guide") {
      pendingGuides.push(item);
    } else {
      visibleItems.push(item);
    }
  }
  return {
    pendingGuides,
    visibleQueue:
      visibleItems.length === queue.items.length ? queue : { ...queue, items: visibleItems },
  };
}
