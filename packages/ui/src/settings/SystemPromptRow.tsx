import { memo, useMemo, useState } from "react";
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
  type SystemPromptOverrideKey,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { SystemPromptEditor } from "@/settings/SystemPromptEditor.js";
import type { SystemPromptOverridesView } from "@/hooks/useSystemPromptOverrides.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import {
  describeSystemPromptSize,
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
  onConfirmRestore: (
    key: EditableSystemPromptSection["key"],
    revision: string | null | undefined,
  ) => void;
  onOpenFolder: () => void;
}

/** One section row: description, size, badge, path, actions, and the inline restore and editor panels. */
function SystemPromptRowBase({
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
        <RestoreConfirmPanel
          sectionKey={section.key}
          revision={section.revision}
          defaultContent={defaultContent}
          hostLabel={hostLabel}
          onConfirm={onConfirmRestore}
          onCancel={onCancelRestore}
        />
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

/**
 * Inline restore confirmation. The revision the user reviewed is captured when the panel opens and
 * is the one Confirm checks against, so a refresh while the panel is open cannot widen the delete.
 */
function RestoreConfirmPanel({
  sectionKey,
  revision,
  defaultContent,
  hostLabel,
  onConfirm,
  onCancel,
}: {
  sectionKey: SystemPromptOverrideKey;
  revision: string | null;
  defaultContent: string;
  hostLabel: string;
  onConfirm: SystemPromptRowProps["onConfirmRestore"];
  onCancel: () => void;
}) {
  const { intl } = useZCodeIntl();
  const [reviewedRevision] = useState(revision);
  return (
    <div
      className="space-y-2 border-t border-border px-4 py-3"
      data-testid={testId(TID_SETTINGS_SYSTEM_PROMPT_RESTORE_CONFIRM, sectionKey)}
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
          data-testid={testId(TID_SETTINGS_SYSTEM_PROMPT_RESTORE_CONFIRM_ACTION, sectionKey)}
          onClick={() => onConfirm(sectionKey, reviewedRevision)}
        >
          {intl.formatMessage({ id: "settings.systemPrompt.restoreConfirm.confirm" })}
        </Button>
        <Button size="sm" variant="outline" onClick={onCancel}>
          {intl.formatMessage({ id: "common.cancel" })}
        </Button>
      </div>
    </div>
  );
}

/**
 * Rows re-render only when their own inputs change. While a row is being edited it re-renders on
 * every draft change, because the editor is part of it; the other rows skip the draft keystrokes.
 */
function areRowPropsEqual(prev: SystemPromptRowProps, next: SystemPromptRowProps): boolean {
  if (next.view.editor?.key === next.row.section.key) return false;
  if (
    prev.row !== next.row ||
    prev.index !== next.index ||
    prev.identityWaiting !== next.identityWaiting ||
    prev.identityNoteId !== next.identityNoteId ||
    prev.hostLabel !== next.hostLabel ||
    prev.draftBlockReason !== next.draftBlockReason ||
    prev.restoring !== next.restoring ||
    prev.onToggleRestore !== next.onToggleRestore ||
    prev.onCancelRestore !== next.onCancelRestore ||
    prev.onConfirmRestore !== next.onConfirmRestore ||
    prev.onOpenFolder !== next.onOpenFolder
  ) {
    return false;
  }
  const a = prev.view;
  const b = next.view;
  return (
    a.isRemote === b.isRemote &&
    a.editorDirty === b.editorDirty &&
    a.openEditor === b.openEditor &&
    a.editor?.key === b.editor?.key &&
    a.editor?.saving === b.editor?.saving
  );
}

export const SystemPromptRow = memo(SystemPromptRowBase, areRowPropsEqual);

/**
 * Approximate assembled main prompt. The caller labels it approximate; runtime parts are not included.
 * The text is rendered only while the panel is open, so a closed panel costs nothing per keystroke.
 */
export function SystemPromptAssembledPreview({ text }: { text: string }) {
  const { intl } = useZCodeIntl();
  const [open, setOpen] = useState(false);
  const size = useMemo(() => describeSystemPromptSize(text), [text]);
  return (
    <details
      className="rounded-xl border border-border px-4 py-3 text-ui-sm"
      data-testid={TID_SETTINGS_SYSTEM_PROMPT_ASSEMBLED}
      onToggle={(event) => setOpen(event.currentTarget.open)}
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
            { tokens: size.tokens, characters: size.characters },
          )}
        </p>
        {open ? (
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-surface-muted p-2 font-mono text-ui-xs leading-5">
            {text}
          </pre>
        ) : null}
      </div>
    </details>
  );
}
