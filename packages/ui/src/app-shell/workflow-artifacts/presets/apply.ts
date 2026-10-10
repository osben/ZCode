/**
 * `applyArtifactItems` — fold a sequence of `report(item, artifactId)` entries into a preset dashboard view model.
 *
 * Pure function, no React: the dashboard itself **stores no data**; every point/row/card comes from a matching journal entry with
 * `kind = "report"` and `artifact_id`. Replaying the same entries twice must produce the same chart, so there can be no clock, randomness, or external state here; all folding rules come from the spec.
 *
 * Entries are **append-only**.
 */

import {
  artifactFieldLabel,
  chartSeriesFields,
  type ArtifactChartScale,
  type ArtifactChartType,
  type ArtifactField,
  type ArtifactPresetKind,
  type ArtifactPresetSpec,
  type BoardSpec,
  type ChartSpec,
  type MetricsSpec,
  type TableSpec,
} from "@/app-shell/workflow-artifacts/presets/spec.js";

/** One arrived entry. `sequence` is a globally increasing event number within the run—it is both the React key (new-point reveal animation uses it to distinguish a new point) and the incremental-fetch cursor; `siteId × ordinal` is the journal identity (same key convention as the Results area), used for row/card identity when no spec key exists. */
export type ArtifactItem = {
  sequence: number;
  siteId: string;
  ordinal: number;
  item: unknown;
};

export type ChartSeriesModel = {
  /** recharts dataKey; use the sequence number instead of a field path because recharts treats dots in paths as nested access. */
  key: string;
  field: string;
  label: string;
  unit?: string;
  /** Palette slot (see seriesColorVar). */
  colorIndex: number;
};

export type ChartPointModel = Record<string, number | string | null> & {
  /** Stable React key: animate reveal only for new points; do not replay old points. */
  sequence: number;
  /** Position on the x-axis. For non-numeric x, use arrival sequence. */
  x: number;
  /** Text shown on x-axis ticks. */
  xLabel: string;
};

export type ChartModel = {
  kind: "chart";
  type: ArtifactChartType;
  scale: ArtifactChartScale;
  series: ChartSeriesModel[];
  points: ChartPointModel[];
  x: { label: string; unit?: string; numeric: boolean };
  /** Reference line: taken from the first entry containing the field. Also discard non-positive reference lines for log axes. */
  baseline?: { value: number; label: string; unit?: string };
  /** Domain used for memo comparison; absent when there are no points. */
  domain?: { xMin: number; xMax: number; yMin: number; yMax: number };
};

type TableColumnModel = { field: string; label: string; unit?: string };
type TableRowModel = { id: string; sequence: number; cells: string[] };
type TableModel = {
  kind: "table";
  columns: TableColumnModel[];
  rows: TableRowModel[];
};

export type MetricTileModel = {
  field: string;
  label: string;
  unit?: string;
  /** Value from the last entry containing the field; absent if it has never appeared. */
  value?: string;
  raw?: unknown;
  /** Entry this value came from—the animation key when a tile updates. */
  sequence?: number;
};
type MetricsModel = { kind: "metrics"; metrics: MetricTileModel[] };

export type BoardCardModel = {
  id: string;
  sequence: number;
  title: string;
  status: string;
  details: { label: string; value: string; unit?: string }[];
};
export type BoardColumnModel = {
  id: string;
  /** The “Other” column has no name in the spec; the renderer supplies labels.otherColumn. */
  other: boolean;
  cards: BoardCardModel[];
};
type BoardModel = {
  kind: "board";
  columns: BoardColumnModel[];
  cardCount: number;
};

type ArtifactPresetModel = ChartModel | TableModel | MetricsModel | BoardModel;

/** Column ID for entries in the trailing “Other” column; if the spec has a column with the same ID, merge them (acceptable). */
const BOARD_OTHER_COLUMN_ID = "__other__";

/**
 * Read a dot path such as “timing.after” or “rounds.0.ms.”
 * Array indices are numeric path segments; return `undefined` when the path cannot be resolved (= the entry has no such field).
 */
function readArtifactField(item: unknown, path: string): unknown {
  const segments = path.split(".");
  let cursor: unknown = item;
  for (const segment of segments) {
    if (cursor === null || cursor === undefined) {
      return undefined;
    }
    if (Array.isArray(cursor)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= cursor.length) {
        return undefined;
      }
      cursor = cursor[index];
      continue;
    }
    if (typeof cursor !== "object") {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/**
 * Whether this entry contains the field. Both `undefined` and `null` count as absent: if metrics treat an explicit null as the “last entry containing this field,”
 * a single clear operation would pin the tile to an empty value.
 */
function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null;
}

/** Convert to a number: accept numbers directly and numeric strings too (scripts often extract values from command output as strings). */
function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** Display text for cell/card details. Use compact JSON for objects—it is more useful than “[object Object]”. */
function formatArtifactValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    // Circular references and similar values: show a placeholder rather than throwing and breaking the entire table.
    return String(value);
  }
}

