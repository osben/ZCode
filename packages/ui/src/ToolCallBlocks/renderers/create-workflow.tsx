import { ChevronRightIcon, RotateCcwIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { CodeBlock } from "@/components/ai-elements/code-block.js";
import { Button } from "@/components/ui/button.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import { cn } from "@/components/lib/utils.js";
import { WorkflowArtifactStrip } from "@/components/workflow-timeline/WorkflowArtifactStrip.js";
import type {
  TimelinePill,
  TimelineStation,
} from "@/components/workflow-timeline/timeline-model.js";
import { workflowCardDetail } from "@/components/workflow-timeline/timeline-summary.js";
import {
  WORKFLOW_CARD_ICON,
  WorkflowCardFooter,
  WorkflowCardHeader,
  WorkflowRunStatus,
  WorkflowStaticStatus,
  workflowRunKindMessageId,
} from "@/components/workflow-timeline/WorkflowCardChrome.js";
import { WorkflowTimeline } from "@/components/workflow-timeline/WorkflowTimeline.js";
import { isAmendWorkflowToolCall } from "@/lib/workflowToolNames.js";
import {
  useWorkflowCardModel,
  useWorkflowHoleRow,
  useWorkflowRowPrimaryText,
} from "@/ToolCallBlocks/renderers/workflow-fill-row.js";
import {
  isPlainRecord,
  readWorkflowAmendTarget,
  readWorkflowCardKeptScript,
  readWorkflowKindMessageId,
  readWorkflowName,
  readWorkflowPrelaunchKindMessageId,
  readWorkflowRetuneCall,
  readWorkflowSaved,
  readWorkflowScript,
} from "@/ToolCallBlocks/renderers/createWorkflowInput.js";
export { readWorkflowKindMessageId } from "@/ToolCallBlocks/renderers/createWorkflowInput.js";
import {
  readFallbackOutputText,
  readWorkflowDisplay,
} from "@/ToolCallBlocks/renderers/createWorkflowDisplay.js";
import {
  WorkflowAmendsLine,
  WorkflowCardMetaLine,
} from "@/ToolCallBlocks/renderers/WorkflowCardMetaLine.js";
import { WorkflowDiagnosticsSection } from "@/ToolCallBlocks/renderers/workflow-diagnostics.js";
import {
  useWorkflowDraftRowSlots,
  WorkflowFeedbackContent,
} from "@/ToolCallBlocks/renderers/workflow-draft-row.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { ToolLayout } from "../ToolLayout.js";
import type { ToolCallBlockRenderContext } from "../shared.js";

/** Empty diagnostic used in the draft slot when display is absent; keep it as a module-level constant so each render does not allocate a new array. */
const NO_DIAGNOSTICS: readonly never[] = [];

/** Remember collapsed state by toolId (same pattern as ToolLayout’s toolLayoutOpenState); expanded by default. */
const workflowCardOpenState = new Map<string, boolean>();

/**
 * CreateWorkflow / AmendWorkflow tool card in the chat area.
 *
 * While writing, use a non-expandable ToolLayout with a persistent draft-stage line below it (stations are written as the script streams); awaiting confirmation uses a ToolLayout with an expandable script. A compile error is a compiler-feedback row
 * (“Workflow draft · version n · n fixes needed · not run”)—not a failure; nothing was run.
 * The row above a run already linked in v4 is handled by WorkflowToolSummary. This component retains the legacy host’s run-card rendering.
 *
 * AmendWorkflow uses the **same** renderer (the display kind is also `create_workflow`, so the graph, draft pen, and diagnostic card have one implementation),
 * changing only the revision terminology and adding an “Adjusted from run X” line in the card body—based on tool name, not family.
 */
export function CreateWorkflowToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const amend = isAmendWorkflowToolCall(toolCall);
  const amendTarget = amend ? readWorkflowAmendTarget(toolCall.input) : undefined;
  // Hole-fill row (docs/dynamic-workflow/presentation.md, “The fill row”): reuse this renderer with hole-filling vocabulary (workflow-fill-row.tsx).
  const { fill, holeTarget, vocabulary } = useWorkflowHoleRow(toolCall, amend);

  const display = useMemo(() => readWorkflowDisplay(toolCall.raw), [toolCall.raw]);
  // In-progress wording (docs/dynamic-workflow/concurrency.md): a call that only changes the
  // concurrency ceiling neither writes nor compiles a script, so “Validating workflow” does not
  // apply. The wiring layer (ConversationRowView) converts the whole row to a settings row only
  // **after settlement**; this component handles only the in-flight labels.
  const retuning = amend && readWorkflowRetuneCall(toolCall.input) !== undefined;
  const scriptText = useMemo(() => readWorkflowScript(toolCall.input), [toolCall.input]);
  const workflowName = readWorkflowName(toolCall.input);
  const saved = useMemo(() => readWorkflowSaved(toolCall.input), [toolCall.input]);
  const fallbackOutputText = display ? null : readFallbackOutputText(toolCall.output);
  const fallbackName = intl.formatMessage({ id: "chat.toolCall.workflow.fallbackName" });
  const name = fill
    ? (holeTarget?.name ?? holeTarget?.holeId ?? fallbackName)
    : (workflowName ?? fallbackName);

  const workflowRun = context.workflowRun;
  const run = workflowRun?.run;
  const hasCompileErrors = display?.ok === false;
  const showFailureStatus = hasCompileErrors || (!display && toolCall.status === "failed");
  const draft = context.workflowDraft;

  // An empty graph (no ask or files.* calls in the script) is not worth an empty track; build the model only when there is a step.
  const graph =
    display?.causalityGraph !== undefined && display.causalityGraph.steps.length > 0
      ? display.causalityGraph
      : undefined;
  const v4Status = isPlainRecord(toolCall.raw) ? toolCall.raw.v4Status : undefined;
  const writing = context.isRunning && v4Status === "inputStreaming";
  // Reuse the previous script revision: the row input is the one emitted by the model.
  // If both `script` and `path` are absent, the script was omitted (`path` revisions omit `script` but still revise it)
  //—say this only after the input is complete, since the script may not have arrived during streaming. The missing script is intentional for this
  // call: the lineage row says “script unchanged,” so do not show the “script not provided” hint.
  const keptScript = amend && !writing && readWorkflowCardKeptScript(toolCall);
  const inFlight = context.isRunning && workflowRun === undefined;
  const draftSlots = useWorkflowDraftRowSlots({
    draft,
    compileErrors: hasCompileErrors,
    inFlight,
    errorCount: display?.errorCount ?? 0,
    diagnostics: display?.diagnostics ?? NO_DIAGNOSTICS,
    saved: saved !== undefined,
  });

  // Use the graph when available (the fill row is narrowed to the filled segment); scan the draft
  // while streaming. Once display arrives, the whole model is replaced.
  const model = useWorkflowCardModel({ graph, holeTarget, run, scriptText, writing });

  const [isOpen, setIsOpen] = useState(() => workflowCardOpenState.get(toolCall.toolId) ?? true);
  const forceOpen = context.forceOpen ?? false;
  const canToggle = context.canToggle ?? true;
  const expanded = forceOpen || !canToggle || isOpen;
  const handleToggle = useCallback(() => {
    setIsOpen((previous) => {
      workflowCardOpenState.set(toolCall.toolId, !previous);
      return !previous;
    });
  }, [toolCall.toolId]);
  const [scriptOpen, setScriptOpen] = useState(false);

  const onOpenWorkflowRun = context.onOpenWorkflowRun;
  const named = useMemo(() => (workflowName === undefined ? {} : { workflowName }), [workflowName]);
  const handleOpenRunDetails = useCallback(
    () => onOpenWorkflowRun?.(named),
    [onOpenWorkflowRun, named],
  );
  // The station header and “n more” row provide a station id so the details page can jump to that station and expand the list.
  const handleSelectStation = useCallback(
    (station: TimelineStation) => onOpenWorkflowRun?.({ ...named, phaseId: station.id }),
    [onOpenWorkflowRun, named],
  );
  const onResumeWorkflowRun = context.onResumeWorkflowRun;
  const handleResume = useCallback(() => {
    onResumeWorkflowRun?.(workflowName === undefined ? {} : { workflowName });
  }, [onResumeWorkflowRun, workflowName]);
  // Clicking a pill opens that subagent’s transcript. The card provides only the slot identity
  // (pills can be opened before launch too; include the session id if available); the host supplies session and workspace identity.
  const onOpenWorkflowActor = context.onOpenWorkflowActor;
  const onOpenWorkflowWorkspace = context.onOpenWorkflowWorkspace;
  const onOpenWorkflowArtifact = context.onOpenWorkflowArtifact;
  const runId = workflowRun?.runId;
  // Script pill: provide the stage id for this station; the host binds the run and session
  // identity (through the same path as onOpenWorkflowRun).
  const handleOpenWorkspace = useCallback(
    (pill: TimelinePill) => {
      const phaseId = pill.workspace?.phaseId;
      if (phaseId === undefined) return;
      onOpenWorkflowWorkspace?.({
        phaseId,
        ...(workflowName === undefined ? {} : { workflowName }),
      });
    },
    [onOpenWorkflowWorkspace, workflowName],
  );
  const handleOpenPill = useCallback(
    (pill: TimelinePill) => {
      const slot = pill.slot;
      if (runId === undefined || slot === undefined) return;
      const sessionId = pill.instance?.sessionId;
      const actorName = pill.runtimeName ?? pill.lane.name;
      onOpenWorkflowActor?.({
        ordinal: slot.ordinal,
        runId,
        siteId: slot.siteId,
        ...(sessionId === undefined ? {} : { actorSessionId: sessionId }),
        ...(actorName === undefined ? {} : { actorName }),
      });
    },
    [onOpenWorkflowActor, runId],
  );

  // ToolLayout is a memoized component: nodes and callbacks passed to it must have stable references (enforced by reactStableReferences).
  const diagnosticsPrimaryText = useWorkflowRowPrimaryText(fill, name);
  const renderDiagnosticsContent = useCallback(
    () => (
      <WorkflowFeedbackContent
        display={display}
        fallbackOutputText={fallbackOutputText}
        saved={saved !== undefined}
        scriptText={scriptText}
      />
    ),
    [display, fallbackOutputText, saved, scriptText],
  );

  const snapshotNotice = (
    <ToolSnapshotFieldNotice
      refs={toolCall.snapshotRefs ?? []}
      onLoadFullToolCallFields={
        context.onLoadFullToolCallFields
          ? () => context.onLoadFullToolCallFields?.(toolCall.toolId)
          : undefined
      }
    />
  );

  // Compile errors use the compiler-feedback row; failures without display use the failure summary. The handler returns diagnostics directly and does not start the engine on compile-error paths,
  // so there should be no run—even if the host linked one, keep it in the feedback row. Encode “diagnostics first” here instead of relying on the caller.
  // Reuse the regular summary before launch: do not show a partial script while writing; allow the final script to expand when awaiting confirmation.
  const prelaunch = workflowRun === undefined && (writing || v4Status === "pendingApproval");
  const summaryOnly = writing && !showFailureStatus;
  // The writing row cannot expand, but the draft-stage line remains below it (it is not expandable content and has no collapse control):
  // stations are written character by character by the pen; when display arrives, the analyzer’s stations replace the whole model and this line leaves with the writing state.
  const draftTimelineBlock =
    summaryOnly && model?.draft !== undefined ? (
      <div className="pt-2" data-testid="workflow-draft-timeline">
        <WorkflowTimeline className="py-1" model={model} />
      </div>
    ) : null;
  if (showFailureStatus || prelaunch) {
    return (
      <>
        <ToolLayout
          toolId={toolCall.toolId}
          icon={WORKFLOW_CARD_ICON}
          showIcon={context.showIcon !== false}
          canToggle={!summaryOnly && canToggle}
          forceOpen={!summaryOnly && forceOpen}
          kindLabel={
            context.kindLabelOverride ??
            intl.formatMessage({
              id: readWorkflowPrelaunchKindMessageId(
                {
                  compileErrors: hasCompileErrors,
                  failed: showFailureStatus,
                  writing,
                  revising: (draft?.ordinal ?? 1) >= 2,
                },
                vocabulary,
              ),
            })
          }
          sourceLabel={context.sourceLabel}
          primaryText={diagnosticsPrimaryText}
          // Keep the version number on the row when expanded: it identifies “which draft this is,” not a collapsed summary.
          secondaryText={draftSlots.secondaryText}
          statusLabel={draftSlots.statusLabel ?? context.statusLabel}
          statusIndicator={draftSlots.statusIndicator}
          statusTooltip={draftSlots.statusTooltip ?? context.errorText}
          showFailureStatus={showFailureStatus}
          // Awaiting confirmation is still part of the launch flow; share the shimmer with the writing state so it does not look finished.
          isRunning={showFailureStatus ? context.isRunning : prelaunch}
          title={toolCall.title}
          renderContent={summaryOnly ? undefined : renderDiagnosticsContent}
        />
        {draftTimelineBlock}
        {snapshotNotice}
      </>
    );
  }

  // For a linked run, describe the kind according to run state (legacy host run card); before a run exists, revision rows use revision wording.
  const kindId =
    workflowRun !== undefined
      ? workflowRunKindMessageId(workflowRun)
      : readWorkflowKindMessageId(toolCall.raw, context.isRunning, vocabulary, retuning);
  const kindText = context.kindLabelOverride ?? intl.formatMessage({ id: kindId });
  // The kind label changes with its copy (writing → awaiting confirmation → running); the header owns the label transition animation. See WorkflowCardHeader.
  const live = workflowRun !== undefined ? workflowRun.status === "running" : context.isRunning;
  const status =
    workflowRun !== undefined ? (
      <WorkflowRunStatus run={workflowRun} testId="workflow-card-status" />
    ) : display?.ok === true ? (
      <WorkflowStaticStatus word={intl.formatMessage({ id: "chat.toolCall.workflow.compiled" })} />
    ) : undefined;
  // The detail string and its tooltip (including subagent model names) share the v4 turn-tail summary implementation. This rendering path cannot access the session’s
  // model catalog (the tool-card layer does not touch the store), so custom provider names cannot be resolved; follow the same fallback rule and show
  // the bare modelId, never providerId.
  const cardDetail = workflowCardDetail(intl, model, graph, run);
  // During validation (in flight, with no graph), show the draft number in the detail slot from version 2 onward so “Editing · version 2” does not disappear between validation and feedback.
  const headerDetail = cardDetail?.detail ?? draftSlots.inFlightOrdinalText;
  const terminal = run !== undefined && (run.status === "errored" || run.status === "stopped");
  const resume =
    workflowRun?.resumable === true && onResumeWorkflowRun !== undefined ? (
      <Button
        className="ml-auto"
        data-testid="workflow-card-resume"
        onClick={handleResume}
        size="sm"
        type="button"
        variant="outline"
      >
        <RotateCcwIcon className="size-3.5" />
        {intl.formatMessage({ id: "chat.toolCall.workflow.run.resume" })}
      </Button>
    ) : undefined;
  const savedSourceLabel = intl.formatMessage({ id: "chat.permission.workflow.saved.badge" });
  const savedScopeProjectLabel = intl.formatMessage({
    id: "chat.permission.workflow.saved.scope.project",
  });
  const showScriptFold = workflowRun === undefined && !writing && scriptText !== undefined;

  return (
    <>
      <section
        aria-label={typeof kindText === "string" ? kindText : undefined}
        className="wf-motion flex w-full min-w-0 flex-col gap-2"
        data-testid="workflow-card"
        data-workflow-card-state={workflowRun?.status ?? (writing ? "writing" : "static")}
        {...(workflowRun === undefined
          ? {}
          : {
              "data-workflow-run-id": workflowRun.runId,
              "data-workflow-run-status": workflowRun.status,
            })}
      >
        <WorkflowCardHeader
          detail={headerDetail}
          {...(cardDetail?.title === undefined ? {} : { detailTitle: cardDetail.title })}
          expanded={expanded}
          kind={kindText}
          live={live}
          name={name}
          status={status}
          {...(onOpenWorkflowRun === undefined ? {} : { onOpenDetails: handleOpenRunDetails })}
          {...(forceOpen || !canToggle ? {} : { onToggle: handleToggle })}
        />

        {expanded ? (
          <div className="wf-unfold flex min-w-0 flex-col gap-2" data-testid="workflow-card-body">
            {amendTarget === undefined ? null : (
              <WorkflowAmendsLine runId={amendTarget} scriptInherited={keptScript} />
            )}
            {saved ? (
              <WorkflowCardMetaLine
                marker="saved-source"
                label={
                  saved.scope === "project"
                    ? `${savedSourceLabel} · ${savedScopeProjectLabel}`
                    : savedSourceLabel
                }
                value={saved.name}
                title={saved.path ?? saved.name}
              />
            ) : null}

            {model === undefined ? null : (
              <WorkflowTimeline
                className="py-1"
                model={model}
                {...(onOpenWorkflowRun === undefined
                  ? {}
                  : { onOpenMore: handleSelectStation, onSelectStation: handleSelectStation })}
                {...(onOpenWorkflowActor === undefined || run === undefined
                  ? {}
                  : { onOpenPill: handleOpenPill })}
                {...(onOpenWorkflowWorkspace === undefined || run === undefined
                  ? {}
                  : { onOpenWorkspace: handleOpenWorkspace })}
              />
            )}

            {/* Artifact row (see “Artifact pills” note): what the run delivered, up to 3 items + N; the full list is in the details side pane. */}
            {run?.artifacts !== undefined && run.artifacts.length > 0 ? (
              <WorkflowArtifactStrip
                artifacts={run.artifacts}
                className="px-1 pb-0.5"
                moreTestId="workflow-card-artifacts-more"
                pillTestId="workflow-card-artifact"
                testId="workflow-card-artifacts"
                {...(onOpenWorkflowArtifact === undefined
                  ? {}
                  : { onOpenArtifact: onOpenWorkflowArtifact })}
              />
            ) : null}

            {graph?.truncated === true ? (
              <p className="text-ui-xs text-foreground-subtlest">
                {intl.formatMessage({ id: "chat.toolCall.workflow.graph.truncated" })}
              </p>
            ) : null}

            {display && display.diagnostics.length > 0 ? (
              <WorkflowDiagnosticsSection
                count={display.errorCount}
                diagnostics={display.diagnostics}
                saved={saved !== undefined}
                truncated={display.truncated}
              />
            ) : null}

            {!display && fallbackOutputText ? (
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border bg-panel px-3 py-2 font-mono text-ui-base text-foreground-subtle">
                {fallbackOutputText}
              </pre>
            ) : null}

            {!scriptText && !keptScript && !display && !fallbackOutputText && !context.isRunning ? (
              <p className="font-mono text-ui-base text-foreground-subtle">
                {intl.formatMessage({ id: "chat.toolCall.workflow.noScript" })}
              </p>
            ) : null}

            {showScriptFold ? (
              // Without a run there is no Script section on the details page, so this is the only place to read the source; collapsed by default like the confirmation dialog.
              <Collapsible open={scriptOpen} onOpenChange={setScriptOpen}>
                <CollapsibleTrigger
                  className="flex min-w-0 items-center gap-1 rounded-md py-0.5 text-left text-ui-xs font-medium text-foreground-subtlest transition-colors hover:text-foreground-subtle"
                  data-testid="workflow-card-script-toggle"
                >
                  <ChevronRightIcon
                    className={cn(
                      "size-3.5 shrink-0 transition-transform",
                      scriptOpen && "rotate-90",
                    )}
                  />
                  <span className="min-w-0 truncate">
                    {intl.formatMessage({
                      id: scriptOpen
                        ? "chat.permission.workflow.hideScript"
                        : "chat.permission.workflow.showScript",
                    })}
                  </span>
                </CollapsibleTrigger>
                <CollapsibleContent className="pt-1.5">
                  <div className="max-h-72 overflow-auto">
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
        ) : null}

        {/* Footer: always present when expanded; when collapsed, keep it only for terminal states (failure/cancel), so Resume remains accessible. */}
        {/* The footer used to be a summary row (subagents, steps, tokens, turns, artifacts). Since 2026-09-09, the card shows only phases and subagents in the header; the footer is only for Resume, and is omitted when Resume is unavailable. */}
        {resume !== undefined && run !== undefined && (expanded || terminal) ? (
          <WorkflowCardFooter status={run.status} trailing={resume} />
        ) : null}
      </section>
      {snapshotNotice}
    </>
  );
}
