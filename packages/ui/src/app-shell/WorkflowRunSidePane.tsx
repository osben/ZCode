import { memo, useCallback, useEffect, useMemo, useState } from "react";
import type {
  WorkflowRunArtifactSummary,
  WorkflowRunPendingQuestion,
} from "@zcode/shared/zcode-protocol-v4";
import { buildWorkflowTimeline } from "@/components/workflow-timeline/timeline-model.js";
import { workflowSubagentModelCardLabel } from "@/components/workflow-timeline/subagent-model-label.js";
import { workflowSummaryParts } from "@/components/workflow-timeline/timeline-summary.js";
import { WorkflowRunArtifactsSection } from "@/app-shell/WorkflowRunArtifactsSection.js";
import { WorkflowRunPhaseList } from "@/app-shell/WorkflowRunPhaseList.js";
import { WorkflowRunProvenance } from "@/app-shell/WorkflowRunProvenance.js";
import {
  WorkflowRunResultSections,
  WorkflowRunStatusHeader,
} from "@/app-shell/WorkflowRunSidePaneSections.js";
import {
  useWorkflowRunPaneSettings,
  workflowRunTabScope,
} from "@/app-shell/useWorkflowRunPaneSettings.js";
import { WorkflowRunSettingsPopover } from "@/components/workflow-timeline/WorkflowRunSettingsPopover.js";
import { WorkflowRunPaneSaveSlots } from "@/app-shell/WorkflowRunPaneSaveSlots.js";
import { resolveWorkflowLaunchProvenance } from "@/app-shell/workflowRunLaunchProvenance.js";
import {
  describeWorkflowRunActionRejection,
  workflowRunActionRejectionMessageId,
  type WorkflowRunAction,
  type WorkflowRunActionRejection,
} from "@/app-shell/workflowRunActionRejection.js";
import { useWorkflowSubagentModelProviderName } from "@/hooks/useWorkflowSubagentModelProviderName.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type {
  OpenScopedWorkflowActorSessionSideTabRequest,
  OpenScopedWorkflowArtifactSideTabRequest,
  OpenScopedWorkflowRunSideTabRequest,
  OpenScopedWorkflowWorkspaceSideTabRequest,
  WorkflowRunSidePaneTab,
} from "@/lib/workspaceSidePane.js";
import { logger } from "@/logger.js";
import {
  isWorkflowRunCancellable,
  isWorkflowRunResumable,
  workflowRunResultView,
  type WorkflowActorInstance,
} from "@/app-shell/workflowRunPanel.js";
import { useDynamicWorkflowAvailability } from "@/hooks/useDynamicWorkflowAvailability.js";
import { useWorkflowRunArtifacts } from "@/hooks/useWorkflowRunArtifacts.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import {
  buildWorkflowFillGraphByRunId,
  buildWorkflowGraphByToolCallId,
  resolveWorkflowRunGraphForRun,
} from "@/v4/workflowRunCardJoin.js";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import { useConversationProjection } from "@/v4/useConversationProjection.js";
import { useV4Conversation, V4PaneConversationProvider } from "@/v4/V4ConversationContext.js";

/** Stable reference to an empty list: the pendingQuestions key **comes and goes** (the whole key disappears when a question is answered), so an unstable empty reference would needlessly rerender memoized children every time. */
const EMPTY_QUESTIONS: readonly WorkflowRunPendingQuestion[] = [];
/** Same here. The `artifacts` key is absent when there are no artifacts, and it is one of the artifact hook’s journal-requery dependencies. */
const EMPTY_ARTIFACTS: readonly WorkflowRunArtifactSummary[] = [];

