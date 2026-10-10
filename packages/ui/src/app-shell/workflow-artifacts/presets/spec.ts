/**
 * Spec type mirror + permissive parsing for preset artifacts (chart / table / metrics / board).
 *
 * Here, `artifact` means the **user-facing** artifact:
 * a dashboard declared by the script through `artifact.chart(id, spec)` and populated by the `report(item, id)` stream; not the engine’s internal
 * `RunSettlement.artifact` “top-level return value.”
 *
 * **Why parse it again in the UI.** The engine (zod) is authoritative for spec validation and fails the run for invalid shapes.
 * The journal stores canonical JSON, but after the v4 projection reaches the renderer, its type has degraded to `unknown`.
 * The renderer may receive a valid spec written by a new CLI, a spec with missing fields from an older CLI, or a truncated/tampered row.
 * It should not throw and break the entire side pane; this layer performs only **structural** checks,
 * returning a normalized spec when renderable or `undefined` when not (the caller falls back to an “Unable to render” card).
 *
 * Permissive means extra keys are ignored, invalid optional fields are dropped, and only missing required fields make the spec unrenderable.
 */

/** Read one value from a report item by its dot path (for example, “timing.after”). */
export type ArtifactField = {
  field: string;
  label?: string;
  unit?: string;
};

export type ArtifactChartType = "line" | "bar" | "scatter";
export type ArtifactChartScale = "linear" | "log";

const CHART_TYPES: readonly ArtifactChartType[] = ["line", "bar", "scatter"];
const CHART_SCALES: readonly ArtifactChartScale[] = ["linear", "log"];

/** Shared display fields for all preset specs (facade’s `ArtifactOptions`). */
type ArtifactPresetOptions = {
  title?: string;
  description?: string;
};

export type ChartSpec = ArtifactPresetOptions & {
  /** Defaults to “line.” */
  type?: ArtifactChartType;
  x: ArtifactField;
  /** Multiple values produce multiple series. */
  y: ArtifactField | ArtifactField[];
  /** Y-axis, defaults to “linear.” */
  scale?: ArtifactChartScale;
  /** Draw a horizontal reference line from the first item **containing this field**. */
  baseline?: ArtifactField;
};

export type TableSpec = ArtifactPresetOptions & {
  columns: ArtifactField[];
  /** Row identity field; a later item with the same key replaces that row. Absent means append only. */
  key?: string;
};

export type MetricsSpec = ArtifactPresetOptions & {
  /** Value shown on each tile from the last item **containing this field**. */
  metrics: ArtifactField[];
};

export type BoardSpec = ArtifactPresetOptions & {
  /** Card identity field; a later item with the same key moves/updates that card. */
  key: string;
  /** Field used for the card’s column. */
  status: string;
  /** Column order. Items whose status is not listed fall into the final “Other” column. */
  columns: string[];
  /** Card title field (defaults to key) and additional fields displayed on the card. */
  cardTitle?: string;
  detail?: ArtifactField[];
};

export type ArtifactPresetKind = "chart" | "table" | "metrics" | "board";
export type ArtifactPresetSpec = ChartSpec | TableSpec | MetricsSpec | BoardSpec;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Non-empty string; all field paths / column names in the spec must be of this type. */
function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * An `ArtifactField`. It can be a plain string (“latencyMs”)—script authors may use this form even though the facade type disallows it; older journal entries may still contain it, so accept it here.
 */
