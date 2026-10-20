/**
 * Public entry point for preset artifact renderers.
 *
 * Four renderers + two pure-function layers:
 * - `parseArtifactPresetSpec(kind, spec)` classifies an `unknown` wire spec as renderable or not;
 * - `applyArtifactItems(kind, spec, items)` folds the `report(item, id)` item stream into a view model;
 * - `<ArtifactChart|Table|Metrics|Board>` renders it; `compact` is the smaller form used in run side-pane cards.
 *
 * **recharts is not a static dependency of this barrel**: `ArtifactChart` is wrapped in `lazy()`
 * (see `ArtifactChart.tsx`), so importing this module does not pull the chart library into the initial screen.
 */

export { type ArtifactItem } from "@/app-shell/workflow-artifacts/presets/apply.js";
export {
  parseArtifactPresetSpec,
  type ArtifactPresetKind,
  type BoardSpec,
  type ChartSpec,
  type MetricsSpec,
  type TableSpec,
} from "@/app-shell/workflow-artifacts/presets/spec.js";

export { type PresetLabels } from "@/app-shell/workflow-artifacts/presets/parts.js";
export { ArtifactChart } from "@/app-shell/workflow-artifacts/presets/ArtifactChart.js";
export { ArtifactTable } from "@/app-shell/workflow-artifacts/presets/ArtifactTable.js";
export { ArtifactMetrics } from "@/app-shell/workflow-artifacts/presets/ArtifactMetrics.js";
export { ArtifactBoard } from "@/app-shell/workflow-artifacts/presets/ArtifactBoard.js";
