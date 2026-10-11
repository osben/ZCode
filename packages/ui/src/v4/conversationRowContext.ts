// Host-injected context for v4 row rendering (required to reconnect ai-elements / ToolCallBlocks).
// Injection follows PermissionDialog (decoupled from store): display components do not read stores themselves.
// The host (SessionPane) reads theme/codePreviewSettings and passes them down as stable props.
import type { CodePreviewSettings } from "@/lib/codePreviewSettings.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { AssistantPreviewCardsAutoOpenRequest } from "@/lib/assistantPreviewCards.js";
import type { OpenAutomationsMain } from "@/lib/taskNavigationHistory.js";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import type { WorkflowRunSettingsChange } from "@/components/workflow-timeline/workflowRunSettings.js";
import type { WorkflowDraftPosition, WorkflowRunCardSummary } from "@/ToolCallBlocks/shared.js";
import type { WorkflowFillGraph } from "@/v4/workflowRunCardJoin.js";
import type { Theme } from "@/useTheme.js";
import type { ModelSelectionView } from "@zcode/services";
import type { ZCodeWorkflowsForRunCandidate } from "@zcode/shared";
import type { ConversationAttachmentReadParams, ConversationTransport } from "@/v4/transport.js";
import type {
  OpenPlanDetailSideTabRequest,
  OpenWorkflowActorSessionSideTabRequest,
  OpenWorkflowArtifactSideTabRequest,
  OpenWorkflowRunSideTabRequest,
  OpenWorkflowWorkspaceSideTabRequest,
  OpenSubagentSideTabRequest,
} from "@/lib/workspaceSidePane.js";
import type {
  CommandAck,
  ConversationRowTarget,
  TurnHeaderRow,
  V4ConversationFileChangesResult,
  V4ConversationFileRewindPreviewResult,
} from "@zcode/shared/zcode-protocol-v4";

export type ConversationFileChangesState = Exclude<
  NonNullable<TurnHeaderRow["fileChanges"]>["state"],
  undefined
>;

