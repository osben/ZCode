/* Top-bar action menu for the Off-Peak task editor: "⋯" next to Save → Pause/Resume + Delete based on state.
   Matches the list-card menu so actions are available directly in the editor; queued → pause, paused → resume, terminal states show only Delete.
   Styling is shared with the scheduled-task editor's top-bar menu. */
import { TID_OFFPEAK_CARD_MENU, type ZCodeOffPeakTask } from "@zcode/shared";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import {
  AutomationContinueIcon,
  AutomationMoreHorizontalIcon,
  AutomationPauseActionIcon,
  AutomationTrashIcon,
} from "@/settings/AutomationDesignPrimitives.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function OffPeakEditActionsMenu({
  task,
  onPause,
  onContinue,
  onDelete,
}: {
  task: ZCodeOffPeakTask;
  onPause?: (task: ZCodeOffPeakTask) => void;
  onContinue?: (task: ZCodeOffPeakTask) => void;
  onDelete?: (task: ZCodeOffPeakTask) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid={TID_OFFPEAK_CARD_MENU}
          aria-label={intl.formatMessage({ id: "automations.moreActions" })}
          className="flex size-8 items-center justify-center rounded-lg border-0 bg-surface text-foreground-subtle shadow-none outline-none transition-colors hover:bg-hover hover:text-foreground data-[state=open]:bg-hover data-[state=open]:text-foreground focus-visible:ring-0"
        >
          <AutomationMoreHorizontalIcon className="size-4" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={4}
        className="w-[190px] min-w-[190px] border-0 px-1 py-1.5"
      >
        {task.status === "queued" && onPause ? (
          <DropdownMenuItem
            className="min-h-9 gap-1 rounded-md leading-5"
            onSelect={() => onPause(task)}
          >
            <span className="flex size-5 items-center justify-center">
              <AutomationPauseActionIcon className="size-4" aria-hidden="true" />
            </span>
            {intl.formatMessage({ id: "offPeak.action.pause" })}
          </DropdownMenuItem>
        ) : null}
        {task.status === "paused" && onContinue ? (
          <DropdownMenuItem
            className="min-h-9 gap-1 rounded-md leading-5"
            onSelect={() => onContinue(task)}
          >
            <span className="flex size-5 items-center justify-center">
              <AutomationContinueIcon className="size-4" aria-hidden="true" />
            </span>
            {intl.formatMessage({ id: "offPeak.action.continue" })}
          </DropdownMenuItem>
        ) : null}
        {onDelete ? (
          <>
            <DropdownMenuSeparator className="mx-0 my-0.5" />
            <DropdownMenuItem
              className="min-h-9 gap-1 rounded-md leading-5 !text-destructive data-[highlighted]:!bg-menu-hover data-[highlighted]:!text-destructive focus:!text-destructive [&_svg]:!text-destructive"
              onSelect={() => onDelete(task)}
            >
              <AutomationTrashIcon />
              {intl.formatMessage({ id: "common.delete" })}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
