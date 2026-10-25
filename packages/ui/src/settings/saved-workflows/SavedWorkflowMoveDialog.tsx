import { useEffect, useState } from "react";
import {
  TID_WORKFLOW_MOVE_DIALOG,
  TID_WORKFLOW_MOVE_DIALOG_SUBMIT,
  TID_WORKFLOW_MOVE_DIALOG_TARGET,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  findAutomationWorkspaceOptionByKey,
  reconcileAutomationWorkspaceSelectionKey,
  resolveAutomationWorkspaceSelectionKey,
  type AutomationWorkspaceOption,
} from "@/settings/automationWorkspaceOptions.js";

interface SavedWorkflowMoveDialogProps {
  open: boolean;
  /** Name of the workflow being moved (used in the dialog description); null omits title context. */
  entryName: string | null;
  /** Destination project candidates for "Move to project…" (same options as "Run in"). */
  targets: readonly AutomationWorkspaceOption[];
  defaultTargetKey?: string | null;
  busy?: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (target: AutomationWorkspaceOption) => void;
}

/**
 * "Move to project" dialog: move a global workflow back into a local project.
 * One project picker + submit; disable submission and show a notice when there are no local projects. Structure and styling reuse the argument dialog.
 */
export function SavedWorkflowMoveDialog({
  open,
  entryName,
  targets,
  defaultTargetKey,
  busy = false,
  onOpenChange,
  onSubmit,
}: SavedWorkflowMoveDialogProps) {
  const { intl } = useZCodeIntl();
  const [targetKey, setTargetKey] = useState<string | null>(null);

  // When candidates change, keep a still-valid selection; otherwise fall back to the default project, first candidate, or null.
  useEffect(() => {
    const defaultOption = defaultTargetKey
      ? findAutomationWorkspaceOptionByKey(targets, defaultTargetKey)
      : undefined;
    setTargetKey((current) =>
      reconcileAutomationWorkspaceSelectionKey(targets, current, defaultOption),
    );
  }, [targets, defaultTargetKey]);

  const noTargets = targets.length === 0;

  const handleSubmit = () => {
    if (noTargets || busy) return;
    const target = findAutomationWorkspaceOptionByKey(targets, targetKey);
    if (!target) return;
    onSubmit(target);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]" data-testid={TID_WORKFLOW_MOVE_DIALOG}>
        <DialogHeader>
          <DialogTitle>{intl.formatMessage({ id: "workflows.hub.moveDialog.title" })}</DialogTitle>
          {entryName ? (
            <DialogDescription>
              {intl.formatMessage({ id: "workflows.hub.launch.title" }, { name: entryName })}
            </DialogDescription>
          ) : null}
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            handleSubmit();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <span className="text-ui-base font-medium text-foreground">
              {intl.formatMessage({ id: "workflows.hub.detail.projectColumn" })}
            </span>
            {noTargets ? (
              <p className="text-ui-sm text-foreground-subtle">
                {intl.formatMessage({ id: "workflows.hub.moveDialog.noLocalProject" })}
              </p>
            ) : (
              <Select value={targetKey ?? undefined} onValueChange={setTargetKey}>
                <SelectTrigger data-testid={TID_WORKFLOW_MOVE_DIALOG_TARGET}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {targets.map((option) => {
                    const key = resolveAutomationWorkspaceSelectionKey(option);
                    return (
                      <SelectItem key={key} value={key}>
                        {option.label}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" size="lg" onClick={() => onOpenChange(false)}>
              {intl.formatMessage({ id: "workflows.hub.launch.cancel" })}
            </Button>
            <Button
              type="submit"
              size="lg"
              data-testid={TID_WORKFLOW_MOVE_DIALOG_SUBMIT}
              disabled={noTargets || busy}
            >
              {intl.formatMessage({ id: "workflows.hub.moveDialog.submit" })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
