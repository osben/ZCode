/* eslint-disable max-lines -- Centralize open/reuse/close/sort rules for Browser/Git/CodeViewer/Treemapping/Whiteboard side-pane tabs; splitting this file would require moving existing in-memory recovery logic too. */
import {
  createUuid,
  type BrowserTabResidencyState,
  type BrowserViewRestoredTabShell,
} from "@zcode/shared";
import type { PluginUiSidePaneTab } from "@/plugin-ui/contract.js";
import { inferMediaPreview, isPptxPreviewPath, type CodeViewerSource } from "@/lib/codeViewer.js";
import { normalizeCodeViewerSource } from "@/lib/codeViewerSource.js";

export interface BrowserSidePaneTab {
  id: string;
  type: "browser";
  /** Conversation owner frozen when the tab opens; null means draft state. */
  ownerTaskId?: string | null;
  /** Workspace isolation key (workspaceIdentity || workspacePath). */
  workspaceKey?: string | null;
  remoteSessionId?: string | null;
  faviconUrl?: string | null;
  initialUrl?: string | null;
  /** Popup triggered by an Agent-controlled page; do not apply persistent display preferences for the human browser. */
  agentOpened?: boolean;
  openedAt?: number;
  title?: string | null;
  residency?: BrowserTabResidencyState;
  residencyGeneration?: number;
}

export type BrowserSidePaneMetadata = Partial<Pick<BrowserSidePaneTab, "faviconUrl" | "title">>;

export const BROWSER_USE_OPERATION_INDICATOR_DURATION_MS = 5_000;

export interface BrowserPermissionsSidePaneTab {
  id: string;
  type: "browser-permissions";
  origin: string;
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  openedAt?: number;
}

export interface GitSidePaneTab {
  id: "git";
  type: "git";
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  openedAt?: number;
}

export interface CodeViewerSidePaneTab {
  id: string;
  type: "code-viewer";
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  openedAt?: number;
  source: CodeViewerSource;
  sourceKey: string | null;
}

export type TreemappingSidePaneSource =
  | { kind: "current" }
  | { kind: "message"; messageId: string; turnIndex?: number };

export interface TreemappingSidePaneTab {
  id: "treemapping";
  type: "treemapping";
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  openedAt?: number;
  source?: TreemappingSidePaneSource;
}

export interface WhiteboardSidePaneTab {
  id: string;
  type: "whiteboard";
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  boardId: string;
  openedAt?: number;
  title: string;
}

export interface ModelTrajectorySidePaneTab {
  id: string;
  type: "model-trajectory";
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  openedAt?: number;
  /** Target task/session ID; model-io matches against this ID. */
  taskId: string;
  title?: string | null;
}

export interface DeveloperToolsSidePaneTab {
  id: "developer-tools";
  type: "developer-tools";
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  openedAt?: number;
}

export interface TerminalSidePaneTab {
  id: string;
  type: "terminal";
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  openedAt?: number;
  title: string;
  cwd?: string;
  remoteSessionId?: string | null;
}

/** Controlled browser-use view (renderer `<webview>` + main CDP). */
export interface BrowserUseSidePaneTab {
  id: string;
  type: "browser-use";
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  remoteSessionId?: string | null;
  sessionId: string;
  /** Opaque IAB tab identity assigned by main; also used as the webview attach key. */
  tabId: string;
  browserId?: string;
  browserGeneration?: number;
  openedAt?: number;
  title?: string | null;
  faviconUrl?: string | null;
  residency?: BrowserTabResidencyState;
  residencyGeneration?: number;
  /** UI indicator deadline for the most recent agent browser-use operation. */
  browserUseOperationUntil?: number;
  /** Monotonic version for the model-layout command; the target view rebuilds its ResizeObserver baseline from this. */
  browserUseResizeBaselineVersion?: number;
}

export interface OpenBackgroundBashSideTabRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  rootSessionId: string;
  sessionId: string;
  workId: string;
  title: string;
}

export interface BackgroundBashSidePaneTab extends OpenBackgroundBashSideTabRequest {
  id: string;
  type: "bash-output";
  workspaceKey: string;
  ownerTaskId: string;
  openedAt?: number;
}

export interface SubagentSessionSidePaneTab {
  id: string;
  type: "subagent-session";
  ownerTaskId?: string | null;
  openedAt?: number;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  rootSessionId: string;
  parentSessionId: string;
  childSessionId: string;
  subagentType: string;
  title: string;
}

export interface SubagentDirectorySidePaneTab {
  id: string;
  type: "subagent-directory";
  ownerTaskId?: string | null;
  openedAt?: number;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  rootSessionId: string;
  parentSessionId: string;
}

export interface SelectionSideChatPaneTab {
  id: string;
  type: "selection-side-chat";
  ownerTaskId?: string | null;
  openedAt?: number;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  parentSessionId: string;
  childSessionId: string;
  ordinal: number;
}

export interface PlanDetailSidePaneTab {
  id: string;
  type: "plan-detail";
  ownerTaskId?: string | null;
  openedAt?: number;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  parentSessionId: string;
  /** 子会话提供计划 projection 时，根任务仍是 Side Pane tab 的可见范围所有者。 */
  rootSessionId?: string;
  toolCallId: string;
  markdown: string;
  planFilePath?: string;
}

export interface OpenPlanDetailSideTabRequest {
  parentSessionId: string;
  rootSessionId?: string;
  toolCallId: string;
  markdown: string;
  planFilePath?: string;
}

/** Workflow-run detail tab. Its identity is the run (`runId`), not the tool call that started it: one CreateWorkflow starts one run, but the run is the key shared by the engine, journal, and `cancelBackgroundWork {workId}` (`workId ≡ taskId ≡ runId`). Keep `toolCallId` too because the static causal graph is stored in that tool-call row’s display, and the detail page locates it in the parent-session projection. This tab intentionally has no GC. Do not add it. Two tempting cleanup rules are both wrong: do not close it when the run is evicted by `WORKFLOW_RUNS_LIMITS.maxRuns` (8); the detail page reads its event log from the journal, not the `workflowRuns` projection. Eviction removes only live overlay state; the event log remains complete, exactly the case where users keep a tab to review a finished run. Closing it would destroy the only persistent view of that run. Eviction only changes the detail page to “no longer in the live tracking window”; the wording must be accurate because live status is gone, but the run itself is not. Do not close it when the parent session is edited/retried either. The run identity remains valid; at most the initiating tool-call row leaves the current window, which only means “no graph available,” not that the tab should disappear. Visibility is already scoped by `parentSessionId` (like plan-detail), so it cannot leak into another conversation. Keep GC in `syncSubagentSessionSidePaneTabs` scoped to subagent-session tabs. */
export interface WorkflowRunSidePaneTab {
  id: string;
  type: "workflow-run";
  ownerTaskId?: string | null;
  openedAt?: number;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  parentSessionId: string;
  toolCallId: string;
  runId: string;
  /** Display name frozen when opened; only a title fallback if the projection is missing (run evicted/cold start). */
  workflowName?: string;
  /** Destination: expand this station, show all, and scroll its section header to the top. If absent, stay put. */
  focusPhaseId?: string;
}

export interface OpenWorkflowRunSideTabRequest {
  parentSessionId: string;
  toolCallId: string;
  runId: string;
  workflowName?: string;
  /** Destination: expand this station in the detail page, show all, and scroll to its section header. If absent, stay put. */
  phaseId?: string;
  /** After “Configure,” keep the panel on the workflow: replace the tab showing this run in place with a tab for the new run, keeping its position, name, and owner. If no such tab exists because it was closed, do nothing; do not reopen the panel. */
  replaceRunId?: string;
}

/** Workflow-run directory tab for one conversation. Identity is the conversation (`parentSessionId`): each conversation has one run directory, so repeated footer clicks idempotently focus the same tab, like `subagent-directory`. The tab carries no run data; the directory page reads one page of journal by `parentSessionId` as its single source of truth. Freezing summaries into the tab would make a tab restored after restart show a stale list, even though it exists specifically for that post-restart moment. */
export interface WorkflowRunDirectorySidePaneTab {
  id: string;
  type: "workflow-directory";
  ownerTaskId?: string | null;
  openedAt?: number;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  parentSessionId: string;
}

export interface OpenWorkflowRunDirectorySideTabRequest {
  parentSessionId: string;
}

/** Transcript tab for one dwf actor instance. Identity is the actor session: each instance has a real persistent session, so `actorSessionId` is the tab identity. Carry `runId` / `siteId` / `ordinal` for titles, search, and troubleshooting—they are journal keys; the session ID is minted by the run service from `(runId, actorRef)` and should not be reverse-engineered by the renderer. This is a separate type rather than a variant of `subagent-session`: `syncSubagentSessionSidePaneTabs` deletes subagent tabs whose `childSessionId` is absent from `validChildSessionIds`; actor sessions are never in that set because they are not child sessions of subagents. Reusing that type would make the tab be collected every time the parent’s subagent projection updates. Teaching its collector about a variant would cost the same while hiding the invariant in cleanup logic. Visibility also differs: subagent tabs are scoped by `rootSessionId`, actor tabs by `parentSessionId` (same workflow run); and `lastActiveSubagentTabByRootRef` tracks active tabs by rootSessionId, which actor tabs do not have and should not gain. GC: like `workflow-run`, none. Do not add it. Actor sessions persist after the run ends (the durable audit benefit); run eviction at the 8-run limit, parent edit/retry, or run settlement must not close a readable transcript. Visibility is already scoped by parentSessionId, so it cannot leak to another conversation. */
export interface WorkflowActorSessionSidePaneTab {
  id: string;
  type: "workflow-actor-session";
  ownerTaskId?: string | null;
  openedAt?: number;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  parentSessionId: string;
  runId: string;
  /** Actor session ID: the session rendered by the nested read-only SessionPane. Optional because a tab opened from an unstarted pill has no session; the panel finds it by slot in the live projection and fills it in. Identity is (runId, siteId, ordinal), not this field. */
  actorSessionId?: string;
  /** Actor station ID and ordinal; together with runId they identify the tab and are never used for its name. */
  siteId: string;
  ordinal: number;
  /** Name written in the script (`agent("reviewer")`); absent if analysis cannot recover the literal, in which case use the localized title fallback. */
  actorName?: string;
}

export interface OpenWorkflowActorSessionSideTabRequest {
  parentSessionId: string;
  runId: string;
  /** Session ID known when the tab opened; absent for an unstarted slot. */
  actorSessionId?: string;
  siteId: string;
  ordinal: number;
  actorName?: string;
}

export interface OpenScopedWorkflowActorSessionSideTabRequest extends OpenWorkflowActorSessionSideTabRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