export interface ConversationRowRenderContext {
  logEpoch?: string;
  workspacePath: string;
  /** User Home for the current workspace Host, used to resolve ~/ paths in Assistant output. */
  workspaceHomePath?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  /** Same model-selection view that SessionPane reads from the target Host. */
  modelSelectionView?: ModelSelectionView | null;
  theme: Theme;
  /** Keep this reference stable (used by memoization in MessageResponse/ToolCallBlock). */
  codePreviewSettings: CodePreviewSettings;
  /** Parent session bound to the current pane; the right-side subagent tab uses it to group by parent task. */
  sessionId?: string | null;
  /** Top-level session in the current drill-down tree; detail tabs group across nested levels by this ID. */
  rootSessionId?: string | null;
  /** @deprecated Legacy inline drill-down marker; new child sessions open in the side-panel detail view. */
  inSubagentDrilldown?: boolean;
  /** Compact mobile /remote mode: hide the external-app dropdown and keep only in-app preview. */
  compactForRemoteControl?: boolean;
  /** Current session is compacting or verifying a goal; dedicated status UI owns progress feedback. */
  chatLoadingBlockedByActiveWork?: boolean;
  /** Current session is waiting for permission confirmation or an AskUserQuestion response; hide ChatLoading at the bottom. */
  chatLoadingBlockedByInteraction?: boolean;
  /** Standard setting: whether to render reasoning/thought rows in the conversation stream. */
  messageStreamShowReasoning?: boolean;
  /** First reasoning row in the current assistant turn; still show it when full thinking is disabled. */
  messageStreamFirstReasoningRowId?: number;
  /** Standard setting: whether to render Todo tool cards in the conversation stream. */
  messageStreamShowTodos?: boolean;
  /** Standard setting: whether to aggregate consecutive Explore-compatible tools. */
  toolGroupingExploreEnabled?: boolean;
  /** Standard setting: whether to aggregate consecutive non-read-only Shell tools. */
  toolGroupingTerminalEnabled?: boolean;
  /** Standard setting: whether to aggregate consecutive file-writing tools. */
  toolGroupingChangesEnabled?: boolean;
  /** Tier 1 fork navigation: switch the current pane to the target session (forkNotice → parent session, reusing onSessionCreated for an in-place switch). rowId is reserved for Tier 2 precise scrolling; currently forkNotice.parentRowId is always the placeholder 0 and is ignored. Keep this reference stable (rowContext memo depends on it). */
  onNavigateToRow?: (sessionId: string, rowId: number) => void;
  /** Assistant Preview Cards: Website-card preview entry point; app shell injects side-pane behavior. */
  onOpenBrowserUrl?: (url: string) => void;
  onOpenAutomationsMain?: OpenAutomationsMain;
  /** Assistant Preview Cards: Markdown/file-card preview entry point; app shell injects code-viewer behavior. */
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  /** Desktop completed-state PPTX: shell atomically creates multiple right-side Preview Tabs. */
  onAutoOpenAssistantPptx?: (request: AssistantPreviewCardsAutoOpenRequest) => void;
  /** Locks the specific turn when the current renderer observes running → completedSuccess. */
  assistantPreviewPptxAutoOpenTarget?: { turnId: string; key: string } | null;
  /** Assistant Markdown local-file-link entry point; shell stats paths centrally and routes to preview or file tree. */
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenSubagentSession?: (request: OpenSubagentSideTabRequest) => void;
  onOpenPlanDetail?: (request: OpenPlanDetailSideTabRequest) => void;
  /** Plugin UI: open inline-card requests in the side pane; RowView adds parentSessionId and workspace fields. */
  onOpenWorkflowRun?: (request: OpenWorkflowRunSideTabRequest) => void;
  /** Full-size artifact-view tab entry point. Terminology: artifact here is user-facing output published by scripts through `artifact.*`, not the engine-internal value returned by a script’s top level. Like `onOpenWorkflowRun`, the row reports only intent (which run and artifact); the host supplies session and workspace identity. No version is included—the chip means “show me this artifact,” and always opens the latest version. */
  onOpenWorkflowArtifact?: (request: OpenWorkflowArtifactSideTabRequest) => void;
  /** Cancel background work (`cancelBackgroundWork{workId}`); the host binds dispatchCommand + sessionId. The turn-tail run card uses this for “Stop run”: runId ≡ workId and shares the cancellation path with the detail side panel/task list. Notification rows are terminal and need no cancel entry, so they omit this context capability. The run card is the first transcript row to show a stop button while running, so this optional field was added. In read-only sessions, SessionPane omits it and the whole card has no cancel action. */
  onCancelBackgroundWork?: (workId: string) => void;
  /** Resume in the tool-card footer uses the same v4 `resumeWorkflowRun {workId ≡ runId}` path as the detail page. The host omits it for read-only sessions. */
  onResumeWorkflowRun?: (workId: string, name?: string) => void;
  /** “Configure” on a run card invokes v4 `amendWorkflowRunSettings {workId ≡ runId, ...changed settings}` and returns the ACK so the dialog can display rejection reasons. It shares the same two gates as Resume (read-only and rollout); when omitted, the card has no Configure action. */
  onAmendWorkflowRunSettings?: (
    workId: string,
    change: WorkflowRunSettingsChange,
  ) => Promise<CommandAck>;
  /**
   * “Save”/“Run again” on the completion card (docs/dynamic-workflow/transcript-and-notifications.md,
   * “Saving the run, and running it again”): send the user message written by the GUI into this
   * session and let ZCode distill and save it. Uses the same two gates as Resume (read-only and
   * rollout) and the **same entry point**—writing the file and starting the engine are both handled
   * where Resume is handled. When absent, the card shows only the “Saved” chip as a fact.
   */
  onSendWorkflowSaveRequest?: (text: string) => Promise<void>;
  /**
   * runId → SaveWorkflow candidates in the transcript that claimed this run
   * (`workflowRunCardJoin.buildWorkflowSaveCandidatesByRunId`), built by the host in one pass over
   * the row window. This is the only link between the definition saved under a separate model-chosen
   * name and this run (the model does not use the run name as the workflow name), so it must come from the transcript.
   */
  workflowSaveCandidatesByRunId?: ReadonlyMap<string, readonly ZCodeWorkflowsForRunCandidate[]>;
  /** Current session model (name shown as the first “Session model” option in the Configure dialog); omit if unavailable, in which case the option only says “Session model”. */
  workflowSessionModel?: { providerId: string; modelId: string };
  /** Subagent pill on a tool card opens that subagent’s transcript tab, using the same path as the detail-page subagent row; the host supplies workspace identity. */
  onOpenWorkflowActor?: (request: OpenWorkflowActorSessionSideTabRequest) => void;
  /** Script pill on a tool card opens the transcript tab for that run’s script; uses the same path as the detail-page timeline script row, with workspace identity supplied by the host. */
  onOpenWorkflowWorkspace?: (request: OpenWorkflowWorkspaceSideTabRequest) => void;
  /** Lookup from CreateWorkflow tool calls to workflow-run summaries, built by the host from the `workflowRuns` projection. Resolve run identity from the projection, not tool output: `workflowRunSchema.toolCallId` exists specifically for this join (the correlation key from “tool card → detail page”). In v4, the tool-row output is only a sentence, and `formatModelContent` drops structured `status`/`backgroundTaskId` fields. Values include status and step counts, not just runId: on a match the card becomes a compact clickable run card, which needs live status text and progress, so compute them in one join (`workflowRunCardJoin.ts`). */
  workflowRunByToolCallId?: ReadonlyMap<string, WorkflowRunCardSummary>;
  /** Lookup keyed by runId (`workflowRunCardJoin.buildWorkflowRunByRunId`). Used by ResumeWorkflowRun tool rows: the projection’s `run.toolCallId` retains the original CreateWorkflow row across resumes by design, so a resume row can never find it by toolCallId. Its display payload does carry runId, so join it to the same projection by runId. */
  workflowRunByRunId?: ReadonlyMap<string, WorkflowRunCardSummary>;
  /** Set of question IDs currently pending for each runId, built by the host from the live projection only (no journal fallback) using `workflowRunCardJoin.buildWorkflowRunPendingQuestionsByRunId`. Workflow notification manifest upgrade entries use it to change Waiting → Answered: a key means the run exists in the live projection; a value containing qid means Waiting, without qid means Answered, and no key means the run is absent (neutral Question). */
  workflowRunPendingQuestionsByRunId?: ReadonlyMap<string, ReadonlySet<string>>;
  /** Static graph for each initiating toolCallId (`workflowRunCardJoin.buildWorkflowGraphByToolCallId`), built by the host from the row window. The graph belongs to the run: the turn-tail card reads it by the run’s initiating toolCallId whether attached to a CreateWorkflow row, ResumeWorkflowRun row, or direct-launch turn. */
  workflowGraphByToolCallId?: ReadonlyMap<string, WorkflowCausalityGraphData>;
  /**
   * runId → latest successful filled script graph (`workflowRunCardJoin.buildWorkflowFillGraphByRunId`):
   * after a fill, the run card and side pane use this instead of the launch-row graph
   * (docs/dynamic-workflow/presentation.md, “Holes on the timeline”).
   */
  workflowFillGraphByRunId?: ReadonlyMap<string, WorkflowFillGraph>;
  /** Draft position for CreateWorkflow/AmendWorkflow rows (draft number and whether it was superseded), built in one pass by the host from the row window (`workflowDraftJoin.buildWorkflowDraftByToolCallId`). Compiler feedback uses this to show “Draft n” and choose the empty-circle light color; omit it when the card should not be numbered. */
  workflowDraftByToolCallId?: ReadonlyMap<string, WorkflowDraftPosition>;
  fetchFileChanges?: (
    target: ConversationRowTarget,
    options: ConversationFileChangesRequestOptions,
  ) => Promise<V4ConversationFileChangesResult>;
  previewFileRewind?: (
    target: ConversationRowTarget,
  ) => Promise<V4ConversationFileRewindPreviewResult>;
  applyFileRewind?: (target: ConversationRowTarget) => Promise<CommandAck>;
  /** Sent image/video previews; injected by the workspace transport bound to the pane. */
  readAttachment?: (
    params: ConversationAttachmentReadParams,
  ) => ReturnType<ConversationTransport["attachmentRead"]>;
  readAttachmentRange?: (
    params: Parameters<ConversationTransport["attachmentReadRange"]>[0],
  ) => ReturnType<ConversationTransport["attachmentReadRange"]>;
}

export interface ConversationFileChangesRequestOptions {
  /** A result from a running turn can still change as the projection revision grows, so reuse only the in-flight request. Reuse a successful result after virtual-row remount only for a terminal turn. */
  cachePolicy: "in-flight" | "terminal";
  /** Rewind switches active/reverted within the same logEpoch, so terminal-result caches must be isolated by this semantic state. */
  fileChangesState?: ConversationFileChangesState;
}

export type ConversationReasoningVisibility = Pick<
  ConversationRowRenderContext,
  "messageStreamShowReasoning" | "messageStreamFirstReasoningRowId"
>;

export function isConversationReasoningRowVisible(
  rowId: number,
  visibility: ConversationReasoningVisibility,
): boolean {
  return (
    visibility.messageStreamShowReasoning === true ||
    visibility.messageStreamFirstReasoningRowId === rowId
  );
}