function seriesKey(index: number): string {
  return `y${index}`;
}

function applyChart(spec: ChartSpec, items: readonly ArtifactItem[]): ChartModel {
  const fields = chartSeriesFields(spec);
  const series: ChartSeriesModel[] = fields.map((field, index) => ({
    key: seriesKey(index),
    field: field.field,
    label: artifactFieldLabel(field),
    ...(field.unit ? { unit: field.unit } : {}),
    colorIndex: index,
  }));

  type Raw = { sequence: number; x: unknown; values: (number | undefined)[] };
  const raws: Raw[] = [];
  let baseline: ChartModel["baseline"];

  for (const entry of items) {
    const rawX = readArtifactField(entry.item, spec.x.field);
    if (!hasValue(rawX)) {
      // Entries without x have no place on the chart; skip them silently (they remain visible in the Results section).
      continue;
    }
    const values = fields.map((field) => {
      const value = toFiniteNumber(readArtifactField(entry.item, field.field));
      if (value === undefined) {
        return undefined;
      }
      // Non-positive values have no position on a log axis; omit this dimension for the point rather than dropping the whole series or chart.
      return spec.scale === "log" && value <= 0 ? undefined : value;
    });
    raws.push({ sequence: entry.sequence, x: rawX, values });

    if (spec.baseline && !baseline) {
      const raw = readArtifactField(entry.item, spec.baseline.field);
      const value = toFiniteNumber(raw);
      if (value !== undefined && !(spec.scale === "log" && value <= 0)) {
        baseline = {
          value,
          label: artifactFieldLabel(spec.baseline),
          ...(spec.baseline.unit ? { unit: spec.baseline.unit } : {}),
        };
      }
    }
  }

  // Sort only when x is numeric. If any value is non-numeric, use arrival order for the entire axis; a partially sorted x-axis is more misleading than no sorting.
  const numericX = raws.length > 0 && raws.every((raw) => toFiniteNumber(raw.x) !== undefined);
  const ordered = numericX
    ? [...raws].sort((left, right) => {
        const delta = toFiniteNumber(left.x)! - toFiniteNumber(right.x)!;
        // Keep arrival order for equal x values so the same entries collapse in the same order each time.
        return delta !== 0 ? delta : left.sequence - right.sequence;
      })
    : raws;

  const points: ChartPointModel[] = ordered.map((raw, index) => {
    const x = numericX ? toFiniteNumber(raw.x)! : index;
    const point: ChartPointModel = {
      sequence: raw.sequence,
      x,
      xLabel: formatArtifactValue(raw.x),
    };
    raw.values.forEach((value, seriesIndex) => {
      point[seriesKey(seriesIndex)] = value ?? null;
    });
    return point;
  });

  const yValues = ordered.flatMap((raw) =>
    raw.values.filter((value): value is number => value !== undefined),
  );
  const domain =
    points.length > 0 && yValues.length > 0
      ? {
          xMin: Math.min(...points.map((point) => point.x)),
          xMax: Math.max(...points.map((point) => point.x)),
          yMin: Math.min(...yValues),
          yMax: Math.max(...yValues),
        }
      : undefined;

  return {
    kind: "chart",
    type: spec.type ?? "line",
    scale: spec.scale ?? "linear",
    series,
    points,
    x: {
      label: artifactFieldLabel(spec.x),
      ...(spec.x.unit ? { unit: spec.x.unit } : {}),
      numeric: numericX,
    },
    ...(baseline ? { baseline } : {}),
    ...(domain ? { domain } : {}),
  };
}