const WorkflowRunContent = memo(function WorkflowRunContent({
  tab,
  onOpenWorkflowActorSession,
  onOpenWorkflowArtifact,
  onOpenWorkflowRun,
  onOpenWorkflowWorkspace,
}: {
  tab: WorkflowRunSidePaneTab;
  onOpenWorkflowActorSession?: (request: OpenScopedWorkflowActorSessionSideTabRequest) => void;
  onOpenWorkflowArtifact?: (request: OpenScopedWorkflowArtifactSideTabRequest) => void;
  /** “Replaced by run X” → details tab for the successor run. */
  onOpenWorkflowRun?: (request: OpenScopedWorkflowRunSideTabRequest) => void;
  /** Script row on the spine → script transcript tab, at this station. */
  onOpenWorkflowWorkspace?: (request: OpenScopedWorkflowWorkspaceSideTabRequest) => void;
}) {
  const { intl } = useZCodeIntl();
  const { layer, sendCommand } = useV4Conversation();
  const [lease, setLease] = useState<SessionLease | null>(null);

  // The details page resubscribes to the **parent session** projection (as in PlanDetailSidePane): runtime state is the parent session’s authoritative projection,
  // not a local query cache in this panel.
  useEffect(() => {
    const nextLease = layer.acquire(tab.parentSessionId);
    setLease(nextLease);
    return () => nextLease.release();
  }, [layer, tab.parentSessionId]);
  const state = useConversationProjection(lease);
  const snapshot = state.snapshot;
  // Workspace scope from the open request (shared by actor/script/artifact/successor tabs).
  const { remoteSessionId, workspaceIdentity, workspacePath } = tab;
  const tabScope = useMemo(
    () => workflowRunTabScope({ remoteSessionId, workspaceIdentity, workspacePath }),
    [remoteSessionId, workspaceIdentity, workspacePath],
  );

  const run = useMemo(
    () => snapshot?.workflowRuns?.runs.find((candidate) => candidate.runId === tab.runId),
    [snapshot?.workflowRuns, tab.runId],
  );
  // The successor (`run.supersededBy`) must be in the projection and carry its own initiating-row ID to open: the toolCallId in the request is
  // the key the details page uses to find the graph; an incorrect value shows “graph not found in history” on the successor details page.
  const successor = useMemo(() => {
    const supersededBy = run?.supersededBy;
    if (supersededBy === undefined) return undefined;
    const candidate = snapshot?.workflowRuns?.runs.find((item) => item.runId === supersededBy);
    return candidate?.toolCallId === undefined ? undefined : candidate;
  }, [run?.supersededBy, snapshot?.workflowRuns]);
  const handleOpenSuccessor = useCallback(() => {
    if (successor?.toolCallId === undefined) return;
    onOpenWorkflowRun?.({
      ...tabScope,
      parentSessionId: tab.parentSessionId,
      toolCallId: successor.toolCallId,
      runId: successor.runId,
      ...(tab.workflowName ? { workflowName: tab.workflowName } : {}),
    });
  }, [onOpenWorkflowRun, successor, tab.parentSessionId, tab.workflowName, tabScope]);

  // Resolve the static graph by **initiating toolCallId**: it uses the same table as the run card at the end of a turn,
  // and the script transcript—either a CreateWorkflow tool row or direct-launch metadata may own the graph. The row window is
  // bounded, so an initiating row missing from an old conversation is normal, not an error; there is no graph to show then.
  // A run created by a “Settings” revision borrows the predecessor’s graph until the settings turn is recorded (see resolveWorkflowRunGraph for the rule and rationale).
  // For a completed run, use the effective workflow graph from its latest completion row (docs/dynamic-workflow/presentation.md, “Holes on the timeline”).
  const { graph, holeLabels } = useMemo(() => {
    const fills = buildWorkflowFillGraphByRunId(snapshot?.rows.window);
    const graphs = buildWorkflowGraphByToolCallId(snapshot?.rows.window);
    const runs = snapshot?.workflowRuns?.runs;
    return {
      graph: resolveWorkflowRunGraphForRun(graphs, fills, tab.toolCallId, tab.runId, runs),
      holeLabels: fills.get(tab.runId)?.holeLabels,
    };
  }, [snapshot?.rows.window, snapshot?.workflowRuns, tab.runId, tab.toolCallId]);

  // Provenance for a directly launched run: scope, description, arguments, and
  // “launched by you from the workflow hub.” Present only for hub-launched runs; runs launched through a tool path have no such section.
  const provenance = useMemo(
    () => resolveWorkflowLaunchProvenance(snapshot?.rows.window, tab.toolCallId),
    [snapshot?.rows.window, tab.toolCallId],
  );

  // One model, three consumers: both the roster and summary row start from it.
  const model = useMemo(
    () => (graph === undefined ? undefined : buildWorkflowTimeline(graph, run, holeLabels)),
    [graph, holeLabels, run],
  );
  // Subagent model: remove the chip from the first status-header row,
  // and make the model name the first segment of the summary row—the row already represents “the key figures for this run.” Put thinking level and canonical ID in the tooltip.
  const subagentModelProviderName = useWorkflowSubagentModelProviderName(
    tab.workspacePath,
    tab.workspaceIdentity,
  );
  const subagentModel = useMemo(
    () =>
      workflowSubagentModelCardLabel(run?.subagentModel, {
        formatMessage: intl.formatMessage.bind(intl),
        ...(subagentModelProviderName === undefined
          ? {}
          : { providerName: subagentModelProviderName }),
      }),
    [intl, run?.subagentModel, subagentModelProviderName],
  );
  const summaryParts = useMemo(
    () =>
      model === undefined || run === undefined
        ? undefined
        : workflowSummaryParts(
            intl,
            model,
            run,
            subagentModel === undefined ? {} : { subagentModelName: subagentModel.name },
          ),
    [intl, model, run, subagentModel],
  );

  const cancellable = isWorkflowRunCancellable(run);
  // Most recently rejected Cancel / Resume. The hint no longer applies when run state
  // changes (actually cancelled / resumed / settlement added by cold replay), so clear it as the state changes. This means a “change,” not merely
  // “different from before”: if the state cycles back to its original value, the old hint still must not reappear.
  const [rejection, setRejection] = useState<WorkflowRunActionRejection | undefined>(undefined);
  const runStatus = run?.status;
  useEffect(() => {
    setRejection(undefined);
  }, [runStatus]);
  const recordAck = useCallback(
    (action: WorkflowRunAction, ack: Parameters<typeof describeWorkflowRunActionRejection>[1]) => {
      const next = describeWorkflowRunActionRejection(action, ack);
      setRejection(next);
      if (next !== undefined) {
        logger.warn(`[workflow-run] ${action} 被拒绝`, {
          reasonCode: ack.reasonCode,
          runId: tab.runId,
          status: ack.status,
        });
      }
    },
    [tab.runId],
  );
  const rejectionView = useMemo(() => {
    if (rejection === undefined) return undefined;
    return {
      text: intl.formatMessage(
        { id: workflowRunActionRejectionMessageId(rejection) },
        { code: rejection.code },
      ),
      ...(rejection.message === undefined ? {} : { detail: rejection.message }),
    };
  }, [intl, rejection]);

  const handleCancel = useCallback(() => {
    // Cancellation has one path: the existing v4 cancelBackgroundWork {workId ≡ runId}.
    void sendCommand(
      createCommandEnvelope({
        type: "cancelBackgroundWork",
        payload: { workId: tab.runId },
        sessionId: tab.parentSessionId,
      }),
    ).then((ack) => recordAck("cancel", ack));
  }, [recordAck, sendCommand, tab.parentSessionId, tab.runId]);

  // Resume availability reads only the `resumable` bit from the projection:
  // after restart, the CLI cold replay fills in the projection, so do not query the journal summary again here.
  //
  // Add another rollout gate: render existing runs normally
  // (status header, timeline, and all artifacts), but hide Resume because clicking it starts an engine.
  // If the snapshot is not ready, enabled is false and treated as a miss: show the button a moment late rather than show one that may disappear.
  const { enabled: dynamicWorkflowEnabled } = useDynamicWorkflowAvailability();
  const resumable = isWorkflowRunResumable(run) && dynamicWorkflowEnabled;
  // “Settings” uses the same rollout gate as Resume;
  // when accepted, the panel follows the workflow to the new run (useWorkflowRunPaneSettings).
  const settings = useWorkflowRunPaneSettings({
    enabled: dynamicWorkflowEnabled,
    run,
    runs: snapshot?.workflowRuns?.runs,
    sendCommand,
    sessionConfig: snapshot?.sessionId === tab.parentSessionId ? snapshot?.config : undefined,
    tab,
    ...(onOpenWorkflowRun === undefined ? {} : { onOpenWorkflowRun }),
  });
  const handleResume = useCallback(() => {
    // resume is a new v4 command (like cancel, it does not include baseRevision); workId ≡ runId.
    // `name` supplies the subject for the completion notification after resume; the original tool input is unavailable after restart, so the tab display name is the only source.
    void sendCommand(
      createCommandEnvelope({
        type: "resumeWorkflowRun",
        payload: {
          workId: tab.runId,
          ...(tab.workflowName?.trim() ? { name: tab.workflowName.trim() } : {}),
        },
        sessionId: tab.parentSessionId,
      }),
    ).then((ack) => {
      recordAck("resume", ack);
      // After acceptance, the live projection returns to running on run-started, and the reducer removes resumable so the button closes naturally.
    });
  }, [recordAck, sendCommand, tab.parentSessionId, tab.runId, tab.workflowName]);

  const handleOpenActor = useCallback(
    (instance: WorkflowActorInstance) => {
      onOpenWorkflowActorSession?.({
        ...tabScope,
        parentSessionId: tab.parentSessionId,
        runId: tab.runId,
        ...(instance.sessionId ? { actorSessionId: instance.sessionId } : {}),
        siteId: instance.siteId,
        ordinal: instance.ordinal,
        ...(instance.name ? { actorName: instance.name } : {}),
      });
    },
    [onOpenWorkflowActorSession, tab.parentSessionId, tab.runId, tabScope],
  );

  // Script transcript: mirrors actor transcript; rows provide only the stage ID, and scope/run identity are added here.
  const handleOpenWorkspace = useCallback(
    (phaseId: string) => {
      onOpenWorkflowWorkspace?.({
        ...tabScope,
        parentSessionId: tab.parentSessionId,
        toolCallId: tab.toolCallId,
        runId: tab.runId,
        ...(tab.workflowName ? { workflowName: tab.workflowName } : {}),
        phaseId,
      });
    },
    [
      onOpenWorkflowWorkspace,
      tab.parentSessionId,
      tab.runId,
      tab.toolCallId,
      tab.workflowName,
      tabScope,
    ],
  );

  // Destination: recreate it on every open. `openedAt` changes each time, so opening the same stage again
  // also changes the key and writes the manifest again.
  const landing = useMemo(
    () =>
      tab.focusPhaseId === undefined
        ? undefined
        : { key: `${tab.focusPhaseId}@${tab.openedAt ?? 0}`, phaseId: tab.focusPhaseId },
    [tab.focusPhaseId, tab.openedAt],
  );

  // Artifacts. The live projection contains metadata for only the latest version, while the spec and version history are in
  // the journal, so the hook reads both. If `run` is absent from the projection (cold recovery / evicted by the 8-run limit),
  // `live` is absent and the entire manifest comes from the journal.
  const { artifacts } = useWorkflowRunArtifacts({
    sessionId: tab.parentSessionId,
    runId: tab.runId,
    ...(run === undefined ? {} : { live: run.artifacts ?? EMPTY_ARTIFACTS }),
  });
  const handleOpenArtifact = useCallback(
    (artifactId: string) => {
      // The card sends only the intent (which artifact); session and workspace identity are added here, just as for actor transcript:
      // the card is scope-agnostic. **No version number**: opening always shows the latest version.
      //
      // This manifest combines the live projection and journal, so it contains both `contentType` and `sourcePath`:
      // the former lets the host open HTML artifacts directly in a browser tab; the latter saves the host another journal lookup.
      const artifact = artifacts.find((candidate) => candidate.id === artifactId);
      onOpenWorkflowArtifact?.({
        ...tabScope,
        parentSessionId: tab.parentSessionId,
        runId: tab.runId,
        artifactId,
        ...(artifact?.title === undefined ? {} : { title: artifact.title }),
        ...(artifact?.contentType === undefined ? {} : { contentType: artifact.contentType }),
        ...(artifact?.sourcePath === undefined ? {} : { sourcePath: artifact.sourcePath }),
      });
    },
    [artifacts, onOpenWorkflowArtifact, tab.parentSessionId, tab.runId, tabScope],
  );

  const result = workflowRunResultView(run);
  const pendingQuestions = run?.pendingQuestions ?? EMPTY_QUESTIONS;
  const runTitle = tab.workflowName?.trim() || intl.formatMessage({ id: "sidePane.workflowRun" });

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-background"
      data-workflow-run-id={tab.runId}
      data-workflow-run-status={run?.status ?? "absent"}
    >
      {/* “Save / Run again” (docs/dynamic-workflow/transcript-and-notifications.md, “Saving the run, and running it again”): the same controller drives this pane and the completion card, so both use the same wording for a given run. */}
      <WorkflowRunPaneSaveSlots rows={snapshot?.rows.window} run={run} tab={tab}>
        {(slots) => (
          <WorkflowRunStatusHeader
            cancellable={cancellable}
            configureOpen={settings.popover.open}
            onCancel={handleCancel}
            {...(settings.configurable ? { onConfigureFrom: settings.popover.toggleFrom } : {})}
            {...(onOpenWorkflowRun === undefined || successor === undefined
              ? {}
              : { onOpenSuccessor: handleOpenSuccessor })}
            onResume={handleResume}
            {...(rejectionView === undefined ? {} : { rejection: rejectionView })}
            resumable={resumable}
            run={run}
            saveSlots={slots}
            {...(subagentModel === undefined ? {} : { subagentModel })}
            summaryParts={summaryParts}
            title={runTitle}
            usage={run?.usage}
          />
        )}
      </WorkflowRunPaneSaveSlots>

      {run === undefined || !settings.configurable ? null : (
        <WorkflowRunSettingsPopover
          anchorRef={settings.popover.anchorRef}
          host={settings.host}
          onAccepted={settings.onAccepted}
          onOpenChange={settings.popover.setOpen}
          open={settings.popover.open}
          run={run}
        />
      )}

      {provenance === undefined ? null : (
        <WorkflowRunProvenance
          meta={provenance.meta}
          {...(subagentModelProviderName === undefined
            ? {}
            : { providerName: subagentModelProviderName })}
          {...(provenance.startedAt === undefined ? {} : { startedAt: provenance.startedAt })}
        />
      )}

      <WorkflowRunResultSections result={result} />

      {/*
       * Stage list: read the timeline as a vertical list,
       *           with upgrade questions under the row for the asker. If the source row is unavailable (older conversations cannot locate it), show “Diagram unavailable.”
       */}
      {graph !== undefined && model !== undefined ? (
        <WorkflowRunPhaseList
          graph={graph}
          model={model}
          pendingQuestions={pendingQuestions}
          run={run}
          {...(onOpenWorkflowActorSession === undefined ? {} : { onOpenActor: handleOpenActor })}
          {...(onOpenWorkflowWorkspace === undefined
            ? {}
            : { onOpenWorkspace: handleOpenWorkspace })}
          {...(landing === undefined ? {} : { landing })}
          {...(subagentModelProviderName === undefined ? {} : { subagentModelProviderName })}
        />
      ) : (
        <p
          className="flex-1 px-4 py-3 text-ui-xs text-foreground-subtle"
          data-testid="workflow-run-graph-unavailable"
        >
          {intl.formatMessage({ id: "chat.toolCall.workflow.run.graph.unavailable" })}
        </p>
      )}

      {/*
       * Artifacts section: outputs delivered to the **user** by the script through `artifact.*`. It is the panel's last section and expanded by default because
       *           these are the run's deliverables and the most common reason for opening the panel. Omit the section when empty; render it for failed and canceled
       *           runs too (a run that stopped at step 12 may still have delivered a PDF). The `report` entry,
       *           event log, and raw script sections were removed because they are technical details for the model and CLI.
       */}
      {artifacts.length === 0 ? null : (
        <WorkflowRunArtifactsSection
          artifacts={artifacts}
          runId={tab.runId}
          sessionId={tab.parentSessionId}
          {...(onOpenWorkflowArtifact === undefined ? {} : { onOpenArtifact: handleOpenArtifact })}
        />
      )}
    </div>
  );
});

