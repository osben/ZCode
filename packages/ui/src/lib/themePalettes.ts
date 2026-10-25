export const THEME_PALETTE_IDS = [
  "neutral",
  "zai",
  "ocean",
  "forest",
  "ember",
  "violet",
  "slate",
  "rose",
  "sand",
  "mint",
] as const;

export type ThemePalette = (typeof THEME_PALETTE_IDS)[number];

export type ThemeAccentPaletteId = Exclude<ThemePalette, "neutral" | "zai">;

export interface ThemePaletteDefinition {
  id: ThemePalette;
  /** Only accent palettes have values: brand colors in light and dark modes, used for WCAG contrast tests. */
  accent?: { light: string; dark: string };
}

export const THEME_PALETTES: readonly ThemePaletteDefinition[] = [
  { id: "neutral" },
  { id: "zai" },
  { id: "ocean", accent: { light: "#2563eb", dark: "#60a5fa" } },
  { id: "forest", accent: { light: "#15803d", dark: "#4ade80" } },
  { id: "ember", accent: { light: "#c2410c", dark: "#fb923c" } },
  { id: "violet", accent: { light: "#7c3aed", dark: "#a78bfa" } },
  { id: "slate", accent: { light: "#475569", dark: "#94a3b8" } },
  { id: "rose", accent: { light: "#be185d", dark: "#f472b6" } },
  { id: "sand", accent: { light: "#a16207", dark: "#facc15" } },
  { id: "mint", accent: { light: "#0f766e", dark: "#2dd4bf" } },
];

export const DEFAULT_THEME_PALETTE: ThemePalette = "zai";

export function isThemePalette(value: unknown): value is ThemePalette {
  return typeof value === "string" && (THEME_PALETTE_IDS as readonly string[]).includes(value);
}

export function isAccentPalette(value: unknown): value is ThemeAccentPaletteId {
  return isThemePalette(value) && value !== "neutral" && value !== "zai";
}
