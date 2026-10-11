import { ChevronRightIcon } from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";
import type { ZCodePermissionRequest } from "@zcode/shared";
import { CodeBlock } from "@/components/ai-elements/code-block.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import { cn } from "@/components/lib/utils.js";
import { buildWorkflowTimeline } from "@/components/workflow-timeline/timeline-model.js";
import { workflowPhasesDetail } from "@/components/workflow-timeline/timeline-summary.js";
import { WorkflowCardHeader } from "@/components/workflow-timeline/WorkflowCardChrome.js";
import { WorkflowTimeline } from "@/components/workflow-timeline/WorkflowTimeline.js";
import {
  formatWorkflowArgValue,
  isWorkflowAmendPredecessorLive,
  readWorkflowAdjustableSettings,
  readWorkflowAmendPredecessor,
  readWorkflowAmendScriptInherited,
  readWorkflowAmendTarget,
  readWorkflowMaxConcurrency,
  readWorkflowName,
  readWorkflowSaved,
  readWorkflowScript,
  readWorkflowSubagentModel,
  workflowScriptNamesModels,
  type WorkflowSavedSource,
} from "@/ToolCallBlocks/renderers/createWorkflowInput.js";
import {
  describeWorkflowSubagentModel,
  workflowSubagentModelText,
  workflowSubagentModelTooltip,
} from "@/components/workflow-timeline/subagent-model-label.js";
import { WorkflowAskSettings } from "@/components/workflow-timeline/WorkflowAskSettingsLines.js";
import { WorkflowAskPlainSettings } from "@/components/workflow-timeline/WorkflowAskSettingsParts.js";
import type { WorkflowAskSettingsContent } from "@/components/workflow-timeline/workflowAskSettings.js";
import { useWorkflowSubagentModelProviderName } from "@/hooks/useWorkflowSubagentModelProviderName.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { isAmendWorkflowToolCall, isFillWorkflowHoleToolCall } from "@/lib/workflowToolNames.js";
import { readWorkflowHoleTarget } from "@/ToolCallBlocks/renderers/createWorkflowHoleInput.js";
import { narrowTimelineToFill } from "@/components/workflow-timeline/timeline-holes.js";
import { WorkflowPermissionHoles } from "@/WorkflowPermissionHoles.js";

/**
 * Saved-source badge: the script for this run comes from a project file, not text newly written by the model.
 *
 * Intentionally limited to one line plus an argument table and placed **above** the timeline: the graph remains the decision focus, while the source and arguments state which version runs and with what parameters
 * as context before the graph. The badge expresses no trust — invariant 1: saving does not create trust.
 */
function WorkflowSavedSourceBadge({ saved }: { saved: WorkflowSavedSource }) {
  const { intl } = useZCodeIntl();

  const savedLabel = intl.formatMessage({ id: "chat.permission.workflow.saved.badge" });
  const scopeLabel =
    saved.scope === "project"
      ? intl.formatMessage({ id: "chat.permission.workflow.saved.scope.project" })
      : saved.scope;
  const argsLabel = intl.formatMessage({ id: "chat.permission.workflow.saved.args" });
  const argEntries = Object.entries(saved.args);

  return (
    <div
      className="space-y-1.5 rounded-lg border border-border bg-surface px-2.5 py-2"
      data-workflow-saved-source="true"
    >
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="shrink-0 text-ui-sm font-medium text-foreground-subtle">
          {scopeLabel === undefined ? savedLabel : `${savedLabel} · ${scopeLabel}`}
        </span>
        <span
          className="min-w-0 flex-1 truncate font-mono text-ui-sm text-foreground-subtlest"
          data-workflow-saved-name="true"
          title={saved.path ?? saved.name}
        >
          {saved.name}
        </span>
      </div>

      {saved.path === undefined ? null : (
        <p
          className="min-w-0 truncate font-mono text-ui-xs text-foreground-subtlest"
          data-workflow-saved-path="true"
          title={saved.path}
        >
          {saved.path}
        </p>
      )}

      {argEntries.length === 0 ? null : (
        <dl
          className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 pt-0.5"
          data-workflow-saved-args="true"
          aria-label={argsLabel}
        >
          {argEntries.map(([key, value]) => (
            <Fragment key={key}>
              <dt className="font-mono text-ui-sm text-foreground-subtlest">{key}</dt>
              <dd className="min-w-0 break-words font-mono text-ui-sm text-foreground-subtle">
                {formatWorkflowArgValue(value)}
              </dd>
            </Fragment>
          ))}
        </dl>
      )}
    </div>
  );
}

