// ============================================================
// "Configure" popover.
// ============================================================
// The Configure buttons on run cards and the details page, plus the model segment in the details summary, open the same popover:
// two fields, one consequence, and Apply. Apply is a GUI revision through `amendWorkflowRunSettings`, without a model turn or confirmation dialog;
// clicking it is consent, following the same rule as "Run" in the hub.
//
// One popover, multiple triggers: anchor to **the element that opened it** (virtual anchor), so both details-page entries align independently.
// Mount the form only while open; the model-list subscription is active only for that period.

import { useCallback, useRef, useState, type RefObject } from "react";
import type { CommandAck, WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverAnchor, PopoverContent, PopoverTitle } from "@/components/ui/popover.js";
import { Spinner } from "@/components/ui/spinner.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  WorkflowRunSettingsBoundField,
  WorkflowRunSettingsModelField,
} from "./WorkflowRunSettingsFields.js";
import {
  useWorkflowSettingsModelChoices,
  type WorkflowSettingsModelScope,
} from "./useWorkflowSettingsModelChoices.js";
import {
  describeWorkflowRunSettingsRejection,
  initialWorkflowRunSettingsDraft,
  workflowRunDefaultConcurrency,
  workflowRunSettingsChange,
  workflowRunSettingsConsequenceId,
  workflowRunSettingsRejectionDetail,
  workflowRunSettingsRejectionMessageId,
  type WorkflowRunSettingsChange,
  type WorkflowRunSettingsDraft,
  type WorkflowRunSettingsRejection,
} from "./workflowRunSettings.js";

/** Everything the host supplies to the popover: model-list scope, session model, and command dispatch. */
export interface WorkflowRunSettingsHost extends WorkflowSettingsModelScope {
  /** Send `amendWorkflowRunSettings` (the host adds workId and session) and return the ACK. */
  apply: (change: WorkflowRunSettingsChange) => Promise<CommandAck>;
}

/** Two IDs for the new run after acceptance (ACK.result). */
export interface WorkflowRunSettingsAccepted {
  runId: string;
  toolCallId: string;
}

/** Trigger state and anchor: clicking the same trigger again closes it; clicking another moves and reopens it. */
export function useWorkflowRunSettingsPopoverState() {
  const anchorRef = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const toggleFrom = useCallback(
    (element: HTMLElement) => {
      if (open && anchorRef.current === element) {
        setOpen(false);
        return;
      }
      anchorRef.current = element;
      setOpen(true);
    },
    [open],
  );
  return { anchorRef, open, setOpen, toggleFrom };
}

export function WorkflowRunSettingsPopover({
  anchorRef,
  host,
  onAccepted,
  onOpenChange,
  open,
  run,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  host: WorkflowRunSettingsHost;
  onAccepted?: (accepted: WorkflowRunSettingsAccepted) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  run: WorkflowRunState;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor virtualRef={anchorRef as RefObject<HTMLElement>} />
      <PopoverContent
        align="end"
        className="gap-2.5"
        data-testid="workflow-run-settings-popover"
        // The popover is portaled elsewhere, but React events still bubble through the component tree. Without stopping them, clicking blank popover space
        // makes the run card think its body was clicked and collapse it (the entire card toggles); Enter in a number field also toggles the card.
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") event.stopPropagation();
        }}
        // Clicking the trigger that opened it does not count as an outside click; otherwise it closes and immediately reopens on the same click.
        onInteractOutside={(event) => {
          const target = event.target;
          if (target instanceof Node && anchorRef.current?.contains(target)) event.preventDefault();
        }}
      >
        <WorkflowRunSettingsForm
          host={host}
          onClose={() => onOpenChange(false)}
          run={run}
          {...(onAccepted === undefined ? {} : { onAccepted })}
        />
      </PopoverContent>
    </Popover>
  );
}

