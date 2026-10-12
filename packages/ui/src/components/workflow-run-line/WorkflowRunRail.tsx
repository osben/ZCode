// Miniature rail for a workflow run (docs/dynamic-workflow/presentation.md "The sidebar run line"):
// 6px lamps laid out in declaration order, separated by 6×1px track segments — segments the control
// flow traversed use the strong color, and parallel stations are joined by a double-line segment;
// beyond six stations it folds to the running station ±2 with a "+n" tail. The sidebar run line and
// the task island's run row share this one component: a run looks the same in both places.
import { cn } from "@/components/lib/utils.js";
import { STATUS_DOT } from "@/components/workflow-graph/run-status-presentation.js";
import type { WorkflowRunRail as WorkflowRunRailModel } from "@/lib/workflowRunLine.js";

export interface WorkflowRunRailIntl {
  formatMessage: (desc: { id: string }, values?: Record<string, string>) => string;
}

const TRACE_FAINT = "var(--color-workflow-trace)";
const TRACE_STRONG = "var(--color-workflow-trace-strong)";

export function WorkflowRunRail({
  rail,
  intl,
}: {
  rail: WorkflowRunRailModel;
  intl: WorkflowRunRailIntl;
}) {
  if (rail.implicit) {
    return (
      <span
        data-workflow-run-rail="true"
        data-implicit="true"
        className="flex shrink-0 items-center"
      >
        <span aria-hidden="true" className={cn("size-1.5 rounded-full", STATUS_DOT.running)} />
      </span>
    );
  }
  return (
    <span data-workflow-run-rail="true" className="flex shrink-0 items-center">
      {rail.stations.map((station, index) => (
        <span key={`${station.name}:${index}`} className="flex items-center">
          {index > 0 ? (
            station.twin === true ? (
              // Double-line segment: this station runs parallel to the previous one; control flow did
              // not walk from that station into this one. The two 1px lines sit 2px apart (a 4px
              // container, one line hugging each edge); width and ink rules match ordinary segments exactly.
              <span
                aria-hidden="true"
                data-rail-segment={station.reached ? "strong" : "faint"}
                data-rail-twin="true"
                className="flex h-1 w-1.5 flex-col justify-between"
              >
                <span
                  className="h-px w-full"
                  style={{ backgroundColor: station.reached ? TRACE_STRONG : TRACE_FAINT }}
                />
                <span
                  className="h-px w-full"
                  style={{ backgroundColor: station.reached ? TRACE_STRONG : TRACE_FAINT }}
                />
              </span>
            ) : (
              <span
                aria-hidden="true"
                data-rail-segment={station.reached ? "strong" : "faint"}
                className="h-px w-1.5"
                style={{ backgroundColor: station.reached ? TRACE_STRONG : TRACE_FAINT }}
              />
            )
          ) : null}
          {station.hole === undefined ? (
            <span
              aria-hidden="true"
              data-rail-station={station.status}
              title={station.name}
              className={cn("size-1.5 rounded-full", STATUS_DOT[station.status])}
            />
          ) : (
            // Hole (docs/dynamic-workflow/presentation.md "Holes on the timeline", section "The sidebar"):
            // a dashed 6px lamp, warning-colored while waiting. Once filled it becomes an ordinary
            // station and this branch is no longer walked.
            <span
              aria-hidden="true"
              data-rail-station={station.status}
              data-rail-hole={station.hole}
              title={station.name}
              className={cn(
                "size-1.5 rounded-full border border-dashed bg-transparent",
                station.hole === "waiting" ? "border-warning" : "border-foreground-subtlest",
              )}
            />
          )}
        </span>
      ))}
      {rail.hidden > 0 ? (
        <span className="ml-1 text-ui-xs leading-none text-foreground-subtlest">
          {intl.formatMessage(
            { id: "taskList.workflowRun.moreStations" },
            { count: String(rail.hidden) },
          )}
        </span>
      ) : null}
    </span>
  );
}
