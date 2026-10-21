import type { TaskGroupColor as ZCodeTaskGroupColor } from "@/project-sidebar/contract.js";
import { Label } from "@/components/ui/label.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { TASK_GROUP_COLORS } from "@/project-sidebar/grouped/types.js";

/** Full-opacity swatches; the shared group palette washes out in dark mode (/32 alpha). */
const PROJECT_SWATCH_CLASS: Record<ZCodeTaskGroupColor, string> = {
  gray: "bg-zinc-400 dark:bg-zinc-400",
  red: "bg-rose-400 dark:bg-rose-500",
  orange: "bg-orange-400 dark:bg-orange-500",
  yellow: "bg-amber-300 dark:bg-amber-400",
  green: "bg-emerald-400 dark:bg-emerald-500",
  blue: "bg-sky-400 dark:bg-sky-500",
  purple: "bg-violet-400 dark:bg-violet-500",
};

/** Color picker section of the project editor; the draft is saved together with the name. */
export function ProjectColorField({
  value,
  onChange,
  disabled = false,
}: {
  value: ZCodeTaskGroupColor | null;
  onChange(color: ZCodeTaskGroupColor | null): void;
  disabled?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const selected = "border-foreground/60 bg-card-selected dark:border-foreground/50";
  return (
    <div className="grid gap-1.5" data-testid="project-color-field">
      <Label>{intl.formatMessage({ id: "workspaceSidebar.customizeColorLabel" })}</Label>
      <div className="flex flex-wrap items-center gap-2.5">
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange(null)}
          aria-pressed={value === null}
          aria-label={intl.formatMessage({ id: "workspaceSidebar.customizeColorNone" })}
          className={cn(
            "flex size-6 items-center justify-center rounded-full border",
            value === null ? selected : "border-border hover:border-border-hover",
          )}
        >
          <span className="h-4 w-4 rounded-full border border-dashed border-border" />
        </button>
        {TASK_GROUP_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            disabled={disabled}
            onClick={() => onChange(color)}
            aria-pressed={value === color}
            aria-label={intl.formatMessage({ id: `taskGroup.color.${color}` })}
            data-customize-color={color}
            className={cn(
              "flex size-6 items-center justify-center rounded-full border",
              value === color ? selected : "border-transparent hover:border-border-hover",
            )}
          >
            <span
              className={cn("size-4 rounded-full", PROJECT_SWATCH_CLASS[color])}
              aria-hidden="true"
            />
          </button>
        ))}
      </div>
    </div>
  );
}
