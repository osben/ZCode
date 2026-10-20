import type { ReactNode } from "react";
import { Ban, ChevronRight, CircleCheck, Loader2, TriangleAlert } from "lucide-react";
import { TID_WORKFLOW_RUN_ROW, type ZCodeSavedWorkflowRun } from "@zcode/shared";
import { testId } from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatDateTime } from "@/settings/automationFormat.js";
import { SavedWorkflowArtifactChips } from "@/settings/saved-workflows/SavedWorkflowArtifactChips.js";
import {
  formatSavedWorkflowRunArgs,
  formatSavedWorkflowTokens,
  savedWorkflowRunBadgeKind,
  savedWorkflowRunDurationMs,
} from "@/settings/saved-workflows/savedWorkflowRunHistory.js";

/** Project corresponding to a run-history row on the detail page (used across cwd values for global workflows; “View instance” requires cwd to match an open project). */
export interface SavedWorkflowRunProject {
  label: string;
  /** Full cwd path, attached to the title. */
  title?: string;
  /** This row's cwd matches an open local project → “View instance” is available. */
  canOpen: boolean;
}

/** Detail-page “Run history”: journal rows (status / time / cost / arguments); rows with ownership fields can “View instance.” */
export function SavedWorkflowRunHistory({
  runs,
  now,
  canOpenRun,
  onOpenRun,
  onOpenArtifact,
  resolveRunProject,
}: {
  runs: readonly ZCodeSavedWorkflowRun[];
  now: number;
  canOpenRun: boolean;
  onOpenRun: (run: ZCodeSavedWorkflowRun) => void;
  /**
   * Artifact chip → `workflow-artifact` tab.
   * If absent, chips are read-only. The gate is one step less strict than “View instance”: artifacts do not need `toolCallId`.
   */
  onOpenArtifact?: (run: ZCodeSavedWorkflowRun, artifactId: string) => void;
  /** When provided, render the project column for every row (global workflow history across projects); “View instance” also requires the row's canOpen. */
  resolveRunProject?: (run: ZCodeSavedWorkflowRun) => SavedWorkflowRunProject | null;
}) {
  const { intl } = useZCodeIntl();
  if (runs.length === 0) {
    return (
      <p className="text-ui-base text-foreground-subtlest">
        {intl.formatMessage({ id: "workflows.hub.history.empty" })}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-hidden rounded-lg border border-border">
        {runs.map((run, index) => {
          const kind = savedWorkflowRunBadgeKind(run.status);
          const project = resolveRunProject ? resolveRunProject(run) : null;
          const durationMs = savedWorkflowRunDurationMs(run, now);
          const totalSeconds = Math.round(durationMs / 1000);
          const minutes = Math.floor(totalSeconds / 60);
          const seconds = totalSeconds % 60;
          const duration =
            minutes > 0
              ? intl.formatMessage(
                  { id: "workflows.hub.time.duration.minutes" },
                  { minutes: String(minutes), seconds: String(seconds) },
                )
              : intl.formatMessage(
                  { id: "workflows.hub.time.duration.seconds" },
                  { seconds: String(seconds) },
                );
          const openable =
            canOpenRun &&
            Boolean(run.parentSessionId && run.toolCallId) &&
            (resolveRunProject ? (project?.canOpen ?? false) : true);
          // Artifact chip gate: `parentSessionId` is present (may be missing in legacy rows) + project is openable.
          // `toolCallId` is not a condition — the artifact tab does not return to the CreateWorkflow tool row.
          const artifactsOpenable =
            onOpenArtifact !== undefined &&
            Boolean(run.parentSessionId) &&
            (resolveRunProject ? (project?.canOpen ?? false) : true);
          const statusLabel = intl.formatMessage({ id: `workflows.hub.lastRun.${kind}` });
          let icon: ReactNode;
          let statusClass: string;
          switch (kind) {
            case "completed":
              icon = <CircleCheck className="size-4" strokeWidth={1.33} aria-hidden="true" />;
              statusClass = "text-success";
              break;
            case "errored":
              icon = <TriangleAlert className="size-4" strokeWidth={1.33} aria-hidden="true" />;
              statusClass = "text-destructive";
              break;
            case "running":
              icon = (
                <Loader2 className="size-4 animate-spin" strokeWidth={1.33} aria-hidden="true" />
              );
              statusClass = "text-warning";
              break;
            default:
              icon = <Ban className="size-4" strokeWidth={1.33} aria-hidden="true" />;
              statusClass = "text-foreground-subtle";
          }
          return (
            <div
              key={run.runId}
              data-testid={testId(TID_WORKFLOW_RUN_ROW, run.runId)}
              className={cn(
                "grid grid-cols-[112px_minmax(0,1fr)_auto] items-center gap-4 px-3 py-2.5",
                index > 0 && "border-t border-border",
              )}
            >
              <span className={cn("inline-flex items-center gap-1.5 text-ui-base", statusClass)}>
                {icon}
                {statusLabel}
              </span>
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-ui-base">
                <span className="text-foreground">{formatDateTime(run.createdAt)}</span>
                {resolveRunProject && project ? (
                  <span
                    data-workflow-run-project="true"
                    className="min-w-0 max-w-40 truncate text-foreground-subtle"
                    title={project.title ?? project.label}
                  >
                    {project.label}
                  </span>
                ) : null}
                <span className="text-foreground-subtle">
                  {duration} ·{" "}
                  {intl.formatMessage(
                    { id: "workflows.hub.history.tokens" },
                    { tokens: formatSavedWorkflowTokens(run.spentTokens) },
                  )}
                </span>
                {formatSavedWorkflowRunArgs(run.args).map((chip) => (
                  <span
                    key={chip}
                    className="rounded-xs border border-border px-1.5 py-0.5 font-mono text-ui-xs leading-none text-foreground-subtlest"
                  >
                    {chip}
                  </span>
                ))}
                {/*
                 * Artifacts delivered by this run.
                 * ⚠ Terminology: artifact = output a script publishes for users, not the script's top-level return value.
                 * Legacy rows do not have this field (older CLI versions do not send it), so omit the whole block instead of rendering an empty space.
                 */}
                {run.artifacts === undefined ? null : (
                  <SavedWorkflowArtifactChips
                    artifacts={run.artifacts}
                    {...(artifactsOpenable
                      ? {
                          onOpenArtifact: (artifactId: string) => onOpenArtifact?.(run, artifactId),
                        }
                      : {})}
                  />
                )}
              </div>
              {openable ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  data-icon="inline-end"
                  className="text-foreground-subtle"
                  onClick={() => onOpenRun(run)}
                >
                  {intl.formatMessage({ id: "workflows.hub.history.open" })}
                  <ChevronRight className="size-3" aria-hidden="true" />
                </Button>
              ) : (
                <span aria-hidden="true" />
              )}
            </div>
          );
        })}
      </div>
      <p className="text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "workflows.hub.history.note" })}
      </p>
    </div>
  );
}
