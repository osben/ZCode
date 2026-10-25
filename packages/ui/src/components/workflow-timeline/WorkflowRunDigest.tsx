import { useMemo, useState } from "react";
import {
  MessageCircleQuestionIcon,
  RotateCcwIcon,
  SlidersHorizontalIcon,
  SquareIcon,
} from "lucide-react";
import { TID_CHAT_WORKFLOW_RUN_DIGEST } from "@zcode/shared";
import { testId } from "@zcode/shared/test-ids";
import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { WorkflowRunCardSummary } from "@/ToolCallBlocks/fileSummaryTypes.js";
import type { HoleLabels } from "./timeline-holes.js";
import { buildWorkflowTimeline, type TimelinePill } from "./timeline-model.js";
import { workflowCardDetail } from "./timeline-summary.js";
import { HolesWaitingChip } from "./WorkflowHoleParts.js";
import {
  WORKFLOW_RUN_ENDED_KIND_ID,
  WorkflowCardHeader,
  workflowRunKindMessageId,
} from "./WorkflowCardChrome.js";
import { WorkflowArtifactStrip } from "./WorkflowArtifactStrip.js";
import {
  useWorkflowRunSettingsPopoverState,
  WorkflowRunSettingsPopover,
  type WorkflowRunSettingsHost,
} from "./WorkflowRunSettingsPopover.js";
import { timelineHeight, WorkflowTimeline } from "./WorkflowTimeline.js";
import { WorkflowTruncatedNotice } from "./WorkflowTruncatedNotice.js";

/** Running cards are expanded by default; there is no arrow, but they can still be collapsed. The title conveys state. */
export interface WorkflowRunDigestProps {
  name: string;
  runId: string;
  /** Initiating graph for this run (looked up by initiating toolCallId); absent means no phase line can be drawn because the row window did not include the initiating row. */
  graph: WorkflowCausalityGraphData | undefined;
  /** Name and type of a filled hole (from the fill-row input); the header uses these when the projection has no type. */
  holeLabels?: HoleLabels;
  /** Summary joined from the live projection. Missing means the run is absent from the projection (evicted by the eight-run limit or cold recovery found no journal entry): render a neutral one-line card — type label “Workflow finished,” with no light, track, Cancel, or Resume; keep only ⤢ (the side panel explains that live tracking ended). */
  summary: WorkflowRunCardSummary | undefined;
  /** Number of pending questions for this run; when > 0, show a warning-colored chip in the header. */
  pendingQuestions?: number;
  /** Open run details; absent means no ⤢, the chip is not clickable, and the “n more” line is static. If `landing` is present, the detail page lands on that station. Only that line supplies it; ⤢ and the question chip open the entire run. */
  onOpenRun?: (landing?: { phaseId: string }) => void;
  /** Resume this run; render Resume only when `summary.resumable` and the callback is present. */
  onResume?: () => void;
  /** Stop the run; render Stop only while running and when its callback is present. It shares one position with Resume because those states are mutually exclusive, showing the user both available paths directly on the card. */
  onCancel?: () => void;
  /** Click a pill to open that subagent’s transcript; without the handler, pills are not clickable. */
  onOpenPill?: (pill: TimelinePill) => void;
  /** Click the script pill to open its transcript at that station; without the handler, the script pill is not clickable. */
  onOpenWorkspace?: (pill: TimelinePill) => void;
  /** Click an artifact pill to open its artifact tab; without the handler, the pill is disabled. */
  onOpenArtifact?: (artifactId: string) => void;
  /** providerId → provider name (the host supplies this from the session model list; see useWorkflowSubagentModelProviderName). If absent, compose a name with the bare modelId. Never display providerId; for team plans it is a UUID. */
  subagentModelProviderName?: (providerId: string) => string | undefined;
  /** Host for the Configure dialog. When present, show Configure in the header; the host supplies it only when the callback exists and this run can be configured. */
  settingsHost?: WorkflowRunSettingsHost;
  /** testid suffix (unit.key + toolCallId). */
  testIdKey: string;
}

