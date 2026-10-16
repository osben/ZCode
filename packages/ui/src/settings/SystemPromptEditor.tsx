import { Alert, AlertDescription } from "@/components/ui/alert.js";
import { Button } from "@/components/ui/button.js";
import { SettingsFormActions } from "@/settings/SettingsFormActions.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";
import { SettingsGroupCard } from "@/settings/SettingsPageParts.js";
import { useSystemPromptOverrides } from "@/hooks/useSystemPromptOverrides.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import {
  TID_SETTINGS_SYSTEM_PROMPT_DIFF,
  TID_SETTINGS_SYSTEM_PROMPT_EDITOR,
  TID_SETTINGS_SYSTEM_PROMPT_SAVE,
  testId,
} from "@zcode/shared";
import { diffOutputStylePrompt, hasDiffChanges } from "@/settings/outputStylesEditorModel.js";
import {
  countSystemPromptCharacters,
  SYSTEM_PROMPT_SECTION_TITLE_IDS,
} from "@/settings/systemPromptEditorModel.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";

export function SystemPromptEditor({
  view,
}: {
  view: ReturnType<typeof useSystemPromptOverrides>;
}) {
  const { intl } = useZCodeIntl();
  const editor = view.editor;
  if (!editor) return null;
  const diffLines = diffOutputStylePrompt(editor.baseline, editor.draft);
  const showDiff = view.editorDirty && hasDiffChanges(diffLines);
  const key = editor.key;
  const busy = editor.saving;
  return (
    <SettingsGroupCard>
      <div className="space-y-3 px-4 py-3">
        <div className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: SYSTEM_PROMPT_SECTION_TITLE_IDS[key] })}
        </div>
        <label className="block space-y-1.5">
          <span className="text-ui-sm font-medium text-foreground">
            {intl.formatMessage({ id: "settings.systemPrompt.editorLabel" })}
          </span>
          <SettingsFormTextarea
            rows={12}
            value={editor.draft}
            disabled={busy}
            onChange={(event) => view.setDraft(event.target.value)}
            className="font-mono text-ui-sm"
            data-testid={testId(TID_SETTINGS_SYSTEM_PROMPT_EDITOR, key)}
          />
        </label>
        <p
          className="text-ui-xs text-foreground-subtle tabular-nums"
          aria-live="polite"
          data-testid={`settings-system-prompt-character-count-${key}`}
        >
          {intl.formatMessage(
            { id: "settings.systemPrompt.characterCount" },
            { count: countSystemPromptCharacters(editor.draft) },
          )}
        </p>
        {editor.draft.trim().length === 0 ? (
          <Alert variant="warning">
            <AlertDescription>
              {intl.formatMessage({ id: "settings.systemPrompt.emptyHint" })}
            </AlertDescription>
          </Alert>
        ) : null}
        {showDiff ? (
          <div className="space-y-1.5">
            <div className="text-ui-sm font-medium text-foreground">
              {intl.formatMessage({ id: "settings.systemPrompt.diffTitle" })}
            </div>
            <pre
              className="max-h-64 overflow-auto rounded-lg border border-border bg-surface-muted p-2 font-mono text-ui-xs leading-5"
              data-testid={testId(TID_SETTINGS_SYSTEM_PROMPT_DIFF, key)}
            >
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
            disabled={!view.canSaveEditor}
            onClick={() => void view.saveEditor()}
            data-testid={testId(TID_SETTINGS_SYSTEM_PROMPT_SAVE, key)}
          >
            {intl.formatMessage({ id: "settings.systemPrompt.save" })}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              if (!view.editorDirty) {
                view.closeEditor();
                return;
              }
              void useConfirmDialogStore
                .getState()
                .requestConfirmation({
                  title: intl.formatMessage({ id: "settings.systemPrompt.discard.title" }),
                  description: intl.formatMessage({ id: "settings.systemPrompt.discard.leave" }),
                  confirmLabel: intl.formatMessage({ id: "settings.systemPrompt.discard.confirm" }),
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
