import { resolvePluginIconSource } from "@/lib/pluginIconSource.js";
import type { ZCodePluginReferenceCatalogEntry } from "@zcode/shared";
import type { ConversationRowsPartition } from "@zcode/shared/zcode-protocol-v4";
import { memoizeByRows, type ConversationStoreStatus } from "@/v4/conversationProjectionStore.js";

export function isSessionPluginCatalogReady(
  projectionStatus: ConversationStoreStatus,
  sessionId: string | null,
  snapshotSessionId: string | null | undefined,
): boolean {
  return Boolean(projectionStatus === "live" && sessionId && snapshotSessionId === sessionId);
}

export function hasPluginReferenceRows(
  rows: readonly {
    kind: string;
    text?: string;
    display?: { ui?: { pluginId?: string }; kind?: string };
  }[],
): boolean {
  return rows.some(
    (row) =>
      (row.kind === "userInput" && row.text?.includes("(plugin://")) ||
      (row.kind === "toolCall" && Boolean(row.display?.ui?.pluginId)),
  );
}

const pluginReferenceRowsByRows = memoizeByRows(hasPluginReferenceRows);

/**
 * Same result as hasPluginReferenceRows(history ++ tail).
 * Bug root cause: SessionPane scanned the entire history row by row on every render (every frame
 * while streaming); with the history-segment check cached by reference, only the tail rounds are scanned.
 */
export function hasPluginReferenceRowsInPartition(partition: ConversationRowsPartition): boolean {
  return pluginReferenceRowsByRows(partition.history) || pluginReferenceRowsByRows(partition.tail);
}

/**
 * Display-only projection for sent Plugin chips.
 *
 * Historical messages can be reconstructed for display only from canonical stable IDs; using workspace
 * authority by mistake could make an existing Session show data outside its identity boundary after Plugins are enabled/disabled.
 * Therefore build an icon map only with explicit Session authority; fail closed in all other cases.
 */
export function buildSessionPluginIconMap(
  authority: "session" | "workspace" | null,
  entries: readonly ZCodePluginReferenceCatalogEntry[],
): ReadonlyMap<string, string> {
  if (authority !== "session") {
    return new Map();
  }

  const iconById = new Map<string, string>();
  for (const entry of entries) {
    const icon = resolvePluginIconSource(entry.pluginId, entry.icon);
    if (icon) {
      iconById.set(entry.pluginId, icon);
    }
  }
  return iconById;
}
