import { useMemo } from "react";
import {
  sortPluginStoreEntries,
  isPublicStoreMarketplaceId,
  type PluginStoreModeOrder,
  resolvePluginDisplayName,
  resolveLocalizedText,
  type ZCodePluginReferenceCatalogEntry,
} from "@zcode/shared";
import type { MentionCategoryResult, MentionItem } from "@/mentions/mentionTypes.js";
import { filterMentionItemsWithOptions } from "@/mentions/mentionSearch.js";
import { buildPluginMentionMarkdown } from "@/mentions/mentionMarkdown.js";
import { usePluginReferenceCatalog } from "@/hooks/usePluginReferenceCatalog.js";
import { usePluginStoreOrder } from "@/hooks/usePluginStoreOrder.js";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export interface PluginMentionLabels {
  conflictReason: string;
}

// - Show only enabled Plugins in the catalog; disabled entries cannot be referenced and are excluded from candidates.
// - Keep same-name manifest conflicts (conflictingPluginIds is non-empty) visible but disabled, with the conflict reason shown (V1 fails closed).
// - The markdown payload is fixed as `[@Label](plugin://stable-id)`; the label is for display only, and identity is in the destination.
//   The panel display name displayLabel uses the app-wide resolvePluginDisplayName for the current locale; label and
//   the payload label remains entry.name, and chip/canonical text/reminder do not change with locale (the chip node reuses
//   item.label; localizing the label would make message bubble copy reconstructed from markdown inconsistent).
// - Include display names in every language from the listing as keywords, regardless of the current locale: users can type Chinese in the English UI
//   to find official plugins (Chinese search for Plugin @ mentions).
export function mapPluginCatalogToMentionItemsForTest(
  entries: ZCodePluginReferenceCatalogEntry[],
  labels: PluginMentionLabels,
  locale: string,
  order?: PluginStoreModeOrder,
): MentionItem[] {
  const sorted =
    order && entries.some((entry) => entry.category !== undefined)
      ? [
          ...sortPluginStoreEntries(
            entries.filter((entry) => isPublicStoreMarketplaceId(entry.marketplace)),
            (entry) => ({
              id: entry.pluginId,
              category: entry.category,
              displayName: resolvePluginDisplayName(
                {
                  name: entry.name,
                  listing: {
                    displayName: entry.displayName,
                    displayNameI18n: entry.displayNameI18n,
                  },
                },
                locale,
              ),
            }),
            locale,
            order,
          ),
          ...entries.filter((entry) => !isPublicStoreMarketplaceId(entry.marketplace)),
        ]
      : entries;
  return sorted
    .filter((entry) => entry.enabled)
    .map((entry) => {
      const conflicted = entry.conflictingPluginIds.length > 0;
      return {
        id: `plugin:${entry.pluginId}`,
        category: "plugins" as const,
        label: entry.name,
        displayLabel: resolvePluginDisplayName(
          {
            name: entry.name,
            listing: {
              displayName: entry.displayName,
              displayNameI18n: entry.displayNameI18n,
            },
          },
          locale,
        ),
        description: resolveLocalizedText(locale, entry.description, entry.descriptionI18n) ?? "",
        value: entry.pluginId,
        markdown: buildPluginMentionMarkdown(entry.name, entry.pluginId),
        keywords: [
          entry.name,
          entry.pluginId,
          entry.marketplace,
          ...(entry.displayName ? [entry.displayName] : []),
          ...Object.values(entry.displayNameI18n ?? {}),
        ],
        data: {
          pluginId: entry.pluginId,
          ...(entry.icon ? { icon: entry.icon } : {}),
        },
        ...(conflicted
          ? {
              disabled: true,
              disabledReason: labels.conflictReason,
            }
          : {}),
      };
    });
}

export function usePluginsMentionProvider(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  sessionId: string | null,
  query: string,
  enabled: boolean,
  emptyText: string,
  title: string,
): MentionCategoryResult {
  const { intl, locale } = useZCodeIntl();
  const { order } = usePluginStoreOrder(enabled);
  const isOfficeMode = useIsOfficeMode();
  const modeOrder = isOfficeMode ? order?.work : order?.code;
  const catalog = usePluginReferenceCatalog(workspacePath, workspaceIdentity, sessionId, enabled);

  const allItems = useMemo(
    () =>
      mapPluginCatalogToMentionItemsForTest(
        catalog.entries,
        {
          conflictReason: intl.formatMessage({ id: "chat.mention.plugins.conflict" }),
        },
        locale,
        modeOrder,
      ),
    [catalog.entries, intl, locale, modeOrder],
  );

  const items = useMemo(
    () =>
      filterMentionItemsWithOptions(allItems, query, {
        requireQuery: false,
      }),
    [allItems, query],
  );

  return {
    items: enabled ? items : [],
    loading: catalog.loading,
    error: catalog.error ? new Error(catalog.error) : null,
    emptyText,
    title,
  };
}
