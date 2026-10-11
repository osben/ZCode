import { buildPluginMentionMarkdown } from "@/mentions/mentionMarkdown.js";
import { resolveItemDisplayName, type StorePluginItem } from "@/settings/pluginStoreListing.js";
import type { ComposerMentionPrefill } from "@/store/zcodeSessionStoreTypes.js";

export function buildPluginStoreTryMention({
  item,
  locale,
}: {
  item: StorePluginItem;
  locale: string;
}): ComposerMentionPrefill {
  const label = resolveItemDisplayName(item, locale);
  return {
    id: `plugin:${item.id}`,
    category: "plugins",
    label,
    value: item.id,
    markdown: buildPluginMentionMarkdown(label, item.id),
    data: {
      pluginId: item.id,
      ...(item.listing?.icon ? { icon: item.listing.icon } : {}),
    },
  };
}

/**
 * Plugin store trials and the Composer @ Picker share the same canonical reference carrier.
 * The example prompt is only editable draft text after the reference; it does not create a second Plugin selection state.
 */
export function buildPluginStoreTryPrompt({
  item,
  locale,
  prompt,
}: {
  item: StorePluginItem;
  locale: string;
  prompt: string;
}): string {
  const pluginMention = buildPluginStoreTryMention({ item, locale }).markdown;
  const normalizedPrompt = prompt.trim();
  return normalizedPrompt ? `${pluginMention} ${normalizedPrompt}` : pluginMention;
}
