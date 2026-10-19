import { FolderOpen, RotateCcw } from "lucide-react";
import {
  TID_SETTINGS_SYSTEM_PROMPT_CUSTOMIZED,
  TID_SETTINGS_SYSTEM_PROMPT_DIRTY,
  TID_SETTINGS_SYSTEM_PROMPT_EDIT,
  TID_SETTINGS_SYSTEM_PROMPT_INFO,
  TID_SETTINGS_SYSTEM_PROMPT_OPEN_FOLDER,
  TID_SETTINGS_SYSTEM_PROMPT_PATH,
  TID_SETTINGS_SYSTEM_PROMPT_RESTORE,
  TID_SETTINGS_SYSTEM_PROMPT_RESTORE_CONFIRM,
  TID_SETTINGS_SYSTEM_PROMPT_RESTORE_CONFIRM_ACTION,
  TID_SETTINGS_SYSTEM_PROMPT_ASSEMBLED,
  TID_SETTINGS_SYSTEM_PROMPT_ROW,
  TID_SETTINGS_SYSTEM_PROMPT_SIZE,
  testId,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { SystemPromptEditor } from "@/settings/SystemPromptEditor.js";
import type { SystemPromptOverridesView } from "@/hooks/useSystemPromptOverrides.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import {
  SYSTEM_PROMPT_SECTION_INFO_IDS,
  SYSTEM_PROMPT_SECTION_TITLE_IDS,
  type EditableSystemPromptSection,
} from "@/settings/systemPromptEditorModel.js";

export interface SystemPromptRowData {
  section: EditableSystemPromptSection;
  defaultContent: string;
  effectiveContent: string;
  size: { characters: number; tokens: number };
  variableHint: { id: string; values: Record<string, string> } | undefined;
}

export interface SystemPromptRowProps {
  view: SystemPromptOverridesView;
  row: SystemPromptRowData;
  index: number;
  /** Identity baseline is not known yet (Output Styles still resolving); Edit stays disabled. */
  identityWaiting: boolean;
  /** Localized note id for the identity baseline, or null when there is none. */
  identityNoteId: string | null;
  /** Localized host label for the restore confirmation text. */
  hostLabel: string;
  /** Explanation shown on blocked buttons while another draft is dirty. */
  draftBlockReason: string | undefined;
  restoring: boolean;
  onToggleRestore: (section: EditableSystemPromptSection) => void;
  onCancelRestore: () => void;
  onConfirmRestore: (key: EditableSystemPromptSection["key"]) => void;
  onOpenFolder: () => void;
}