/**
 * Workflow run detail page.
 *
 * The detail page handles usage, controls, and deliverables. The diagram itself returned to the tool card in chat; here we render a vertical list
 * from the same timeline model. It **does not reproduce** the card's bounded display: everything outside the diagram reads the authoritative `workflowRuns` projection,
 * while the artifact manifest reads directly from the journal.
 *
 * The panel shows only what the **user** needs. The `report`, event log, and raw script sections
 * have been removed because they are technical details for the model and CLI, not the person using this panel.
 * Journal reads are unchanged (event queries and report rows remain); only their display here was removed.
 */
export const WorkflowRunSidePane = memo(function WorkflowRunSidePane({
  tab,
  onOpenWorkflowActorSession,
  onOpenWorkflowArtifact,
  onOpenWorkflowRun,
  onOpenWorkflowWorkspace,
}: {
  tab: WorkflowRunSidePaneTab;
  /** Subagent row → actor transcript tab. By default, the row is not clickable. */
  onOpenWorkflowActorSession?: (request: OpenScopedWorkflowActorSessionSideTabRequest) => void;
  /** Artifact card → full-size viewer tab. By default, the card is not clickable. */
  onOpenWorkflowArtifact?: (request: OpenScopedWorkflowArtifactSideTabRequest) => void;
  /** “Replaced by run X” → detail tab for the successor run. By default, the row is static text. */
  onOpenWorkflowRun?: (request: OpenScopedWorkflowRunSideTabRequest) => void;
  /** Script row → script transcript tab at that stage. By default, the row is not clickable. */
  onOpenWorkflowWorkspace?: (request: OpenScopedWorkflowWorkspaceSideTabRequest) => void;
}) {
  const scope = useMemo<PaneWorkspaceScope>(
    () => ({
      workspacePath: tab.workspacePath,
      ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
    }),
    [tab.remoteSessionId, tab.workspaceIdentity, tab.workspacePath],
  );

  return (
    <V4PaneConversationProvider scope={scope}>
      <WorkflowRunContent
        tab={tab}
        {...(onOpenWorkflowActorSession === undefined ? {} : { onOpenWorkflowActorSession })}
        {...(onOpenWorkflowWorkspace === undefined ? {} : { onOpenWorkflowWorkspace })}
        {...(onOpenWorkflowArtifact === undefined ? {} : { onOpenWorkflowArtifact })}
        {...(onOpenWorkflowRun === undefined ? {} : { onOpenWorkflowRun })}
      />
    </V4PaneConversationProvider>
  );
});