export function WorkflowRunDigest({
  graph,
  holeLabels,
  name,
  onOpenArtifact,
  onOpenPill,
  onOpenRun,
  onOpenWorkspace,
  onResume,
  onCancel,
  pendingQuestions = 0,
  runId,
  settingsHost,
  subagentModelProviderName,
  summary,
  testIdKey,
}: WorkflowRunDigestProps) {
  const { intl } = useZCodeIntl();
  const run = summary?.run;
  const [expanded, setExpanded] = useState(true);

  // Draw the phase track only when there is a live projection and graph; without a projection all lights are pending and a completed run would look like it never ran.
  const model = useMemo(
    () =>
      graph !== undefined && graph.steps.length > 0 && run !== undefined
        ? buildWorkflowTimeline(graph, run, holeLabels)
        : undefined,
    [graph, holeLabels, run],
  );
  const hasRail = model !== undefined && model.stations.length > 0;
  const shown = useMemo(
    () =>
      expanded || !model
        ? model
        : {
            ...model,
            stations: model.stations.map((station) => ({ ...station, pills: [] })),
          },
    [expanded, model],
  );
  // Removing the arrow does not disable collapse. Only blank card area toggles; child controls retain their own actions.
  const hitsControl = (target: EventTarget | null, root: HTMLElement) => {
    const control =
      target instanceof Element
        ? target.closest("button, a, input, textarea, select, [role='button']")
        : null;
    return control !== null && control !== root;
  };

  const format = intl.formatMessage.bind(intl);
  // Intentionally omit lineage on the card:
  // “Adjusted from / superseded by” appear only in details and confirmation dialogs; the card changes only the type label to avoid clutter.
  // The final segment of the detail string is the subagent model name (absent if no model was specified); show reasoning level and the canonical string in a tooltip.
  const cardDetail = workflowCardDetail(intl, model, graph, run, subagentModelProviderName);
  const live = summary?.status === "running";
  const kind = format({
    id: summary === undefined ? WORKFLOW_RUN_ENDED_KIND_ID : workflowRunKindMessageId(summary),
  });
  const questionsLabel =
    pendingQuestions > 0
      ? intl.formatPlural({ id: "chat.toolCall.workflow.digest.questions" }, pendingQuestions)
      : undefined;
  const questions =
    questionsLabel === undefined ? undefined : onOpenRun === undefined ? (
      <span
        className="wf-arrive flex shrink-0 items-center gap-1 rounded-full bg-[color-mix(in_oklab,var(--color-warning)_12%,transparent)] py-0.5 pl-1.5 pr-2 text-ui-xs font-medium text-warning"
        data-testid="workflow-digest-questions"
      >
        <MessageCircleQuestionIcon aria-hidden className="size-3" />
        {questionsLabel}
      </span>
    ) : (
      <button
        className="wf-arrive flex shrink-0 cursor-pointer items-center gap-1 rounded-full bg-[color-mix(in_oklab,var(--color-warning)_12%,transparent)] py-0.5 pl-1.5 pr-2 text-ui-xs font-medium text-warning outline-none transition-colors hover:bg-[color-mix(in_oklab,var(--color-warning)_20%,transparent)] focus-visible:ring-2 focus-visible:ring-ring/40"
        data-testid="workflow-digest-questions"
        onClick={() => onOpenRun()}
        type="button"
      >
        <MessageCircleQuestionIcon aria-hidden className="size-3" />
        {questionsLabel}
      </button>
    );
  // “{n} holes waiting to be filled” (docs/dynamic-workflow/presentation.md, “Holes on the timeline”):
  // pen chip in the issue-chip slot; both can appear at once. Clicking it opens the entire run.
  const holesWaiting = (run?.holes ?? []).filter((hole) => hole.state === "waiting").length;
  const leading =
    questions === undefined && holesWaiting === 0 ? undefined : (
      <>
        {questions}
        <HolesWaitingChip
          count={holesWaiting}
          {...(onOpenRun === undefined ? {} : { onOpen: () => onOpenRun() })}
        />
      </>
    );
  const resume =
    summary?.resumable === true && onResume !== undefined ? (
      <Button
        data-testid="workflow-digest-resume"
        onClick={onResume}
        size="default"
        type="button"
        variant="outline"
      >
        <RotateCcwIcon className="size-3.5" />
        {format({ id: "chat.toolCall.workflow.run.resume" })}
      </Button>
    ) : undefined;
  // Stop and Resume are mutually exclusive (running vs. stopped) and share the same position at the right of the header. They use the same command as the detail page.
  // After clicking Stop, disable the button as “Stopping…” until the projection changes status. Key it by status so a status change
  // remounts the button as a new instance (including cancelled → Resume → running).
  // Previously, an effect-driven setState on each status update queued another update after the synchronous projection-frame commit,
  // matching the trigger point of the workflow-card React #185 crash; key-based remount avoids the second commit.
  const cancel =
    live && onCancel !== undefined ? (
      <CancelRunButton key={summary?.status} onCancel={onCancel} />
    ) : undefined;
  // Configure appears before Resume/Stop and in the same place across every state, so it never shifts ⤢.
  const configure =
    settingsHost !== undefined && run !== undefined ? (
      <ConfigureRunButton host={settingsHost} run={run} />
    ) : undefined;

  return (
    <section
      aria-label={kind}
      className={cn(
        "wf-motion wf-arrive flex w-full min-w-0 flex-col gap-1 rounded-xl border border-border/70 bg-card/70 px-3.5 pb-2 pt-1.5 outline-none",
        hasRail && "cursor-pointer focus-visible:ring-2 focus-visible:ring-ring/40",
      )}
      data-expanded={hasRail ? String(expanded) : undefined}
      data-testid={testId(TID_CHAT_WORKFLOW_RUN_DIGEST, testIdKey)}
      data-workflow-run-digest="true"
      data-workflow-run-id={runId}
      data-workflow-run-status={summary?.status ?? "absent"}
      role={hasRail ? "button" : undefined}
      tabIndex={hasRail ? 0 : undefined}
      aria-expanded={hasRail ? expanded : undefined}
      onClick={(event) => {
        if (hasRail && !hitsControl(event.target, event.currentTarget))
          setExpanded((value) => !value);
      }}
      onKeyDown={(event) => {
        if (
          !hasRail ||
          hitsControl(event.target, event.currentTarget) ||
          (event.key !== "Enter" && event.key !== " ")
        )
          return;
        event.preventDefault();
        setExpanded((value) => !value);
      }}
    >
      <WorkflowCardHeader
        detail={cardDetail?.detail}
        {...(cardDetail?.title === undefined ? {} : { detailTitle: cardDetail.title })}
        expanded={expanded}
        kind={kind}
        leading={leading}
        live={live}
        name={name}
        trailing={
          configure === undefined ? (
            (resume ?? cancel)
          ) : (
            <>
              {configure}
              {resume ?? cancel}
            </>
          )
        }
        {...(onOpenRun === undefined ? {} : { onOpenDetails: () => onOpenRun() })}
      />
      {shown === undefined || !hasRail ? null : (
        // When collapsed, hide only agents; retain the phase track as a progress overview.
        <div
          className={cn("wf-digest-plot overflow-hidden")}
          data-testid="workflow-digest-plot"
          style={{ height: timelineHeight(shown) + 8 }}
        >
          <WorkflowTimeline
            className="py-1"
            model={shown}
            {...(onOpenPill === undefined ? {} : { onOpenPill })}
            {...(onOpenWorkspace === undefined ? {} : { onOpenWorkspace })}
            {...(onOpenRun === undefined
              ? {}
              : {
                  onOpenMore: (station) => onOpenRun({ phaseId: station.id }),
                  // Fill header: open the side pane and focus the first station it wrote (that station's phase header is the fill title).
                  onOpenFill: (fill) => {
                    const first = shown.stations[fill.from];
                    if (first !== undefined) onOpenRun({ phaseId: first.id });
                  },
                })}
          />
        </div>
      )}
      {/* The line under the timeline (“Showing details for n/m steps”) clarifies that the header count is the full step count and this line counts only the details displayed. It remains visible when collapsed because it explains the numbers above, not the pills. A card with no track (initiating row absent from the window) is a single line by design and has no count to qualify, so omit this line too. */}
      {hasRail ? <WorkflowTruncatedNotice run={run} testId="workflow-digest-truncated" /> : null}
      {/* Artifact strip (appendix to the artifact pills): run deliverables remain visible in both collapsed and expanded states because they are the most useful receipt. */}
      {run?.artifacts !== undefined && run.artifacts.length > 0 ? (
        <WorkflowArtifactStrip
          artifacts={run.artifacts}
          className="pb-0.5 pt-0.5"
          moreTestId="workflow-digest-artifacts-more"
          pillTestId="workflow-digest-artifact"
          testId="workflow-digest-artifacts"
          {...(onOpenArtifact === undefined ? {} : { onOpenArtifact })}
        />
      ) : null}
    </section>
  );
}

