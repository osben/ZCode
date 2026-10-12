import type { ZCodePluginReferenceCatalogEntry } from "@zcode/shared";
import { buildPluginMentionMarkdown } from "@/mentions/mentionMarkdown.js";
import type { ComposerMentionPrefill } from "@/store/zcodeSessionStoreTypes.js";

export interface DraftSuggestedPromptPluginReference {
  stableId: string;
  label: string;
}

export interface DraftSuggestedPromptPrefill {
  text: string;
  mention?: ComposerMentionPrefill;
  pluginUnavailable?: true;
}

export function buildDraftSuggestedPluginMention(
  plugin: DraftSuggestedPromptPluginReference,
  icon?: string,
): ComposerMentionPrefill {
  const markdown = buildPluginMentionMarkdown(plugin.label, plugin.stableId);
  return {
    id: `plugin:${plugin.stableId}`,
    category: "plugins",
    label: plugin.label,
    value: plugin.stableId,
    markdown,
    data: {
      pluginId: plugin.stableId,
      ...(icon ? { icon } : {}),
    },
  };
}

export async function buildDraftSuggestedPromptPrefill({
  prompt,
  plugin,
  loadPluginCatalog,
  onCatalogError,
}: {
  prompt: string;
  plugin?: DraftSuggestedPromptPluginReference;
  loadPluginCatalog: () => Promise<readonly ZCodePluginReferenceCatalogEntry[]>;
  onCatalogError?: (error: unknown) => void;
}): Promise<DraftSuggestedPromptPrefill> {
  const text = prompt.trim();
  if (!plugin) {
    return { text };
  }

  let catalog: readonly ZCodePluginReferenceCatalogEntry[];
  try {
    catalog = await loadPluginCatalog();
  } catch (error) {
    onCatalogError?.(error);
    return { text };
  }

  const entry = catalog.find((candidate) => candidate.pluginId === plugin.stableId);
  // Bug cause: missing and disabled previously shared the silent-degradation branch with
  // conflicts, so callers could not distinguish states that require telling the user.
  // A missing catalog entry means the plugin is not installed in this workspace; no separate
  // installation-status query is needed.
  if (!entry || !entry.enabled) {
    return { text, pluginUnavailable: true };
  }
  if (entry.conflictingPluginIds.length > 0) {
    return { text };
  }

  const mention = buildDraftSuggestedPluginMention(plugin, entry.icon);
  const markdown = mention.markdown;

  return {
    text: text ? `${markdown} ${text}` : markdown,
    mention,
  };
}
