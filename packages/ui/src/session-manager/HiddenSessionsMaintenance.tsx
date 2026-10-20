import { Button } from "@/components/ui/button.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * Footer row of the Session Manager for hidden sessions whose content is still stored. It is the only way
 * to erase sessions hidden before the erase option existed, since they no longer have a list row
 * (specs/session-deletion-cascade.md §3). Renders nothing while the count is unknown or zero.
 */
export function HiddenSessionsMaintenance({
  sessions,
  worktrees = 0,
  busy,
  onErase,
}: {
  sessions: number | null;
  worktrees?: number;
  busy: boolean;
  onErase: () => Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  if (sessions === null || (sessions <= 0 && worktrees <= 0)) {
    return null;
  }

  const handleErase = async () => {
    const confirmed = await confirmDialog({
      title: intl.formatMessage({ id: "sessionManager.hidden.confirmTitle" }),
      description: intl.formatPlural({ id: "sessionManager.hidden.confirmBody" }, sessions),
      confirmLabel: intl.formatMessage({ id: "sessionManager.hidden.confirm" }),
      confirmVariant: "destructive",
    });
    if (confirmed) {
      await onErase();
    }
  };

  return (
    <div
      className="flex items-center justify-between gap-3 border-t border-border px-1 pt-2 text-ui-sm text-foreground-subtle"
      data-testid="session-manager-hidden-sessions"
    >
      <span className="min-w-0">
        {sessions > 0 ? intl.formatPlural({ id: "sessionManager.hidden.count" }, sessions) : null}
        {worktrees > 0 ? (
          <span className="block">
            {intl.formatMessage({ id: "sessionManager.hidden.worktrees" }, { count: worktrees })}
          </span>
        ) : null}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="shrink-0 text-destructive hover:text-destructive"
        disabled={busy}
        onClick={() => void handleErase()}
      >
        {intl.formatMessage({ id: "sessionManager.hidden.erase" })}
      </Button>
    </div>
  );
}