/** Configure button in the header: a ghost slider icon (`icon-md`), matching Stop; the header cannot fit a labeled button. Clicking opens the Configure dialog below it. */
function ConfigureRunButton({
  host,
  run,
}: {
  host: WorkflowRunSettingsHost;
  run: WorkflowRunState;
}) {
  const { intl } = useZCodeIntl();
  const { anchorRef, open, setOpen, toggleFrom } = useWorkflowRunSettingsPopoverState();
  const label = intl.formatMessage({ id: "chat.toolCall.workflow.run.settings.title" });
  return (
    <>
      <ControlHintTooltip title={label} side="top">
        <Button
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label={label}
          data-testid="workflow-digest-configure"
          onClick={(event) => toggleFrom(event.currentTarget)}
          size="icon-md"
          type="button"
          variant="ghost"
        >
          <SlidersHorizontalIcon className="size-3.5" />
        </Button>
      </ControlHintTooltip>
      <WorkflowRunSettingsPopover
        anchorRef={anchorRef}
        host={host}
        onOpenChange={setOpen}
        open={open}
        run={run}
      />
    </>
  );
}

/** Stop button in the header: same form as ⤢ details (ghost icon button + tooltip, no label because the header cannot fit one). “Stopping” is a local state; the host keys it by run status, so a status change remounts it and resets naturally. Tooltip second line: “You can resume after stopping; completed steps are preserved.” After changing the action from “Cancel” to “Stop,” explain at the moment of clicking that stopping does not discard the run and that it can be resumed. Hide the sentence while stopping—the decision has been made and no further persuasion is useful. */
function CancelRunButton({ onCancel }: { onCancel: () => void }) {
  const { intl } = useZCodeIntl();
  const [cancelling, setCancelling] = useState(false);
  const label = intl.formatMessage({
    id: cancelling ? "chat.toolCall.workflow.run.cancelling" : "chat.toolCall.workflow.run.cancel",
  });
  return (
    <ControlHintTooltip
      title={label}
      side="top"
      {...(cancelling
        ? {}
        : {
            description: intl.formatMessage({ id: "chat.toolCall.workflow.run.stopHint" }),
          })}
    >
      <Button
        aria-label={label}
        data-testid="workflow-digest-cancel"
        disabled={cancelling}
        onClick={() => {
          setCancelling(true);
          onCancel();
        }}
        size="icon-md"
        type="button"
        variant="ghost"
      >
        <SquareIcon className="size-3.5 fill-current" />
      </Button>
    </ControlHintTooltip>
  );
}
