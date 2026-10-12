// The half of the "save workflow" popover below the thin divider (docs/dynamic-workflow/transcript-and-notifications.md
// "The popover"): three fields, one consequence sentence, one "save as-is" button.
//
// A separate file from the popover shell only to keep the 400-line gate; it holds no state —
// everything is passed in by WorkflowSavePopover.
import type { RefObject } from "react";
import { FolderIcon, GlobeIcon } from "lucide-react";
import type { ZCodeSavedWorkflowScope } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Spinner } from "@/components/ui/spinner.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";
import { SAVED_WORKFLOW_NAME_MAX_CHARS, type WorkflowSaveDraft } from "./workflowRunSave.js";

/** The agent rejected this save: `reason` is a word-listed cause, `detail` is the diagnostics it brought back (already bounded). */
export interface WorkflowSaveFailure {
  reason: string;
  detail?: string;
}

export function WorkflowSaveFields({
  draft,
  failure,
  nameInvalid,
  nameRef,
  onDirectSave,
  pathPreview,
  saving,
  scopeLocked,
  shadowing,
  showDivider,
  submitDisabled,
  submitLabel,
  taken,
  update,
}: {
  draft: WorkflowSaveDraft;
  failure: WorkflowSaveFailure | undefined;
  nameInvalid: boolean;
  nameRef: RefObject<HTMLInputElement | null>;
  onDirectSave: () => void;
  pathPreview: string;
  saving: boolean;
  scopeLocked: boolean;
  /** Another scope also holds this name: shadowing will happen; say so before it is clicked. */
  shadowing: boolean;
  showDivider: boolean;
  submitDisabled: boolean;
  submitLabel: string;
  taken: boolean;
  update: (next: Partial<WorkflowSaveDraft>) => void;
}) {
  const { intl } = useZCodeIntl();
  const format = (id: string, values?: Record<string, string>) =>
    intl.formatMessage({ id }, values);
  return (
    <>
      {showDivider ? (
        <div className="flex items-center gap-2 text-ui-xs text-foreground-subtlest">
          <span aria-hidden className="h-px flex-1 bg-border" />
          <span>{format("chat.toolCall.workflow.saveRun.or")}</span>
          <span aria-hidden className="h-px flex-1 bg-border" />
        </div>
      ) : null}
      <div className="flex flex-col gap-1">
        <label className="text-ui-sm text-foreground-subtle" htmlFor="workflow-save-name">
          {format("chat.toolCall.workflow.saveRun.name")}
        </label>
        <div className="relative">
          <Input
            aria-invalid={nameInvalid}
            className="pr-16 font-mono"
            data-testid="workflow-save-name"
            disabled={saving}
            id="workflow-save-name"
            maxLength={SAVED_WORKFLOW_NAME_MAX_CHARS}
            onChange={(event) => update({ name: event.target.value })}
            placeholder={format("chat.toolCall.workflow.saveRun.name.placeholder")}
            ref={nameRef}
            value={draft.name}
          />
          {/* The suffix is a **fact**, not input: the name is a file name, the extension is decided by the save path, and the user should not (and cannot) change it. */}
          <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center font-mono text-ui-xs text-foreground-subtlest">
            .dwf.ts
          </span>
        </div>
        <p
          className={cn(
            "text-ui-xs",
            nameInvalid ? "text-destructive" : "text-foreground-subtlest",
          )}
          data-testid="workflow-save-name-helper"
        >
          {format(
            nameInvalid
              ? "chat.toolCall.workflow.saveRun.name.invalid"
              : "chat.toolCall.workflow.saveRun.name.helper",
          )}
        </p>
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-ui-sm text-foreground-subtle">
          {format("chat.toolCall.workflow.save.scope.label")}
        </span>
        <Select
          disabled={scopeLocked || saving}
          onValueChange={(value) => update({ scope: value as ZCodeSavedWorkflowScope })}
          value={draft.scope}
        >
          <SelectTrigger className="w-full" data-testid="workflow-save-scope">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {/* The icons say "where it lands": the folder is this project; the globe is every project on this machine. */}
            <SelectItem value="project">
              <FolderIcon aria-hidden className="size-3.5 text-foreground-subtle" />
              {format("chat.toolCall.workflow.save.scope.project")}
            </SelectItem>
            <SelectItem value="global">
              <GlobeIcon aria-hidden className="size-3.5 text-foreground-subtle" />
              {format("chat.toolCall.workflow.save.scope.global")}
            </SelectItem>
          </SelectContent>
        </Select>
        {scopeLocked ? (
          <p className="text-ui-xs text-foreground-subtlest">
            {format("chat.toolCall.workflow.saveRun.scope.remoteOnly")}
          </p>
        ) : null}
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-ui-sm text-foreground-subtle" htmlFor="workflow-save-description">
          {format("chat.toolCall.workflow.saveRun.description")}
        </label>
        <SettingsFormTextarea
          className="min-h-14"
          data-testid="workflow-save-description"
          disabled={saving}
          id="workflow-save-description"
          onChange={(event) => update({ description: event.target.value })}
          value={draft.description}
        />
        <p className="text-ui-xs text-foreground-subtlest">
          {format("chat.toolCall.workflow.saveRun.description.helper")}
        </p>
      </div>
      <WorkflowSaveConsequence
        failure={failure}
        pathPreview={pathPreview}
        scope={draft.scope}
        shadowing={shadowing}
        taken={taken}
      />
      <div className="flex justify-end">
        <Button
          data-testid="workflow-save-submit"
          disabled={submitDisabled}
          onClick={onDirectSave}
          type="button"
          variant="outline"
        >
          {saving ? <Spinner className="size-3.5" /> : null}
          {submitLabel}
        </Button>
      </div>
    </>
  );
}