/** Script transcript tab for one workflow run: each call to `files.*` / `git.*` / `world.run` is replayed as a tool card. It is at the same logical level as an actor transcript (what one participant did in the run), but the workspace has no session. It is its own type, not an actor-tab variant: the panel does not embed SessionPane but queries two journal streams and renders cards itself. Identity is (workspace, parent session, run): one tab per run, regardless of which station opened it. `focusPhaseId` is only a destination (scroll to the first card in that station), recalculated on each open. GC: like `workflow-actor-session`, none; journal rows remain after the run ends so this replay can be used for post-run audit. Visibility is scoped by parentSessionId. */
export interface WorkflowWorkspaceSidePaneTab {
  id: string;
  type: "workflow-workspace";
  ownerTaskId?: string | null;
  openedAt?: number;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  parentSessionId: string;
  /** Tool-call ID that started this run; the static graph (phase names, step labels) is attached to that row and follows the same lookup path as a workflow-run tab. */
  toolCallId: string;
  runId: string;
  /** Display name frozen when opened; only a title fallback when the projection is missing. */
  workflowName?: string;
  /** Destination: scroll to the first card in this station; if it has not been reached, scroll to the end. If absent, stay put. */
  focusPhaseId?: string;
}

export interface OpenWorkflowWorkspaceSideTabRequest {
  parentSessionId: string;
  toolCallId: string;
  runId: string;
  workflowName?: string;
  phaseId?: string;
}

export interface OpenScopedWorkflowWorkspaceSideTabRequest extends OpenWorkflowWorkspaceSideTabRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

/** Full-size viewer tab for one dwf artifact. Terminology: artifact here is output published for users through script `artifact.*` (a file, Markdown, or a board projected from journal), not the engine-internal `RunSettlement.artifact` value returned by the script’s top level. Identity is (run, artifact ID), excluding version: repeated publication creates a new version of the same artifact, so opening it again should focus the existing tab and show the latest version instead of opening separate v1/v2 tabs. `version` is only the initial destination; notification/hub chips do not include a version and default to latest. The header’s version stepper is the actual version navigation. GC: like `workflow-run`, none. Do not add it. Artifact bytes are copied into the store at publish time, so output from a run evicted by the 8-run limit or even rewritten by editing the whole conversation remains fully readable—exactly why users keep this tab open. Visibility is scoped by parentSessionId, so it cannot leak into another conversation. */
export interface WorkflowArtifactSidePaneTab {
  id: string;
  type: "workflow-artifact";
  ownerTaskId?: string | null;
  openedAt?: number;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  parentSessionId: string;
  runId: string;
  /** Artifact ID (compile-time literal in the script, `[A-Za-z0-9_.-]` ≤ 64). */
  artifactId: string;
  /** Initial version when opened; absent means latest. Not part of tab identity (see the type comment). */
  version?: number;
  /** Display name frozen when opened; only a title fallback if metadata is missing (cold restore/older CLI). */
  title?: string;
}

export interface OpenWorkflowArtifactSideTabRequest {
  parentSessionId: string;
  runId: string;
  artifactId: string;
  version?: number;
  title?: string;
  /** Latest contentType (include it when the visible summary has it). `useAppPanels.handleOpenWorkflowArtifact` uses it to decide whether an HTML artifact opens directly in a browser tab or in an artifact tab; if absent, always open an artifact tab. */
  contentType?: string;
  /** Original workspace-relative path. Available only in surfaces that have merged the journal (run side panel); if absent, `handleOpenWorkflowArtifact` queries the journal to fill it in. The summary intentionally omits it to keep frame size down. */
  sourcePath?: string;
}

export interface OpenScopedWorkflowArtifactSideTabRequest extends OpenWorkflowArtifactSideTabRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

export interface OpenScopedWorkflowRunSideTabRequest extends OpenWorkflowRunSideTabRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

export interface OpenScopedWorkflowRunDirectorySideTabRequest extends OpenWorkflowRunDirectorySideTabRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

export interface OpenScopedPlanDetailSideTabRequest extends OpenPlanDetailSideTabRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

export interface OpenSelectionSideChatRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  parentSessionId: string;
  childSessionId: string;
  /** Host atomically replaces the matching old tab when the active child is confirmed absent. */
  replacesChildSessionId?: string;
}

export interface OpenSubagentSideTabRequest {
  rootSessionId?: string;
  parentSessionId: string;
  childSessionId: string;
  subagentType: string;
  title: string;
}

export interface OpenSubagentDirectorySideTabRequest {
  rootSessionId?: string;
  parentSessionId: string;
}

export interface OpenScopedSubagentDirectorySideTabRequest extends OpenSubagentDirectorySideTabRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

export interface SyncSubagentSessionTabsRequest {
  rootSessionId: string;
  parentSessionId: string;
  validChildSessionIds: readonly string[];
}

export interface OpenScopedSubagentSideTabRequest extends OpenSubagentSideTabRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

export type WorkspaceSidePaneTab =
  | BackgroundBashSidePaneTab
  | BrowserSidePaneTab
  | BrowserPermissionsSidePaneTab
  | GitSidePaneTab
  | CodeViewerSidePaneTab
  | TreemappingSidePaneTab
  | WhiteboardSidePaneTab
  | ModelTrajectorySidePaneTab
  | DeveloperToolsSidePaneTab
  | TerminalSidePaneTab
  | BrowserUseSidePaneTab
  | SubagentSessionSidePaneTab
  | SubagentDirectorySidePaneTab
  | SelectionSideChatPaneTab
  | PlanDetailSidePaneTab
  | PluginUiSidePaneTab
  | WorkflowRunSidePaneTab
  | WorkflowRunDirectorySidePaneTab
  | WorkflowActorSessionSidePaneTab
  | WorkflowWorkspaceSidePaneTab
  | WorkflowArtifactSidePaneTab;

/** Browser/browser-use page and CDP lifecycles depend on `<webview>` remaining connected to the DOM. Keep it mounted in the background while the panel is collapsed or another conversation is active; destroy page state only when the tab is explicitly closed. */
export function shouldMountSidePaneContent(
  isVisible: boolean,
  tabs: readonly WorkspaceSidePaneTab[],
): boolean {
  return (
    isVisible ||
    tabs.some(
      (tab) => tab.type === "browser" || tab.type === "browser-use" || tab.type === "bash-output",
    )
  );
}

export function shouldMountBrowserTabGuest(
  tab: BrowserSidePaneTab | BrowserUseSidePaneTab,
): boolean {
  return tab.residency !== "suspended" && tab.residency !== "suspend-pending";
}

export interface WorkspaceSidePaneState {
  tabs: WorkspaceSidePaneTab[];
  activeTabId: string;
}

export function normalizeWorkspaceSidePaneState(
  current: WorkspaceSidePaneState | null,
): WorkspaceSidePaneState | null {
  if (!current) {
    return null;
  }

  // Treemapping must currently be hidden from the sidebar. Older versions may already have stored its tab
  // in workspace-level side-pane memory, so filter it at the state boundary to prevent the entry from reappearing after restore.
  const filteredTabs = current.tabs.filter((tab) => tab.type !== "treemapping");
  if (filteredTabs.length === 0) {
    return null;
  }

  // Helper-conversation tabs created before adding `ordinal` for multiple instances (HMR/old in-window state) may lack the
  // field; passing them to getNextSelectionSideChatOrdinal would yield NaN/undefined and cause title-number collisions. At the state boundary,
  // fill the smallest available number within each parent group while preserving existing numbers.
  let migratedOrdinal = false;
  const tabs = filteredTabs.map((tab, index, allTabs) => {
    if (tab.type !== "selection-side-chat" || Number.isInteger(tab.ordinal)) {
      return tab;
    }
    // A tab already backfilled during this iteration is replaced in place in allTabs and naturally contributes its integer ordinal to occupied-number checks.
    const used = new Set(
      allTabs.flatMap((candidate) =>
        candidate.type === "selection-side-chat" &&
        candidate.workspaceKey === tab.workspaceKey &&
        candidate.parentSessionId === tab.parentSessionId &&
        Number.isInteger(candidate.ordinal)
          ? [candidate.ordinal]
          : [],
      ),
    );
    let ordinal = 1;
    while (used.has(ordinal)) ordinal += 1;
    migratedOrdinal = true;
    const migrated: SelectionSideChatPaneTab = { ...tab, ordinal };
    allTabs[index] = migrated;
    return migrated;
  });

  const activeTabId =
    current.activeTabId === "" || tabs.some((tab) => tab.id === current.activeTabId)
      ? current.activeTabId
      : tabs[tabs.length - 1]!.id;
  if (
    !migratedOrdinal &&
    tabs.length === current.tabs.length &&
    activeTabId === current.activeTabId
  ) {
    return current;
  }

  return {
    tabs,
    activeTabId,
  };
}

