import recommendedPluginsConfig from "@/settings/recommendedPlugins.json" with { type: "json" };

// The client's curated "recommended" section has been retired (product decision: the personal segment no
// longer pins a curated list); only the default marketplace id is kept here — it is the default personal
// marketplace beyond the official one, and several views use it for attribution decisions.
// If the curated list needs to be restored, the full selectRecommendedPlugins implementation is in git history.

/** Default marketplace id: the UI shows this marketplace by default and matches recommended plugins against it. */
export const DEFAULT_MARKETPLACE_ID = (recommendedPluginsConfig as { marketplace: string })
  .marketplace;
