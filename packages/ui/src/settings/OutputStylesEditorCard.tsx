import { Alert, AlertDescription } from "@/components/ui/alert.js";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { outputStyleFilenameFromName, TID_SETTINGS_OUTPUT_STYLES_SAVE } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { OutputStylesView } from "@/hooks/useOutputStyles.js";
import { SettingsGroupCard } from "@/settings/SettingsPageParts.js";
import { SettingsFormActions } from "@/settings/SettingsFormActions.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";
import {
  baseStyleId,
  detectOutputStyleNameCollision,
  diffOutputStylePrompt,
  hasDiffChanges,
  isEmptyOutputStylePrompt,
  outputStyleFilePath,
} from "@/settings/outputStylesEditorModel.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";
import { cn } from "@/components/lib/utils.js";

type Intl = ReturnType<typeof useZCodeIntl>["intl"];

/** Draft editor card for one output style, with collision warnings and a save-time diff preview. */
export function OutputStylesEditorCard({ view, intl }: { view: OutputStylesView; intl: Intl }) {
  const editor = view.editor;
  if (editor === null) return null;
  const { draft, baseline } = editor;
  const collision = detectOutputStyleNameCollision(draft, view.styles);
  const emptyPrompt = isEmptyOutputStylePrompt(draft);
  const diffLines = diffOutputStylePrompt(baseline?.content ?? "", draft.content);
  const showDiff = view.editorDirty && hasDiffChanges(diffLines);
  const style =
    draft.styleId !== null ? view.styles.find((entry) => entry.id === draft.styleId) : undefined;
  // Editing a built-in that has no override file yet: saving is what materializes the file,
  // so state that (and where) up front instead of creating it silently.
  const customizingBuiltin = Boolean(
    style?.isBuiltIn && !style.isOverridden && style.id !== "default" && view.stylesDirectory,
  );
  const overridePath =
    customizingBuiltin && draft.styleId !== null && view.stylesDirectory
      ? outputStyleFilePath(view.stylesDirectory, `${baseStyleId(draft.styleId)}.md`)
      : null;
  const newStylePath =
    draft.styleId === null && draft.name.trim() && view.stylesDirectory
      ? outputStyleFilePath(view.stylesDirectory, outputStyleFilenameFromName(draft.name))
      : null;
  // "default" is reserved (the runtime ignores overrides for that id); block the save outright
  // rather than letting a file appear that can never take effect.
  const reservedDefault = collision === "reserved-default";
  const busy = editor.saving;
  return (
    <SettingsGroupCard>
      <div className="space-y-3 px-4 py-3">
        <div className="text-ui-base font-medium text-foreground">
          {intl.formatMessage(
            {
              id:
                draft.styleId === null
                  ? "settings.outputStyles.editor.newTitle"
                  : "settings.outputStyles.editor.editTitle",
            },
            draft.styleId === null ? {} : { name: baseline?.name ?? draft.name },
          )}
        </div>
        {overridePath ? (
          <Alert variant="default">
            <AlertDescription>
              {intl.formatMessage(
                { id: "settings.outputStyles.editor.overrideHint" },
                { path: overridePath },
              )}
            </AlertDescription>
          </Alert>
        ) : null}
        {style?.filePath ? (
          <div className="break-all font-mono text-ui-xs text-foreground-subtlest">
            {intl.formatMessage(
              { id: "settings.outputStyles.editor.fileLocation" },
              { path: style.filePath },
            )}
          </div>
        ) : null}
        {collision ? (
          <Alert variant={reservedDefault ? "warning" : "default"}>
            <AlertDescription>
              {intl.formatMessage({
                id:
                  collision === "builtin-override"
                    ? "settings.outputStyles.collisionBuiltin"
                    : collision === "custom-collision"
                      ? "settings.outputStyles.collisionCustom"
                      : "settings.outputStyles.collisionReservedDefault",
              })}
            </AlertDescription>
          </Alert>
        ) : null}
        <label className="block space-y-1.5">
          <span className="text-ui-sm font-medium text-foreground">
            {intl.formatMessage({ id: "settings.outputStyles.nameLabel" })}
          </span>
          <Input
            value={draft.name}
            disabled={busy}
            onChange={(event) => view.setDraft({ name: event.target.value })}
            data-testid="settings-output-styles-name"
          />
          {newStylePath ? (
            <span className="break-all font-mono text-ui-xs text-foreground-subtlest">
              {intl.formatMessage(
                { id: "settings.outputStyles.editor.saveAs" },
                { path: newStylePath },
              )}
            </span>
          ) : null}
        </label>
        <label className="block space-y-1.5">
          <span className="text-ui-sm font-medium text-foreground">
            {intl.formatMessage({ id: "settings.outputStyles.descriptionLabel" })}
          </span>
          <Input
            value={draft.description}
            disabled={busy}
            onChange={(event) => view.setDraft({ description: event.target.value })}
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-ui-sm font-medium text-foreground">
            {intl.formatMessage({ id: "settings.outputStyles.promptLabel" })}
          </span>
          <SettingsFormTextarea
            rows={10}
            value={draft.content}
            disabled={busy}
            onChange={(event) => view.setDraft({ content: event.target.value })}
            className="font-mono text-ui-sm"
          />
        </label>
        {emptyPrompt ? (
          <Alert variant="warning">
            <AlertDescription>
              {intl.formatMessage({ id: "settings.outputStyles.promptEmptyHint" })}
            </AlertDescription>
          </Alert>
        ) : null}
        {showDiff ? (
          <div className="space-y-1.5">
            <div className="text-ui-sm font-medium text-foreground">
              {intl.formatMessage({ id: "settings.outputStyles.diffTitle" })}
            </div>
            <pre className="max-h-64 overflow-auto rounded-lg border border-border bg-surface-muted p-2 font-mono text-ui-xs leading-5">
              {diffLines.map((line, index) => (
                <div
                  key={index}
                  className={cn(
                    line.type === "add" && "text-success",
                    line.type === "remove" && "text-danger line-through",
                  )}
                >
                  {line.type === "add" ? "+ " : line.type === "remove" ? "- " : "  "}
                  {line.text}
                </div>
              ))}
            </pre>
          </div>
        ) : null}
        <SettingsFormActions>
          <Button
            size="sm"
            disabled={!view.canSaveEditor || reservedDefault}
            onClick={() => void view.saveEditor()}
            data-testid={TID_SETTINGS_OUTPUT_STYLES_SAVE}
          >
            {intl.formatMessage({ id: "settings.outputStyles.save" })}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => {
              if (!view.editorDirty) {
                view.closeEditor();
                return;
              }
              void useConfirmDialogStore
                .getState()
                .requestConfirmation({
                  title: intl.formatMessage({ id: "settings.outputStyles.discard.title" }),
                  description: intl.formatMessage({ id: "settings.outputStyles.discard.leave" }),
                  confirmLabel: intl.formatMessage({ id: "settings.outputStyles.discard.confirm" }),
                  confirmVariant: "destructive",
                })
                .then((confirmed) => {
                  if (confirmed) view.closeEditor();
                });
            }}
          >
            {intl.formatMessage({ id: "common.cancel" })}
          </Button>
        </SettingsFormActions>
      </div>
    </SettingsGroupCard>
  );
}

/** Save-time conflict dialog: the style file changed on disk since the editor opened. */
export function OutputStylesConflictDialog({ view, intl }: { view: OutputStylesView; intl: Intl }) {
  return (
    <AlertDialog
      open={view.editor !== null && view.editor.conflict !== null}
      onOpenChange={(open) => {
        // Closing the dialog (Esc / backdrop) keeps the draft.
        if (!open) void view.resolveConflict("keep");
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {intl.formatMessage({ id: "settings.outputStyles.conflict.title" })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {intl.formatMessage({ id: "settings.outputStyles.conflict.description" })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{intl.formatMessage({ id: "common.cancel" })}</AlertDialogCancel>
          <Button variant="outline" onClick={() => void view.resolveConflict("reload")}>
            {intl.formatMessage({ id: "settings.outputStyles.conflict.reload" })}
          </Button>
          <Button variant="destructive" onClick={() => void view.resolveConflict("overwrite")}>
            {intl.formatMessage({ id: "settings.outputStyles.conflict.overwrite" })}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