function applyTable(spec: TableSpec, items: readonly ArtifactItem[]): TableModel {
  const columns: TableColumnModel[] = spec.columns.map((column) => ({
    field: column.field,
    label: artifactFieldLabel(column),
    ...(column.unit ? { unit: column.unit } : {}),
  }));

  // A present key means upsert: a later entry replaces the entire row, but **the row keeps its first position**—
  // a table that keeps changing sort order during a run is difficult to read.
  const byId = new Map<string, TableRowModel>();
  for (const entry of items) {
    const keyValue = spec.key ? readArtifactField(entry.item, spec.key) : undefined;
    // If key is absent (or declared but omitted from this entry), fall back to the journal identity: `siteId@ordinal` is unique per entry,
    // so upsert naturally becomes append without separate paths for the two modes.
    const id = hasValue(keyValue)
      ? formatArtifactValue(keyValue)
      : `${entry.siteId}@${entry.ordinal}`;
    byId.set(id, {
      id,
      sequence: entry.sequence,
      cells: columns.map((column) =>
        formatArtifactValue(readArtifactField(entry.item, column.field)),
      ),
    });
  }

  return { kind: "table", columns, rows: [...byId.values()] };
}

function applyMetrics(spec: MetricsSpec, items: readonly ArtifactItem[]): MetricsModel {
  const metrics: MetricTileModel[] = spec.metrics.map((metric) => ({
    field: metric.field,
    label: artifactFieldLabel(metric),
    ...(metric.unit ? { unit: metric.unit } : {}),
  }));

  // Each tile finds its own “last entry containing this field,” not “the last entry.”
  // A heartbeat entry that reports only the stage should not clear the previous p99 value.
  for (const entry of items) {
    metrics.forEach((tile, index) => {
      const raw = readArtifactField(entry.item, tile.field);
      if (!hasValue(raw)) {
        return;
      }
      metrics[index] = {
        ...tile,
        value: formatArtifactValue(raw),
        raw,
        sequence: entry.sequence,
      };
    });
  }

  return { kind: "metrics", metrics };
}

function applyBoard(spec: BoardSpec, items: readonly ArtifactItem[]): BoardModel {
  const detail: ArtifactField[] = spec.detail ?? [];
  // Map insertion order is the order in which cards first appeared; cards that change state keep this order in the new column.
  const byId = new Map<string, BoardCardModel>();

  for (const entry of items) {
    const keyValue = readArtifactField(entry.item, spec.key);
    if (!hasValue(keyValue)) {
      // Entries without identity have no place on the board (the board's entire semantics are “upsert by key”).
      continue;
    }
    const id = formatArtifactValue(keyValue);
    const status = formatArtifactValue(readArtifactField(entry.item, spec.status));
    const titleRaw = spec.cardTitle ? readArtifactField(entry.item, spec.cardTitle) : undefined;
    byId.set(id, {
      id,
      sequence: entry.sequence,
      title: hasValue(titleRaw) ? formatArtifactValue(titleRaw) : id,
      status,
      details: detail.map((field) => ({
        label: artifactFieldLabel(field),
        value: formatArtifactValue(readArtifactField(entry.item, field.field)),
        ...(field.unit ? { unit: field.unit } : {}),
      })),
    });
  }

  const columns: BoardColumnModel[] = spec.columns.map((column) => ({
    id: column,
    other: false,
    cards: [],
  }));
  const listed = new Map(columns.map((column) => [column.id, column]));
  const other: BoardColumnModel = { id: BOARD_OTHER_COLUMN_ID, other: true, cards: [] };

  for (const card of byId.values()) {
    (listed.get(card.status) ?? other).cards.push(card);
  }

  return {
    kind: "board",
    // “Other” is always last and appears only when it contains cards; an empty column would make an already narrow side pane tighter.
    columns: other.cards.length > 0 ? [...columns, other] : columns,
    cardCount: byId.size,
  };
}

export function applyArtifactItems(
  kind: "chart",
  spec: ChartSpec,
  items: readonly ArtifactItem[],
): ChartModel;
export function applyArtifactItems(
  kind: "table",
  spec: TableSpec,
  items: readonly ArtifactItem[],
): TableModel;
export function applyArtifactItems(
  kind: "metrics",
  spec: MetricsSpec,
  items: readonly ArtifactItem[],
): MetricsModel;
export function applyArtifactItems(
  kind: "board",
  spec: BoardSpec,
  items: readonly ArtifactItem[],
): BoardModel;
export function applyArtifactItems(
  kind: ArtifactPresetKind,
  spec: ArtifactPresetSpec,
  items: readonly ArtifactItem[],
): ArtifactPresetModel;
export function applyArtifactItems(
  kind: ArtifactPresetKind,
  spec: ArtifactPresetSpec,
  items: readonly ArtifactItem[],
): ArtifactPresetModel {
  switch (kind) {
    case "chart":
      return applyChart(spec as ChartSpec, items);
    case "table":
      return applyTable(spec as TableSpec, items);
    case "metrics":
      return applyMetrics(spec as MetricsSpec, items);
    case "board":
      return applyBoard(spec as BoardSpec, items);
  }
}
