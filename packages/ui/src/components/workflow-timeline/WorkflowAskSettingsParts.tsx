// ============================================================
// Parts for the confirmation window's two setting sentences (docs/dynamic-workflow/presentation.md
// "The confirmation window")
// ============================================================
// Split out of WorkflowAskSettingsLines.tsx (max-lines gate): the class names shared by both
// sentences, the "· was X ↺" tail, the upper-bound sentence, and the plain-text conditional row used
// when the block is absent (older agent). State lives in WorkflowAskSettings; the components here only
// receive fully prepared values.

import { MinusIcon, PlusIcon, Undo2Icon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { clampWorkflowRunSettingsBound } from "./workflowRunSettings.js";

/** An in-sentence value rendered as a chip: normally a small surface; the border and input background appear only on hover (the composer model trigger's vocabulary). */
export const WORKFLOW_ASK_CHIP_CLASS_NAME =
  "h-6 min-w-0 max-w-[260px] gap-1 rounded-md border border-transparent bg-surface pl-[7px] pr-1 text-ui-sm text-foreground hover:border-border-hover hover:bg-input focus-visible:border-input-border-focused data-[state=open]:border-border-hover data-[state=open]:bg-input [&_svg]:size-3";
export const WORKFLOW_ASK_LINE_CLASS_NAME =
  "flex min-h-6 min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-ui-sm text-foreground-subtle";
export const WORKFLOW_ASK_TAIL_CLASS_NAME = "text-foreground-subtlest";

/** "· was X ↺": only on changed rows; ↺ puts the row back to its starting value. */
export function WorkflowAskWasTail({
  disabled,
  onReset,
  testId,
  value,
}: {
  disabled: boolean;
  onReset: () => void;
  testId: string;
  value: string;
}) {
  const { intl } = useZCodeIntl();
  const resetLabel = intl.formatMessage({ id: "chat.permission.workflow.settings.reset" });
  // Icon-only button: aria-label for screen readers, title for hover (spec: "restore original value").
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-0.5", WORKFLOW_ASK_TAIL_CLASS_NAME)}>
      <span className="min-w-0 truncate" data-testid={`${testId}-was`}>
        · {intl.formatMessage({ id: "chat.permission.workflow.settings.was" }, { value })}
      </span>
      <Button
        aria-label={resetLabel}
        className="text-foreground-subtlest hover:text-foreground"
        data-testid={`${testId}-reset`}
        disabled={disabled}
        onClick={onReset}
        size="icon-xs"
        title={resetLabel}
        type="button"
        variant="ghost"
      >
        <Undo2Icon className="size-3" />
      </Button>
    </span>
  );
}

