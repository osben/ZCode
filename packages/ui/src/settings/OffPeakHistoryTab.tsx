/* Off-Peak task History tab:
   each row summarizes one complete execution (3h continuation segments are transparent to the user): Instructions / Triggered /
   Status / Duration + row menu Go to session / Delete; no executions → "No history yet." */
import { isOffPeakTerminalStatus, type ZCodeOffPeakTask } from "@zcode/shared";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatDateTime } from "@/settings/automationFormat.js";
import {
  AutomationExternalLinkIcon,
  AutomationHistoryEmptyState,
  AutomationMoreHorizontalIcon,
  AutomationTrashIcon,
} from "@/settings/AutomationDesignPrimitives.js";

// Show status as a dot plus colored text (matches the Scheduled history-table density spec).
const STATUS_INDICATOR_CLASS = {
  succeeded: { dot: "bg-success", text: "text-success" },
  failed: { dot: "bg-destructive", text: "text-destructive" },
  skipped: { dot: "bg-foreground-subtlest", text: "text-foreground-subtle" },
  running: { dot: "bg-brand", text: "text-brand" },
} as const satisfies Record<string, { dot: string; text: string }>;

function resolveOffPeakHistoryStatus(
  task: Pick<ZCodeOffPeakTask, "status">,
): keyof typeof STATUS_INDICATOR_CLASS {
  if (task.status === "completed") return "succeeded";
  if (task.status === "failed") return "failed";
  if (task.status === "cancelled") return "skipped";
  return "running";
}

export function OffPeakHistoryTab({
  task,
  onOpenSession,
  onDelete,
}: {
  task: ZCodeOffPeakTask | null;
  onOpenSession?: (task: ZCodeOffPeakTask) => void;
  onDelete?: (task: ZCodeOffPeakTask) => void;
}) {
  const { intl } = useZCodeIntl();
  // An execution record means the first segment was dispatched and started (startedAt exists); queued/paused tasks alone have no history.
  if (!task?.startedAt || task.historyDeletedAt !== undefined) {
    return (
      <AutomationHistoryEmptyState>
        {intl.formatMessage({ id: "offPeak.history.empty" })}
      </AutomationHistoryEmptyState>
    );
  }
  const status = resolveOffPeakHistoryStatus(task);
  const endAt = isOffPeakTerminalStatus(task.status) ? (task.endedAt ?? Date.now()) : Date.now();
  const durationMin = Math.max(1, Math.round((endAt - task.startedAt) / 60_000));
  return (
    <div className="overflow-x-auto rounded-[8px]">
      {/* History table text can scale; use relative line height so large text is not clipped by a fixed 18px line box. */}
      <table className="w-full text-left text-ui-base font-normal leading-snug tracking-[-0.08px]">
        <thead className="bg-surface text-foreground-subtle">
          <tr className="h-[30px] border-b border-border">
            <th className="px-4 font-normal">
              {intl.formatMessage({ id: "offPeak.history.col.instructions" })}
            </th>
            <th className="px-4 font-normal">
              {intl.formatMessage({ id: "automations.runs.col.triggered" })}
            </th>
            <th className="px-4 font-normal">
              {intl.formatMessage({ id: "automations.runs.col.status" })}
            </th>
            <th className="px-4 font-normal">
              {intl.formatMessage({ id: "automations.runs.col.duration" })}
            </th>
            <th className="px-4 font-normal" />
          </tr>
        </thead>
        <tbody>
          <tr className="h-[46px] transition-colors hover:bg-surface-hover">
            <td className="max-w-64 truncate px-4 text-foreground-subtle" title={task.prompt}>
              {task.prompt}
            </td>
            <td className="whitespace-nowrap px-4 text-foreground-subtle">
              {formatDateTime(task.startedAt)}
            </td>
            <td className="px-4">
              <span className="flex items-center text-ui-base leading-5 tracking-[-0.18px]">
                <span className="flex size-5 shrink-0 items-center justify-center">
                  <span
                    className={cn(
                      "inline-block size-1.5 rounded-full",
                      STATUS_INDICATOR_CLASS[status].dot,
                    )}
                  />
                </span>
                <span className={STATUS_INDICATOR_CLASS[status].text}>
                  {intl.formatMessage({
                    id: `automations.runs.status.${status}`,
                  })}
                </span>
              </span>
            </td>
            <td className="whitespace-nowrap px-4 text-foreground-subtle">
              {intl.formatMessage(
                { id: "offPeak.history.durationMinutes" },
                { count: durationMin },
              )}
            </td>
            <td className="px-4">
              <div className="flex items-center justify-end">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={intl.formatMessage({
                        id: "automations.moreActions",
                      })}
                      className="flex size-6 items-center justify-center rounded-[6px] text-foreground-subtle transition-colors hover:bg-white/10 hover:text-foreground data-[state=open]:bg-white/10 data-[state=open]:text-foreground"
                    >
                      <AutomationMoreHorizontalIcon className="size-4" aria-hidden="true" />
                    </button>
                  </DropdownMenuTrigger>
                  {/* The old layout aligned to the trigger's right edge and reused compact menu padding,
                      shifting the popover toward the table and making it 17.5px too narrow. */}
                  <DropdownMenuContent
                    align="start"
                    alignOffset={-10}
                    sideOffset={4}
                    collisionPadding={8}
                    className="flex w-[160px] min-w-[160px] flex-col gap-0.5 border-0 px-1 py-1.5"
                  >
                    {task.sessionId && onOpenSession ? (
                      <DropdownMenuItem
                        className="min-h-9 gap-1 rounded-md p-2 text-ui-base leading-5 tracking-[-0.18px]"
                        onSelect={() => onOpenSession(task)}
                      >
                        <span className="flex size-5 shrink-0 items-center justify-center">
                          <AutomationExternalLinkIcon className="size-4" aria-hidden="true" />
                        </span>
                        {intl.formatMessage({ id: "offPeak.goToSession" })}
                      </DropdownMenuItem>
                    ) : null}
                    {task.sessionId && onOpenSession && onDelete ? (
                      <DropdownMenuSeparator className="m-0 h-px w-full" />
                    ) : null}
                    {onDelete ? (
                      <DropdownMenuItem
                        variant="destructive"
                        className="min-h-9 gap-1 p-2 text-ui-base leading-5 tracking-[-0.18px]"
                        onSelect={() => onDelete(task)}
                      >
                        <AutomationTrashIcon />
                        {intl.formatMessage({ id: "offPeak.history.delete" })}
                      </DropdownMenuItem>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
