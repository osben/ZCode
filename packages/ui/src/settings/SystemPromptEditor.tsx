import { useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert.js";
import { Button } from "@/components/ui/button.js";
import { SettingsFormActions } from "@/settings/SettingsFormActions.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";
import { DiffLinesPre } from "@/settings/DiffLinesPre.js";
import type { SystemPromptOverridesView } from "@/hooks/useSystemPromptOverrides.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  TID_SETTINGS_SYSTEM_PROMPT_DIFF,
  TID_SETTINGS_SYSTEM_PROMPT_DIFF_MODE,
  TID_SETTINGS_SYSTEM_PROMPT_DIFF_TOO_LARGE,
  TID_SETTINGS_SYSTEM_PROMPT_DISK_CHANGED,
  TID_SETTINGS_SYSTEM_PROMPT_DISK_OVERWRITE,
  TID_SETTINGS_SYSTEM_PROMPT_DISK_RELOAD,
  TID_SETTINGS_SYSTEM_PROMPT_DISK_SHOW,
  TID_SETTINGS_SYSTEM_PROMPT_DISK_VERSION,
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
  type SystemPromptIntl,
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
  const editor = view.editor;
  // The diff follows the draft a moment later, so typing never waits on the LCS table.
  const deferredDraft = useDeferredValue(editor?.draft ?? "");
  const baseline = editor?.baseline ?? "";
  const diff = useMemo(
    () =>
      // Only the selected comparison is computed; the LCS table is the expensive part.
      diffMode === "saved"
        ? diffSystemPromptText(baseline, deferredDraft)
        : diffSystemPromptText(builtInDefault, deferredDraft),
    [baseline, builtInDefault, deferredDraft, diffMode],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.querySelector("textarea")?.focus();
    container.scrollIntoView?.({ block: "nearest" });
  }, []);

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
  // One save decision per render: the reason line and the Save and Overwrite buttons share it.
  const writeBlock = resolveSystemPromptSaveBlockReason({
    baseline: editor.baseline,
    draft: editor.draft,
    saving: editor.saving,
  });
  const saveBlock = view.editorDiskChanged ? "disk-changed" : writeBlock;
  const saveReasonId =
    saveBlock === "empty"
      ? "settings.systemPrompt.emptyHint"
      : saveBlock === "unchanged"
        ? "settings.systemPrompt.saveReason.unchanged"
        : saveBlock === "disk-changed"
          ? "settings.systemPrompt.saveReason.diskChanged"
          : null;

  return (
    <div
      ref={containerRef}
      className="space-y-3 border-t border-border px-4 py-3"
      data-section-editor={key}
    >
      {view.editorDiskChanged ? (
        <DiskChangedAlert
          view={view}
          section={section}
          effectiveContent={effectiveContent}
          canOverwrite={writeBlock === null}
          busy={busy}
        />
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
      <p className="text-ui-xs text-foreground-subtle tabular-nums" aria-live="polite">
        {intl.formatMessage(
          { id: "settings.systemPrompt.sizeLine" },
          { characters: size.characters, tokens: size.tokens },
        )}
      </p>
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
          <DiffLinesPre
            lines={diff.lines}
            data-testid={testId(TID_SETTINGS_SYSTEM_PROMPT_DIFF, key)}
          />
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

/** A disk version the user has looked at: its revision and override text from one listing. */
interface CapturedDiskVersion {
  revision: string | null | undefined;
  text: string | null;
}

/**
 * Changed-on-disk state. Overwrite replaces the disk version the user has looked at: "Show disk version"
 * captures that version's revision and text, and Overwrite sends exactly that revision. A captured
 * version is only viewed while its revision is the disk revision this card is about.
 * A conflicting Overwrite drops the captured version, so the newer disk version has to be shown again
 * before the next Overwrite.
 */
function DiskChangedAlert({
  view,
  section,
  effectiveContent,
  canOverwrite,
  busy,
}: {
  view: SystemPromptOverridesView;
  section: EditableSystemPromptSection;
  effectiveContent: string;
  canOverwrite: boolean;
  busy: boolean;
}) {
  const { intl } = useZCodeIntl();
  const [captured, setCaptured] = useState<CapturedDiskVersion | null>(null);
  // A save conflict names the disk revision it found, which can be newer than the listing when the
  // follow-up refresh failed. Without a conflict, the listing's revision is the disk revision.
  const conflictRevision = view.editor?.conflictRevision;
  const diskRevision = conflictRevision !== undefined ? conflictRevision : section.revision;
  // The listing has the disk text only when its revision is the disk revision. Until a refresh brings
  // it, Show refreshes the list instead of capturing text that belongs to an older revision.
  const listingCurrent = section.revision === diskRevision;
  const viewed = captured !== null && captured.revision === diskRevision ? captured : null;
  // Hosts without revisions run no conflict check, so Overwrite stays available there without a view.
  const overwriteReady = viewed !== null || diskRevision === undefined;
  const overwrite = async () => {
    const conflict = await view.saveEditor({
      overwrite: { reviewedRevision: viewed ? viewed.revision : diskRevision },
    });
    if (conflict) setCaptured(null);
  };
  return (
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
            data-testid={TID_SETTINGS_SYSTEM_PROMPT_DISK_SHOW}
            onClick={() => {
              if (!listingCurrent) {
                view.reload();
                return;
              }
              setCaptured({ revision: section.revision, text: section.overrideContent });
            }}
          >
            {intl.formatMessage({ id: "settings.systemPrompt.diskChanged.show" })}
          </Button>
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
            disabled={!canOverwrite || !overwriteReady}
            data-testid={TID_SETTINGS_SYSTEM_PROMPT_DISK_OVERWRITE}
            onClick={() => void overwrite()}
          >
            {intl.formatMessage({ id: "settings.systemPrompt.diskChanged.overwrite" })}
          </Button>
        </div>
        {viewed ? (
          viewed.text === null ? (
            <p>{intl.formatMessage({ id: "settings.systemPrompt.diskChanged.noOverride" })}</p>
          ) : (
            <div className="space-y-1">
              <p>{intl.formatMessage({ id: "settings.systemPrompt.diskChanged.diskVersion" })}</p>
              <pre
                className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-surface-muted p-2 font-mono text-ui-xs leading-5 text-foreground"
                data-testid={TID_SETTINGS_SYSTEM_PROMPT_DISK_VERSION}
              >
                {viewed.text}
              </pre>
            </div>
          )
        ) : !overwriteReady ? (
          <p>{intl.formatMessage({ id: "settings.systemPrompt.diskChanged.viewFirst" })}</p>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

function formatWarning(intl: SystemPromptIntl, warning: SystemPromptDraftWarning): string {
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
