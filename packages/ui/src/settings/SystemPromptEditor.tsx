import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert.js";
import { Button } from "@/components/ui/button.js";
import { SettingsFormActions } from "@/settings/SettingsFormActions.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";
import type { SystemPromptOverridesView } from "@/hooks/useSystemPromptOverrides.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import {
  normalizeSystemPromptText,
  TID_SETTINGS_SYSTEM_PROMPT_DIFF,
  TID_SETTINGS_SYSTEM_PROMPT_DIFF_MODE,
  TID_SETTINGS_SYSTEM_PROMPT_DIFF_TOO_LARGE,
  TID_SETTINGS_SYSTEM_PROMPT_DISK_CHANGED,
  TID_SETTINGS_SYSTEM_PROMPT_DISK_OVERWRITE,
  TID_SETTINGS_SYSTEM_PROMPT_DISK_RELOAD,
  TID_SETTINGS_SYSTEM_PROMPT_EDITOR,
  TID_SETTINGS_SYSTEM_PROMPT_SAVE,
  TID_SETTINGS_SYSTEM_PROMPT_SAVE_REASON,
  TID_SETTINGS_SYSTEM_PROMPT_WARNINGS,
  testId,
} from "@zcode/shared";
import {
  describeSystemPromptSize,
  diffSystemPromptText,
  resolveSystemPromptSaveBlockReason,
  SYSTEM_PROMPT_SECTION_TITLE_IDS,
  validateSystemPromptDraft,
  type EditableSystemPromptSection,
  type SystemPromptDraftWarning,
} from "@/settings/systemPromptEditorModel.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";

type DiffMode = "saved" | "default";

interface SystemPromptEditorProps {
  view: SystemPromptOverridesView;
  section: EditableSystemPromptSection;
  /** Current effective text on disk (override or default); used when reloading from disk. */
  effectiveContent: string;
  /** Built-in default the row's Restore would produce; used by "Changes vs built-in default". */
  builtInDefault: string;
}

/**
 * Inline editor rendered under its row. It owns only presentation state (diff mode and
 * focus/scroll on open); the draft, dirty state and disk revision live in the hook.
 */
