/**
 * Series palette and **secondary encoding** for preset charts.
 *
 * Colors reuse the design system's existing `--color-usage-chart-1..6` tokens directly (DESIGN.md “Color Usage Rules”:
 * use semantic tokens instead of inventing one-off values). These tokens are defined in all four themes (light / dark / zai-light / zai-dark),
 * so charts follow the theme automatically and components do not need theme branches.
 *
 * **Why every series also needs a dashed style**: these six color slots are not all pairwise distinguishable with color vision deficiencies (protan / deutan)
 * — the dataviz palette checker reports purple↔blue and orange↔red below the ΔE 8 threshold in all-pairs checks.
 * The checker's only permitted remedy is “add a secondary encoding”: each series therefore has a fixed line style in addition to color,
 * and legends/direct labels are always present, so identity never relies on color alone (the same principle as DESIGN.md “Use semantic status colors
 * together with readable text, never by color alone”). The palette itself is a repository-level asset.
 */

/** Number of color slots = maximum series per chart; omit extra y fields rather than recycling colors. */
export const ARTIFACT_CHART_MAX_SERIES = 6;

/** Color for series at index (CSS variable reference, updates immediately when the theme changes). */
export function artifactSeriesColorVar(index: number): string {
  return `var(--color-usage-chart-${(index % ARTIFACT_CHART_MAX_SERIES) + 1})`;
}

const SERIES_DASH: readonly (string | undefined)[] = [
  undefined,
  "6 3",
  "2 3",
  "9 3 2 3",
  "1 3",
  "12 4",
];

/** Line style for series at index; the first series is solid. */
export function artifactSeriesDash(index: number): string | undefined {
  return SERIES_DASH[index % SERIES_DASH.length];
}

const SERIES_SYMBOL = ["circle", "cross", "diamond", "square", "triangle", "star"] as const;

/** Scatterplot point shape; like line style, it is a second identity cue besides color. */
export function artifactSeriesSymbol(index: number): (typeof SERIES_SYMBOL)[number] {
  return SERIES_SYMBOL[index % SERIES_SYMBOL.length]!;
}
