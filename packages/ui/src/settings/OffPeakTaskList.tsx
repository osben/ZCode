/* Off-peak task list: two-column card grid. Cards share the scheduled-task card structure: title + instruction description + footer (moon + #N-in-queue position badge). Sort by creation time descending; hover menu actions vary by status. No Est. for position. */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
  type SVGProps,
} from "react";
import { CircleCheck, Loader2, TriangleAlert } from "lucide-react";
import { type ZCodeOffPeakTask } from "@zcode/shared";
import {
  TID_OFFPEAK_ACTION_CONTINUE,
  TID_OFFPEAK_ACTION_DELETE,
  TID_OFFPEAK_ACTION_PAUSE,
  TID_OFFPEAK_CARD,
  TID_OFFPEAK_CARD_SESSION,
  TID_OFFPEAK_CARD_MENU,
} from "@zcode/shared/test-ids";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import {
  AutomationCancelActionIcon,
  AutomationContinueIcon,
  AutomationExternalLinkIcon,
  AutomationIdleTimeIcon,
  AutomationInfoIcon,
  AutomationMoreHorizontalIcon,
  AutomationPauseActionIcon,
  AutomationPausedIcon,
  AutomationTrashIcon,
} from "@/settings/AutomationDesignPrimitives.js";
import {
  resolveFailedOffPeakQueueFooter,
  resolveOffPeakStatusFooter,
  shouldShowOffPeakModelSelectionIssue,
  type OffPeakStatusIconKind,
} from "@/settings/offPeakUiPresentation.js";

interface OffPeakTaskListProps {
  tasks: readonly ZCodeOffPeakTask[];
  busyOperationId: string | null;
  onOpen: (task: ZCodeOffPeakTask) => void;
  onPause: (task: ZCodeOffPeakTask) => void;
  onContinue: (task: ZCodeOffPeakTask) => void;
  onCancel: (task: ZCodeOffPeakTask) => void;
  onDelete: (task: ZCodeOffPeakTask) => void;
  onOpenSession: (task: ZCodeOffPeakTask) => void;
}

// Grouping by status would move tasks when they switch between running and terminal states, breaking users’ expectations for existing card positions;
// sort only by immutable creation time descending so status changes do not affect order.
export function sortOffPeakTasksByCreatedAt(
  tasks: readonly ZCodeOffPeakTask[],
): ZCodeOffPeakTask[] {
  return [...tasks].sort((a, b) => b.createdAt - a.createdAt);
}

/** Same scroll threshold as the scheduled-task list in AutomationsSection (the Figma spec shows at most 8 cards). */
export const OFFPEAK_LIST_SCROLL_THRESHOLD = 8;

const OFFPEAK_MENU_HINT_MAX_WIDTH = 320;
const OFFPEAK_MENU_HINT_RIGHT_OFFSET = 16;

type OffPeakMenuHintSide = "right" | "top";

export function resolveOffPeakMenuHintSide(
  triggerRect: Pick<DOMRect, "right"> | null,
  viewportWidth: number,
): OffPeakMenuHintSide {
  if (!triggerRect) {
    return "top";
  }
  return viewportWidth - triggerRect.right >=
    OFFPEAK_MENU_HINT_MAX_WIDTH + OFFPEAK_MENU_HINT_RIGHT_OFFSET
    ? "right"
    : "top";
}

function OffPeakMenuHint({ children, title }: { children: ReactNode; title: string }) {
  const triggerRef = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [side, setSide] = useState<OffPeakMenuHintSide>("right");

  const updateSide = useCallback(() => {
    // The hint trigger is inside the menu. In narrow windows, Radix flips “right” to “left” automatically,
    // which would make the left-side hint cross the entire menu; when horizontal space is limited, place it above the menu to avoid covering actions.
    setSide(
      resolveOffPeakMenuHintSide(
        triggerRef.current?.getBoundingClientRect() ?? null,
        window.innerWidth,
      ),
    );
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }
    updateSide();
    window.addEventListener("resize", updateSide);
    return () => window.removeEventListener("resize", updateSide);
  }, [open, updateSide]);

  return (
    <ControlHintTooltip
      title={title}
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          updateSide();
        }
        setOpen(nextOpen);
      }}
      triggerRef={triggerRef}
      side={side}
      align={side === "top" ? "end" : "center"}
      sideOffset={OFFPEAK_MENU_HINT_RIGHT_OFFSET}
      className="max-w-[min(20rem,calc(100vw-1rem))]"
    >
      {children}
    </ControlHintTooltip>
  );
}

const STATUS_ICON: Record<OffPeakStatusIconKind, ComponentType<SVGProps<SVGSVGElement>>> = {
  moon: AutomationIdleTimeIcon,
  // In the design, Paused uses a circular stop icon; the old pause bars looked like a media pause control.
  pause: AutomationPausedIcon,
  spinner: Loader2,
  success: CircleCheck,
  warning: TriangleAlert,
  stopped: AutomationPausedIcon,
};

