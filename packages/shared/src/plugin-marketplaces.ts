export interface DefaultPluginMarketplace {
  id: string;
  source: string;
  name: string;
  description: string;
  pluginCount: number;
  lastUpdated?: string;
}

export const ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID = "zcode-plugins-official";

/** Shared by the three resource-discovery surfaces in Settings; the Bootstrap unit test mechanically compares defaultEnabled against official definitions. */
export const DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS: ReadonlySet<string> = new Set([
  "browser-use@zcode-plugins-official",
  "image-search@zcode-plugins-official",
  "documents@zcode-plugins-official",
  "pdf@zcode-plugins-official",
  "presentations@zcode-plugins-official",
  "spreadsheets@zcode-plugins-official",
  // node_repl host: it is not listed in the marketplace, shown to users, or a source of skills/commands/subagents, but it must
  // always be available — node_repl registration is gated by either Browser Use or Computer Use being enabled, while the host itself
  // is not part of that check. Browser Use is enabled by default, so disabling the host by default would leave it without a host at startup.
  "node-repl-host@zcode-plugins-official",
  "skill-creator@zcode-plugins-official",
  "plugin-creator@zcode-plugins-official",
  "zcode-guide@zcode-plugins-official",
  // Computer control falls back to disabled by default, so computer-use is not included in this list.
  // This set must match every plugin marked defaultEnabled in official-plugin-definitions.ts,
  // and the Bootstrap test mechanically compares them to ensure the default-enabled Settings set matches the CLI's official plugin declarations.
]);

export const DEFAULT_PLUGIN_MARKETPLACES: DefaultPluginMarketplace[] = [
  {
    // The only official ZCode marketplace: local seed and CDN shards are merged in Agent storage.
    // The CDN manifest name must match this canonical id.
    id: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
    source: "https://cdn-zcode.z.ai/zcode/official-plugin/marketplace.json",
    name: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
    description: "Official ZCode plugins marketplace: built-in and community plugins for ZCode.",
    pluginCount: 0,
  },
];

// The store's "Public" section has only one official ZCode marketplace id; built-in and CDN sources no longer have separate identities.
export const PUBLIC_STORE_MARKETPLACE_IDS = [ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID] as const;

export function isPublicStoreMarketplaceId(id: string): boolean {
  return (PUBLIC_STORE_MARKETPLACE_IDS as readonly string[]).includes(id);
}
