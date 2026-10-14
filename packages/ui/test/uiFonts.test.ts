import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyMonoFontFamily,
  applyUiFontFamily,
  loadMonoFontFamily,
  loadUiFontFamily,
  MAX_CUSTOM_FONT_FAMILY_LENGTH,
  MONO_FONT_FAMILY_STORAGE_KEY,
  normalizeCustomFontFamily,
  normalizeInstalledFontFamilies,
  resolveTerminalFontFamily,
  UI_FONT_FAMILY_STORAGE_KEY,
} from "../src/lib/uiFonts.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubDocument() {
  const properties = new Map<string, string>();
  const removed = new Set<string>();
  const style = {
    setProperty: (name: string, value: string) => {
      properties.set(name, value);
      removed.delete(name);
    },
    removeProperty: (name: string) => {
      properties.delete(name);
      removed.add(name);
    },
  };
  vi.stubGlobal("localStorage", { getItem: () => null });
  vi.stubGlobal("document", { documentElement: { style }, fonts: { check: () => true } });
  return { properties, removed, style };
}

describe("normalizeCustomFontFamily", () => {
  it("returns null for empty, whitespace, or oversized input", () => {
    expect(normalizeCustomFontFamily(null)).toBeNull();
    expect(normalizeCustomFontFamily(undefined)).toBeNull();
    expect(normalizeCustomFontFamily("")).toBeNull();
    expect(normalizeCustomFontFamily("   ")).toBeNull();
    expect(normalizeCustomFontFamily("x".repeat(MAX_CUSTOM_FONT_FAMILY_LENGTH + 1))).toBeNull();
  });

  it("trims and strips quotes from user input", () => {
    expect(normalizeCustomFontFamily('  "SF Mono"  ')).toBe("SF Mono");
    expect(normalizeCustomFontFamily("'JetBrains Mono'")).toBe("JetBrains Mono");
  });
});

describe("load persisted families", () => {
  it("uses stored values per key", () => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) =>
        key === UI_FONT_FAMILY_STORAGE_KEY
          ? "Inter"
          : key === MONO_FONT_FAMILY_STORAGE_KEY
            ? '"SF Mono"'
            : null,
    });
    expect(loadUiFontFamily()).toBe("Inter");
    expect(loadMonoFontFamily()).toBe("SF Mono");
  });
});

describe("apply font family overrides", () => {
  it("applies a custom family by prepending it to the default stack", () => {
    const { properties } = stubDocument();
    applyUiFontFamily("My Font");
    expect(properties.get("--font-sans")).toBe(
      '"My Font", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
    );
    applyMonoFontFamily("My Mono");
    expect(properties.get("--font-mono")).toContain('"My Mono", ui-monospace');
  });

  it("keeps the CJK-safe mono fallback order", () => {
    const { properties } = stubDocument();
    applyMonoFontFamily("My Mono");
    const value = properties.get("--font-mono") ?? "";
    expect(value.indexOf("Consolas")).toBeLessThan(value.indexOf('"Microsoft YaHei UI"'));
    expect(value.endsWith("monospace")).toBe(true);
  });

  it("removes the CSS property when the override is cleared", () => {
    const { properties, removed } = stubDocument();
    applyUiFontFamily("My Font");
    applyUiFontFamily(null);
    applyMonoFontFamily("");
    expect(properties.has("--font-sans")).toBe(false);
    expect(removed.has("--font-sans")).toBe(true);
    expect(properties.has("--font-mono")).toBe(false);
    expect(removed.has("--font-mono")).toBe(true);
  });
});

describe("normalizeInstalledFontFamilies", () => {
  it("dedupes families, trims, and sorts case-insensitively", () => {
    expect(
      normalizeInstalledFontFamilies([
        { family: "Arial" },
        { family: "SF Mono" },
        { family: "  Arial  " },
        { family: "arial" },
        { family: "   " },
        { family: "Zapfino" },
      ]),
    ).toEqual(["Arial", "SF Mono", "Zapfino"]);
  });

  it("returns an empty list for empty or malformed input", () => {
    expect(normalizeInstalledFontFamilies([])).toEqual([]);
    expect(
      normalizeInstalledFontFamilies([{ family: undefined as unknown as string }, { family: "" }]),
    ).toEqual([]);
  });
});

describe("resolveTerminalFontFamily", () => {
  const defaultStack = "Default Mono";

  it("prefers the terminal-specific setting over the appearance mono font", () => {
    expect(
      resolveTerminalFontFamily({
        customMonoFamily: "Appearance Mono",
        profileFontFamily: "Terminal Setting",
        profileFontIsCustom: true,
        defaultStack,
      }),
    ).toBe("Terminal Setting");
  });

  it("prepends the appearance mono font to the profile stack", () => {
    expect(
      resolveTerminalFontFamily({
        customMonoFamily: "Appearance Mono",
        profileFontFamily: "System Profile",
        profileFontIsCustom: false,
        defaultStack,
      }),
    ).toBe('"Appearance Mono", System Profile');
  });

  it("falls back to the default stack without any override", () => {
    expect(
      resolveTerminalFontFamily({
        customMonoFamily: null,
        profileFontFamily: undefined,
        profileFontIsCustom: false,
        defaultStack,
      }),
    ).toBe(defaultStack);
  });
});
