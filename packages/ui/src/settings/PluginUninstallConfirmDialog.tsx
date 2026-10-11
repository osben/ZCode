import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

// Uninstall permanently removes data (cache + data directory + leftover config); all UI entry points share the same confirmation dialog,
// keeping wording and behavior consistent between the Installed and Marketplace panels.
export function PluginUninstallConfirmDialog({
  open,
  pluginName,
  pending,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  pluginName: string;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <AlertDialogContent data-testid="plugin-store-uninstall-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {intl.formatMessage(
              { id: "settings.plugins.uninstall.confirmTitle" },
              { name: pluginName },
            )}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {intl.formatMessage({ id: "settings.plugins.uninstall.confirmDescription" })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel
            type="button"
            size="sm"
            data-testid="plugin-store-uninstall-cancel"
            disabled={pending}
          >
            {intl.formatMessage({ id: "common.cancel" })}
          </AlertDialogCancel>
          <AlertDialogAction
            type="button"
            data-testid="plugin-store-uninstall-confirm"
            variant="destructive"
            size="sm"
            disabled={pending}
            onClick={(event) => {
              // Prevent Radix from closing the dialog after the action is clicked; uninstall is asynchronous, so the parent closes it after the result.
              event.preventDefault();
              onConfirm();
            }}
          >
            {intl.formatMessage({ id: "settings.plugins.uninstall.confirm" })}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