/** One section row: description, size, badge, path, actions, and the inline restore and editor panels. */
export function SystemPromptRow({
  view,
  row,
  index,
  identityWaiting,
  identityNoteId,
  hostLabel,
  draftBlockReason,
  restoring,
  onToggleRestore,
  onCancelRestore,
  onConfirmRestore,
  onOpenFolder,
}: SystemPromptRowProps) {
  const { intl } = useZCodeIntl();
  const { section, defaultContent, effectiveContent, size, variableHint } = row;
  const editing = view.editor?.key === section.key;
  const editBlocked = view.editorDirty && !editing;
  const title = intl.formatMessage({ id: SYSTEM_PROMPT_SECTION_TITLE_IDS[section.key] });

  return (
    <div
      className={cn(index > 0 && "border-t border-border")}
      data-testid={testId(TID_SETTINGS_SYSTEM_PROMPT_ROW, section.key)}
      data-section-key={section.key}
    >
      <div className="flex flex-wrap items-start gap-2 px-4 py-3">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-ui-base font-medium text-foreground">{title}</span>
            {editing && view.editorDirty ? (
              <span
                role="img"
                aria-label={intl.formatMessage({ id: "settings.systemPrompt.unsavedDot" })}
                className="inline-block size-2 rounded-full bg-warning"
                data-testid={testId(TID_SETTINGS_SYSTEM_PROMPT_DIRTY, section.key)}
              />
            ) : null}
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-ui-xs",
                section.isOverridden
                  ? "bg-surface-muted text-foreground"
                  : "bg-transparent text-foreground-subtle ring-1 ring-border",
              )}
            >
              {section.isOverridden ? (
                <span data-testid={testId(TID_SETTINGS_SYSTEM_PROMPT_CUSTOMIZED, section.key)}>
                  {intl.formatMessage({ id: "settings.systemPrompt.customized" })}
                </span>
              ) : (
                intl.formatMessage({ id: "settings.systemPrompt.defaultBadge" })
              )}
            </span>
          </div>
          <p
            className="text-ui-xs leading-5 text-foreground-subtle"
            data-testid={testId(TID_SETTINGS_SYSTEM_PROMPT_INFO, section.key)}
          >
            {intl.formatMessage({ id: SYSTEM_PROMPT_SECTION_INFO_IDS[section.key] })}
          </p>
          {variableHint ? (
            <p className="text-ui-xs leading-5 text-foreground-subtle">
              {intl.formatMessage({ id: variableHint.id }, variableHint.values)}
            </p>
          ) : null}
          {identityNoteId ? (
            <p className="text-ui-xs leading-5 text-foreground-subtle">
              {intl.formatMessage({ id: identityNoteId })}
            </p>
          ) : null}
          <p
            className="text-ui-xs text-foreground-subtle tabular-nums"
            data-testid={testId(TID_SETTINGS_SYSTEM_PROMPT_SIZE, section.key)}
          >
            {intl.formatMessage(
              { id: "settings.systemPrompt.sizeLine" },
              { characters: size.characters, tokens: size.tokens },
            )}
          </p>
          <div className="flex flex-wrap items-center gap-2 text-ui-xs text-foreground-subtlest">
            <span
              className="break-all font-mono"
              data-testid={testId(TID_SETTINGS_SYSTEM_PROMPT_PATH, section.key)}
            >
              {section.filePath}
            </span>
            {view.isRemote ? null : (
              <Button
                size="sm"
                variant="ghost"
                data-testid={testId(TID_SETTINGS_SYSTEM_PROMPT_OPEN_FOLDER, section.key)}
                onClick={onOpenFolder}
              >
                <FolderOpen className="mr-1.5 size-3.5" aria-hidden="true" />
                {intl.formatMessage({ id: "settings.systemPrompt.openFolder" })}
              </Button>
            )}
          </div>
          {editing ? null : (
            <details className="text-ui-sm text-foreground-subtle">
              <summary className="cursor-pointer">
                {intl.formatMessage({ id: "settings.systemPrompt.effectivePreview" })}
              </summary>
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-surface-muted p-2 font-mono text-ui-xs leading-5">
                {identityWaiting && identityNoteId
                  ? intl.formatMessage({ id: identityNoteId })
                  : effectiveContent}
              </pre>
            </details>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {editing ? null : (
            <Button
              size="sm"
              variant="outline"
              disabled={view.editor?.saving || editBlocked || identityWaiting}
              title={editBlocked ? draftBlockReason : undefined}
              data-testid={testId(TID_SETTINGS_SYSTEM_PROMPT_EDIT, section.key)}
              onClick={() => view.openEditor(section.key, effectiveContent)}
            >
              {intl.formatMessage({ id: "settings.systemPrompt.edit" })}
            </Button>
          )}
          {section.isOverridden ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={view.editor?.saving || view.editorDirty}
              title={view.editorDirty ? draftBlockReason : undefined}
              data-testid={testId(TID_SETTINGS_SYSTEM_PROMPT_RESTORE, section.key)}
              onClick={() => onToggleRestore(section)}
            >
              <RotateCcw className="mr-1.5 size-3.5" aria-hidden="true" />
              {intl.formatMessage({ id: "settings.systemPrompt.restoreDefault" })}
            </Button>
          ) : null}
        </div>
      </div>
      {restoring ? (
        <div
          className="space-y-2 border-t border-border px-4 py-3"
          data-testid={testId(TID_SETTINGS_SYSTEM_PROMPT_RESTORE_CONFIRM, section.key)}
        >
          <div className="text-ui-sm font-medium text-foreground">
            {intl.formatMessage({ id: "settings.systemPrompt.restoreConfirm.title" })}
          </div>
          <p className="text-ui-xs text-foreground-subtle">
            {intl.formatMessage(
              { id: "settings.systemPrompt.restoreConfirm.description" },
              { host: hostLabel },
            )}
          </p>
          <div className="text-ui-xs font-medium text-foreground-subtle">
            {intl.formatMessage({ id: "settings.systemPrompt.restoreConfirm.preview" })}
          </div>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-surface-muted p-2 font-mono text-ui-xs leading-5">
            {defaultContent}
          </pre>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="destructive"
              data-testid={testId(TID_SETTINGS_SYSTEM_PROMPT_RESTORE_CONFIRM_ACTION, section.key)}
              onClick={() => onConfirmRestore(section.key)}
            >
              {intl.formatMessage({ id: "settings.systemPrompt.restoreConfirm.confirm" })}
            </Button>
            <Button size="sm" variant="outline" onClick={onCancelRestore}>
              {intl.formatMessage({ id: "common.cancel" })}
            </Button>
          </div>
        </div>
      ) : null}
      {editing && view.editor ? (
        <SystemPromptEditor
          view={view}
          section={section}
          effectiveContent={effectiveContent}
          builtInDefault={defaultContent}
        />
      ) : null}
    </div>
  );
}

/** Approximate assembled main prompt. The caller labels it approximate; runtime parts are not included. */
export function SystemPromptAssembledPreview({
  text,
  tokens,
  characters,
}: {
  text: string;
  tokens: number;
  characters: number;
}) {
  const { intl } = useZCodeIntl();
  return (
    <details
      className="rounded-xl border border-border px-4 py-3 text-ui-sm"
      data-testid={TID_SETTINGS_SYSTEM_PROMPT_ASSEMBLED}
    >
      <summary className="cursor-pointer font-medium text-foreground">
        {intl.formatMessage({ id: "settings.systemPrompt.assembled.title" })}
      </summary>
      <div className="mt-2 space-y-2">
        <p className="text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: "settings.systemPrompt.assembled.description" })}
        </p>
        <p className="text-ui-xs text-foreground-subtle tabular-nums">
          {intl.formatMessage(
            { id: "settings.systemPrompt.assembled.tokens" },
            { tokens, characters },
          )}
        </p>
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-surface-muted p-2 font-mono text-ui-xs leading-5">
          {text}
        </pre>
      </div>
    </details>
  );
}
