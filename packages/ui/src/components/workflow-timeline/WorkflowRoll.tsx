import { Fragment, type ReactNode } from "react";
import { CircleCheckIcon, CircleXIcon, LoaderCircleIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import type { StepRunStatus } from "@/components/workflow-graph/types.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { RollGroup } from "./roster-model.js";
import type { TimelinePill } from "./timeline-model.js";

/**
 * The roster behind the door: agents in the side-pane roster station that were not pinned,
 * each shown once and grouped by status in attention order (failed → running → pending → done), preserving participant order within each group.
 * The group header is the count row (icon, count, status label, semantic color, and a thin line to the edge), so the count row need not appear again when open.
 * Callers render the rows (each surface supplies its own wiring); this component arranges two columns and assigns entrance delays.
 *
 * Unlisted agents have no row to render: the door and count row include them, so the roster can only report the difference in a faint line at the end,
 * rather than pretending those rows exist (see "unlisted" note).
 */
/** Rows appear in sequence: 8ms per row, capped at 400ms (matching the cell rhythm; 30ms pill timing is too slow for a full roster). */
export const ROW_STAGGER_MS = 8;
export const ROW_STAGGER_CAP_MS = 400;

const GROUP_TONE: Record<StepRunStatus, string> = {
  done: "text-success",
  failed: "text-destructive",
  pending: "text-foreground-subtlest",
  running: "text-warning",
};

function GroupIcon({ status }: { status: StepRunStatus }) {
  if (status === "done") return <CircleCheckIcon aria-hidden className="size-2.5" />;
  if (status === "running") {
    return (
      <LoaderCircleIcon aria-hidden className="size-2.5 animate-spin motion-reduce:animate-none" />
    );
  }
  if (status === "failed") return <CircleXIcon aria-hidden className="size-2.5" />;
  return <span aria-hidden className="size-2 rounded-full border-[1.5px] border-current" />;
}

export function WorkflowRoll({
  groups,
  renderRow,
  unlisted = 0,
}: {
  groups: readonly RollGroup[];
  /** Render a row; `enterDelayMs` is its entrance delay across the entire roster. */
  renderRow: (pill: TimelinePill, enterDelayMs: number) => ReactNode;
  /** Number of subagents this station cannot list (finished and unfinished); zero omits the faint line. */
  unlisted?: number;
}) {
  const { intl } = useZCodeIntl();
  let index = 0;
  return (
    <div className="wf-unfold grid grid-cols-2 gap-x-2 pt-0.5" data-testid="workflow-roster-roll">
      {groups.map((group) => {
        const label = intl.formatMessage(
          { id: `chat.toolCall.workflow.timeline.roster.${group.status}` },
          { count: group.pills.length },
        );
        // Both locale strings start with the count (`{count} done` / `{count} completed`): bold the count and render the rest normally.
        const split = /^(\d+)(.*)$/.exec(label);
        return (
          <Fragment key={group.status}>
            <div
              aria-level={4}
              className={cn(
                "col-span-2 mt-1 flex h-[22px] items-center gap-[5px] pl-1 font-mono text-ui-xs leading-none tabular-nums first:mt-0",
                GROUP_TONE[group.status],
              )}
              data-roll-group={group.status}
              data-testid="workflow-roll-heading"
              role="heading"
            >
              <GroupIcon status={group.status} />
              {split === null ? (
                <span>{label}</span>
              ) : (
                <>
                  <span className="font-medium">{split[1]}</span>
                  <span>{split[2]!.trim()}</span>
                </>
              )}
              <span aria-hidden className="ml-[3px] h-px flex-1 bg-border" />
            </div>
            {group.pills.map((pill) =>
              renderRow(pill, Math.min(ROW_STAGGER_MS * index++, ROW_STAGGER_CAP_MS)),
            )}
          </Fragment>
        );
      })}
      {unlisted <= 0 ? null : (
        <p
          className="col-span-2 mt-1.5 min-w-0 text-ui-xs text-foreground-subtlest"
          data-testid="workflow-roll-unlisted"
        >
          {intl.formatPlural({ id: "chat.toolCall.workflow.timeline.roster.unlisted" }, unlisted)}
        </p>
      )}
    </div>
  );
}
