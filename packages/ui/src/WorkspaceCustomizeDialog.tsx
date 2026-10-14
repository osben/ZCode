import { useEffect, useState } from "react";
import type { ZCodeTaskGroupColor } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import { TASK_GROUP_COLORS } from "@/workspace-grouped-tasks/types.js";
import {
  useWorkspaceDisplayStore,
  type WorkspaceDisplayEntry,
} from "@/store/workspaceDisplayStore.js";

/** Full-opacity dialog swatches; the shared group palette washes out in dark mode (/32 alpha). */
const WORKSPACE_SWATCH_CLASS: Record<ZCodeTaskGroupColor, string> = {
  gray: "bg-zinc-400 dark:bg-zinc-400",
  red: "bg-rose-400 dark:bg-rose-500",
  orange: "bg-orange-400 dark:bg-orange-500",
  yellow: "bg-amber-300 dark:bg-amber-400",
  green: "bg-emerald-400 dark:bg-emerald-500",
  blue: "bg-sky-400 dark:bg-sky-500",
  purple: "bg-violet-400 dark:bg-violet-500",
};

export function WorkspaceCustomizeDialog({
  open,
  onOpenChange,
  workspaceKey,
  defaultName,
  entry,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Stable workspace key (identity fallback path) the customization is stored under. */
  workspaceKey: string;
  /** Folder-derived label used as the initial input value when no custom name is set. */
  defaultName: string;
  entry: WorkspaceDisplayEntry | undefined;
}) {
  const { intl } = useZCodeIntl();
  const setWorkspaceDisplayName = useWorkspaceDisplayStore(
    (state) => state.setWorkspaceDisplayName,
  );
  const setWorkspaceColor = useWorkspaceDisplayStore((state) => state.setWorkspaceColor);

  const [nameDraft, setNameDraft] = useState("");
  const [colorDraft, setColorDraft] = useState<ZCodeTaskGroupColor | null>(null);

  // Re-seed the drafts each time the dialog opens so edits from a previous
  // session of the dialog and concurrent changes do not leak between opens.
  // The name field is prefilled with the effective name (custom name or folder label),
  // not left as a placeholder — an empty submit still clears back to the folder name.
  useEffect(() => {
    if (open) {
      setNameDraft(entry?.displayName ?? defaultName);
      setColorDraft(entry?.color ?? null);
    }
  }, [open, defaultName, entry?.color, entry?.displayName]);

  const handleSave = () => {
    setWorkspaceDisplayName(workspaceKey, nameDraft.trim() ? nameDraft : null);
    setWorkspaceColor(workspaceKey, colorDraft);
    onOpenChange(false);
  };

  const handleReset = () => {
    setWorkspaceDisplayName(workspaceKey, null);
    setWorkspaceColor(workspaceKey, null);
    onOpenChange(false);
  };

  const hasCustomization = Boolean(entry?.displayName || entry?.color);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="workspace-customize-dialog">
        <DialogHeader>
          <DialogTitle>{intl.formatMessage({ id: "workspaceSidebar.customizeTitle" })}</DialogTitle>
          <DialogDescription>
            {intl.formatMessage(
              { id: "workspaceSidebar.customizeDescription" },
              { name: defaultName },
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="workspace-customize-display-name">
              {intl.formatMessage({ id: "workspaceSidebar.customizeDisplayNameLabel" })}
            </Label>
            <Input
              id="workspace-customize-display-name"
              data-testid="workspace-customize-display-name"
              value={nameDraft}
              placeholder={defaultName}
              onChange={(event) => setNameDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  handleSave();
                }
              }}
            />
            <p className="text-ui-xs text-foreground-subtle">
              {intl.formatMessage({ id: "workspaceSidebar.customizeDisplayNameHint" })}
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <Label>{intl.formatMessage({ id: "workspaceSidebar.customizeColorLabel" })}</Label>
            <div className="flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                onClick={() => setColorDraft(null)}
                aria-pressed={colorDraft === null}
                aria-label={intl.formatMessage({ id: "workspaceSidebar.customizeColorNone" })}
                className={cn(
                  "flex size-6 items-center justify-center rounded-full border",
                  colorDraft === null
                    ? "border-foreground/60 bg-card-selected dark:border-foreground/50"
                    : "border-border hover:border-border-hover",
                )}
              >
                <span className="h-4 w-4 rounded-full border border-dashed border-border" />
              </button>
              {TASK_GROUP_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  onClick={() => setColorDraft(color)}
                  aria-pressed={colorDraft === color}
                  aria-label={intl.formatMessage({ id: `taskGroup.color.${color}` })}
                  data-customize-color={color}
                  className={cn(
                    "flex size-6 items-center justify-center rounded-full border",
                    colorDraft === color
                      ? "border-foreground/60 bg-card-selected dark:border-foreground/50"
                      : "border-transparent hover:border-border-hover",
                  )}
                >
                  {/* Selection follows the theme tokens (OnboardingModeSelector pattern:
                      foreground-alpha border + card-selected fill); full-opacity swatches
                      because the shared group palette is /32 alpha in dark mode. */}
                  <span
                    className={cn("size-4 rounded-full", WORKSPACE_SWATCH_CLASS[color])}
                    aria-hidden="true"
                  />
                </button>
              ))}
            </div>
          </div>
        </div>
        <DialogFooter>
          {hasCustomization ? (
            <Button
              type="button"
              variant="ghost"
              data-testid="workspace-customize-reset"
              onClick={handleReset}
            >
              {intl.formatMessage({ id: "workspaceSidebar.customizeReset" })}
            </Button>
          ) : null}
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {intl.formatMessage({ id: "common.cancel" })}
          </Button>
          <Button type="button" data-testid="workspace-customize-save" onClick={handleSave}>
            {intl.formatMessage({ id: "common.save" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