function parseField(value: unknown): ArtifactField | undefined {
  const shorthand = readNonEmptyString(value);
  if (shorthand) {
    return { field: shorthand };
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const field = readNonEmptyString(value.field);
  if (!field) {
    return undefined;
  }
  const label = readNonEmptyString(value.label);
  const unit = readNonEmptyString(value.unit);
  return { field, ...(label ? { label } : {}), ...(unit ? { unit } : {}) };
}

/** A set of fields. Invalid entries are dropped individually (permissive); only an empty result is unrenderable. */
function parseFieldList(value: unknown): ArtifactField[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const fields = value
    .map(parseField)
    .filter((field): field is ArtifactField => field !== undefined);
  return fields.length > 0 ? fields : undefined;
}

function parseOptions(spec: Record<string, unknown>): ArtifactPresetOptions {
  const title = readNonEmptyString(spec.title);
  const description = readNonEmptyString(spec.description);
  return { ...(title ? { title } : {}), ...(description ? { description } : {}) };
}

function parseChartSpec(spec: Record<string, unknown>): ChartSpec | undefined {
  const x = parseField(spec.x);
  if (!x) {
    return undefined;
  }
  // Normalize a single y value and an array to the same array shape: downstream code (apply / renderers) uses just one shape,
  // reducing the places where an Array.isArray branch could cause a single-series chart to disappear.
  const single = Array.isArray(spec.y) ? undefined : parseField(spec.y);
  const y = Array.isArray(spec.y) ? parseFieldList(spec.y) : single ? [single] : undefined;
  if (!y) {
    return undefined;
  }
  const type = CHART_TYPES.find((candidate) => candidate === spec.type) ?? "line";
  const scale = CHART_SCALES.find((candidate) => candidate === spec.scale) ?? "linear";
  const baseline = parseField(spec.baseline);
  return {
    ...parseOptions(spec),
    type,
    x,
    y,
    scale,
    ...(baseline ? { baseline } : {}),
  };
}

function parseTableSpec(spec: Record<string, unknown>): TableSpec | undefined {
  const columns = parseFieldList(spec.columns);
  if (!columns) {
    return undefined;
  }
  const key = readNonEmptyString(spec.key);
  return { ...parseOptions(spec), columns, ...(key ? { key } : {}) };
}

function parseMetricsSpec(spec: Record<string, unknown>): MetricsSpec | undefined {
  const metrics = parseFieldList(spec.metrics);
  if (!metrics) {
    return undefined;
  }
  return { ...parseOptions(spec), metrics };
}

function parseBoardSpec(spec: Record<string, unknown>): BoardSpec | undefined {
  const key = readNonEmptyString(spec.key);
  const status = readNonEmptyString(spec.status);
  if (!key || !status) {
    return undefined;
  }
  if (!Array.isArray(spec.columns)) {
    return undefined;
  }
  const columns = spec.columns
    .map(readNonEmptyString)
    .filter((column): column is string => column !== undefined);
  if (columns.length === 0) {
    return undefined;
  }
  const cardTitle = readNonEmptyString(spec.cardTitle);
  const detail = parseFieldList(spec.detail);
  return {
    ...parseOptions(spec),
    key,
    status,
    columns,
    ...(cardTitle ? { cardTitle } : {}),
    ...(detail ? { detail } : {}),
  };
}

/**
 * Parse an `unknown` wire spec into a renderable shape; `undefined` means it cannot be rendered.
 *
 * Normalization handled here (so downstream code needs no fallback): `chart.y` is always an array, `chart.type` / `chart.scale`
 * always have values, and empty/whitespace-only strings are treated as absent.
 */
export function parseArtifactPresetSpec(
  kind: ArtifactPresetKind,
  spec: unknown,
): ArtifactPresetSpec | undefined {
  if (!isRecord(spec)) {
    return undefined;
  }
  switch (kind) {
    case "chart":
      return parseChartSpec(spec);
    case "table":
      return parseTableSpec(spec);
    case "metrics":
      return parseMetricsSpec(spec);
    case "board":
      return parseBoardSpec(spec);
    default:
      return undefined;
  }
}

/** Read normalized `chart.y`; a parsed spec is always an array, so this only narrows the type. */
export function chartSeriesFields(spec: ChartSpec): ArtifactField[] {
  return Array.isArray(spec.y) ? spec.y : [spec.y];
}

/** Field name shown in the UI: explicit `label` takes precedence, otherwise use the dot path itself. */
export function artifactFieldLabel(field: ArtifactField): string {
  return field.label ?? field.field;
}