/**
 * Run confirmation block for CreateWorkflow / AmendWorkflow (docs/dynamic-workflow/presentation.md,
 * “The confirmation window”): header (question + name, with only `N phases` on the right—since
 * 2026-09-09 there is no “compiled” lamp and no subagent/step count) + lineage (revisions only) +
 * two run settings (model above, ceiling below; values are editable when the agent supplies
 * `adjustable_settings`) + saved badge + **timeline** + collapsed script.
 * Deny / Refine / Run still come from PermissionDialog. Edited settings are returned through
 * `onSettingsChange` and sent with the Allow response.
 *
 * The revision confirmation appears only when the predecessor is a run from **another session** (or one the user stopped manually): the question becomes “Adjust this workflow?” and the lineage row says which run will change and whether it is still running.
 *
 * Permission blocks are generally not collapsible (see the PermissionDialog getPermissionBlockInteraction comment); the timeline and name
 * are critical to the decision and cannot be collapsed, while the script is an audit detail.
 */
export function WorkflowPermissionBlock({
  onSettingsBlockedChange,
  onSettingsChange,
  remoteSessionId,
  request,
  sessionModel,
  settingsDisabled = false,
  workspaceIdentity,
  workspacePath,
}: {
  /** The selected subagent model is unavailable; the user must choose another before Allow. */
  onSettingsBlockedChange?: (blocked: boolean) => void;
  /** Settings edited in the dialog; includes only changed fields and is undefined if all values are restored. */
  onSettingsChange?: (content: WorkflowAskSettingsContent | undefined) => void;
  remoteSessionId?: string;
  request: ZCodePermissionRequest;
  /** Current session model, used for the “Session model” option label. */
  sessionModel?: { providerId: string; modelId: string };
  /** A response is in progress; disable both controls and options. */
  settingsDisabled?: boolean;
  workspaceIdentity?: string;
  /** Scope for the session model catalog (provided by PermissionDialog); both the model menu and provider names come from it. */
  workspacePath?: string;
}) {
  const { intl } = useZCodeIntl();

  // The v4 ask raw value is the tool input (product-projection detail: payload.input).
  // Share the parsing rules from create-workflow.tsx with the chat card so the same input is not parsed independently in two places.
  const scriptText = readWorkflowScript(request.raw);
  const workflowName = readWorkflowName(request.raw);
  const saved = readWorkflowSaved(request.raw);
  // Detect revisions by tool name (kind/title are tool names attached by v4 ask); lineage applies only to revisions.
  const amend = isAmendWorkflowToolCall(request);
  // Confirmation dialog for filling a hole (docs/dynamic-workflow/launch.md, “Approval”): change
  // the question to “Fill this hole?” and show the fill's draft phase line on the timeline (the new
  // station sits between ghost neighbors). The tool supplies the name and type in the input's `hole` block.
  const fill = isFillWorkflowHoleToolCall(request);
  const holeTarget = fill ? readWorkflowHoleTarget(request.raw) : undefined;
  const amendTarget = amend ? readWorkflowAmendTarget(request.raw) : undefined;
  const predecessor = amend ? readWorkflowAmendPredecessor(request.raw) : undefined;
  // This revision keeps the predecessor's script:
  // the input script is the one filled in by CLI, so render the upcoming script normally in the diagram and collapsed view, and add “Script unchanged” to the lineage row.
  const scriptInherited = amend && readWorkflowAmendScriptInherited(request.raw);
  // Concurrency limit: Create and Amend use the same
  // input field, so do not branch on tool name—the approval is “run with this limit,” and both dialogs must state it. resolveInput
  // has already clamped the input, so the number in the dialog is the effective limit.
  const maxConcurrency = readWorkflowMaxConcurrency(request.raw);
  // Subagent model: another user-specified condition like the concurrency limit,
  // and one that is even more important to state—the approval lets these subagents run on another model. resolveInput
  // has normalized the input, so this ID is the one that will actually be used. The main Agent is unaffected, so the copy refers only to subagents.
  const subagentModel = readWorkflowSubagentModel(request.raw);
  // The agent reports which adjustments this host can apply (docs/dynamic-workflow/launch.md,
  // “Adjusting the settings in the window”). If absent (older agent), show only fields set by the
  // call as plain text; do not offer edits that the agent would discard.
  const adjustable = readWorkflowAdjustableSettings(request.raw);
  // The model catalog requires a scope; when unavailable, render the model row as plain text while keeping the ceiling editable.
  const hasModelScope = Boolean(workspacePath?.trim() || workspaceIdentity?.trim());
  // Show the canonical string only in the tooltip; display the model name (plus reasoning level when needed), using the same name construction as the model menu.
  const subagentModelProviderName = useWorkflowSubagentModelProviderName(workspacePath);
  const describedSubagentModel = useMemo(
    () =>
      subagentModel === undefined
        ? undefined
        : describeWorkflowSubagentModel(subagentModel, {
            formatMessage: intl.formatMessage.bind(intl),
            ...(subagentModelProviderName === undefined
              ? {}
              : { providerName: subagentModelProviderName }),
          }),
    [intl, subagentModel, subagentModelProviderName],
  );

  // An empty diagram (no ask or files.* calls in the script) does not need an empty track; use the same condition as the chat card.
  const display = request.display?.kind === "create_workflow" ? request.display : null;
  const causalityGraph =
    display?.causalityGraph !== undefined && display.causalityGraph.steps.length > 0
      ? display.causalityGraph
      : undefined;
  const hasGraph = causalityGraph !== undefined;
  const holeId = holeTarget?.holeId;
  const holeName = holeTarget?.name;
  const model = useMemo(() => {
    if (causalityGraph === undefined) return undefined;
    if (holeId === undefined) return buildWorkflowTimeline(causalityGraph, undefined);
    const labels = new Map(holeName === undefined ? [] : [[holeId, { name: holeName }]]);
    const whole = buildWorkflowTimeline(causalityGraph, undefined, labels);
    return narrowTimelineToFill(whole, holeId) ?? whole;
  }, [causalityGraph, holeId, holeName]);

  // Collapse the script by default when there is a diagram; a zero-step script has no diagram to show, so expand its only content by default.
  const [scriptOpen, setScriptOpen] = useState(!hasGraph);

  // PermissionDialog reuses the same component instance across requests (resetting internal state only by requestId),
  // so reset to the default collapsed state for each new request; otherwise the previous expansion leaks into the next workflow.
  useEffect(() => {
    setScriptOpen(!hasGraph);
  }, [hasGraph, request.requestId]);

  const fallbackName = intl.formatMessage({ id: "chat.toolCall.workflow.fallbackName" });
  const title = intl.formatMessage({
    id: fill
      ? "chat.permission.workflow.hole.title"
      : amend
        ? "chat.permission.workflow.amend.title"
        : "chat.permission.workflow.title",
  });
  const amendsLabel = intl.formatMessage({ id: "chat.permission.workflow.amends" });
  const stillRunningLabel = intl.formatMessage({ id: "chat.permission.workflow.amends.running" });
  const scriptUnchangedLabel = intl.formatMessage({
    id: "chat.permission.workflow.amends.scriptUnchanged",
  });
  const scriptToggleLabel = intl.formatMessage({
    id: scriptOpen ? "chat.permission.workflow.hideScript" : "chat.permission.workflow.showScript",
  });
  const detail =
    model === undefined ? undefined : workflowPhasesDetail(intl, model, causalityGraph);

  return (
    <div className="space-y-3" data-workflow-permission-block="true">
      {/* Put the question first. The dialog’s generic “Permission required” title sits directly above it; together they form the complete decision prompt.
          Place the name after it as the heading for the timeline below. */}
      <WorkflowCardHeader
        detail={detail}
        expanded
        kind={title}
        name={fill ? (holeName ?? holeId ?? fallbackName) : (workflowName ?? fallbackName)}
      />

      {/* Holes row (docs/dynamic-workflow/presentation.md, "Holes on the timeline"): holes still
          open plus their types, with one line saying the run pauses when it reaches a hole. */}
      <WorkflowPermissionHoles holes={causalityGraph?.holes} />

      {/* The lineage row (only for revisions) sits directly below the name and together they identify what will change. If the predecessor is still running,
          add that it will be stopped; approval covers both the new script and stopping the active run. */}
      {amendTarget === undefined ? null : (
        <div
          className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5"
          data-workflow-amends="true"
          {...(isWorkflowAmendPredecessorLive(predecessor)
            ? { "data-workflow-amends-live": "true" }
            : {})}
          {...(scriptInherited ? { "data-workflow-amends-script-inherited": "true" } : {})}
        >
          <span className="shrink-0 text-ui-xs text-foreground-subtlest">{amendsLabel}</span>
          <span
            className="min-w-0 truncate font-mono text-ui-xs text-foreground-subtlest"
            title={amendTarget}
          >
            {amendTarget}
          </span>
          {scriptInherited ? (
            <span className="shrink-0 text-ui-xs text-foreground-subtlest">
              · {scriptUnchangedLabel}
            </span>
          ) : null}
          {isWorkflowAmendPredecessorLive(predecessor) ? (
            <span className="shrink-0 text-ui-xs text-warning">· {stillRunningLabel}</span>
          ) : null}
        </div>
      )}

      {/* Two run settings: like the lineage row, they state "what constrains this run"; placed
          right after it and before the source badge. When adjustable, both sentences are always
          shown (even untouched, they state what would happen); remounted by requestId, so a new
          request starts from the new inputs' baseline. */}
      {adjustable === undefined ? (
        <WorkflowAskPlainSettings
          maxConcurrency={maxConcurrency}
          scriptNamesModels={workflowScriptNamesModels(request.raw)}
          subagentModel={
            describedSubagentModel === undefined
              ? undefined
              : {
                  text: workflowSubagentModelText(
                    intl.formatMessage.bind(intl),
                    describedSubagentModel,
                  ),
                  tooltip: workflowSubagentModelTooltip(
                    intl.formatMessage.bind(intl),
                    describedSubagentModel,
                  ),
                }
          }
        />
      ) : (
        <WorkflowAskSettings
          key={request.requestId}
          adjustable={{
            ...adjustable,
            subagentModel: adjustable.subagentModel && hasModelScope,
          }}
          disabled={settingsDisabled}
          input={request.raw}
          scope={{
            workspacePath: workspacePath ?? "",
            ...(workspaceIdentity === undefined ? {} : { workspaceIdentity }),
            ...(remoteSessionId === undefined ? {} : { remoteSessionId }),
            ...(sessionModel === undefined ? {} : { sessionModel }),
          }}
          {...(onSettingsChange === undefined ? {} : { onContentChange: onSettingsChange })}
          {...(onSettingsBlockedChange === undefined
            ? {}
            : { onBlockedChange: onSettingsBlockedChange })}
        />
      )}

      {saved ? <WorkflowSavedSourceBadge saved={saved} /> : null}

      {model === undefined ? null : <WorkflowTimeline className="py-1" model={model} />}

      {scriptText ? (
        <Collapsible open={scriptOpen} onOpenChange={setScriptOpen}>
          <CollapsibleTrigger className="flex min-w-0 items-center gap-1 rounded-md py-0.5 text-left text-ui-xs font-medium text-foreground-subtlest transition-colors hover:text-foreground-subtle">
            <ChevronRightIcon
              className={cn("size-3.5 shrink-0 transition-transform", scriptOpen && "rotate-90")}
            />
            <span className="min-w-0 truncate">{scriptToggleLabel}</span>
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-1.5">
            {/* Limit the height and allow scrolling so long scripts do not stretch the confirmation dialog. */}
            <div className="max-h-72 overflow-auto" data-testid="workflow-script-scroll">
              <CodeBlock
                code={scriptText}
                language="typescript"
                renderMermaid={false}
                showLineNumbers
              />
            </div>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  );
}