/**
 * Three-in-one for the same spot: the agent's rejection → the overwrite warning → the consequence
 * sentence. When a rejection is present the popover stays open, because not a single byte was
 * written. Both the overwrite warning and the consequence sentence append the shadowing sentence when
 * another scope also holds this name (the same sentence as the SaveWorkflow card) — shadowing and
 * overwriting are two things; mentioning only one would make users believe the other will not happen.
 */
function WorkflowSaveConsequence({
  failure,
  pathPreview,
  scope,
  shadowing,
  taken,
}: {
  failure: WorkflowSaveFailure | undefined;
  pathPreview: string;
  scope: ZCodeSavedWorkflowScope;
  shadowing: boolean;
  taken: boolean;
}) {
  const { intl } = useZCodeIntl();
  const format = (id: string, values?: Record<string, string>) =>
    intl.formatMessage({ id }, values);
  // The shadowing sentence borrows the SaveWorkflow card's wording (which itself carries no period);
  // the period is added per language by the message entry.
  const shadowingText = shadowing
    ? format("chat.toolCall.workflow.saveRun.shadowing", {
        text: format(
          scope === "global"
            ? "chat.toolCall.workflow.save.scope.hiddenByProject"
            : "chat.toolCall.workflow.save.scope.hidesGlobal",
        ),
      })
    : null;
  if (failure !== undefined) {
    return (
      <div className="text-ui-xs text-warning" data-testid="workflow-save-failure" role="status">
        <span>{format(`chat.toolCall.workflow.saveRun.error.${failure.reason}`)}</span>
        {failure.detail === undefined ? null : (
          <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap font-mono text-ui-xs text-foreground-subtle">
            {failure.detail}
          </pre>
        )}
      </div>
    );
  }
  if (taken) {
    return (
      <div
        className="rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-2 text-ui-sm leading-snug text-foreground-subtle"
        data-testid="workflow-save-overwrite"
      >
        {format("chat.toolCall.workflow.saveRun.overwrite")}
        {shadowingText === null ? null : ` ${shadowingText}`}
      </div>
    );
  }
  // The path is a technical value and needs monospace type (DESIGN.md reserves font-mono for
  // technical values); the message engine only accepts strings, so a placeholder that never appears
  // in copy splits the sentence into before/after, and the path is embedded back as a <code>.
  const [before, after = ""] = format("chat.toolCall.workflow.saveRun.consequence", {
    path: PATH_SLOT,
  }).split(PATH_SLOT);
  return (
    <p
      className="text-ui-sm leading-snug text-foreground-subtle"
      data-testid="workflow-save-consequence"
    >
      {before}
      <code className="font-mono text-ui-xs">{pathPreview}</code>
      {after}
      {shadowingText === null ? null : ` ${shadowingText}`}
    </p>
  );
}

/** Placeholder for the path inside the sentence: NUL never appears in any message entry. */
const PATH_SLOT = "\u0000";