export function WorkflowAskBoundLine({
  bound,
  changed,
  defaultConcurrency,
  disabled,
  initial,
  onChange,
  onReset,
}: {
  bound: number | null;
  changed: boolean;
  /** Default concurrency D: only used to write "· default N" and to judge "= default", not the stepper's upper bound. */
  defaultConcurrency: number | undefined;
  disabled: boolean;
  initial: number | null;
  onChange: (bound: number) => void;
  onReset: () => void;
}) {
  const { intl } = useZCodeIntl();
  const format = intl.formatMessage.bind(intl);
  const tail =
    defaultConcurrency === undefined
      ? bound === null
        ? format({ id: "chat.permission.workflow.settings.limit.none" })
        : undefined
      : bound === defaultConcurrency
        ? format({ id: "chat.toolCall.workflow.run.settings.limit.atDefault" })
        : format(
            { id: "chat.toolCall.workflow.run.settings.limit.default" },
            { n: defaultConcurrency },
          );
  const initialText =
    initial === null
      ? format({ id: "chat.permission.workflow.settings.limit.none" })
      : String(initial);
  return (
    <div
      className={WORKFLOW_ASK_LINE_CLASS_NAME}
      data-changed={changed ? "true" : undefined}
      data-testid="workflow-permission-settings-bound"
    >
      <span>{format({ id: "chat.permission.workflow.settings.limit.lead" })}</span>
      <InputGroup className="h-6 w-auto shrink-0">
        <InputGroupAddon align="inline-start">
          <InputGroupButton
            aria-label={format({ id: "chat.toolCall.workflow.run.settings.limit.decrease" })}
            data-testid="workflow-permission-settings-bound-decrease"
            disabled={disabled || bound === null || bound <= 1}
            onClick={() => bound !== null && onChange(clampWorkflowRunSettingsBound(bound - 1))}
            size="icon-xs"
          >
            <MinusIcon className="size-3" />
          </InputGroupButton>
        </InputGroupAddon>
        <InputGroupInput
          aria-label={format({ id: "chat.toolCall.workflow.run.settings.limit" })}
          className={cn(
            "h-6 w-[30px] px-0 text-center font-mono text-ui-sm tabular-nums",
            changed && "font-medium",
          )}
          data-testid="workflow-permission-settings-bound-value"
          disabled={disabled}
          inputMode="numeric"
          onChange={(event) => {
            const parsed = Number.parseInt(event.target.value, 10);
            if (Number.isFinite(parsed)) onChange(clampWorkflowRunSettingsBound(parsed));
          }}
          placeholder="—"
          value={bound === null ? "" : String(bound)}
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            aria-label={format({ id: "chat.toolCall.workflow.run.settings.limit.increase" })}
            data-testid="workflow-permission-settings-bound-increase"
            disabled={disabled || bound === null}
            onClick={() => bound !== null && onChange(clampWorkflowRunSettingsBound(bound + 1))}
            size="icon-xs"
          >
            <PlusIcon className="size-3" />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      <span>{format({ id: "chat.permission.workflow.settings.limit.trail" })}</span>
      {tail === undefined ? null : (
        <span
          className={WORKFLOW_ASK_TAIL_CLASS_NAME}
          data-testid="workflow-permission-settings-bound-tail"
        >
          · {tail}
        </span>
      )}
      {changed ? (
        <WorkflowAskWasTail
          disabled={disabled}
          onReset={onReset}
          testId="workflow-permission-settings-bound"
          value={initialText}
        />
      ) : null}
    </div>
  );
}

/**
 * Plain-text conditional rows when the block is absent (older agent): only fields set by the
 * invocation, model above and upper bound below, in the faintest `text-ui-xs`. Same order as the two
 * adjustable rows so old and new windows read as the same thing. The model shows its parsed name; the
 * canonical string goes only into the tooltip.
 */
export function WorkflowAskPlainSettings({
  maxConcurrency,
  scriptNamesModels = false,
  subagentModel,
}: {
  maxConcurrency: number | undefined;
  /** The script names a model for some subagents: the model sentence says "by default" (it no longer speaks for every subagent). */
  scriptNamesModels?: boolean;
  subagentModel: { text: string; tooltip: string } | undefined;
}) {
  const { intl } = useZCodeIntl();
  if (maxConcurrency === undefined && subagentModel === undefined) return null;
  return (
    <div className="space-y-1">
      {subagentModel === undefined ? null : (
        <p
          className="min-w-0 text-ui-xs text-foreground-subtlest"
          data-testid="workflow-permission-subagent-model"
          title={subagentModel.tooltip}
        >
          {intl.formatMessage(
            {
              id: scriptNamesModels
                ? "chat.permission.workflow.subagentModelDefault"
                : "chat.permission.workflow.subagentModel",
            },
            { model: subagentModel.text },
          )}
        </p>
      )}
      {maxConcurrency === undefined ? null : (
        <p
          className="min-w-0 text-ui-xs text-foreground-subtlest"
          data-testid="workflow-permission-max-concurrency"
        >
          {intl.formatMessage(
            { id: "chat.permission.workflow.maxConcurrency" },
            { count: String(maxConcurrency) },
          )}
        </p>
      )}
    </div>
  );
}
