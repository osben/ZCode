import {
  ArtifactBoard,
  ArtifactChart,
  ArtifactMetrics,
  ArtifactTable,
  parseArtifactPresetSpec,
  type ArtifactItem,
  type BoardSpec,
  type ChartSpec,
  type MetricsSpec,
  type TableSpec,
} from "@/app-shell/workflow-artifacts/presets/index.js";
import { isArtifactPresetKind } from "@/app-shell/workflow-artifacts/artifactPresentation.js";
import type { PresetLabels } from "@/app-shell/workflow-artifacts/presets/index.js";
import type { WorkflowRunArtifactView } from "@/hooks/useWorkflowRunArtifacts.js";

/**
 * Body renderer for preset artifacts.
 *
 * ⚠ Terminology: artifact = output a script publishes for users through `artifact.*`, not the identically named “script top-level return value”
 * inside the engine.
 *
 * This used to live in the same file as the side-pane artifact card; after the card became an artifact pill,
 * this is the only dispatcher shared by the side-pane thumbnail and full-size tab.
 */
/**
 * Dispatch spec + items to one of four renderers by kind. The side-pane thumbnail (`compact`) and full-size tab share it —
 * separate switches would eventually diverge, such as “the thumbnail shows a chart, but the full-size view shows nothing.”
 */
export function ArtifactPresetBody({
  artifact,
  items,
  labels,
  compact,
  invalidLabel,
  missingLabel,
  className,
}: {
  artifact: Pick<WorkflowRunArtifactView, "kind" | "spec">;
  items: readonly ArtifactItem[];
  labels: PresetLabels;
  compact?: boolean;
  /** Fallback copy when spec exists but **cannot be parsed**; if absent, render nothing. */
  invalidLabel?: string;
  /** Copy when the spec is **entirely absent**; if absent, render nothing (see the loading comment below). */
  missingLabel?: string;
  className?: string;
}) {
  if (!isArtifactPresetKind(artifact.kind)) return null;
  // Distinguish “spec is absent” from “spec is invalid.”
  //
  // Only the journal query restores spec (the live projection intentionally omits it), so during the **first few frames after opening a pane**
  // spec is still undefined. Merging the two states into “Cannot render” makes every board flash an error during loading. Therefore, for an absent spec,
  // let the caller decide (the side-pane thumbnail passes undefined and stays quiet;
  // the full-size tab passes missingLabel only after metadata has **finished loading**).
  if (artifact.spec === undefined) {
    return missingLabel === undefined ? null : (
      <p
        className="text-ui-sm text-foreground-subtlest"
        data-testid="workflow-run-artifact-preset-missing"
      >
        {missingLabel}
      </p>
    );
  }
  const spec = parseArtifactPresetSpec(artifact.kind, artifact.spec);
  if (spec === undefined) {
    return invalidLabel === undefined ? null : (
      <p
        className="text-ui-sm text-foreground-subtlest"
        data-testid="workflow-run-artifact-preset-invalid"
      >
        {invalidLabel}
      </p>
    );
  }
  // All four `as` casts are guaranteed by the **same kind**: `parseArtifactPresetSpec(kind, …)` validates by kind,
  // so the shape it accepts is the spec for that kind. This 4b function has no kind-specific overload (only
  // `applyArtifactItems` does), so narrowing must happen at the call site.
  const shared = { compact, items, labels, className };
  switch (artifact.kind) {
    case "chart":
      return <ArtifactChart spec={spec as ChartSpec} {...shared} />;
    case "table":
      return <ArtifactTable spec={spec as TableSpec} {...shared} />;
    case "metrics":
      return <ArtifactMetrics spec={spec as MetricsSpec} {...shared} />;
    default:
      return <ArtifactBoard spec={spec as BoardSpec} {...shared} />;
  }
}