function WorkflowRunSettingsForm({
  host,
  onAccepted,
  onClose,
  run,
}: {
  host: WorkflowRunSettingsHost;
  onAccepted?: (accepted: WorkflowRunSettingsAccepted) => void;
  onClose: () => void;
  run: WorkflowRunState;
}) {
  const { intl } = useZCodeIntl();
  const format = useCallback(
    (id: string, values?: Record<string, string | number>) => intl.formatMessage({ id }, values),
    [intl],
  );
  // Checklist, the session-model item, trigger copy, and thinking-level rules for model changes are shared with the confirmation dialog.
  // （useWorkflowSettingsModelChoices.ts）。
  const choices = useWorkflowSettingsModelChoices(host);

  // Set the initial values when opening; a run-state change while the popover is open must not reset the form the user is editing.
  const [initial] = useState(() => initialWorkflowRunSettingsDraft(run));
  const [draft, setDraft] = useState<WorkflowRunSettingsDraft>(initial);
  const [pending, setPending] = useState(false);
  const [rejection, setRejection] = useState<WorkflowRunSettingsRejection | undefined>(undefined);
  const defaultConcurrency = workflowRunDefaultConcurrency(run);
  const change = workflowRunSettingsChange(initial, draft, defaultConcurrency);
  const updateDraft = (next: WorkflowRunSettingsDraft) => {
    setDraft(next);
    setRejection(undefined);
  };

  const draftModel = draft.model;
  const face = choices.describe(draftModel);
  const handleModelChange = (value: string) => {
    updateDraft({ ...draft, model: choices.pick(value, draftModel) });
  };

  const handleApply = () => {
    if (change === undefined) return;
    setPending(true);
    setRejection(undefined);
    host.apply(change).then(
      (ack) => {
        const next = describeWorkflowRunSettingsRejection(ack);
        if (next !== undefined) {
          logger.warn("[workflow-run] 调整设置被拒绝", {
            reasonCode: ack.reasonCode,
            runId: run.runId,
            status: ack.status,
          });
          setRejection(next);
          setPending(false);
          return;
        }
        const result = ack.result;
        if (result?.type === "amendWorkflowRunSettings") {
          onAccepted?.({ runId: result.runId, toolCallId: result.toolCallId });
        }
        onClose();
      },
      (error: unknown) => {
        logger.warn("[workflow-run] 调整设置命令失败", { runId: run.runId, error: String(error) });
        setRejection({
          reason: "generic",
          code: error instanceof Error ? error.message : String(error),
        });
        setPending(false);
      },
    );
  };

  const rejectionDetail =
    rejection === undefined ? undefined : workflowRunSettingsRejectionDetail(rejection);
  const consequenceId = workflowRunSettingsConsequenceId(run.status, change);
  return (
    <>
      <PopoverTitle>{format("chat.toolCall.workflow.run.settings.title")}</PopoverTitle>
      <WorkflowRunSettingsModelField
        disabled={pending || choices.loading}
        groups={choices.groups}
        leadingItem={choices.sessionModelItem}
        noCatalog={choices.noCatalog}
        onLevelChange={(level) => {
          if (draftModel.kind !== "model" || level === draftModel.level) return;
          updateDraft({ ...draft, model: { ...draftModel, level } });
        }}
        onValueChange={handleModelChange}
        thoughtOption={face.thoughtOption}
        triggerLabel={face.triggerLabel}
        value={face.value}
        {...(draftModel.kind === "session"
          ? { badge: { text: choices.sessionBadge, tone: "subtle" as const } }
          : face.unavailable
            ? {
                badge: {
                  text: format("chat.toolCall.workflow.run.settings.model.unavailable"),
                  tone: "warning" as const,
                },
              }
            : {})}
      />
      <WorkflowRunSettingsBoundField
        bound={draft.bound}
        defaultConcurrency={defaultConcurrency}
        disabled={pending}
        onChange={(bound) => updateDraft({ ...draft, bound })}
      />
      {/* When nothing has changed, the consequence sentence is empty but retains one line of height (min-h-lh), so the footer does not jump down after the first edit. */}
      <p
        className="min-h-lh text-ui-sm text-foreground-subtle"
        data-testid="workflow-run-settings-consequence"
      >
        {consequenceId === undefined ? null : format(consequenceId)}
      </p>
      {rejection === undefined ? null : (
        <div
          className="text-ui-xs text-warning"
          data-testid="workflow-run-settings-rejection"
          role="status"
        >
          <span>
            {format(workflowRunSettingsRejectionMessageId(rejection), {
              code: rejection.code,
              message: rejection.message ?? rejection.code,
            })}
          </span>
          {rejectionDetail === undefined ? null : (
            <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap font-mono text-ui-xs text-foreground-subtle">
              {rejectionDetail}
            </pre>
          )}
        </div>
      )}
      <div className="flex justify-end">
        <Button
          data-testid="workflow-run-settings-apply"
          disabled={change === undefined || pending || face.unavailable}
          onClick={handleApply}
          size="default"
          type="button"
          variant="default"
        >
          {pending ? <Spinner className="size-3.5" /> : null}
          {format(
            pending
              ? "chat.toolCall.workflow.run.settings.applying"
              : "chat.toolCall.workflow.run.settings.apply",
          )}
        </Button>
      </div>
    </>
  );
}
