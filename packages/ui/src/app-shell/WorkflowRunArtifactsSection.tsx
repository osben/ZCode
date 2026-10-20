import { memo, useMemo, useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import {
  TID_WORKFLOW_ARTIFACTS_SECTION,
  TID_WORKFLOW_ARTIFACTS_TOGGLE,
  TID_WORKFLOW_ARTIFACT_CARD,
} from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { WorkflowArtifactIndex } from "@/components/workflow-timeline/WorkflowArtifactIndex.js";
import { WorkflowArtifactRow } from "@/components/workflow-timeline/WorkflowArtifactRow.js";
import { WorkflowArtifactTile } from "@/components/workflow-timeline/WorkflowArtifactTile.js";
import { PILL_STAGGER_MS } from "@/components/workflow-timeline/WorkflowTimeline.js";
import {
  ArtifactDetail,
  artifactDisplayTitle,
  artifactKindMessageId,
  buildPresetLabels,
  resolvePrimaryArtifact,
} from "@/app-shell/workflow-artifacts/artifactPresentation.js";
import { WorkflowArtifactTilePreview } from "@/app-shell/workflow-artifacts/WorkflowArtifactTilePreview.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { WorkflowRunArtifactView } from "@/hooks/useWorkflowRunArtifacts.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";

/**
 * Artifact section on the workflow run detail page.
 *
 * ⚠ Terminology: artifacts in this section are outputs the script delivers to the **user** through `artifact.*`. They are **different from** the "Result"
 * panel above (the script's top-level return value for the model); the contract requires both to be visible at once with distinct labels.
 *
 * The header follows the phase-list rhythm (same height, same inset, same chevron). Two body layouts:
 * - **With a deliverable** (the item marked primary, or the only item): a deliverable row (same `WorkflowArtifactRow` as the completion card;
 *   when the panel is under 380px wide, its frame shrinks to 136 × 85 based on the body container query), then a thin divider and an **index** of
 *   remaining artifacts: one per row, one column, all listed (same `WorkflowArtifactIndex` as the completion card, which caps at six rows; this section does not).
 *   Twelve artifacts means twelve rows, all visible at once.
 * - **Without a deliverable**: a **gallery**, one tile per artifact (preview frame + caption, `WorkflowArtifactTile`), with the column count
 *   adapting to panel width—one column from 130px and at most 180px for a single column, which keeps thumbnails readable.
 * The preview frame shows the artifact itself: boards centered at natural size and growing with live report entries; documents scaled to show the beginning;
 * the first few CSV rows; and page glyphs for PDFs and binary files. The list already puts the deliverable first and the rest in first-published order (sorted by the hook).
 *
 * **Expanded by default** (unlike the phase section): artifacts are what this run **delivered to the user**; collapsing by default would hide them,
 * even though they are a common reason for opening this panel. Users can still collapse the section; the header then shows the count.
 * **Render failed and cancelled runs too**: a run that failed at step 12 may already have published a PDF.
 */
export const WorkflowRunArtifactsSection = memo(function WorkflowRunArtifactsSection({
  artifacts,
  sessionId,
  runId,
  onOpenArtifact,
}: {
  /** Confirmed non-empty; the caller does not render this section when there are zero items (omit absent sections instead of showing an empty shell). */
  artifacts: readonly WorkflowRunArtifactView[];
  sessionId: string;
  runId: string;
  /** If absent, tiles are disabled (the host did not provide the open-tab capability). */
  onOpenArtifact?: (artifactId: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const [expanded, setExpanded] = useState(true);
  // Markdown thumbnails need theme-specific code-block colors; hosts without a Provider (tests) use system theme.
  const theme = useZCodeStoreWithDefault((state) => state.theme, "system");
  const title = intl.formatMessage({ id: "chat.toolCall.workflow.run.artifacts.title" });
  // Stable reference: all four renderers are memoized; creating a new labels object every frame would always defeat their comparison.
  const labels = useMemo(
    () => buildPresetLabels((descriptor, values) => intl.formatMessage(descriptor, values)),
    [intl],
  );
  const primary = resolvePrimaryArtifact(artifacts);
  const rest = primary === undefined ? artifacts : artifacts.filter((a) => a !== primary);
  const preview = (artifact: WorkflowRunArtifactView) => (
    <WorkflowArtifactTilePreview
      artifact={artifact}
      key={`${artifact.id}:${artifact.version}`}
      runId={runId}
      sessionId={sessionId}
      theme={theme}
    />
  );
  // Put the workspace source in a tooltip: it is a path that does not fit in the caption and should not compete with the title.
  const tooltipOf = (
    artifact: Pick<WorkflowRunArtifactView, "id" | "kind" | "title" | "sourcePath">,
  ) => {
    const kindLabel = intl.formatMessage({ id: artifactKindMessageId(artifact.kind) });
    return (
      `${kindLabel} · ${artifactDisplayTitle(artifact)}` +
      (artifact.sourcePath === undefined ? "" : `\n${artifact.sourcePath}`)
    );
  };

  return (
    <section
      className="wf-motion shrink-0 border-t border-border/60"
      data-artifacts-open={expanded ? "true" : "false"}
      data-testid={TID_WORKFLOW_ARTIFACTS_SECTION}
    >
      <button
        aria-expanded={expanded}
        aria-label={intl.formatMessage({
          id: expanded
            ? "chat.toolCall.workflow.run.artifacts.collapse"
            : "chat.toolCall.workflow.run.artifacts.expand",
        })}
        className="flex h-9 w-full items-center gap-2 px-3 text-left outline-none transition-colors hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring/40"
        data-testid={TID_WORKFLOW_ARTIFACTS_TOGGLE}
        onClick={() => setExpanded((previous) => !previous)}
        type="button"
      >
        <span className="min-w-0 shrink-0 truncate text-ui-base font-medium text-foreground">
          {title}
        </span>
        {/* Keep the item count visible even when **collapsed**; collapsing must not hide what this run delivered. */}
        <span
          className="shrink-0 font-mono text-ui-xs tabular-nums text-foreground-subtlest"
          data-testid="workflow-run-artifacts-count"
        >
          {artifacts.length.toLocaleString()}
        </span>
        {/* Keep artifact names in the section header while collapsed; they are the information users most often open the panel to find. */}
        {!expanded && primary !== undefined ? (
          <span
            className="min-w-0 truncate text-ui-sm text-foreground-subtle"
            data-testid="workflow-run-artifacts-primary-title"
          >
            · {artifactDisplayTitle(primary)}
          </span>
        ) : null}
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "ml-auto size-3.5 shrink-0 text-foreground-subtlest transition-transform",
            expanded && "rotate-90",
          )}
        />
      </button>
      {expanded && primary !== undefined ? (
        // `@container/wf-artifacts`: the deliverable-row frame uses this container's width to choose 160 × 100 or 136 × 85.
        <div
          className="wf-unfold @container/wf-artifacts flex max-h-[50vh] flex-col gap-2.5 overflow-auto px-3 pb-3 pt-0.5"
          data-testid="workflow-run-artifact-primary-body"
        >
          <WorkflowArtifactRow
            artifact={primary}
            enterDelayMs={PILL_STAGGER_MS}
            labels={labels}
            preview={preview(primary)}
            // Same testid as the tile (`data-variant="row"` distinguishes the form): it remains a card for one artifact.
            testId={TID_WORKFLOW_ARTIFACT_CARD}
            title={tooltipOf(primary)}
            {...(onOpenArtifact === undefined ? {} : { onOpen: onOpenArtifact })}
          />
          {rest.length > 0 ? (
            // One column, no cap: the side panel promises to list all artifacts. Each row is also a card for one artifact (`data-variant="line"`).
            <WorkflowArtifactIndex
              artifacts={rest}
              columns="one"
              firstDelayMs={PILL_STAGGER_MS * 2}
              labels={labels}
              lineTestId={TID_WORKFLOW_ARTIFACT_CARD}
              rule
              testId="workflow-run-artifact-index"
              tooltipOf={tooltipOf}
              {...(onOpenArtifact === undefined ? {} : { onOpenArtifact })}
            />
          ) : null}
        </div>
      ) : expanded ? (
        <div
          className="wf-unfold grid max-h-[50vh] grid-cols-[repeat(auto-fill,minmax(130px,180px))] gap-3 overflow-auto px-3 pb-3 pt-0.5"
          data-testid="workflow-run-artifact-gallery"
        >
          {artifacts.map((artifact, index) => (
            <WorkflowArtifactTile
              artifact={artifact}
              detail={<ArtifactDetail artifact={artifact} labels={labels} />}
              enterDelayMs={PILL_STAGGER_MS * (index + 1)}
              key={artifact.id}
              preview={preview(artifact)}
              testId={TID_WORKFLOW_ARTIFACT_CARD}
              title={tooltipOf(artifact)}
              {...(onOpenArtifact === undefined ? {} : { onOpen: onOpenArtifact })}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
});
