import { describe, expect, it } from "vitest";
import { DEFAULT_PLUGIN_MARKETPLACES, isPublicStoreMarketplaceId } from "../src/index.js";

describe("DEFAULT_PLUGIN_MARKETPLACES", () => {
  it("includes the official CDN marketplace and the Claude official marketplace", () => {
    expect(DEFAULT_PLUGIN_MARKETPLACES).toEqual([
      expect.objectContaining({
        id: "zcode-plugins-official",
        name: "zcode-plugins-official",
        pluginCount: 0,
        source: "https://cdn-zcode.z.ai/zcode/official-plugin/marketplace.json",
      }),
      expect.objectContaining({
        id: "claude-plugins-official",
        name: "claude-plugins-official",
        pluginCount: 0,
        source: "anthropics/claude-plugins-official",
      }),
    ]);
  });

  it("classifies only the ZCode-operated channels as public store marketplaces", () => {
    expect(isPublicStoreMarketplaceId("zcode-plugins-official")).toBe(true);
    expect(isPublicStoreMarketplaceId("zcode-plugins")).toBe(false);
    // The Claude official marketplace is trusted but not in the "public" segment (it belongs to personal), see the CONTEXT.md glossary.
    expect(isPublicStoreMarketplaceId("claude-plugins-official")).toBe(false);
    expect(isPublicStoreMarketplaceId("inline")).toBe(false);
  });
});
