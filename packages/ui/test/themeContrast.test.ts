import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { THEME_PALETTES } from "../src/lib/themePalettes.js";

const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

// Approximate sRGB values for Tailwind’s default neutral-50 and neutral-900, corresponding to oklch(98.5% 0 0) and oklch(20.5% 0 0).
const LIGHT_BACKGROUND = "#fafafa";
const DARK_BACKGROUND = "#171717";
const MIN_CONTRAST = 3;

// --color-foreground is neutral-700 in light mode and neutral-200 in dark mode, using the corresponding approximate sRGB values.
const LIGHT_FOREGROUND = "#404040";
const DARK_FOREGROUND = "#e5e5e5";
const SURFACE_TOKENS = [
  "--color-background",
  "--color-sidebar",
  "--color-header",
  "--color-panel",
  "--color-card",
  "--color-popover",
  "--color-input",
  "--color-background-win-alt",
] as const;

const accentPalettes = THEME_PALETTES.flatMap((palette) =>
  palette.accent ? [{ id: palette.id, accent: palette.accent }] : [],
);

function channelToLinear(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  return (
    0.2126 * channelToLinear((value >> 16) & 0xff) +
    0.7152 * channelToLinear((value >> 8) & 0xff) +
    0.0722 * channelToLinear(value & 0xff)
  );
}

