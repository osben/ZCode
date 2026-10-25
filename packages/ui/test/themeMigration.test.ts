import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_THEME_PALETTE,
  THEME_PALETTE_IDS,
  isAccentPalette,
  isThemePalette,
  migrateThemeSelection,
} from "../src/useTheme.js";

describe("migrateThemeSelection", () => {
  it("maps legacy zai mode values to a mode and the zai palette", () => {
    assert.deepEqual(migrateThemeSelection("zai-light", null), {
      mode: "light",
      palette: "zai",
    });
    assert.deepEqual(migrateThemeSelection("zai-dark", null), {
      mode: "dark",
      palette: "zai",
    });
  });

  it("keeps plain light, dark and system modes on the zai palette", () => {
    assert.deepEqual(migrateThemeSelection("light", null), { mode: "light", palette: "zai" });
    assert.deepEqual(migrateThemeSelection("dark", null), { mode: "dark", palette: "zai" });
    assert.deepEqual(migrateThemeSelection("system", null), { mode: "system", palette: "zai" });
  });

  it("uses fallbackMode when the stored mode is missing or unknown", () => {
    assert.deepEqual(migrateThemeSelection(null, null), { mode: "dark", palette: "zai" });
    assert.deepEqual(migrateThemeSelection("garbage", null), { mode: "dark", palette: "zai" });
    assert.deepEqual(migrateThemeSelection(null, null, "light"), {
      mode: "light",
      palette: "zai",
    });
  });

  it("does not let fallbackMode override a stored mode", () => {
    assert.deepEqual(migrateThemeSelection("dark", null, "light"), {
      mode: "dark",
      palette: "zai",
    });
  });

  it("keeps a valid stored palette", () => {
    assert.deepEqual(migrateThemeSelection("light", "ocean"), {
      mode: "light",
      palette: "ocean",
    });
    assert.deepEqual(migrateThemeSelection("system", "neutral"), {
      mode: "system",
      palette: "neutral",
    });
  });

  it("falls back to the default palette when the stored palette is invalid", () => {
    assert.equal(migrateThemeSelection("dark", "not-a-palette").palette, DEFAULT_THEME_PALETTE);
    assert.equal(migrateThemeSelection("dark", "").palette, DEFAULT_THEME_PALETTE);
    assert.equal(migrateThemeSelection("dark", null).palette, DEFAULT_THEME_PALETTE);
  });
});

describe("theme palette registry", () => {
  it("defaults to zai", () => {
    assert.equal(DEFAULT_THEME_PALETTE, "zai");
  });

  it("contains neutral, zai and eight accent palettes", () => {
    assert.deepEqual([...THEME_PALETTE_IDS].sort(), [
      "ember",
      "forest",
      "mint",
      "neutral",
      "ocean",
      "rose",
      "sand",
      "slate",
      "violet",
      "zai",
    ]);
  });

  it("validates palette ids", () => {
    for (const id of THEME_PALETTE_IDS) {
      assert.equal(isThemePalette(id), true, id);
    }
    assert.equal(isThemePalette("zai-dark"), false);
    assert.equal(isThemePalette(null), false);
    assert.equal(isThemePalette(42), false);
  });

  it("classifies only the eight accent palettes as accent", () => {
    assert.equal(isAccentPalette("ocean"), true);
    assert.equal(isAccentPalette("neutral"), false);
    assert.equal(isAccentPalette("zai"), false);
    assert.equal(isAccentPalette("unknown"), false);
  });
});