export function SystemPromptEditor({
  view,
  section,
  effectiveContent,
  builtInDefault,
}: SystemPromptEditorProps) {
  const { intl } = useZCodeIntl();
  const containerRef = useRef<HTMLDivElement>(null);
  const [diffMode, setDiffMode] = useState<DiffMode>("saved");
  const key = section.key;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.querySelector("textarea")?.focus();
    container.scrollIntoView?.({ block: "nearest" });
  }, []);

  const editor = view.editor;
  if (!editor) return null;
  const busy = editor.saving;
  const sectionTitle = intl.formatMessage({ id: SYSTEM_PROMPT_SECTION_TITLE_IDS[key] });

  const requestClose = () => {
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
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      // Keep an enclosing shortcut handler from also treating Cmd/Ctrl+S as its own command.
      event.stopPropagation();
      if (view.canSaveEditor) void view.saveEditor();
      return;
    }
    if (event.key === "Escape") {
      // Stop propagation so an enclosing Settings or dialog Escape handler does not also run.
      event.preventDefault();
      event.stopPropagation();
      if (!busy) requestClose();
    }
  };

  const warnings = validateSystemPromptDraft(key, editor.draft);
  const size = describeSystemPromptSize(editor.draft);
  // Only the selected comparison is computed; the LCS table is the expensive part.
  const diff =
    diffMode === "saved"
      ? diffSystemPromptText(editor.baseline, editor.draft)
      : diffSystemPromptText(builtInDefault, editor.draft);
  const saveBlock = view.editorDiskChanged
    ? "disk-changed"
    : resolveSystemPromptSaveBlockReason({
        baseline: editor.baseline,
        draft: editor.draft,
        saving: editor.saving,
      });
  const saveReasonId =
    saveBlock === "empty"
      ? "settings.systemPrompt.emptyHint"
      : saveBlock === "unchanged"
        ? "settings.systemPrompt.saveReason.unchanged"
        : saveBlock === "disk-changed"
          ? "settings.systemPrompt.saveReason.diskChanged"
          : null;
  const canOverwrite =
    view.editorDirty && normalizeSystemPromptText(editor.draft).length > 0 && !busy;

  return (
    <div
      ref={containerRef}
      className="space-y-3 border-t border-border px-4 py-3"
      data-section-editor={key}
    >
      {view.editorDiskChanged ? (
        <Alert variant="warning" data-testid={TID_SETTINGS_SYSTEM_PROMPT_DISK_CHANGED}>
          <AlertDescription className="space-y-2">
            <div className="font-medium">
              {intl.formatMessage({ id: "settings.systemPrompt.diskChanged.title" })}
            </div>
            <p>{intl.formatMessage({ id: "settings.systemPrompt.diskChanged.description" })}</p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                data-testid={TID_SETTINGS_SYSTEM_PROMPT_DISK_RELOAD}
                onClick={() => view.reloadEditor(effectiveContent)}
              >
                {intl.formatMessage({ id: "settings.systemPrompt.diskChanged.reload" })}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!canOverwrite}
                data-testid={TID_SETTINGS_SYSTEM_PROMPT_DISK_OVERWRITE}
                onClick={() => void view.saveEditor({ overwrite: true })}
              >
                {intl.formatMessage({ id: "settings.systemPrompt.diskChanged.overwrite" })}
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : null}
      <label className="block space-y-1.5">
        <span className="text-ui-sm font-medium text-foreground">
          {intl.formatMessage({ id: "settings.systemPrompt.editorLabel" })}
        </span>
        <SettingsFormTextarea
          rows={10}
          value={editor.draft}
          disabled={busy}
          spellCheck={false}
          aria-label={sectionTitle}
          onChange={(event) => view.setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          className="min-h-40 max-h-[60vh] resize-y font-mono text-ui-sm"
          data-testid={testId(TID_SETTINGS_SYSTEM_PROMPT_EDITOR, key)}
        />
      </label>
      <p
        className="text-ui-xs text-foreground-subtle tabular-nums"
        aria-live="polite"
        data-testid={`settings-system-prompt-character-count-${key}`}
      >
        {intl.formatMessage(
          { id: "settings.systemPrompt.sizeLine" },
          { characters: size.characters, tokens: size.tokens },
        )}
      </p>
      {editor.draft.trim().length === 0 ? (
        <Alert variant="warning">
          <AlertDescription>
            {intl.formatMessage({ id: "settings.systemPrompt.emptyHint" })}
          </AlertDescription>
        </Alert>
      ) : null}
      {warnings.length > 0 ? (
        <Alert variant="warning" data-testid={TID_SETTINGS_SYSTEM_PROMPT_WARNINGS}>
          <AlertDescription>
            <ul className="list-disc space-y-1 pl-4">
              {warnings.map((warning, index) => (
                <li key={`${warning.code}-${index}`}>{formatWarning(intl, warning)}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <div className="text-ui-sm font-medium text-foreground">
            {intl.formatMessage({ id: "settings.systemPrompt.diffTitle" })}
          </div>
          {(["saved", "default"] as const).map((mode) => (
            <Button
              key={mode}
              size="sm"
              variant={diffMode === mode ? "secondary" : "ghost"}
              aria-pressed={diffMode === mode}
              data-mode={mode}
              data-testid={TID_SETTINGS_SYSTEM_PROMPT_DIFF_MODE}
              onClick={() => setDiffMode(mode)}
            >
              {intl.formatMessage({
                id:
                  mode === "saved"
                    ? "settings.systemPrompt.diffMode.saved"
                    : "settings.systemPrompt.diffMode.default",
              })}
            </Button>
          ))}
        </div>
        {diff.kind === "too-large" ? (
          <p
            className="text-ui-xs text-foreground-subtle"
            data-testid={TID_SETTINGS_SYSTEM_PROMPT_DIFF_TOO_LARGE}
          >
            {intl.formatMessage(
              { id: "settings.systemPrompt.diffTooLarge" },
              { baselineLines: diff.baselineLines, draftLines: diff.draftLines },
            )}
          </p>
        ) : diff.kind === "changed" ? (
          <pre
            className="max-h-64 overflow-auto rounded-lg border border-border bg-surface-muted p-2 font-mono text-ui-xs leading-5"
            data-testid={testId(TID_SETTINGS_SYSTEM_PROMPT_DIFF, key)}
          >
            {diff.lines.map((line, index) => (
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
        ) : (
          <p className="text-ui-xs text-foreground-subtle">
            {intl.formatMessage({ id: "settings.systemPrompt.diffNone" })}
          </p>
        )}
      </div>
      <SettingsFormActions>
        <Button
          size="sm"
          disabled={!view.canSaveEditor}
          onClick={() => void view.saveEditor()}
          data-testid={testId(TID_SETTINGS_SYSTEM_PROMPT_SAVE, key)}
        >
          {intl.formatMessage({ id: "settings.systemPrompt.save" })}
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={requestClose}>
          {intl.formatMessage({ id: "common.cancel" })}
        </Button>
      </SettingsFormActions>
      {saveReasonId && !busy ? (
        <p
          className="text-ui-xs text-foreground-subtle"
          data-testid={TID_SETTINGS_SYSTEM_PROMPT_SAVE_REASON}
        >
          {intl.formatMessage({ id: saveReasonId })}
        </p>
      ) : null}
      <p className="text-ui-xs text-foreground-subtlest">
        {intl.formatMessage({ id: "settings.systemPrompt.shortcutHint" })}
      </p>
    </div>
  );
}

type Intl = ReturnType<typeof useZCodeIntl>["intl"];

function formatWarning(intl: Intl, warning: SystemPromptDraftWarning): string {
  switch (warning.code) {
    case "unknown-placeholder":
      return intl.formatMessage(
        { id: "settings.systemPrompt.warning.unknownPlaceholder" },
        { token: warning.token },
      );
    case "missing-placeholder":
      return intl.formatMessage(
        { id: "settings.systemPrompt.warning.missingPlaceholder" },
        { token: warning.token },
      );
    case "confirmation-removed":
      return intl.formatMessage({ id: "settings.systemPrompt.warning.confirmationRemoved" });
  }
}