export function OffPeakTaskList({
  tasks,
  busyOperationId,
  onOpen,
  onPause,
  onContinue,
  onCancel,
  onDelete,
  onOpenSession,
}: OffPeakTaskListProps) {
  const { intl } = useZCodeIntl();
  const sorted = sortOffPeakTasksByCreatedAt(tasks);

  if (sorted.length === 0) {
    return (
      <div className="rounded-[10px] border border-card-border px-3 py-3 text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "offPeak.list.empty" })}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "grid auto-rows-[132px] grid-cols-1 gap-x-4 gap-y-4 lg:grid-cols-2",
        // Same rule as the scheduled task list: show at most eight cards, with the grid itself scrolling for overflow so the page does not grow indefinitely.
        sorted.length > OFFPEAK_LIST_SCROLL_THRESHOLD &&
          "max-h-[1198px] overflow-y-auto overscroll-contain lg:max-h-[606px]",
      )}
    >
      {sorted.map((task) => {
        const footer =
          task.modelSelectionIssue && shouldShowOffPeakModelSelectionIssue(task.status)
            ? {
                icon: "warning" as const,
                className: "text-warning",
                labelId: "offPeak.modelSelection.repairRequired",
              }
            : resolveOffPeakStatusFooter(task);
        const FooterIcon = STATUS_ICON[footer.icon];
        const failedQueueFooter = resolveFailedOffPeakQueueFooter(task);
        const FailedQueueIcon = failedQueueFooter ? STATUS_ICON[failedQueueFooter.icon] : null;
        const busy = busyOperationId?.endsWith(task.offPeakTaskId) ?? false;
        const hasPrimaryMenuAction =
          task.status === "queued" || task.status === "paused" || task.status === "running";
        return (
          <div
            key={task.offPeakTaskId}
            data-testid={TID_OFFPEAK_CARD}
            role="button"
            tabIndex={0}
            onClick={() => onOpen(task)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onOpen(task);
              }
            }}
            className={cn(
              // An inset surface shadow does not convey a Card outline and creates a color mismatch with home-page cards across light/dark themes.
              "group relative flex h-full min-h-0 cursor-pointer gap-3 overflow-hidden rounded-[10px] border border-card-border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused",
              // Keep completed cards muted overall, but still show a hover background to indicate the card is clickable and its more menu is usable.
              task.status === "completed" ? "opacity-60 hover:bg-hover" : "hover:bg-hover",
            )}
          >
            <div className="flex h-full min-w-0 flex-1 flex-col gap-3">
              <span className="block truncate pr-14 text-ui-base font-medium leading-5 text-foreground">
                {task.title || task.prompt}
              </span>
              {/* Fix reason: task-card body and status font sizes can scale; a fixed 18px line-height would squeeze or clip text at larger font sizes. */}
              <p className="line-clamp-2 h-9 text-ui-base font-normal leading-snug text-foreground-subtle">
                {task.prompt}
              </p>
              <div className="mt-auto flex h-6 min-w-0 items-center gap-[10px] text-ui-base leading-snug">
                {/* Bug cause: the status badge and right-side “Running session: …” may both shrink, letting
                   a long session title compress the status to one character. Status is the primary footer
                   information, so keep it shrink-0 and truncate only the session-title segment. */}
                <div
                  className={cn(
                    "flex w-fit shrink-0 items-center gap-0.5 font-normal",
                    footer.className,
                    (task.status === "queued" || task.status === "paused") &&
                      // Zai Dark uses white as its brand color; the off-peak queue Tag must use the dedicated purple semantic color from the design.
                      "rounded-[8px] bg-idle-task-surface py-0.5 pl-1 pr-2 text-idle-task",
                  )}
                >
                  <span className="flex size-5 shrink-0 items-center justify-center">
                    <FooterIcon
                      className={cn("size-4 shrink-0", task.status === "running" && "animate-spin")}
                      strokeWidth={1.33}
                      aria-hidden="true"
                    />
                  </span>
                  <span className="truncate">
                    {intl.formatMessage({ id: footer.labelId }, footer.labelValues)}
                  </span>
                </div>
                {failedQueueFooter && FailedQueueIcon ? (
                  <div className="flex w-fit shrink-0 items-center gap-0.5 rounded-[6px] bg-idle-task-surface py-0.5 pl-1 pr-2 text-idle-task opacity-40">
                    <span className="flex size-5 shrink-0 items-center justify-center">
                      <FailedQueueIcon
                        className="size-4 shrink-0"
                        strokeWidth={1.33}
                        aria-hidden="true"
                      />
                    </span>
                    <span className="truncate">
                      {intl.formatMessage(
                        { id: failedQueueFooter.labelId },
                        failedQueueFooter.labelValues,
                      )}
                    </span>
                  </div>
                ) : null}
                {task.sessionTitle ? (
                  // Tasks created in a session are bound to and run in that session, so show its title in the footer.
                  <span
                    data-testid={TID_OFFPEAK_CARD_SESSION}
                    className="ml-auto min-w-0 truncate text-foreground-subtle"
                    title={task.sessionTitle}
                  >
                    {intl.formatMessage(
                      { id: "offPeak.boundSession.label" },
                      { title: task.sessionTitle },
                    )}
                  </span>
                ) : null}
              </div>
            </div>

            <div className="absolute right-3 top-3 flex items-center gap-1">
              {task.sessionId ? (
                <button
                  type="button"
                  className="flex size-6 items-center justify-center rounded-md opacity-100 transition-colors hover:bg-surface-hover md:opacity-0 md:group-hover:opacity-100"
                  aria-label={intl.formatMessage({
                    id: "offPeak.goToSession",
                  })}
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpenSession(task);
                  }}
                >
                  <AutomationExternalLinkIcon
                    className="size-4 text-foreground-subtle"
                    aria-hidden="true"
                  />
                </button>
              ) : null}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="flex size-6 items-center justify-center rounded-md opacity-100 transition-colors hover:bg-surface-hover md:opacity-0 md:group-hover:opacity-100 data-[state=open]:bg-surface-hover data-[state=open]:opacity-100"
                    data-testid={TID_OFFPEAK_CARD_MENU}
                    aria-label={intl.formatMessage({
                      id: "automations.moreActions",
                    })}
                    disabled={busy}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <AutomationMoreHorizontalIcon
                      className="size-4 text-foreground-subtle"
                      aria-hidden="true"
                    />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  sideOffset={4}
                  className="w-[190px]"
                  onClick={(event) => event.stopPropagation()}
                >
                  {task.status === "queued" ? (
                    <DropdownMenuItem
                      className="gap-1"
                      data-testid={TID_OFFPEAK_ACTION_PAUSE}
                      onSelect={() => onPause(task)}
                    >
                      <span className="flex size-5 items-center justify-center">
                        <AutomationPauseActionIcon className="size-4" aria-hidden="true" />
                      </span>
                      <span className="flex-1">
                        {intl.formatMessage({ id: "offPeak.action.pause" })}
                      </span>
                      {/* Fix reason: pause now takes effect immediately without a second confirmation.
                         Keep the info entry to explain queue wait time and requeue behavior so users
                         understand the outcome of the action. */}
                      <OffPeakMenuHint
                        title={intl.formatMessage({
                          id: "offPeak.action.pauseHint",
                        })}
                      >
                        {/* Fix reason: the hint trigger is nested inside a selectable menu item; click
                           bubbling would execute Pause / Continue. Stop only click propagation so
                           pointerdown does not disrupt Radix selection timing. */}
                        <span className="inline-flex" onClick={(event) => event.stopPropagation()}>
                          <AutomationInfoIcon
                            className="size-3.5 shrink-0 text-foreground-subtle"
                            aria-hidden="true"
                          />
                        </span>
                      </OffPeakMenuHint>
                    </DropdownMenuItem>
                  ) : null}
                  {task.status === "paused" ? (
                    <DropdownMenuItem
                      className="gap-1"
                      data-testid={TID_OFFPEAK_ACTION_CONTINUE}
                      onSelect={() => onContinue(task)}
                    >
                      <span className="flex size-5 items-center justify-center">
                        <AutomationContinueIcon className="size-4" aria-hidden="true" />
                      </span>
                      <span className="flex-1">
                        {intl.formatMessage({
                          id: "offPeak.action.continue",
                        })}
                      </span>
                      <OffPeakMenuHint
                        title={intl.formatMessage({
                          id: "offPeak.action.continueHint",
                        })}
                      >
                        <span className="inline-flex" onClick={(event) => event.stopPropagation()}>
                          <AutomationInfoIcon
                            className="size-3.5 shrink-0 text-foreground-subtle"
                            aria-hidden="true"
                          />
                        </span>
                      </OffPeakMenuHint>
                    </DropdownMenuItem>
                  ) : null}
                  {task.status === "running" ? (
                    <DropdownMenuItem className="gap-1" onSelect={() => onCancel(task)}>
                      {/* Fix reason: the thin-outline X is lighter than neighboring action icons and does not match the home Chat “stop generation” semantics. */}
                      <span className="flex size-5 items-center justify-center">
                        <AutomationCancelActionIcon
                          className="size-4 fill-current"
                          aria-hidden="true"
                        />
                      </span>
                      {intl.formatMessage({ id: "offPeak.action.cancel" })}
                    </DropdownMenuItem>
                  ) : null}
                  {/* Fix reason: when the terminal-state menu has only Delete, a fixed divider looks like a top rule with no grouping meaning. */}
                  {hasPrimaryMenuAction ? <DropdownMenuSeparator /> : null}
                  <DropdownMenuItem
                    className="gap-1 !text-destructive data-[highlighted]:!bg-menu-hover data-[highlighted]:!text-destructive focus:!text-destructive [&_svg]:!text-destructive"
                    data-testid={TID_OFFPEAK_ACTION_DELETE}
                    onSelect={() => onDelete(task)}
                  >
                    <AutomationTrashIcon />
                    {intl.formatMessage({ id: "automations.delete" })}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        );
      })}
    </div>
  );
}
