import { dispatchPluginUiResourceDelta } from "@/plugin-ui/app/pluginUiResourceNotificationBus.js";
import { buildPluginUiSessionKey, type PluginUiSessionScope } from "@/plugin-ui/contract.js";
import type { ConversationProjectionStore } from "@/v4/conversationProjectionStore.js";
import { useEffect } from "react";

/**
 * Wires a session projection store's live-only deltas into the resource notification routing table.
 * The same store may be held by SessionPane and multiple side pane tabs at once; reference-count the
 * store and attach a single listener to avoid duplicate delivery.
 */
const feeds = new Map<ConversationProjectionStore, { count: number; off: () => void }>();

export function attachPluginUiResourceDeltaFeed(
  store: ConversationProjectionStore,
  scope: PluginUiSessionScope,
): () => void {
  let entry = feeds.get(store);
  if (!entry) {
    const sessionKey = buildPluginUiSessionKey(scope);
    const off = store.onLiveDeltas((deltas) => {
      for (const delta of deltas) {
        if (
          delta.op === "pluginUi.resourceUpdated" ||
          delta.op === "pluginUi.resourceListChanged" ||
          delta.op === "pluginUi.appToolCall" ||
          delta.op === "pluginUi.instanceClosed"
        ) {
          dispatchPluginUiResourceDelta(sessionKey, delta);
        }
      }
    });
    entry = { count: 0, off };
    feeds.set(store, entry);
  }
  const active = entry;
  active.count += 1;
  return () => {
    active.count -= 1;
    if (active.count === 0 && feeds.get(store) === active) {
      active.off();
      feeds.delete(store);
    }
  };
}

export function usePluginUiResourceDeltaFeed(
  store: ConversationProjectionStore | null | undefined,
  scope: PluginUiSessionScope | null,
): void {
  const sessionKey = scope ? buildPluginUiSessionKey(scope) : null;
  useEffect(() => {
    if (!store || !scope) return;
    return attachPluginUiResourceDeltaFeed(store, scope);
    // Compare scope by session key (SessionPane may create a new object each render); do not put the object itself in deps.
  }, [store, sessionKey]);
}