function contrastRatio(a: string, b: string): number {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

function readPaletteBlock(selector: string): string {
  return new RegExp(`${selector}\\s*\\{([^}]*)\\}`).exec(styles)?.[1] ?? "";
}

function readPaletteHex(selector: string, property: string): string | undefined {
  return new RegExp(`${property}:\\s*(#[0-9a-fA-F]{6})`)
    .exec(readPaletteBlock(selector))?.[1]
    ?.toLowerCase();
}

function readPaletteValue(selector: string, property: string): string | undefined {
  return new RegExp(`${property}:\\s*([^;]+);`).exec(readPaletteBlock(selector))?.[1]?.trim();
}

describe("theme palette contrast", () => {
  it("keeps every accent at 3:1 or higher on its mode background", () => {
    for (const { id, accent } of accentPalettes) {
      const light = contrastRatio(accent.light, LIGHT_BACKGROUND);
      const dark = contrastRatio(accent.dark, DARK_BACKGROUND);
      assert.ok(light >= MIN_CONTRAST, `${id} light accent ratio ${light.toFixed(2)}`);
      assert.ok(dark >= MIN_CONTRAST, `${id} dark accent ratio ${dark.toFixed(2)}`);
    }
  });

  it("matches the registry hexes in styles.css for brand and primary in light and dark modes", () => {
    for (const { id, accent } of accentPalettes) {
      const modes = [
        [`\\.palette-${id}`, accent.light],
        [`\\.palette-${id}\\.dark`, accent.dark],
      ] as const;
      for (const [selector, hex] of modes) {
        assert.equal(readPaletteHex(selector, "--color-brand"), hex.toLowerCase(), `${id} brand`);
        assert.equal(
          readPaletteHex(selector, "--color-primary"),
          hex.toLowerCase(),
          `${id} primary`,
        );
      }
    }
  });

  it("keeps primary foreground at 4.5:1 or higher on the primary fill", () => {
    for (const { id } of accentPalettes) {
      for (const selector of [`\\.palette-${id}`, `\\.palette-${id}\\.dark`]) {
        const fill = readPaletteHex(selector, "--color-primary");
        const foreground = readPaletteHex(selector, "--color-primary-foreground");
        assert.ok(fill && foreground, `${id} ${selector} is missing primary tokens`);
        const ratio = contrastRatio(foreground, fill);
        assert.ok(ratio >= 4.5, `${id} ${selector} primary foreground ratio ${ratio.toFixed(2)}`);
      }
    }
  });

  it("keeps foreground text at 4.5:1 or higher on every palette surface", () => {
    for (const { id } of accentPalettes) {
      const modes = [
        ["light", `\\.palette-${id}`, LIGHT_FOREGROUND],
        ["dark", `\\.palette-${id}\\.dark`, DARK_FOREGROUND],
      ] as const;
      for (const [mode, selector, foreground] of modes) {
        for (const token of SURFACE_TOKENS) {
          const surface = readPaletteHex(selector, token);
          assert.ok(surface, `${id} ${mode} is missing ${token}`);
          const ratio = contrastRatio(foreground, surface);
          assert.ok(ratio >= 4.5, `${id} ${mode} ${token} foreground ratio ${ratio.toFixed(2)}`);
        }
      }
    }
  });

  it("tints background-alt from the palette win-alt in every mode block", () => {
    // background-alt is the translucent layer used by the macOS sidebar and collapsed rail. color-mix generates it, so validate its expression form instead of parsing it as hex.
    const expected = "color-mix(in oklab, var(--color-background-win-alt) 60%, transparent)";
    for (const { id } of accentPalettes) {
      for (const selector of [`\\.palette-${id}`, `\\.palette-${id}\\.dark`]) {
        assert.equal(
          readPaletteValue(selector, "--color-background-alt"),
          expected,
          `${id} ${selector} background-alt`,
        );
      }
    }
  });

  it("derives overlay and selection surfaces from each palette popover and input", () => {
    // Menus, tooltips, popover headers, and selected cards previously kept the neutral base values
    // under accent palettes, rendering dropdown content unthemed. Like background-alt, these tokens
    // are var/color-mix expressions, so pin the exact expression for every token and mode: a
    // neutralized, mistyped, or omitted derivation must fail here instead of shipping.
    const derivedByMode = [
      {
        mode: "light",
        selector: (id: string) => `\\.palette-${id}`,
        expected: {
          "--color-menu": "var(--color-popover)",
          "--color-menu-hover":
            "color-mix(in oklab, var(--color-popover) 92%, var(--color-neutral-950))",
          "--color-popover-header":
            "color-mix(in oklab, var(--color-popover) 94%, var(--color-neutral-950))",
          "--color-tooltip":
            "color-mix(in oklab, var(--color-popover) 92%, var(--color-neutral-950))",
          "--color-tooltip-tag":
            "color-mix(in oklab, var(--color-popover) 88%, var(--color-neutral-950))",
          "--color-card-selected":
            "color-mix(in oklab, var(--color-popover) 92%, var(--color-neutral-950))",
          "--color-input-focused": "var(--color-input)",
        },
      },
      {
        mode: "dark",
        selector: (id: string) => `\\.palette-${id}\\.dark`,
        expected: {
          "--color-menu": "var(--color-popover)",
          "--color-menu-hover": "color-mix(in oklab, var(--color-popover) 92%, var(--color-white))",
          "--color-popover-header":
            "color-mix(in oklab, var(--color-popover) 88%, var(--color-neutral-950))",
          "--color-tooltip":
            "color-mix(in oklab, var(--color-popover) 85%, var(--color-neutral-950))",
          "--color-tooltip-tag":
            "color-mix(in oklab, var(--color-popover) 94%, var(--color-white))",
          "--color-card-selected":
            "color-mix(in oklab, var(--color-popover) 92%, var(--color-white))",
          "--color-input-focused": "var(--color-input)",
        },
      },
    ] as const;
    for (const { id } of accentPalettes) {
      for (const { mode, selector, expected } of derivedByMode) {
        for (const [token, expression] of Object.entries(expected)) {
          assert.equal(readPaletteValue(selector(id), token), expression, `${id} ${mode} ${token}`);
        }
      }
    }
  });

  it("keeps every quick prompt color dot at 3:1 or higher on the card surface of its theme", () => {
    // specs/composer-quick-prompts.md rule 23. Approximate sRGB values of the Tailwind v4 steps the
    // dot tokens may reference; an unknown step fails so a new reference must be added here.
    const tailwindHex: Record<string, string> = {
      "red-400": "#ff6467",
      "red-500": "#fb2c36",
      "orange-400": "#ff8904",
      "orange-500": "#ff6900",
      "orange-600": "#f54900",
      "yellow-400": "#fdc700",
      "yellow-500": "#f0b100",
      "yellow-600": "#d08700",
      "yellow-700": "#a65f00",
      "green-400": "#05df72",
      "green-500": "#00c950",
      "green-600": "#00a63e",
      "blue-400": "#51a2ff",
      "blue-500": "#2b7fff",
      "violet-400": "#a684ff",
      "violet-500": "#8e51ff",
      "pink-400": "#fb64b6",
      "pink-500": "#f6339a",
    };
    // Card surfaces: white (light), neutral-800 (dark), and the z.ai theme hexes.
    const themes = [
      { block: /^@theme \{([^}]*)\}/m, card: "#ffffff" },
      { block: /^\.dark \{([^}]*)\}/m, card: "#262626" },
      { block: /^\.theme-zai-light \{([^}]*)\}/m, card: "#ffffff" },
      { block: /^\.theme-zai-dark \{([^}]*)\}/m, card: "#2b2b2b" },
    ];
    const hues = ["red", "orange", "yellow", "green", "blue", "violet", "pink"];
    for (const { block, card } of themes) {
      const body = block.exec(styles)?.[1];
      assert.ok(body, `${block} is missing`);
      for (const hue of hues) {
        const step = new RegExp(
          `--color-quick-prompt-${hue}:\\s*var\\(--color-([a-z]+-\\d+)\\);`,
        ).exec(body)?.[1];
        assert.ok(step, `${block} is missing --color-quick-prompt-${hue}`);
        const hex = tailwindHex[step];
        assert.ok(hex, `no reference hex for ${step}`);
        const ratio = contrastRatio(hex, card);
        assert.ok(ratio >= MIN_CONTRAST, `${block} ${hue} (${step}) ratio ${ratio.toFixed(2)}`);
      }
    }
  });

  it("defines CSS palette blocks only for accent palettes", () => {
    const blockIds = [...styles.matchAll(/^\.palette-([a-z]+) \{/gm)].map((match) => match[1]);
    assert.deepEqual(
      blockIds,
      accentPalettes.map((palette) => palette.id),
    );
  });
});