function createBrowserSidePaneTab(options?: {
  tabId?: string;
  initialUrl?: string | null;
  ownerTaskId?: string | null;
  workspaceKey?: string | null;
  remoteSessionId?: string | null;
  agentOpened?: boolean;
}): BrowserSidePaneTab {
  return {
    id: options?.tabId ?? `browser:${createUuid()}`,
    type: "browser",
    ...(options?.ownerTaskId !== undefined ? { ownerTaskId: options.ownerTaskId } : {}),
    ...(options?.workspaceKey !== undefined ? { workspaceKey: options.workspaceKey } : {}),
    // Human tabs historically did not write remoteSessionId, while stampSidePaneTabsOwnership only fills
    // tabs without an ownerTaskId. Tabs created with an ownerTaskId (open link/terminal URL/popup/share)
    // permanently lack that field in remote sessions. The attach renderer falls back to
    // workspaceRemoteSessionId to freeze the main-process owner, but close compares the empty value on
    // the tab; after the scope mismatch, the tab can never be closed. Freeze ownership at creation.
    ...(options?.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    faviconUrl: null,
    initialUrl: options?.initialUrl ?? null,
    ...(options?.agentOpened ? { agentOpened: true } : {}),
    openedAt: Date.now(),
    title: null,
  };
}

function createGitSidePaneTab(): GitSidePaneTab {
  return { id: "git", type: "git", openedAt: Date.now() };
}

function createTreemappingSidePaneTab(
  source: TreemappingSidePaneSource = { kind: "current" },
): TreemappingSidePaneTab {
  return {
    id: "treemapping",
    type: "treemapping",
    openedAt: Date.now(),
    source,
  };
}

function createModelTrajectorySidePaneTab(options: {
  taskId: string;
  title?: string | null;
}): ModelTrajectorySidePaneTab {
  return {
    // Reuse one tab for the same task to avoid opening duplicate traces.
    id: `model-trajectory:${options.taskId}`,
    type: "model-trajectory",
    openedAt: Date.now(),
    taskId: options.taskId,
    title: options.title ?? null,
  };
}

function createDeveloperToolsSidePaneTab(): DeveloperToolsSidePaneTab {
  return {
    id: "developer-tools",
    type: "developer-tools",
    openedAt: Date.now(),
  };
}

function createTerminalSidePaneTab(options: {
  title: string;
  cwd?: string;
  remoteSessionId?: string | null;
}): TerminalSidePaneTab {
  return {
    id: `terminal:${createUuid()}`,
    type: "terminal",
    openedAt: Date.now(),
    title: options.title,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
  };
}

export function encodeSidePaneTabIdPart(value: string): string {
  return encodeURIComponent(value);
}

export function createSubagentSessionSidePaneTab(options: {
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  rootSessionId?: string;
  parentSessionId: string;
  childSessionId: string;
  subagentType: string;
  title: string;
}): SubagentSessionSidePaneTab {
  const rootSessionId = options.rootSessionId ?? options.parentSessionId;
  return {
    id: [
      "subagent-session",
      encodeSidePaneTabIdPart(options.workspaceKey),
      encodeSidePaneTabIdPart(rootSessionId),
      encodeSidePaneTabIdPart(options.childSessionId),
    ].join(":"),
    type: "subagent-session",
    openedAt: Date.now(),
    workspaceKey: options.workspaceKey,
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    rootSessionId,
    parentSessionId: options.parentSessionId,
    childSessionId: options.childSessionId,
    subagentType: options.subagentType,
    title: options.title.trim(),
  };
}

export function createSubagentDirectorySidePaneTab(options: {
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  rootSessionId?: string;
  parentSessionId: string;
}): SubagentDirectorySidePaneTab {
  const rootSessionId = options.rootSessionId ?? options.parentSessionId;
  return {
    id: [
      "subagent-directory",
      encodeSidePaneTabIdPart(options.workspaceKey),
      encodeSidePaneTabIdPart(rootSessionId),
      encodeSidePaneTabIdPart(options.parentSessionId),
    ].join(":"),
    type: "subagent-directory",
    openedAt: Date.now(),
    workspaceKey: options.workspaceKey,
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    rootSessionId,
    parentSessionId: options.parentSessionId,
  };
}

export function createSelectionSideChatPaneTab(
  options: OpenSelectionSideChatRequest & {
    workspaceKey: string;
    ordinal: number;
  },
): SelectionSideChatPaneTab {
  return {
    id: [
      "selection-side-chat",
      encodeSidePaneTabIdPart(options.workspaceKey),
      encodeSidePaneTabIdPart(options.parentSessionId),
      encodeSidePaneTabIdPart(options.childSessionId),
    ].join(":"),
    type: "selection-side-chat",
    openedAt: Date.now(),
    workspaceKey: options.workspaceKey,
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    parentSessionId: options.parentSessionId,
    childSessionId: options.childSessionId,
    ordinal: options.ordinal,
  };
}

export function createPlanDetailSidePaneTab(
  options: OpenScopedPlanDetailSideTabRequest & { workspaceKey: string },
): PlanDetailSidePaneTab {
  return {
    id: [
      "plan-detail",
      encodeSidePaneTabIdPart(options.workspaceKey),
      encodeSidePaneTabIdPart(options.parentSessionId),
      encodeSidePaneTabIdPart(options.toolCallId),
    ].join(":"),
    type: "plan-detail",
    openedAt: Date.now(),
    workspaceKey: options.workspaceKey,
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    parentSessionId: options.parentSessionId,
    ...(options.rootSessionId ? { rootSessionId: options.rootSessionId } : {}),
    toolCallId: options.toolCallId,
    markdown: options.markdown,
    ...(options.planFilePath ? { planFilePath: options.planFilePath } : {}),
  };
}

function createWorkflowRunSidePaneTab(
  options: OpenScopedWorkflowRunSideTabRequest & { workspaceKey: string },
): WorkflowRunSidePaneTab {
  return {
    // Structured ID: a run always maps to the same tab within a workspace and session; repeated clicks are idempotent.
    id: [
      "workflow-run",
      encodeSidePaneTabIdPart(options.workspaceKey),
      encodeSidePaneTabIdPart(options.parentSessionId),
      encodeSidePaneTabIdPart(options.runId),
    ].join(":"),
    type: "workflow-run",
    openedAt: Date.now(),
    workspaceKey: options.workspaceKey,
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    parentSessionId: options.parentSessionId,
    toolCallId: options.toolCallId,
    runId: options.runId,
    ...(options.workflowName ? { workflowName: options.workflowName } : {}),
    ...(options.phaseId ? { focusPhaseId: options.phaseId } : {}),
  };
}

function createWorkflowRunDirectorySidePaneTab(
  options: OpenScopedWorkflowRunDirectorySideTabRequest & { workspaceKey: string },
): WorkflowRunDirectorySidePaneTab {
  return {
    // Structured ID: a conversation has only one run directory, so repeated clicks on its footer row focus the same tab idempotently.
    id: [
      "workflow-directory",
      encodeSidePaneTabIdPart(options.workspaceKey),
      encodeSidePaneTabIdPart(options.parentSessionId),
    ].join(":"),
    type: "workflow-directory",
    openedAt: Date.now(),
    workspaceKey: options.workspaceKey,
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    parentSessionId: options.parentSessionId,
  };
}

function createWorkflowActorSessionSidePaneTab(
  options: OpenScopedWorkflowActorSessionSideTabRequest & { workspaceKey: string },
): WorkflowActorSessionSidePaneTab {
  return {
    // Structured ID: a slot always maps to the same tab within a workspace and conversation; repeated clicks are idempotent.
    // Identity is (runId, siteId@ordinal), not the session ID: the tab can open before a session exists (an
    // unstarted pill), and opening it both before and after startup must resolve to the same tab. Including
    // runId also keeps identically named instances from different runs distinct.
    id: [
      "workflow-actor-session",
      encodeSidePaneTabIdPart(options.workspaceKey),
      encodeSidePaneTabIdPart(options.parentSessionId),
      encodeSidePaneTabIdPart(options.runId),
      encodeSidePaneTabIdPart(`${options.siteId}@${options.ordinal}`),
    ].join(":"),
    type: "workflow-actor-session",
    openedAt: Date.now(),
    workspaceKey: options.workspaceKey,
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    parentSessionId: options.parentSessionId,
    runId: options.runId,
    ...(options.actorSessionId ? { actorSessionId: options.actorSessionId } : {}),
    siteId: options.siteId,
    ordinal: options.ordinal,
    ...(options.actorName ? { actorName: options.actorName } : {}),
  };
}

function createWorkflowWorkspaceSidePaneTab(
  options: OpenScopedWorkflowWorkspaceSideTabRequest & { workspaceKey: string },
): WorkflowWorkspaceSidePaneTab {
  return {
    // Structured ID: (workspace, parent session, run). The phase is **not** part of the ID: each run has
    // one script transcript tab, whether opened from the plan or verify station; only the destination differs.
    id: [
      "workflow-workspace",
      encodeSidePaneTabIdPart(options.workspaceKey),
      encodeSidePaneTabIdPart(options.parentSessionId),
      encodeSidePaneTabIdPart(options.runId),
    ].join(":"),
    type: "workflow-workspace",
    openedAt: Date.now(),
    workspaceKey: options.workspaceKey,
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    parentSessionId: options.parentSessionId,
    toolCallId: options.toolCallId,
    runId: options.runId,
    ...(options.workflowName ? { workflowName: options.workflowName } : {}),
    ...(options.phaseId ? { focusPhaseId: options.phaseId } : {}),
  };
}

function createWorkflowArtifactSidePaneTab(
  options: OpenScopedWorkflowArtifactSideTabRequest & { workspaceKey: string },
): WorkflowArtifactSidePaneTab {
  return {
    // Structured ID: **version is excluded**. v1 and v2 of an artifact are two points in time for the same
    // item. Clicking again (notification chip / hub chip / side-pane card) should focus the same tab and
    // show the newer version, rather than opening a second tab beside it.
    id: [
      "workflow-artifact",
      encodeSidePaneTabIdPart(options.workspaceKey),
      encodeSidePaneTabIdPart(options.parentSessionId),
      encodeSidePaneTabIdPart(options.runId),
      encodeSidePaneTabIdPart(options.artifactId),
    ].join(":"),
    type: "workflow-artifact",
    openedAt: Date.now(),
    workspaceKey: options.workspaceKey,
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    parentSessionId: options.parentSessionId,
    runId: options.runId,
    artifactId: options.artifactId,
    ...(options.version === undefined ? {} : { version: options.version }),
    ...(options.title ? { title: options.title } : {}),
  };
}

function createWhiteboardSidePaneTab(options: {
  boardId: string;
  title: string;
}): WhiteboardSidePaneTab {
  return {
    id: `whiteboard:${options.boardId}`,
    type: "whiteboard",
    boardId: options.boardId,
    openedAt: Date.now(),
    title: options.title,
  };
}

function getCodeViewerTabSourceKey(source: CodeViewerSource): string | null {
  const workspaceScope = source.workspaceIdentity?.trim()
    ? source.workspaceIdentity.trim()
    : (source.workspacePath ?? "");
  const scopedKeyPrefix = workspaceScope ? `${workspaceScope}:` : "";
  // The file tree represents PPTX as a generic `file` source, while opening a reference uses a `pptx`
  // source with navigation intent. The old key included source.type directly, splitting the same workspace
  // path into two tabs. Source type describes the entry point, not file identity; normalize only PPTX here
  // to avoid changing the semantics of other preview types.
  const resourceType =
    source.type === "pptx" || (source.type === "file" && isPptxPreviewPath(source.path))
      ? "pptx"
      : source.type === "media" || (source.type === "file" && inferMediaPreview(source.path))
        ? "media"
        : source.type;

  if (
    source.type === "file" ||
    source.type === "code-review" ||
    source.type === "image" ||
    source.type === "media" ||
    source.type === "pdf" ||
    source.type === "pptx"
  ) {
    return `${scopedKeyPrefix}${resourceType}:${source.path}`;
  }

  if (source.type === "text" && source.path) {
    return `${scopedKeyPrefix}${source.type}:${source.path}`;
  }

  if (source.type === "patch") {
    // File diffs previously reused tabs by path alone, so different patches for the same file in separate
    // turns overwrote each other, making it look as though the diff panel could open only one tab. Include
    // a patch content digest in the key so distinct diffs can stay open side by side, while repeated clicks
    // on the same diff still reuse its tab.
    return `${scopedKeyPrefix}patch:${source.path ?? source.title}:${hashCodeViewerContent(source.patch)}`;
  }

  if (source.type === "multi-file-diff") {
    return `${scopedKeyPrefix}multi-file-diff:${source.path ?? source.title}:${hashCodeViewerContent(`${source.beforeContent}\0${source.afterContent}`)}`;
  }

  return null;
}

function hashCodeViewerContent(content: string): string {
  let hash = 0;
  for (let index = 0; index < content.length; index += 1) {
    hash = (hash * 31 + content.charCodeAt(index)) | 0;
  }

  return Math.abs(hash).toString(36);
}

function createCodeViewerSidePaneTab(source: CodeViewerSource): CodeViewerSidePaneTab {
  const normalizedSource = normalizeCodeViewerSource(source);
  const sourceKey = getCodeViewerTabSourceKey(normalizedSource);
  return {
    id: sourceKey ? `code-viewer:${sourceKey}` : `code-viewer:${createUuid()}`,
    type: "code-viewer",
    openedAt: Date.now(),
    source: normalizedSource,
    sourceKey,
  };
}

function findTabIndexById(tabs: WorkspaceSidePaneTab[], tabId: string): number {
  return tabs.findIndex((tab) => tab.id === tabId);
}

export function activateSidePaneTab(
  current: WorkspaceSidePaneState | null,
  tab: WorkspaceSidePaneTab,
): WorkspaceSidePaneState {
  if (!current) {
    return {
      tabs: [tab],
      activeTabId: tab.id,
    };
  }

  const existingIndex = findTabIndexById(current.tabs, tab.id);
  if (existingIndex >= 0) {
    const nextTabs = [...current.tabs];
    nextTabs[existingIndex] = tab;
    return {
      tabs: nextTabs,
      activeTabId: tab.id,
    };
  }

  return {
    tabs: [...current.tabs, tab],
    activeTabId: tab.id,
  };
}

export function getActiveSidePaneTab(
  current: WorkspaceSidePaneState | null,
): WorkspaceSidePaneTab | null {
  if (!current) {
    return null;
  }

  return current.tabs.find((tab) => tab.id === current.activeTabId) ?? null;
}

/** Normalize draft-state null/undefined values so the side pane can isolate by conversation. */
export function sidePaneOwnerKey(taskId: string | null | undefined): string {
  return taskId ?? "__draft__";
}

const WORKSPACE_GLOBAL_SIDE_PANE_TAB_TYPES = new Set<WorkspaceSidePaneTab["type"]>([
  "git",
  "developer-tools",
  "treemapping",
]);

export function isWorkspaceGlobalSidePaneTab(tab: WorkspaceSidePaneTab): boolean {
  return WORKSPACE_GLOBAL_SIDE_PANE_TAB_TYPES.has(tab.type);
}

export interface SidePaneVisibilityScope {
  workspaceKey: string | null;
  ownerTaskId: string | null;
}

function sidePaneTabMatchesWorkspace(
  tab: WorkspaceSidePaneTab,
  activeWorkspaceKey: string | null,
): boolean {
  return tab.workspaceKey == null || tab.workspaceKey === activeWorkspaceKey;
}

/**
 * Freeze workspace and conversation ownership for new tabs when committing them to shared side-pane state.
 * browser-use events carry their own source ownership, so an already tagged tab must never be overwritten by the current UI scope.
 */
export function stampSidePaneTabsOwnership(
  state: WorkspaceSidePaneState | null,
  ownership: {
    ownerTaskId: string | null;
    workspaceKey: string | null;
    remoteSessionId?: string | null;
  },
): WorkspaceSidePaneState | null {
  if (!state) return state;
  let changed = false;
  const tabs = state.tabs.map((tab) => {
    if (tab.ownerTaskId !== undefined) return tab;
    changed = true;
    return {
      ...tab,
      ownerTaskId: ownership.ownerTaskId,
      workspaceKey: tab.workspaceKey ?? ownership.workspaceKey,
      ...((tab.type === "browser" || tab.type === "browser-use") && ownership.remoteSessionId
        ? { remoteSessionId: ownership.remoteSessionId }
        : {}),
    } as WorkspaceSidePaneTab;
  });
  return changed ? { ...state, tabs } : state;
}

function getVisibleSidePaneTabsByScope(
  tabs: WorkspaceSidePaneTab[],
  scope: SidePaneVisibilityScope,
): WorkspaceSidePaneTab[] {
  const ownerKey = sidePaneOwnerKey(scope.ownerTaskId);
  return tabs.filter((tab) => {
    if (!sidePaneTabMatchesWorkspace(tab, scope.workspaceKey)) return false;
    if (isWorkspaceGlobalSidePaneTab(tab)) return true;
    if (tab.type === "browser-use") return tab.sessionId === scope.ownerTaskId;
    if (
      tab.type === "subagent-session" ||
      tab.type === "subagent-directory" ||
      tab.type === "bash-output"
    ) {
      return tab.rootSessionId === scope.ownerTaskId;
    }
    if (
      tab.type === "selection-side-chat" ||
      tab.type === "plugin-ui" ||
      tab.type === "workflow-run" ||
      tab.type === "workflow-actor-session" ||
      tab.type === "workflow-workspace" ||
      tab.type === "workflow-artifact"
    ) {
      return tab.parentSessionId === scope.ownerTaskId;
    }
    if (tab.type === "plan-detail") {
      // 计划正文来自 child session；tab 生命周期与可见性仍属于根任务的 Side Pane。
      return (tab.rootSessionId ?? tab.parentSessionId) === scope.ownerTaskId;
    }
    return sidePaneOwnerKey(tab.ownerTaskId) === ownerKey;
  });
}

export function resolveActiveTabForOwner(
  state: WorkspaceSidePaneState | null,
  scope: SidePaneVisibilityScope,
  preferredTabId?: string | null,
): string | null {
  if (!state) return null;
  const visibleTabs = getVisibleSidePaneTabsByScope(state.tabs, scope);
  if (visibleTabs.length === 0) return null;
  if (preferredTabId && visibleTabs.some((tab) => tab.id === preferredTabId)) {
    return preferredTabId;
  }
  if (visibleTabs.some((tab) => tab.id === state.activeTabId)) {
    return state.activeTabId;
  }
  return visibleTabs.at(-1)?.id ?? null;
}

/**
 * Resolve the active tab and collapsed state together when the conversation scope changes.
 *
 * When the target conversation has no preferredTabId, do not reuse the previous conversation's collapsed
 * state or simply override it with “expand when a visible tab exists.” Otherwise, after the user collapses
 * conversation A, switches to B, and returns to A, A's visible tab would expand it automatically. The caller
 * now provides the current conversation's explicit preference; only when none exists do we use the default
 * of expanding with tabs and collapsing without them.
 */
export function resolveSidePaneScopeState(
  state: WorkspaceSidePaneState | null,
  scope: SidePaneVisibilityScope,
  preferredTabId?: string | null,
  collapsedPreference?: boolean,
): {
  sidePaneState: WorkspaceSidePaneState | null;
  isSidePaneCollapsed: boolean;
} {
  const activeTabId = resolveActiveTabForOwner(state, scope, preferredTabId);
  return {
    sidePaneState:
      state && state.activeTabId !== (activeTabId ?? "")
        ? { ...state, activeTabId: activeTabId ?? "" }
        : state,
    isSidePaneCollapsed: activeTabId === null ? true : (collapsedPreference ?? false),
  };
}

export function restoreSidePaneTab(
  current: WorkspaceSidePaneState | null,
  tab: WorkspaceSidePaneTab,
): WorkspaceSidePaneState {
  return activateSidePaneTab(current, {
    ...tab,
    openedAt: tab.openedAt ?? Date.now(),
  });
}

export function activateBrowserSidePane(
  current: WorkspaceSidePaneState | null,
  options?: {
    tabId?: string;
    initialUrl?: string | null;
    forceNew?: boolean;
    ownerTaskId?: string | null;
    workspaceKey?: string | null;
    remoteSessionId?: string | null;
    agentOpened?: boolean;
  },
): WorkspaceSidePaneState {
  if (!options?.forceNew && !options?.tabId && !options?.initialUrl) {
    const ownerKey = sidePaneOwnerKey(options?.ownerTaskId);
    const existingBrowserTab = current?.tabs.find(
      (tab): tab is BrowserSidePaneTab =>
        tab.type === "browser" && sidePaneOwnerKey(tab.ownerTaskId) === ownerKey,
    );
    if (existingBrowserTab) {
      return activateSidePaneTab(current, existingBrowserTab);
    }
  }

  return activateSidePaneTab(current, createBrowserSidePaneTab(options));
}

/** Open/reuse a site-permissions settings tab: keep one tab per site, workspace, and conversation. */
export function openBrowserPermissionsSidePane(
  current: WorkspaceSidePaneState | null,
  options: Pick<BrowserPermissionsSidePaneTab, "origin" | "ownerTaskId" | "workspaceKey">,
): WorkspaceSidePaneState {
  const existing = current?.tabs.find(
    (tab) =>
      tab.type === "browser-permissions" &&
      tab.origin === options.origin &&
      tab.workspaceKey === options.workspaceKey &&
      sidePaneOwnerKey(tab.ownerTaskId) === sidePaneOwnerKey(options.ownerTaskId),
  );
  return activateSidePaneTab(
    current,
    existing ?? {
      ...options,
      id: `browser-permissions:${createUuid()}`,
      type: "browser-permissions",
      openedAt: Date.now(),
    },
  );
}

export function openBrowserSidePane(
  current: WorkspaceSidePaneState | null,
  options?: {
    tabId?: string;
    initialUrl?: string | null;
    ownerTaskId?: string | null;
    workspaceKey?: string | null;
    remoteSessionId?: string | null;
    activate?: boolean;
    agentOpened?: boolean;
  },
): WorkspaceSidePaneState {
  const next = activateBrowserSidePane(current, {
    ...options,
    forceNew: true,
  });
  if (options?.activate !== false) return next;
  return { ...next, activeTabId: current?.activeTabId ?? "" };
}

/**
 * Claim the browser tab for a URL within the same workspace/owner.
 *
 * The caller (`useAppPanels`) needs the destination tab ID **before** it can send a navigation request, so
 * lookup and opening happen in two steps: this function finds the tab, and
 * `openOrActivateBrowserSidePaneByUrl` uses the same criteria to choose the destination. Sharing the
 * criteria prevents looking up tab A and opening tab B.
 */
export function findBrowserSidePaneTabByUrl(
  current: WorkspaceSidePaneState | null,
  options: {
    initialUrl: string;
    ownerTaskId?: string | null;
    workspaceKey?: string | null;
  },
): BrowserSidePaneTab | undefined {
  const ownerKey = sidePaneOwnerKey(options.ownerTaskId);
  return current?.tabs.find(
    (tab): tab is BrowserSidePaneTab =>
      tab.type === "browser" &&
      tab.initialUrl === options.initialUrl &&
      sidePaneOwnerKey(tab.ownerTaskId) === ownerKey &&
      sidePaneTabMatchesWorkspace(tab, options.workspaceKey ?? null),
  );
}

/**
 * Reuse tabs by URL: the same URL within a workspace/session only activates its existing tab.
 *
 * Two use cases: a share-handover link and directly opening an HTML artifact. Both mean “take me to this
 * address,” not “open another browser.” Reuse **does not** modify any tab fields (`initialUrl` is the key);
 * the caller sends another navigation request if the webview needs to fetch the content again.
 */
export function openOrActivateBrowserSidePaneByUrl(
  current: WorkspaceSidePaneState | null,
  options: {
    initialUrl: string;
    /** Tab ID to use when creating a tab; generated if omitted. Ignored when an existing tab matches. */
    tabId?: string;
    ownerTaskId?: string | null;
    workspaceKey?: string | null;
    remoteSessionId?: string | null;
  },
): WorkspaceSidePaneState {
  const existing = findBrowserSidePaneTabByUrl(current, options);
  if (existing) return activateSidePaneTab(current, existing);
  return activateBrowserSidePane(current, {
    initialUrl: options.initialUrl,
    ...(options.tabId ? { tabId: options.tabId } : {}),
    ownerTaskId: options.ownerTaskId,
    workspaceKey: options.workspaceKey,
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
  });
}

/** Open or update a controlled browser-use tab; replaying ready is idempotent by tabId. */
export function openBrowserUseSidePane(
  current: WorkspaceSidePaneState | null,
  options: {
    workspaceKey: string;
    sessionId: string;
    tabId: string;
    browserId?: string;
    browserGeneration?: number;
    remoteSessionId?: string;
    title?: string;
    activate?: boolean;
  },
): WorkspaceSidePaneState {
  const id = `browser-use:${options.tabId}`;
  const existing = current?.tabs.find(
    (tab): tab is BrowserUseSidePaneTab => tab.type === "browser-use" && tab.id === id,
  );
  const remoteSessionId = options.remoteSessionId ?? existing?.remoteSessionId;
  const tab: BrowserUseSidePaneTab = {
    id,
    type: "browser-use",
    ownerTaskId: options.sessionId,
    workspaceKey: options.workspaceKey,
    ...(remoteSessionId ? { remoteSessionId } : {}),
    sessionId: options.sessionId,
    tabId: options.tabId,
    ...(options.browserId ? { browserId: options.browserId } : {}),
    ...(options.browserGeneration !== undefined
      ? { browserGeneration: options.browserGeneration }
      : {}),
    openedAt: existing?.openedAt ?? Date.now(),
    ...((options.title ?? existing?.title)
      ? { title: options.title ?? existing?.title ?? null }
      : {}),
    ...(existing?.faviconUrl !== undefined ? { faviconUrl: existing.faviconUrl } : {}),
    ...(existing?.residency !== undefined ? { residency: existing.residency } : {}),
    ...(existing?.residencyGeneration !== undefined
      ? { residencyGeneration: existing.residencyGeneration }
      : {}),
    ...(existing?.browserUseOperationUntil !== undefined
      ? { browserUseOperationUntil: existing.browserUseOperationUntil }
      : {}),
    ...(existing?.browserUseResizeBaselineVersion !== undefined
      ? {
          browserUseResizeBaselineVersion: existing.browserUseResizeBaselineVersion,
        }
      : {}),
  };

  if (options.activate !== false) {
    return activateSidePaneTab(current, tab);
  }
  if (!current) {
    return { tabs: [tab], activeTabId: "" };
  }
  const existingIndex = findTabIndexById(current.tabs, tab.id);
  if (existingIndex >= 0) {
    const tabs = [...current.tabs];
    tabs[existingIndex] = tab;
    return { ...current, tabs };
  }
  return { ...current, tabs: [...current.tabs, tab] };
}

export interface BrowserUseSidePaneScope {
  workspaceKey: string;
  remoteSessionId?: string;
  ownerTaskId: string | null;
}

/** A ready/show event may activate only its origin workspace and session; background events only attach the guest. */
export function applyBrowserUseSidePaneEvent(
  current: WorkspaceSidePaneState | null,
  options: {
    workspaceKey: string;
    remoteSessionId?: string;
    sessionId: string;
    tabId: string;
    browserId?: string;
    browserGeneration?: number;
  },
  activeScope: BrowserUseSidePaneScope,
): { state: WorkspaceSidePaneState; shouldReveal: boolean } {
  const shouldReveal =
    options.workspaceKey === activeScope.workspaceKey &&
    (options.remoteSessionId ?? "") === (activeScope.remoteSessionId ?? "") &&
    options.sessionId === activeScope.ownerTaskId;
  return {
    state: openBrowserUseSidePane(current, {
      ...options,
      activate: shouldReveal,
    }),
    shouldReveal,
  };
}

/** Visibility selects only a shell already created by ready; late events must not recreate a closed tab. */
export function applyBrowserUseSidePaneVisibilityEvent(
  current: WorkspaceSidePaneState | null,
  options: {
    workspaceKey: string;
    remoteSessionId?: string;
    sessionId: string;
    tabId: string;
    browserId?: string;
    browserGeneration?: number;
  },
  activeScope: BrowserUseSidePaneScope,
): {
  state: WorkspaceSidePaneState | null;
  shouldReveal: boolean;
  didMatch: boolean;
} {
  const target = current?.tabs.find(
    (tab): tab is BrowserUseSidePaneTab =>
      tab.type === "browser-use" &&
      tab.tabId === options.tabId &&
      tab.workspaceKey === options.workspaceKey &&
      (tab.remoteSessionId ?? "") === (options.remoteSessionId ?? "") &&
      tab.sessionId === options.sessionId &&
      (options.browserId === undefined || tab.browserId === options.browserId) &&
      (options.browserGeneration === undefined ||
        tab.browserGeneration === options.browserGeneration),
  );
  if (!target) {
    // The old visibility path reused ready's open helper. After main closes a tab, a queued late
    // visible=true could make the renderer recreate a zombie shell without main-process authority, causing
    // later close clicks to fail. Visibility is a selection signal and may only match an existing shell with
    // an exact scope/generation match.
    return { state: current, shouldReveal: false, didMatch: false };
  }

  const shouldReveal =
    options.workspaceKey === activeScope.workspaceKey &&
    (options.remoteSessionId ?? "") === (activeScope.remoteSessionId ?? "") &&
    options.sessionId === activeScope.ownerTaskId;
  return {
    state: shouldReveal ? setActiveSidePaneTab(current, target.id) : current,
    shouldReveal,
    didMatch: true,
  };
}

export function applyBrowserTabResidencyEvent(
  current: WorkspaceSidePaneState | null,
  event: {
    tabId: string;
    workspaceKey?: string;
    remoteSessionId?: string;
    sessionId?: string;
    browserId?: string;
    browserGeneration?: number;
    generation: number;
    residency: Extract<
      BrowserTabResidencyState,
      "live-visible" | "live-background" | "suspended" | "restoring"
    >;
  },
): WorkspaceSidePaneState | null {
  if (!current) return current;
  const index = current.tabs.findIndex(
    (tab) =>
      (tab.type === "browser" && tab.id === event.tabId) ||
      (tab.type === "browser-use" && tab.tabId === event.tabId),
  );
  if (index < 0) return current;
  const target = current.tabs[index] as BrowserSidePaneTab | BrowserUseSidePaneTab;
  if (event.workspaceKey !== undefined && target.workspaceKey !== event.workspaceKey)
    return current;
  if (
    Object.hasOwn(event, "remoteSessionId") &&
    (target.remoteSessionId ?? "") !== (event.remoteSessionId ?? "")
  ) {
    return current;
  }
  if (
    event.sessionId !== undefined &&
    (target.type === "browser-use"
      ? target.sessionId !== event.sessionId
      : (target.ownerTaskId ?? "unscoped") !== event.sessionId)
  ) {
    return current;
  }
  if ((target.residencyGeneration ?? 0) > event.generation) return current;
  const tabs = [...current.tabs];
  tabs[index] = {
    ...target,
    ...(target.type === "browser-use" && event.browserId ? { browserId: event.browserId } : {}),
    ...(target.type === "browser-use" && event.browserGeneration !== undefined
      ? { browserGeneration: event.browserGeneration }
      : {}),
    residency: event.residency,
    residencyGeneration: event.generation,
  };
  return { ...current, tabs };
}

export function restoreBrowserTabShells(
  current: WorkspaceSidePaneState | null,
  shells: readonly BrowserViewRestoredTabShell[],
  scope?: {
    workspaceKey: string;
    remoteSessionId?: string;
    sessionId: string;
  },
): WorkspaceSidePaneState {
  let next: WorkspaceSidePaneState = current ?? { tabs: [], activeTabId: "" };
  const hadActiveTabInScope = Boolean(
    scope &&
    current?.tabs.some(
      (tab) =>
        tab.id === current.activeTabId &&
        (tab.type === "browser" || tab.type === "browser-use") &&
        tab.workspaceKey === scope.workspaceKey &&
        (tab.remoteSessionId ?? "") === (scope.remoteSessionId ?? "") &&
        (tab.type === "browser-use"
          ? tab.sessionId === scope.sessionId
          : (tab.ownerTaskId ?? "unscoped") === scope.sessionId),
    ),
  );
  for (const shell of shells) {
    const existing = next.tabs.find(
      (tab) =>
        (tab.type === "browser" && tab.id === shell.tabId) ||
        (tab.type === "browser-use" && tab.tabId === shell.tabId),
    );
    if (existing) continue;
    const tab: BrowserSidePaneTab | BrowserUseSidePaneTab =
      shell.origin === "agent"
        ? {
            id: `browser-use:${shell.tabId}`,
            type: "browser-use",
            ownerTaskId: shell.sessionId,
            workspaceKey: shell.workspaceKey,
            ...(shell.remoteSessionId ? { remoteSessionId: shell.remoteSessionId } : {}),
            sessionId: shell.sessionId,
            tabId: shell.tabId,
            browserId: shell.browserId,
            browserGeneration: shell.browserGeneration,
            openedAt: shell.openedAt,
            title: shell.title,
            faviconUrl: shell.faviconUrl,
            residency: "suspended",
            residencyGeneration: 0,
          }
        : {
            id: shell.tabId,
            type: "browser",
            // Root cause: draft state uses null for the in-memory owner, while IPC/persistence encodes
            // it as "unscoped." Cold restore must decode it symmetrically; otherwise the tab is restored
            // into state but permanently hidden by the draft scope.
            ownerTaskId: shell.sessionId === "unscoped" ? null : shell.sessionId,
            workspaceKey: shell.workspaceKey,
            ...(shell.remoteSessionId ? { remoteSessionId: shell.remoteSessionId } : {}),
            initialUrl: shell.restoreUrl,
            title: shell.title,
            faviconUrl: shell.faviconUrl,
            openedAt: shell.openedAt,
            residency: "suspended",
            residencyGeneration: 0,
          };
    next = {
      tabs: [...next.tabs, tab],
      activeTabId: next.activeTabId || tab.id,
    };
  }
  if (scope && !hadActiveTabInScope) {
    const preferred = shells
      .filter(
        (shell) =>
          shell.workspaceKey === scope.workspaceKey &&
          (shell.remoteSessionId ?? "") === (scope.remoteSessionId ?? "") &&
          shell.sessionId === scope.sessionId,
      )
      .sort(
        (left, right) =>
          (right.lastSelectedAt ?? Number.NEGATIVE_INFINITY) -
            (left.lastSelectedAt ?? Number.NEGATIVE_INFINITY) ||
          left.openedAt - right.openedAt ||
          left.tabId.localeCompare(right.tabId),
      )[0];
    if (preferred) {
      // Root cause: the old restore activated the first tab by openedAt and ignored persisted
      // lastSelectedAt. Keep tab-strip order by openedAt, but separately select the most recently
      // used tab in the current scope.
      next = {
        ...next,
        activeTabId:
          preferred.origin === "agent" ? `browser-use:${preferred.tabId}` : preferred.tabId,
      };
    }
  }
  return next;
}

export function openCodeViewerSidePane(
  current: WorkspaceSidePaneState | null,
  source: CodeViewerSource,
  ownerTaskId?: string | null,
): WorkspaceSidePaneState {
  // Repeated clicks on the same file/image in a message must not replace the entire right pane and discard
  // content the user was viewing in another pane. Reuse an existing code-viewer tab by stable sourceKey to
  // avoid duplicate same-named tabs and refresh to the latest source when reopened.
  const nextTab = createCodeViewerSidePaneTab(source);
  if (!current || nextTab.sourceKey === null) {
    return activateSidePaneTab(current, nextTab);
  }

  const ownerKey = sidePaneOwnerKey(ownerTaskId);
  const matchedTab = current.tabs.find(
    (tab): tab is CodeViewerSidePaneTab =>
      tab.type === "code-viewer" &&
      tab.sourceKey === nextTab.sourceKey &&
      sidePaneOwnerKey(tab.ownerTaskId) === ownerKey,
  );
  return activateSidePaneTab(
    current,
    matchedTab ? { ...matchedTab, source: nextTab.source } : nextTab,
  );
}

/**
 * Open a batch of code-preview tabs in one operation.
 *
 * When automatically opening generated artifacts, do not call openCodeViewerSidePane for each one: each
 * commit would expose an intermediate right-pane state, and the last tab would become active by accident.
 * Reuse the single-file sourceKey/owner rules for the batch, then activate a tab in the order specified by
 * the caller.
 */
export function openCodeViewerSidePanes(
  current: WorkspaceSidePaneState | null,
  sources: readonly CodeViewerSource[],
  ownerTaskId?: string | null,
  activeIndex = 0,
): WorkspaceSidePaneState {
  if (sources.length === 0) {
    return current ?? { tabs: [], activeTabId: "" };
  }

  let next: WorkspaceSidePaneState | null = current;
  const openedTabIds: string[] = [];
  const seenSourceKeys = new Set<string>();

  for (const source of sources) {
    const normalizedSource = normalizeCodeViewerSource(source);
    const sourceKey = getCodeViewerTabSourceKey(normalizedSource);
    // sourceKey is a stable workspace-scoped identity; open a repeated path only once per batch.
    if (sourceKey !== null && seenSourceKeys.has(sourceKey)) continue;
    if (sourceKey !== null) seenSourceKeys.add(sourceKey);

    next = openCodeViewerSidePane(next, normalizedSource, ownerTaskId);
    const activeTab = getActiveSidePaneTab(next);
    if (activeTab?.type === "code-viewer") {
      openedTabIds.push(activeTab.id);
    }
  }

  if (!next || openedTabIds.length === 0) {
    return next ?? { tabs: [], activeTabId: "" };
  }

  const safeIndex = Math.min(Math.max(activeIndex, 0), openedTabIds.length - 1);
  return {
    ...next,
    activeTabId: openedTabIds[safeIndex]!,
  };
}

export function activateGitSidePane(
  current: WorkspaceSidePaneState | null,
): WorkspaceSidePaneState {
  return activateSidePaneTab(current, createGitSidePaneTab());
}

export function activateTreemappingSidePane(
  current: WorkspaceSidePaneState | null,
  source?: TreemappingSidePaneSource,
): WorkspaceSidePaneState {
  return activateSidePaneTab(current, createTreemappingSidePaneTab(source));
}

export function openWhiteboardSidePane(
  current: WorkspaceSidePaneState | null,
  options: {
    boardId: string;
    title: string;
  },
): WorkspaceSidePaneState {
  return activateSidePaneTab(current, createWhiteboardSidePaneTab(options));
}

export function openModelTrajectorySidePane(
  current: WorkspaceSidePaneState | null,
  options: {
    taskId: string;
    title?: string | null;
  },
): WorkspaceSidePaneState {
  return activateSidePaneTab(current, createModelTrajectorySidePaneTab(options));
}

export function activateDeveloperToolsSidePane(
  current: WorkspaceSidePaneState | null,
): WorkspaceSidePaneState {
  return activateSidePaneTab(current, createDeveloperToolsSidePaneTab());
}

export function openTerminalSidePane(
  current: WorkspaceSidePaneState | null,
  options: { title: string; cwd?: string; remoteSessionId?: string | null },
): WorkspaceSidePaneState {
  return activateSidePaneTab(current, createTerminalSidePaneTab(options));
}

export function openSubagentSessionSidePane(
  current: WorkspaceSidePaneState | null,
  options: {
    workspaceKey: string;
    workspacePath: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
    rootSessionId?: string;
    parentSessionId: string;
    childSessionId: string;
    subagentType: string;
    title: string;
  },
): WorkspaceSidePaneState {
  const nextTab = createSubagentSessionSidePaneTab(options);
  const existing = current?.tabs.find(
    (tab): tab is SubagentSessionSidePaneTab =>
      tab.type === "subagent-session" && tab.id === nextTab.id,
  );
  const nextTitle = options.title.trim();
  return activateSidePaneTab(
    current,
    existing
      ? {
          ...existing,
          workspacePath: options.workspacePath,
          ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
          ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
          rootSessionId: options.rootSessionId ?? options.parentSessionId,
          parentSessionId: options.parentSessionId,
          subagentType: options.subagentType,
          // HMR may reuse an in-memory tab with the old structure. Preserve its known title when the new
          // entry has no title, but never fall back to the old type + ordinal display rule.
          title: nextTitle || existing.title || "",
        }
      : nextTab,
  );
}

export function openSubagentDirectorySidePane(
  current: WorkspaceSidePaneState | null,
  options: {
    workspaceKey: string;
    workspacePath: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
    rootSessionId?: string;
    parentSessionId: string;
  },
): WorkspaceSidePaneState {
  const nextTab = createSubagentDirectorySidePaneTab(options);
  const existing = current?.tabs.find(
    (tab): tab is SubagentDirectorySidePaneTab =>
      tab.type === "subagent-directory" && tab.id === nextTab.id,
  );
  return activateSidePaneTab(current, existing ? { ...existing, ...nextTab } : nextTab);
}

export function syncSubagentSessionSidePaneTabs(
  current: WorkspaceSidePaneState | null,
  options: SyncSubagentSessionTabsRequest,
): WorkspaceSidePaneState | null {
  if (!current) return null;
  const validChildSessionIds = new Set(options.validChildSessionIds);
  const removedTabs = current.tabs.filter(
    (tab) =>
      tab.type === "subagent-session" &&
      tab.rootSessionId === options.rootSessionId &&
      tab.parentSessionId === options.parentSessionId &&
      !validChildSessionIds.has(tab.childSessionId),
  );
  if (removedTabs.length === 0) return current;
  const removedIds = new Set(removedTabs.map((tab) => tab.id));
  const tabs = current.tabs.filter((tab) => !removedIds.has(tab.id));
  if (tabs.length === 0) return null;
  if (!removedIds.has(current.activeTabId)) return { ...current, tabs };
  const directory = tabs.find(
    (tab) => tab.type === "subagent-directory" && tab.rootSessionId === options.rootSessionId,
  );
  if (directory) return { tabs, activeTabId: directory.id };
  const removedIndex = current.tabs.findIndex((tab) => tab.id === current.activeTabId);
  const previous = tabs[Math.max(0, Math.min(removedIndex - 1, tabs.length - 1))];
  return { tabs, activeTabId: previous?.id ?? tabs.at(-1)!.id };
}

export function openSelectionSideChatPane(
  current: WorkspaceSidePaneState | null,
  options: OpenSelectionSideChatRequest & { workspaceKey: string },
): WorkspaceSidePaneState {
  const existing = current?.tabs.find(
    (tab): tab is SelectionSideChatPaneTab =>
      tab.type === "selection-side-chat" &&
      tab.workspaceKey === options.workspaceKey &&
      tab.parentSessionId === options.parentSessionId &&
      tab.childSessionId === options.childSessionId,
  );
  const ordinal =
    existing?.ordinal ??
    getNextSelectionSideChatOrdinal(
      current?.tabs ?? [],
      options.workspaceKey,
      options.parentSessionId,
    );
  const nextTab = createSelectionSideChatPaneTab({ ...options, ordinal });
  return activateSidePaneTab(current, existing ? { ...existing, ...nextTab } : nextTab);
}

function getNextSelectionSideChatOrdinal(
  tabs: readonly WorkspaceSidePaneTab[],
  workspaceKey: string,
  parentSessionId: string,
): number {
  const used = new Set(
    tabs.flatMap((tab) =>
      tab.type === "selection-side-chat" &&
      tab.workspaceKey === workspaceKey &&
      tab.parentSessionId === parentSessionId
        ? [tab.ordinal]
        : [],
    ),
  );
  let ordinal = 1;
  while (used.has(ordinal)) ordinal += 1;
  return ordinal;
}

export function getActiveSelectionSideChatTab(
  current: WorkspaceSidePaneState | null,
  scope: { workspaceKey: string; parentSessionId: string },
): SelectionSideChatPaneTab | null {
  const active = getActiveSidePaneTab(current);
  return active?.type === "selection-side-chat" &&
    active.workspaceKey === scope.workspaceKey &&
    active.parentSessionId === scope.parentSessionId
    ? active
    : null;
}

export function openPlanDetailSidePane(
  current: WorkspaceSidePaneState | null,
  options: OpenScopedPlanDetailSideTabRequest & { workspaceKey: string },
): WorkspaceSidePaneState {
  const nextTab = createPlanDetailSidePaneTab(options);
  const existing = current?.tabs.find(
    (tab): tab is PlanDetailSidePaneTab => tab.type === "plan-detail" && tab.id === nextTab.id,
  );
  // Keep one tab per toolCall. On another click, refresh the fallback from the card's current body; the
  // detail component still treats the parent conversation projection as the source of truth for live content.
  if (!existing) return activateSidePaneTab(current, nextTab);
  const merged: PlanDetailSidePaneTab = { ...existing, ...nextTab };
  if (nextTab.rootSessionId === undefined) delete merged.rootSessionId;
  return activateSidePaneTab(current, merged);
}

/**
 * Open or reuse a workflow-run detail tab.
 *
 * Reuse follows the same structural-ID idempotency rule as plan-detail, and intentionally has **no GC**:
 * event logs come from the journal, while the `workflowRuns` projection keeps only the latest 8 runs. An
 * evicted run can still have a fully readable event log, which is exactly when the user may keep this tab.
 * If the projection is missing, the detail page falls back to its empty state without closing the tab.
 */
export function openWorkflowRunSidePane(
  current: WorkspaceSidePaneState | null,
  options: OpenScopedWorkflowRunSideTabRequest & { workspaceKey: string },
): WorkspaceSidePaneState {
  const nextTab = createWorkflowRunSidePaneTab(options);
  const existing = current?.tabs.find(
    (tab): tab is WorkflowRunSidePaneTab => tab.type === "workflow-run" && tab.id === nextTab.id,
  );
  if (existing === undefined) return activateSidePaneTab(current, nextTab);
  // Recompute the destination each time, following the script-transcript tab rule: use phaseId when supplied
  // and explicitly delete the key when omitted. Refresh `openedAt` on each open so clicking the same station
  // again scrolls to it again.
  const merged: WorkflowRunSidePaneTab = { ...existing, ...nextTab };
  if (nextTab.focusPhaseId === undefined) delete merged.focusPhaseId;
  return activateSidePaneTab(current, merged);
}

/**
 * Replace a run tab in place after “Configure” is accepted: swap the old run's tab for the new one while
 * keeping its position, name, and ownership. Make the new tab active only if the old one was active. If the
 * new run's tab is already open, close the old tab and focus the existing one rather than creating a pair.
 * If the old tab is absent (the user already closed it), return unchanged—replacement is not opening. The
 * same applies when the result run is the one being replaced (an in-place revision has no successor): this
 * tab already represents it.
 */
export function replaceWorkflowRunSidePane(
  current: WorkspaceSidePaneState | null,
  options: OpenScopedWorkflowRunSideTabRequest & { workspaceKey: string; replaceRunId: string },
): WorkspaceSidePaneState | null {
  if (current === null) return current;
  const nextTab = createWorkflowRunSidePaneTab(options);
  const replaceRunId = options.replaceRunId;
  const index = current.tabs.findIndex(
    (tab) =>
      tab.type === "workflow-run" &&
      tab.workspaceKey === nextTab.workspaceKey &&
      tab.parentSessionId === nextTab.parentSessionId &&
      tab.runId === replaceRunId,
  );
  const previous = current.tabs[index];
  if (index < 0 || previous?.type !== "workflow-run") return current;
  // A retune applied in place (only the concurrency ceiling changed while the run was active;
  // docs/dynamic-workflow/concurrency.md) has no successor, so the result's runId is the same run
  // being replaced. Tab ids are derived only from runId; without this guard, the “new tab already
  // open” branch below would mistake itself for the old tab and close it, leaving activeTabId pointing to a nonexistent tab.
  if (nextTab.id === previous.id) return current;
  const wasActive = current.activeTabId === previous.id;
  const existingIndex = findTabIndexById(current.tabs, nextTab.id);
  if (existingIndex >= 0) {
    const tabs = current.tabs.filter((_, tabIndex) => tabIndex !== index);
    return { tabs, activeTabId: wasActive ? nextTab.id : current.activeTabId };
  }
  const replaced: WorkflowRunSidePaneTab = {
    ...nextTab,
    ...(previous.ownerTaskId === undefined ? {} : { ownerTaskId: previous.ownerTaskId }),
    ...(nextTab.workflowName === undefined && previous.workflowName !== undefined
      ? { workflowName: previous.workflowName }
      : {}),
  };
  const tabs = [...current.tabs];
  tabs[index] = replaced;
  return { tabs, activeTabId: wasActive ? replaced.id : current.activeTabId };
}

/**
 * Open or reuse a run-directory tab for a conversation. Identity is the conversation, so repeated clicks on its footer row only focus the tab.
 *
 * There is likewise **no GC** (for the same reasons as workflow-run): the directory page rereads a journal
 * page each time it mounts, so a restored old tab does not show a stale list and has nothing to reclaim.
 */
export function openWorkflowRunDirectorySidePane(
  current: WorkspaceSidePaneState | null,
  options: OpenScopedWorkflowRunDirectorySideTabRequest & { workspaceKey: string },
): WorkspaceSidePaneState {
  const nextTab = createWorkflowRunDirectorySidePaneTab(options);
  const existing = current?.tabs.find(
    (tab): tab is WorkflowRunDirectorySidePaneTab =>
      tab.type === "workflow-directory" && tab.id === nextTab.id,
  );
  return activateSidePaneTab(current, existing ? { ...existing, ...nextTab } : nextTab);
}

/**
 * Open or reuse an actor-transcript tab.
 *
 * Reuse follows the same structural-ID idempotency rule as workflow-run, and likewise has **no GC**: actor
 * sessions remain readable after a run ends, which is one benefit of making them real persistent sessions.
 * See the comment on the type.
 *
 * During merging, keys omitted from the new request do not overwrite old values: opening first from an
 * unstarted pill (without a session ID) and later from a started pill (with a session ID) adds the session;
 * opening again from a request without a session does not erase the known session ID.
 */
export function openWorkflowActorSessionSidePane(
  current: WorkspaceSidePaneState | null,
  options: OpenScopedWorkflowActorSessionSideTabRequest & { workspaceKey: string },
): WorkspaceSidePaneState {
  const nextTab = createWorkflowActorSessionSidePaneTab(options);
  const existing = current?.tabs.find(
    (tab): tab is WorkflowActorSessionSidePaneTab =>
      tab.type === "workflow-actor-session" && tab.id === nextTab.id,
  );
  return activateSidePaneTab(current, existing ? { ...existing, ...nextTab } : nextTab);
}

/**
 * Open or reuse a script-transcript tab for a run.
 *
 * Recompute the destination **on every open**: clicking a script pill again means “take me to that station.”
 * Use phaseId when supplied and clear it when omitted (explicitly delete the key, as
 * `openWorkflowArtifactSidePane` does for version). Refresh `openedAt` each time so clicking the same
 * station again scrolls to it again.
 */
export function openWorkflowWorkspaceSidePane(
  current: WorkspaceSidePaneState | null,
  options: OpenScopedWorkflowWorkspaceSideTabRequest & { workspaceKey: string },
): WorkspaceSidePaneState {
  const nextTab = createWorkflowWorkspaceSidePaneTab(options);
  const existing = current?.tabs.find(
    (tab): tab is WorkflowWorkspaceSidePaneTab =>
      tab.type === "workflow-workspace" && tab.id === nextTab.id,
  );
  if (existing === undefined) return activateSidePaneTab(current, nextTab);
  const merged: WorkflowWorkspaceSidePaneTab = { ...existing, ...nextTab };
  if (nextTab.focusPhaseId === undefined) delete merged.focusPhaseId;
  return activateSidePaneTab(current, merged);
}

/**
 * Open or reuse a full-size tab for an artifact.
 *
 * When reusing a tab, **do not preserve its old version**: clicking a chip again means “show me this
 * artifact,” and chips never carry a version number, so an omitted `version` in the merged result returns to
 * the latest version. Conversely, if a request explicitly includes a version (for example, to jump to a
 * specific version), that version is the destination.
 */
export function openWorkflowArtifactSidePane(
  current: WorkspaceSidePaneState | null,
  options: OpenScopedWorkflowArtifactSideTabRequest & { workspaceKey: string },
): WorkspaceSidePaneState {
  const nextTab = createWorkflowArtifactSidePaneTab(options);
  const existing = current?.tabs.find(
    (tab): tab is WorkflowArtifactSidePaneTab =>
      tab.type === "workflow-artifact" && tab.id === nextTab.id,
  );
  if (existing === undefined) return activateSidePaneTab(current, nextTab);
  // **Drop the old tab's version** during merging: keys omitted from `...nextTab` do not overwrite old
  // values, which would silently break the “chip has no version ⇒ show latest” behavior (a tab at v1 would
  // still show v1 after another click). Delete the key explicitly so omission is real.
  const merged: WorkflowArtifactSidePaneTab = { ...existing, ...nextTab };
  if (nextTab.version === undefined) delete merged.version;
  return activateSidePaneTab(current, merged);
}

export function isSidePaneTabVisibleForParent(
  tab: WorkspaceSidePaneTab,
  parentSessionId: string | null,
): boolean {
  if (tab.type === "browser-use") {
    return tab.sessionId === parentSessionId;
  }
  // Narrow tabs owned by a conversation (rather than the whole workspace) by parentSessionId.
  if (
    tab.type === "selection-side-chat" ||
    tab.type === "plugin-ui" ||
    tab.type === "workflow-run" ||
    tab.type === "workflow-directory" ||
    tab.type === "workflow-actor-session" ||
    tab.type === "workflow-workspace" ||
    tab.type === "workflow-artifact"
  ) {
    return tab.parentSessionId === parentSessionId;
  }
  if (tab.type === "plan-detail") {
    // 子会话 projection 标识不能替代 side chat 所属的根任务可见范围。
    return (tab.rootSessionId ?? tab.parentSessionId) === parentSessionId;
  }
  if (
    tab.type === "subagent-session" ||
    tab.type === "subagent-directory" ||
    tab.type === "bash-output"
  ) {
    return tab.rootSessionId === parentSessionId;
  }
  return true;
}

export function getVisibleSidePaneTabs(
  tabs: WorkspaceSidePaneTab[],
  scope: SidePaneVisibilityScope,
): WorkspaceSidePaneTab[];
export function getVisibleSidePaneTabs(
  current: WorkspaceSidePaneState | null,
  parentSessionId: string | null,
): WorkspaceSidePaneTab[];
export function getVisibleSidePaneTabs(
  input: WorkspaceSidePaneTab[] | WorkspaceSidePaneState | null,
  scopeOrParent: SidePaneVisibilityScope | string | null,
): WorkspaceSidePaneTab[] {
  if (Array.isArray(input)) {
    return getVisibleSidePaneTabsByScope(input, scopeOrParent as SidePaneVisibilityScope);
  }
  const parentSessionId = scopeOrParent as string | null;
  return input?.tabs.filter((tab) => isSidePaneTabVisibleForParent(tab, parentSessionId)) ?? [];
}

export function selectSidePaneTabsForParent(
  current: WorkspaceSidePaneState | null,
  parentSessionId: string | null,
  preferredTabId?: string | null,
): WorkspaceSidePaneState | null {
  if (!current) return null;
  const visibleTabs = getVisibleSidePaneTabs(current, parentSessionId);
  if (visibleTabs.length === 0) {
    return current.activeTabId === "" ? current : { ...current, activeTabId: "" };
  }
  const preferred = preferredTabId
    ? visibleTabs.find((tab) => tab.id === preferredTabId)
    : undefined;
  const currentActive = visibleTabs.find((tab) => tab.id === current.activeTabId);
  const nextActive =
    currentActive ??
    preferred ??
    visibleTabs.findLast(
      (tab) =>
        tab.type === "subagent-session" ||
        tab.type === "subagent-directory" ||
        tab.type === "selection-side-chat" ||
        tab.type === "plan-detail" ||
        tab.type === "workflow-run" ||
        tab.type === "workflow-actor-session" ||
        tab.type === "workflow-workspace" ||
        tab.type === "workflow-artifact",
    ) ??
    visibleTabs.at(-1);
  return nextActive && nextActive.id !== current.activeTabId
    ? { ...current, activeTabId: nextActive.id }
    : current;
}

export function closeVisibleOtherSidePaneTabs(
  current: WorkspaceSidePaneState | null,
  tabId: string,
  parentSessionId: string | null,
): WorkspaceSidePaneState | null {
  if (!current) return null;
  const visibleTabs = getVisibleSidePaneTabs(current, parentSessionId);
  const target = visibleTabs.find((tab) => tab.id === tabId);
  if (!target) return current;
  const closingIds = new Set(visibleTabs.filter((tab) => tab.id !== tabId).map((tab) => tab.id));
  return {
    tabs: current.tabs.filter((tab) => !closingIds.has(tab.id)),
    activeTabId: target.id,
  };
}

export function closeVisibleSidePaneTabs(
  current: WorkspaceSidePaneState | null,
  parentSessionId: string | null,
): WorkspaceSidePaneState | null {
  if (!current) return null;
  const closingIds = new Set(getVisibleSidePaneTabs(current, parentSessionId).map((tab) => tab.id));
  const tabs = current.tabs.filter((tab) => !closingIds.has(tab.id));
  return tabs.length === 0 ? null : { tabs, activeTabId: "" };
}

export function closeSidePaneTabForParent(
  current: WorkspaceSidePaneState | null,
  tabId: string,
  parentSessionId: string | null,
  preferredTabId?: string | null,
): WorkspaceSidePaneState | null {
  const next = closeSidePaneTab(current, tabId);
  return selectSidePaneTabsForParent(next, parentSessionId, preferredTabId);
}

export function closeSidePaneTab(
  current: WorkspaceSidePaneState | null,
  tabId: string,
): WorkspaceSidePaneState | null {
  if (!current) {
    return null;
  }

  const closingIndex = findTabIndexById(current.tabs, tabId);
  if (closingIndex < 0) {
    return current;
  }

  const nextTabs = current.tabs.filter((tab) => tab.id !== tabId);
  if (nextTabs.length === 0) {
    return null;
  }

  if (current.activeTabId !== tabId) {
    return {
      tabs: nextTabs,
      activeTabId: current.activeTabId,
    };
  }

  const fallbackIndex = Math.min(closingIndex, nextTabs.length - 1);
  return {
    tabs: nextTabs,
    activeTabId: nextTabs[fallbackIndex]!.id,
  };
}

export function closeOtherSidePaneTabs(
  current: WorkspaceSidePaneState | null,
  tabId: string,
): WorkspaceSidePaneState | null {
  if (!current) {
    return null;
  }

  const targetTab = current.tabs.find((tab) => tab.id === tabId);
  if (!targetTab || current.tabs.length <= 1) {
    return current;
  }

  return {
    // Interaction: for “Close other tabs,” keep the tab that was right-clicked. Activate it even if
    // it was not previously active, so the content area does not point to an activeTabId that was removed.
    tabs: [targetTab],
    activeTabId: targetTab.id,
  };
}

export function closeAllSidePaneTabs(): WorkspaceSidePaneState | null {
  return null;
}

export function setActiveSidePaneTab(
  current: WorkspaceSidePaneState | null,
  tabId: string,
): WorkspaceSidePaneState | null {
  if (!current || !current.tabs.some((tab) => tab.id === tabId)) {
    return current;
  }

  return {
    ...current,
    activeTabId: tabId,
  };
}

export function updateBrowserSidePaneTab(
  current: WorkspaceSidePaneState | null,
  tabId: string,
  patch: BrowserSidePaneMetadata,
): WorkspaceSidePaneState | null {
  if (!current) {
    return current;
  }

  let didUpdate = false;
  const nextTabs = current.tabs.map((tab) => {
    if (tab.id !== tabId) {
      return tab;
    }
    if (tab.type === "browser" || tab.type === "browser-use") {
      didUpdate = true;
      return { ...tab, ...patch };
    }
    return tab;
  });

  return didUpdate
    ? {
        ...current,
        tabs: nextTabs,
      }
    : current;
}

/** Match runtime state by workspace/session/browser generation/tab to prevent stale runs from writing across scopes. */
export function markBrowserUseSidePaneTabOperation(
  current: WorkspaceSidePaneState | null,
  options: {
    workspaceKey: string;
    sessionId: string;
    browserId: string;
    browserGeneration: number;
    tabId: string;
    operationUntil: number;
    resetsResizeBaseline?: boolean;
  },
): WorkspaceSidePaneState | null {
  if (!current) return current;
  let didUpdate = false;
  const tabs = current.tabs.map((tab) => {
    if (
      tab.type !== "browser-use" ||
      tab.workspaceKey !== options.workspaceKey ||
      tab.sessionId !== options.sessionId ||
      (tab.browserId !== undefined && tab.browserId !== options.browserId) ||
      (tab.browserGeneration !== undefined &&
        tab.browserGeneration !== options.browserGeneration) ||
      tab.tabId !== options.tabId
    ) {
      return tab;
    }
    didUpdate = true;
    return {
      ...tab,
      browserUseOperationUntil: options.operationUntil,
      ...(options.resetsResizeBaseline
        ? {
            browserUseResizeBaselineVersion: (tab.browserUseResizeBaselineVersion ?? 0) + 1,
          }
        : {}),
    };
  });
  return didUpdate ? { ...current, tabs } : current;
}

export function reorderSidePaneTab(
  current: WorkspaceSidePaneState | null,
  activeTabId: string,
  overTabId: string,
): WorkspaceSidePaneState | null {
  if (!current || activeTabId === overTabId) {
    return current;
  }

  const activeIndex = findTabIndexById(current.tabs, activeTabId);
  const overIndex = findTabIndexById(current.tabs, overTabId);
  if (activeIndex < 0 || overIndex < 0) {
    return current;
  }

  const nextTabs = [...current.tabs];
  const [movedTab] = nextTabs.splice(activeIndex, 1);
  if (!movedTab) {
    return current;
  }

  nextTabs.splice(overIndex, 0, movedTab);
  return {
    ...current,
    tabs: nextTabs,
  };
}

export function toggleBrowserSidePane(
  current: WorkspaceSidePaneState | null,
  ownerTaskId?: string | null,
  remoteSessionId?: string | null,
): WorkspaceSidePaneState | null {
  const ownerKey = sidePaneOwnerKey(ownerTaskId);
  const activeTab = getActiveSidePaneTab(current);
  if (activeTab?.type === "browser" && sidePaneOwnerKey(activeTab.ownerTaskId) === ownerKey) {
    return closeSidePaneTab(current, activeTab.id);
  }

  return activateBrowserSidePane(current, {
    ownerTaskId,
    ...(remoteSessionId ? { remoteSessionId } : {}),
  });
}

export function toggleGitSidePane(
  current: WorkspaceSidePaneState | null,
): WorkspaceSidePaneState | null {
  const activeTab = getActiveSidePaneTab(current);
  if (activeTab?.type === "git") {
    return closeSidePaneTab(current, activeTab.id);
  }

  return activateGitSidePane(current);
}

export function closeCodeViewerSidePane(
  current: WorkspaceSidePaneState | null,
): WorkspaceSidePaneState | null {
  const activeTab = getActiveSidePaneTab(current);
  return activeTab?.type === "code-viewer" ? closeSidePaneTab(current, activeTab.id) : current;
}

export function closeGitSidePane(
  current: WorkspaceSidePaneState | null,
): WorkspaceSidePaneState | null {
  return closeSidePaneTab(current, "git");
}

export function openBackgroundBashSidePane(
  current: WorkspaceSidePaneState | null,
  target: OpenBackgroundBashSideTabRequest,
): WorkspaceSidePaneState {
  const workspaceKey = target.workspaceIdentity?.trim() || target.workspacePath;
  const id =
    "bash-output:" +
    [
      workspaceKey,
      target.remoteSessionId ?? "",
      target.rootSessionId,
      target.sessionId,
      target.workId,
    ]
      .map(encodeSidePaneTabIdPart)
      .join(":");
  const existing = current?.tabs.find((tab) => tab.id === id);
  return activateSidePaneTab(
    current,
    existing ?? {
      ...target,
      id,
      type: "bash-output",
      workspaceKey,
      ownerTaskId: target.rootSessionId,
      openedAt: Date.now(),
    },
  );
}
