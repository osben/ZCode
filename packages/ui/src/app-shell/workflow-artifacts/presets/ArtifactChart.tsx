/**
 * **Entry point** for the `chart` preset renderer: lazy loading + local failure isolation; this module does not import recharts itself.
 *
 * Why lazy loading is required: recharts triggers decimal.js-light's LN10 validation during module initialization, which can block the entire renderer startup
 * in Electron Linux containers (the fix is recorded in `AppUsagePanel.tsx`; the spec's “preset renderer” section also requires `lazy()`). Therefore:
 * - The chart view lives in `ArtifactChartView.tsx` and is reached only through `lazy()` dynamic import;
 * - Neither this file nor `index.ts` statically depends on recharts, so importing them does not put chart code in the first-screen bundle.
 *
 * Callers can bypass this layer and use `lazy(() => import(".../ArtifactChartView.js"))` themselves, taking control of
 * Suspense / error boundaries — this file is only the default wrapper for that setup.
 */

import { lazy, Suspense } from "react";
import type { ArtifactItem } from "@/app-shell/workflow-artifacts/presets/apply.js";
import type { PresetLabels } from "@/app-shell/workflow-artifacts/presets/parts.js";
import type { ChartSpec } from "@/app-shell/workflow-artifacts/presets/spec.js";
import { cn } from "@/components/lib/utils.js";
import { ScopedErrorBoundary } from "@/ErrorBoundary.js";

const ArtifactChartView = lazy(
  () => import("@/app-shell/workflow-artifacts/presets/ArtifactChartView.js"),
);

/** Loading placeholder: show space without text — a “Loading” message would only flash during a 200ms lazy load. */
function ChartSkeleton({ compact }: { compact: boolean }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "w-full animate-pulse rounded-lg bg-surface motion-reduce:animate-none",
        compact ? "h-14" : "h-56",
      )}
      data-testid="artifact-chart-skeleton"
    />
  );
}

export function ArtifactChart({
  spec,
  items,
  compact = false,
  labels,
  className,
}: {
  spec: ChartSpec;
  items: readonly ArtifactItem[];
  compact?: boolean;
  labels: PresetLabels;
  className?: string;
}) {
  return (
    // If a chart crashes, collapse only this area while the rest of the run side pane keeps working — artifacts are a delivery surface and should not be a single point of failure.
    <ScopedErrorBoundary
      resetKeys={[spec, compact]}
      scope="workflow-artifact-chart"
      variant={compact ? "compact" : "inline"}
    >
      <Suspense fallback={<ChartSkeleton compact={compact} />}>
        <ArtifactChartView
          className={className}
          compact={compact}
          items={items}
          labels={labels}
          spec={spec}
        />
      </Suspense>
    </ScopedErrorBoundary>
  );
}
