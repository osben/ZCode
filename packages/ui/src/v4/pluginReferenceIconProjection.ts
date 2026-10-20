import { resolvePluginIconSource } from "@/lib/pluginIconSource.js";
import type { ZCodePluginReferenceCatalogEntry } from "@zcode/shared";
import type { ConversationStoreStatus } from "@/v4/conversationProjectionStore.js";

export function isSessionPluginCatalogReady(
  projectionStatus: ConversationStoreStatus,
  sessionId: string | null,
  snapshotSessionId: string | null | undefined,
): boolean {
  return Boolean(projectionStatus === "live" && sessionId && snapshotSessionId === sessionId);
}

export function hasPluginReferenceUserRows(
  rows: readonly { kind: string; text?: string }[],
): boolean {
  return rows.some((row) => row.kind === "userInput" && row.text?.includes("(plugin://"));
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
