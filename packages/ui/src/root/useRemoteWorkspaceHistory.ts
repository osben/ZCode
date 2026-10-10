/* eslint-disable max-lines -- Remote workspace history currently coordinates restoration, reconnection, persistence, and cleanup in one hook. Keep this collaboration boundary in one file for now rather than splitting it just to satisfy lint and risking state regressions.*/
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type {
  AppSettings,
  BotRemoteWorkspaceReconnectedEvent,
  IPlatformService,
  RemoteSessionClosedEvent,
  RemoteWorkspaceSessionEntry,
} from "@zcode/shared";
import { buildSshRemoteHostKey, createUuid, stripRemoteTargetSecrets } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import {
  bindRemoteWorkspaceIdentity,
  bindRemoteWorkspacePath,
  getRemoteWorkspaceSession,
  type RemoteWorkspaceSession,
  unregisterRemoteWorkspaceSession,
} from "@/store/remoteWorkspaceSessionStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { refreshRemotePinnedTasksForSession } from "@/store/remotePinnedTaskStore.js";
import { refreshRemoteTimelineTasksForSession } from "@/store/remoteTimelineTaskStore.js";
import { toast } from "@/components/ui/toast.js";
import {
  buildRemoteWorkspaceIdentity,
  buildRemoteWorkspaceSessionMutation,
  buildWorkspaceSessionKey,
  createRemoteTargetFromSnapshot,
  getRemoteWorkspaceSessionEntries,
  removeRemoteWorkspaceSessionEntries,
} from "@/lib/remoteWorkspaceHistory.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { logger } from "@/logger.js";
import { isWorkspaceTab, type TabStoreState, type WindowTabState } from "@/store/tabStore.js";
import {
  buildRemoteWorkspacePersistPatch,
  restorePersistedRemoteWorkspaceSessions,
} from "@/root/remoteWorkspaceSessionPersistence.js";
import { useReconnectingRemoteWorkspaceLogs } from "@/root/useReconnectingRemoteWorkspaceLogs.js";
import {
  reconnectRemoteWorkspaceHistoryEntry,
  type BindRemoteWorkspaceSessionContextFn,
  type ReconnectRemoteWorkspaceOptions,
  type SshReconnectCredentials,
} from "@/root/reconnectRemoteWorkspaceHistoryEntry.js";
import { useRemoteConnectionEntryVisibility } from "@/hooks/useRemoteConnectionEntryVisibility.js";
import { markRemoteWorkspaceRunningTasksFailed } from "@/lib/remoteWorkspaceSessionRuntime.js";

export { reconnectRemoteWorkspaceHistoryEntry };

async function bindRemoteWorkspaceContextAndGetSession(params: {
  platform: Pick<IPlatformService, "bindRemoteWorkspaceSessionContext">;
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}): Promise<RemoteWorkspaceSession> {
  if (!getRemoteWorkspaceSession(params.sessionId)) {
    throw new Error(`远程 workspace session 不存在: ${params.sessionId}`);
  }
  await params.platform.bindRemoteWorkspaceSessionContext?.({
    remoteSessionId: params.sessionId,
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity,
  });
  // bind replaces the attachment/services generation for the same remoteSessionId from A to B.
  // Objects captured before bind still point to A, so read the current services by sessionId after the ready ACK.
  const currentSession = getRemoteWorkspaceSession(params.sessionId);
  if (!currentSession) {
    throw new Error(`远程 workspace session 不存在: ${params.sessionId}`);
  }
  return currentSession;
}

function resolveBotRemoteWorkspaceReconnectedIdentity(params: {
  event: Pick<BotRemoteWorkspaceReconnectedEvent, "workspaceIdentity">;
  resolvedWorkspacePath: string;
  target: BotRemoteWorkspaceReconnectedEvent["target"];
}): string {
  const eventWorkspaceIdentity = params.event.workspaceIdentity.trim();
  if (eventWorkspaceIdentity) {
    // Bugfix: Bot task/stream broadcasts continue using the workspaceIdentity captured in bot context.
    // Recomputing identity from the canonical path here would make the UI tab subscribe to another key and filter out remote results.
    return eventWorkspaceIdentity;
  }
  return buildRemoteWorkspaceIdentity(params.resolvedWorkspacePath, params.target);
}

function shouldPersistRemoteWorkspaceFailure(params: {
  pendingReconnectRequestIds: ReadonlyMap<string, string>;
  sessionEntry: RemoteWorkspaceSessionEntry;
  workspaceKey: string;
}): boolean {
  if (params.sessionEntry.target.kind !== "wsl") {
    return true;
  }

  // During intermittent WSL disconnects, the old session's close event may arrive after a manual reconnect.
  // If this workspace already has a pending reconnect, do not persist failed in settings yet;
  // let the outcome of this reconnect determine the final state.
  return !params.pendingReconnectRequestIds.has(params.workspaceKey);
}
interface RemoteWorkspaceTabStoreReader {
  getState(): {
    tabs: WindowTabState[];
  };
}

interface OpenRemoteWorkspaceFromHistoryParams {
  workspaceKey: string;
  tabStoreApi: RemoteWorkspaceTabStoreReader;
  getRemoteSessions: () => RemoteWorkspaceSessionEntry[];
  inflightReconnectWorkspaceKeys: Set<string>;
  activateTabByPath: (workspacePath: string, options?: { workspaceIdentity?: string }) => boolean;
  setReconnectingRemoteWorkspaceKeys: Dispatch<SetStateAction<string[]>>;
  loadCredential: IServiceAccessor["credentialService"]["load"];
  connectRemoteWorkspaceTarget: (
    target: Parameters<IPlatformService["connectRemote"]>[0],
    requestId?: string,
  ) => Promise<string>;
  resolveRemoteWorkspaceCanonicalPath: (
    sessionId: string,
    workspacePath: string,
  ) => Promise<string>;
  disposeRemoteWorkspaceSession: (sessionId: string) => Promise<void>;
  bindRemoteWorkspaceSessionContext: BindRemoteWorkspaceSessionContextFn;
  addTab: (
    workspacePath: string,
    options?: {
      remoteSessionId?: string;
      remoteTarget?: Parameters<IPlatformService["connectRemote"]>[0];
      workspaceIdentity?: string;
      localWorkspacePath?: string;
    },
  ) => void;
  commitRemoteWorkspaceSessionMutation: (
    mutation: ReturnType<typeof buildRemoteWorkspaceSessionMutation>,
  ) => Promise<RemoteWorkspaceSessionEntry>;
  resetLogsForWorkspaceKey: (workspaceKey: string) => void;
  onWorkspaceActivated?: (target: { workspacePath: string; workspaceIdentity: string }) => void;
  createReconnectRequestId?: () => string;
  pendingReconnectRequestIds?: Map<string, string>;
  reconnectImpl?: typeof reconnectRemoteWorkspaceHistoryEntry;
}

interface ReconnectRemoteWorkspaceByKeyParams {
  workspaceKey: string;
  canUseRemoteWorkspace: boolean;
  getRemoteSessions: () => RemoteWorkspaceSessionEntry[];
  runReconnectRemoteWorkspace: (
    sessionEntry: RemoteWorkspaceSessionEntry,
    options?: ReconnectRemoteWorkspaceOptions,
  ) => Promise<void>;
  options?: ReconnectRemoteWorkspaceOptions;
}

async function reconnectRemoteWorkspaceByKey({
  workspaceKey,
  canUseRemoteWorkspace,
  getRemoteSessions,
  runReconnectRemoteWorkspace,
  options,
}: ReconnectRemoteWorkspaceByKeyParams): Promise<boolean> {
  if (!canUseRemoteWorkspace) {
    throw new Error("Remote workspace is disabled in this mode");
  }

  const sessionEntry = getRemoteSessions().find(
    (entry) => buildWorkspaceSessionKey(entry) === workspaceKey,
  );
  if (!sessionEntry) {
    throw new Error(`远程 workspace 不在当前窗口中，无法重连: ${workspaceKey}`);
  }

  await runReconnectRemoteWorkspace(sessionEntry, options);
  return true;
}

function collectSshReconnectGroup(params: {
  selected: RemoteWorkspaceSessionEntry;
  sessions: RemoteWorkspaceSessionEntry[];
  tabs: WindowTabState[];
}): RemoteWorkspaceSessionEntry[] {
  if (params.selected.target.kind !== "ssh") {
    return [params.selected];
  }
  const remoteHostKey = buildSshRemoteHostKey(params.selected.target);
  const disconnectedWorkspaceKeys = new Set(
    params.tabs.flatMap((tab) => {
      if (!isWorkspaceTab(tab) || tab.remoteSessionId) {
        return [];
      }
      return [buildWorkspaceSessionKey(tab)];
    }),
  );
  const reconnectGroup = params.sessions.filter(
    (entry) =>
      entry.target.kind === "ssh" &&
      buildSshRemoteHostKey(entry.target) === remoteHostKey &&
      disconnectedWorkspaceKeys.has(buildWorkspaceSessionKey(entry)),
  );
  const selectedWorkspaceKey = buildWorkspaceSessionKey(params.selected);
  if (!reconnectGroup.some((entry) => buildWorkspaceSessionKey(entry) === selectedWorkspaceKey)) {
    return [params.selected];
  }

  // History order does not identify the initiator of this reconnect. Keep the initiator first,
  // or a sibling loading credentials concurrently may create the shared Host first and cause the whole group to use stale credentials.
  return [
    params.selected,
    ...reconnectGroup.filter((entry) => buildWorkspaceSessionKey(entry) !== selectedWorkspaceKey),
  ];
}

async function reconnectRemoteWorkspaceGroup(params: {
  selected: RemoteWorkspaceSessionEntry;
  reconnectGroup: RemoteWorkspaceSessionEntry[];
  reconnectEntry: (
    entry: RemoteWorkspaceSessionEntry,
    options?: ReconnectRemoteWorkspaceOptions,
  ) => Promise<boolean>;
  options?: ReconnectRemoteWorkspaceOptions;
}): Promise<void> {
  const selectedWorkspaceKey = buildWorkspaceSessionKey(params.selected);
  const siblings = params.reconnectGroup.filter(
    (entry) => buildWorkspaceSessionKey(entry) !== selectedWorkspaceKey,
  );

  if (params.selected.target.kind !== "ssh") {
    try {
      await params.reconnectEntry(params.selected, {
        ...params.options,
        throwOnFailure: true,
      });
    } catch (error) {
      if (params.options?.throwOnFailure) {
        throw error;
      }
    }
    return;
  }

  type InitiatorHostGate =
    | { status: "ready"; credentials: SshReconnectCredentials }
    | { status: "skipped" }
    | { status: "failed"; error: unknown };
  let hostReadyCredentials: SshReconnectCredentials | undefined;
  let resolveHostReady!: (result: InitiatorHostGate) => void;
  const hostReadyPromise = new Promise<InitiatorHostGate>((resolve) => {
    resolveHostReady = resolve;
  });

  // Concurrent connections within a group can let the sibling that loads credentials first create the shared Host.
  // Let the initiator bring the Host to ready first; later provider/task initialization does not block sibling attachment.
  const initiatorPromise = params.reconnectEntry(params.selected, {
    ...params.options,
    throwOnFailure: true,
    onSshHostReady: (credentials) => {
      if (hostReadyCredentials) {
        return;
      }
      hostReadyCredentials = credentials;
      resolveHostReady({ status: "ready", credentials });
    },
  });
  const initiatorFinishedBeforeReady = initiatorPromise.then<InitiatorHostGate, InitiatorHostGate>(
    (didReconnect) => {
      if (hostReadyCredentials) {
        return { status: "ready", credentials: hostReadyCredentials };
      }
      return didReconnect
        ? {
            status: "failed",
            error: new Error("SSH initiator completed without reporting Host ready"),
          }
        : { status: "skipped" };
    },
    (error: unknown) =>
      hostReadyCredentials
        ? { status: "ready", credentials: hostReadyCredentials }
        : { status: "failed", error },
  );
  const hostGate = await Promise.race([hostReadyPromise, initiatorFinishedBeforeReady]);
  if (hostGate.status !== "ready") {
    if (hostGate.status === "failed" && params.options?.throwOnFailure) {
      throw hostGate.error;
    }
    return;
  }

  // Siblings reuse the ready Host established with the initiator's credentials instead of reading their own historical credentials.
  // Path/provider/task initialization runs in parallel with the initiator and keeps independent failure semantics.
  const siblingPromise = Promise.allSettled(
    siblings.map((entry) =>
      params.reconnectEntry(entry, {
        ...params.options,
        activateWorkspaceAfterReconnect: false,
        sshCredentialsOverride: hostGate.credentials,
      }),
    ),
  );
  const [initiatorResult] = await Promise.all([
    initiatorPromise.then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    ),
    siblingPromise,
  ]);
  if (initiatorResult.status === "rejected" && params.options?.throwOnFailure) {
    throw initiatorResult.error;
  }
}

function shouldKeepRemoteWorkspaceInTabs(params: {
  tabStoreApi: RemoteWorkspaceTabStoreReader;
  workspacePath: string;
  workspaceIdentity?: string;
}): boolean {
  const reconnectWorkspaceKey = params.workspaceIdentity?.trim() || params.workspacePath;
  return params.tabStoreApi
    .getState()
    .tabs.some(
      (tab): tab is import("@/store/tabStore.js").WorkspaceTabState =>
        isWorkspaceTab(tab) &&
        ((tab.workspaceIdentity?.trim() || tab.workspacePath) === reconnectWorkspaceKey ||
          tab.workspacePath === params.workspacePath),
    );
}

async function cancelPendingRemoteReconnectsForWorkspaceKeys(params: {
  workspaceKeys: string[];
  pendingRequestIds: Map<string, string>;
  cancelPendingRemoteConnection?: (requestId?: string) => Promise<void>;
  logger: Pick<typeof logger, "warn">;
}): Promise<void> {
  const requestIds = params.workspaceKeys.flatMap((workspaceKey) => {
    const requestId = params.pendingRequestIds.get(workspaceKey);
    if (!requestId) {
      return [];
    }

    params.pendingRequestIds.delete(workspaceKey);
    return [requestId];
  });

  if (!params.cancelPendingRemoteConnection || requestIds.length === 0) {
    return;
  }

  await Promise.all(
    requestIds.map(async (requestId) => {
      try {
        await params.cancelPendingRemoteConnection?.(requestId);
      } catch (error) {
        params.logger.warn("[Root] 取消远程 workspace 重连失败", {
          requestId,
          error,
        });
      }
    }),
  );
}

async function openRemoteWorkspaceFromHistoryEntry({
  workspaceKey,
  tabStoreApi,
  getRemoteSessions,
  inflightReconnectWorkspaceKeys,
  activateTabByPath,
  setReconnectingRemoteWorkspaceKeys,
  loadCredential,
  connectRemoteWorkspaceTarget,
  resolveRemoteWorkspaceCanonicalPath,
  disposeRemoteWorkspaceSession,
  bindRemoteWorkspaceSessionContext,
  addTab,
  commitRemoteWorkspaceSessionMutation,
  resetLogsForWorkspaceKey,
  createReconnectRequestId,
  pendingReconnectRequestIds,
  reconnectImpl = reconnectRemoteWorkspaceHistoryEntry,
  onWorkspaceActivated,
}: OpenRemoteWorkspaceFromHistoryParams): Promise<void> {
  const sessionEntry = getRemoteSessions().find(
    (entry) => buildWorkspaceSessionKey(entry) === workspaceKey,
  );
  if (!sessionEntry) {
    return;
  }

  if (inflightReconnectWorkspaceKeys.has(workspaceKey)) {
    return;
  }

  const existingWorkspaceTab = tabStoreApi
    .getState()
    .tabs.find(
      (tab): tab is import("@/store/tabStore.js").WorkspaceTabState =>
        isWorkspaceTab(tab) && buildWorkspaceSessionKey(tab) === workspaceKey,
    );
  if (existingWorkspaceTab?.remoteSessionId) {
    activateTabByPath(existingWorkspaceTab.workspacePath, {
      workspaceIdentity: existingWorkspaceTab.workspaceIdentity,
    });
    return;
  }

  // Remote history in the selection page and sidebar reconnect both restore an existing remote workspace.
  // Without a second “should this workspace remain?” check here, a success callback could restore a tab the user removed during reconnect.
  // Reuse the same shouldKeep condition so both entry points handle this race consistently.
  resetLogsForWorkspaceKey(workspaceKey);
  inflightReconnectWorkspaceKeys.add(workspaceKey);
  const requestId = createReconnectRequestId?.();
  if (requestId) {
    pendingReconnectRequestIds?.set(workspaceKey, requestId);
  }
  try {
    await reconnectImpl({
      sessionEntry,
      activateTabByPath,
      setReconnectingRemoteWorkspaceKeys,
      loadCredential,
      connectRemoteWorkspaceTarget,
      resolveRemoteWorkspaceCanonicalPath,
      disposeRemoteWorkspaceSession,
      bindRemoteWorkspaceSessionContext,
      bindRemoteWorkspacePath,
      bindRemoteWorkspaceIdentity,
      upsertWorkspaceTab: addTab,
      commitRemoteWorkspaceSessionMutation,
      getRemoteSessions,
      logger,
      toast,
      shouldKeepReconnectedWorkspace: ({ workspacePath, workspaceIdentity }) =>
        shouldKeepRemoteWorkspaceInTabs({
          tabStoreApi,
          workspacePath,
          workspaceIdentity,
        }),
      onWorkspaceActivated: (target) => {
        logger.debug("[Root] 远程历史 workspace ready，提交 tab 与 draft 激活", target);
        onWorkspaceActivated?.(target);
      },
      options: {
        // The history entry previously restored only the connected tab without committing tab activation and draft ownership,
        // so the right pane remained on the old workspace after a successful connection. The shared helper commits only after
        // services are ready and does not expose a remote-waiting tab before it has a remoteSessionId.
        activateWorkspaceAfterReconnect: true,
        showErrorToast: true,
        requestId,
      },
    });
  } finally {
    inflightReconnectWorkspaceKeys.delete(workspaceKey);
    if (requestId && pendingReconnectRequestIds?.get(workspaceKey) === requestId) {
      pendingReconnectRequestIds.delete(workspaceKey);
    }
  }
}

async function selectRemoteWorkspaceProjectFromDialog({
  canUseRemoteWorkspace,
  sessionId,
  path,
  localWorkspacePath,
  loadingMessage,
  getRemoteWorkspaceSession,
  connectionTarget,
  getWorkspaceTabs,
  resolveRemoteWorkspaceCanonicalPath,
  activateTabByPath,
  handleCancelRemoteProject,
  bindRemoteWorkspaceSessionContext,
  commitRemoteWorkspaceSessionMutation,
  getRemoteSessions,
  bindRemoteWorkspacePath,
  bindRemoteWorkspaceIdentity,
  addTab,
  onWorkspaceActivated,
  refreshPinnedTasks,
  refreshTimelineTasks,
}: {
  canUseRemoteWorkspace: boolean;
  sessionId: string;
  path: string;
  localWorkspacePath?: string;
  loadingMessage: string;
  getRemoteWorkspaceSession: (sessionId: string) => RemoteWorkspaceSession | null;
  connectionTarget?: Parameters<IPlatformService["connectRemote"]>[0];
  getWorkspaceTabs: () => WindowTabState[];
  resolveRemoteWorkspaceCanonicalPath: (
    sessionId: string,
    workspacePath: string,
  ) => Promise<string>;
  activateTabByPath: (workspacePath: string, options?: { workspaceIdentity?: string }) => boolean;
  handleCancelRemoteProject: (sessionId: string) => Promise<void>;
  bindRemoteWorkspaceSessionContext: BindRemoteWorkspaceSessionContextFn;
  commitRemoteWorkspaceSessionMutation: (
    mutation: ReturnType<typeof buildRemoteWorkspaceSessionMutation>,
  ) => Promise<RemoteWorkspaceSessionEntry>;
  getRemoteSessions: () => RemoteWorkspaceSessionEntry[];
  bindRemoteWorkspacePath: (workspacePath: string, sessionId: string) => void;
  bindRemoteWorkspaceIdentity: (workspaceIdentity: string, sessionId: string) => void;
  addTab: (
    workspacePath: string,
    options?: {
      remoteSessionId?: string;
      remoteTarget?: Parameters<IPlatformService["connectRemote"]>[0];
      workspaceIdentity?: string;
      localWorkspacePath?: string;
    },
  ) => void;
  onWorkspaceActivated?: (target: { workspacePath: string; workspaceIdentity: string }) => void;
  refreshPinnedTasks: (params: {
    sessionId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }) => Promise<void>;
  refreshTimelineTasks: (params: {
    sessionId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }) => Promise<void>;
}): Promise<void> {
  if (!canUseRemoteWorkspace) {
    throw new Error("Remote workspace is disabled in this mode");
  }

  const remoteSession = getRemoteWorkspaceSession(sessionId);
  if (!remoteSession) {
    throw new Error(loadingMessage);
  }
  const remoteTarget = connectionTarget ?? remoteSession.target;
  if (!remoteTarget) {
    // The mobile web relay reuses the remote session store only for service routing and has no local reconnect target.
    // Remote-history directory selection/persistence requires a target; block when it is missing so a bridged session without a target is not written to history.
    throw new Error(`远程 workspace session 缺少连接目标: ${sessionId}`);
  }

  const canonicalPath = await resolveRemoteWorkspaceCanonicalPath(sessionId, path);
  const workspaceIdentity = buildRemoteWorkspaceIdentity(canonicalPath, remoteTarget);
  const existingWorkspaceTab = getWorkspaceTabs().find(
    (tab): tab is import("@/store/tabStore.js").WorkspaceTabState =>
      isWorkspaceTab(tab) &&
      tab.workspacePath === canonicalPath &&
      (tab.workspaceIdentity?.trim() || tab.workspacePath) === workspaceIdentity,
  );

  if (
    existingWorkspaceTab?.remoteSessionId &&
    activateTabByPath(canonicalPath, { workspaceIdentity })
  ) {
    onWorkspaceActivated?.({ workspacePath: canonicalPath, workspaceIdentity });
    await handleCancelRemoteProject(sessionId);
    return;
  }

  // A disconnected tab was previously activated by activateTabByPath before provider/session binding completed.
  // V4PaneConversationProvider then saw remote-waiting and returned null because rpcReady=false, leaving the right pane blank
  // until a later addTab wrote remoteSessionId and a new conversation appeared.
  // For both disconnected tabs and first-time connections, wait until services are bound and let addTab activate atomically,
  // avoiding exposure of a half-connected workspace.

  // A new connection has no context, so the main/host logical session descriptor stays at the connection root "/";
  // the Host also constructs its identity from the resolved target. The tab, remote history, and mobile-visible
  // workspace list all use the canonicalPath/workspaceIdentity computed here.
  // The mobile bridge (attachRemoteWorkspaceSessionHost) requires all three values to match, so after directory
  // selection bind the canonical context back to main before committing connected state and the tab. Commit
  // df2db1df7a moved provider synchronization to main/host and accidentally removed this bind, causing the
  // selected directory after a new connection to be rejected on mobile with REMOTE_WORKSPACE_IDENTITY_MISMATCH.
  // Fail closed if bind fails: dispose the session and return the error to the connection dialog so no session remains with a mismatched descriptor and tab.
  try {
    await bindRemoteWorkspaceSessionContext({
      sessionId,
      workspacePath: canonicalPath,
      workspaceIdentity,
    });
  } catch (error) {
    await handleCancelRemoteProject(sessionId);
    throw error;
  }

  await commitRemoteWorkspaceSessionMutation(
    buildRemoteWorkspaceSessionMutation({
      remoteSessions: getRemoteSessions(),
      workspacePath: canonicalPath,
      localWorkspacePath,
      workspaceIdentity,
      target: remoteTarget,
      lastConnectionStatus: "connected",
      touchOpenedAt: true,
    }),
  );

  bindRemoteWorkspacePath(canonicalPath, sessionId);
  bindRemoteWorkspaceIdentity(workspaceIdentity, sessionId);
  addTab(canonicalPath, {
    remoteSessionId: sessionId,
    remoteTarget: stripRemoteTargetSecrets(remoteTarget),
    workspaceIdentity,
    localWorkspacePath,
  });
  // The caller previously waited for pinned/timeline refreshes before calling startDraft,
  // leaving the tab switched to remote while draft ownership still pointed to the old state and exposing a blank intermediate frame.
  // The activation callback must immediately follow addTab and commit draft state for the same workspaceKey before any list-refresh await.
  onWorkspaceActivated?.({ workspacePath: canonicalPath, workspaceIdentity });
  await Promise.all([
    refreshPinnedTasks({
      sessionId,
      workspacePath: canonicalPath,
      workspaceIdentity,
    }),
    refreshTimelineTasks({
      sessionId,
      workspacePath: canonicalPath,
      workspaceIdentity,
    }),
  ]);
}

export function useRemoteWorkspaceHistory({
  intl,
  services,
  platform,
  supportsSettings,
  allowRemoteWorkspace = true,
  ensureConversationWorkspaceOnRestore = false,
  deferInactiveWorkspaceRestore = false,
  unavailableWorkspacePath,
  tabStoreApi,
  activateTabByPath,
  addTab,
  onWorkspaceActivated,
}: {
  intl: ReturnType<typeof import("@/i18n/IntlProvider.js").useZCodeIntl>["intl"];
  services: IServiceAccessor;
  platform: IPlatformService;
  supportsSettings: boolean;
  allowRemoteWorkspace?: boolean;
  ensureConversationWorkspaceOnRestore?: boolean;
  /** Desktop main window only: add the inactive workspace to sidebar/task data sources after input is available. */
  deferInactiveWorkspaceRestore?: boolean;
  unavailableWorkspacePath?: string;
  tabStoreApi: ReturnType<typeof import("@/store/TabStoreProvider.js").useTabStoreApi>;
  activateTabByPath: (workspacePath: string, options?: { workspaceIdentity?: string }) => boolean;
  addTab: (
    workspacePath: string,
    options?: {
      remoteSessionId?: string;
      remoteTarget?: Parameters<IPlatformService["connectRemote"]>[0];
      workspaceIdentity?: string;
      localWorkspacePath?: string;
    },
  ) => void;
  onWorkspaceActivated?: (target: { workspacePath: string; workspaceIdentity: string }) => void;
}) {
  const showRemoteConnectionEntry = useRemoteConnectionEntryVisibility();
  const canUseRemoteWorkspace = allowRemoteWorkspace && showRemoteConnectionEntry;
  const allowRemoteWorkspaceRestore = canUseRemoteWorkspace;
  const [remoteWorkspaceSessions, setRemoteWorkspaceSessions] = useState<
    RemoteWorkspaceSessionEntry[]
  >([]);
  const remoteWorkspaceSessionsRef = useRef<RemoteWorkspaceSessionEntry[]>([]);
  const [reconnectingRemoteWorkspaceKeys, setReconnectingRemoteWorkspaceKeys] = useState<string[]>(
    [],
  );
  const inflightReconnectWorkspaceKeysRef = useRef<Set<string>>(new Set());
  const pendingReconnectRequestIdsRef = useRef<Map<string, string>>(new Map());
  const pendingConnectionTargetsBySessionIdRef = useRef<
    Map<string, Parameters<IPlatformService["connectRemote"]>[0]>
  >(new Map());
  // The previous version used a useRef here for startup reconnect attempts.
  // After automatic reconnect was removed, Vite Fast Refresh could reuse the old fiber's hook slot,
  // placing useState from the next useReconnectingRemoteWorkspaceLogs layer into the old useRef slot and triggering React's "Should have a queue" error.
  // Keep an empty ref only to stabilize hook order during hot reload; this does not restore startup reconnect behavior.
  const remoteStartupReconnectRefreshCompatibilityRef = useRef<null>(null);
  void remoteStartupReconnectRefreshCompatibilityRef;
  const {
    logsByWorkspaceKey: reconnectingRemoteWorkspaceLogsByWorkspaceKey,
    resetLogsForWorkspaceKey,
  } = useReconnectingRemoteWorkspaceLogs({
    platform,
    reconnectingWorkspaceKeys: reconnectingRemoteWorkspaceKeys,
    resolveWorkspaceTargetByKey: (workspaceKey) =>
      remoteWorkspaceSessionsRef.current.find(
        (entry) => buildWorkspaceSessionKey(entry) === workspaceKey,
      )?.target ?? null,
    resolveWorkspaceRequestIdByKey: (workspaceKey) =>
      pendingReconnectRequestIdsRef.current.get(workspaceKey) ?? null,
  });

  const syncPersistedWorkspaceSession = useCallback(
    async (nextRemoteSessions: readonly RemoteWorkspaceSessionEntry[]) => {
      setRemoteWorkspaceSessions([...nextRemoteSessions]);
      remoteWorkspaceSessionsRef.current = [...nextRemoteSessions];

      if (!supportsSettings) {
        return;
      }

      await services.settingService.update(
        buildRemoteWorkspacePersistPatch(tabStoreApi.getState(), nextRemoteSessions),
      );
    },
    [services.settingService, supportsSettings, tabStoreApi],
  );

  const commitRemoteWorkspaceSessionMutation = useCallback(
    async (mutation: ReturnType<typeof buildRemoteWorkspaceSessionMutation>) => {
      for (const credentialKey of mutation.credentialKeysToDelete) {
        try {
          await services.credentialService.delete(credentialKey);
        } catch (error) {
          logger.warn("[Root] 删除远程 workspace 凭据失败", {
            credentialKey,
            error,
          });
        }
      }

      for (const credential of mutation.credentialsToSave) {
        await services.credentialService.save(credential.key, credential.value);
      }

      await syncPersistedWorkspaceSession(mutation.nextRemoteSessions);
      return mutation.entry;
    },
    [services.credentialService, syncPersistedWorkspaceSession],
  );

  const waitForRemoteWorkspaceSessionReady = useCallback(async (sessionId: string) => {
    if (getRemoteWorkspaceSession(sessionId)) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const startedAt = Date.now();
      const pollTimer = window.setInterval(() => {
        if (getRemoteWorkspaceSession(sessionId)) {
          window.clearInterval(pollTimer);
          resolve();
          return;
        }

        if (Date.now() - startedAt >= 3000) {
          window.clearInterval(pollTimer);
          reject(new Error(`等待远程 workspace session 就绪超时: ${sessionId}`));
        }
      }, 50);
    });
  }, []);

  const connectRemoteWorkspaceTarget = useCallback(
    async (
      target: Parameters<IPlatformService["connectRemote"]>[0],
      requestId?: string,
      context?: Parameters<IPlatformService["connectRemote"]>[2],
    ) => {
      const result = await platform.connectRemote(target, requestId, context);
      if (!result.success) {
        throw new Error(getErrorMessage(result.error || "Connection failed"));
      }

      if (!result.sessionId) {
        throw new Error("Remote session was not created");
      }

      // A successful remote connection means only that main/host created the session;
      // the renderer's MessagePort may not be registered in the Zustand store until the next tick.
      // Calling addTab immediately could briefly use local services, causing the initial directory read or ZCode Agent prewarm to hit the wrong service.
      // Wait until the session is actually in the store before continuing.
      await waitForRemoteWorkspaceSessionReady(result.sessionId);
      if (!context) {
        // The shared Host returns only a redacted target to the renderer store; full credentials are retained temporarily only until directory selection completes.
        pendingConnectionTargetsBySessionIdRef.current.set(result.sessionId, target);
      }
      return result.sessionId;
    },
    [platform, waitForRemoteWorkspaceSessionReady],
  );

  const resolveRemoteWorkspaceCanonicalPath = useCallback(
    async (sessionId: string, workspacePath: string): Promise<string> => {
      const remoteSession = getRemoteWorkspaceSession(sessionId);
      if (!remoteSession) {
        return workspacePath;
      }

      try {
        // The same directory may be entered through symlink aliases (for example, /dev and /home/dev).
        // Persisting the raw input previously treated one workspace as two identities.
        // Normalize with realpath on the remote host before computing and persisting identity.
        return await remoteSession.services.fileService.resolvePath({
          path: workspacePath,
        });
      } catch {
        return workspacePath;
      }
    },
    [],
  );

  const buildPersistedTabPatch = useCallback(
    (state: TabStoreState) =>
      buildRemoteWorkspacePersistPatch(state, remoteWorkspaceSessionsRef.current),
    [],
  );

  const handleCancelRemoteProject = useCallback(
    async (sessionId: string) => {
      try {
        await platform.disposeRemoteSession(sessionId);
      } finally {
        pendingConnectionTargetsBySessionIdRef.current.delete(sessionId);
        // If remote directory selection is cancelled before confirmation, failure to release the session must not leave frontend state stuck at “a remote session is still awaiting selection.”
        // Always clear the local mapping here so reopening the dialog does not reuse an already invalid session record.
        unregisterRemoteWorkspaceSession(sessionId);
      }
    },
    [platform],
  );

  const bindRemoteWorkspaceSessionContext = useCallback<BindRemoteWorkspaceSessionContextFn>(
    async ({ sessionId, workspacePath, workspaceIdentity }) => {
      // bind replaces the renderer attachment generation for the same remoteSessionId.
      // Reuse bindRemoteWorkspaceContextAndGetSession, which returns after the ready ACK; services read by sessionId afterward belong to the new generation.
      await bindRemoteWorkspaceContextAndGetSession({
        platform,
        sessionId,
        workspacePath,
        workspaceIdentity,
      });
    },
    [platform],
  );

  const runReconnectRemoteWorkspaceEntry = useCallback(
    async (
      sessionEntry: RemoteWorkspaceSessionEntry,
      options?: ReconnectRemoteWorkspaceOptions,
    ): Promise<boolean> => {
      const workspaceKey = buildWorkspaceSessionKey(sessionEntry);
      if (inflightReconnectWorkspaceKeysRef.current.has(workspaceKey)) {
        return false;
      }
      const workspaceTab = tabStoreApi
        .getState()
        .tabs.find(
          (tab): tab is import("@/store/tabStore.js").WorkspaceTabState =>
            isWorkspaceTab(tab) && buildWorkspaceSessionKey(tab) === workspaceKey,
        );
      if (!workspaceTab || workspaceTab.remoteSessionId) {
        return false;
      }

      resetLogsForWorkspaceKey(workspaceKey);
      inflightReconnectWorkspaceKeysRef.current.add(workspaceKey);
      const requestId = createUuid();
      pendingReconnectRequestIdsRef.current.set(workspaceKey, requestId);
      try {
        // During reconnect, silently restore only a ready remoteSessionId; the reconnect helper activates the tab
        // after restoration to avoid exposing a remote-waiting intermediate state in the active tab.
        const upsertWorkspaceTab = tabStoreApi.getState().ensureWorkspaceTab;
        logger.debug("[Root] 远程 workspace 重连中，保留当前 conversation", {
          workspaceKey,
        });
        await reconnectRemoteWorkspaceHistoryEntry({
          sessionEntry,
          activateTabByPath,
          setReconnectingRemoteWorkspaceKeys,
          loadCredential: services.credentialService.load,
          connectRemoteWorkspaceTarget,
          resolveRemoteWorkspaceCanonicalPath,
          disposeRemoteWorkspaceSession: handleCancelRemoteProject,
          bindRemoteWorkspaceSessionContext,
          bindRemoteWorkspacePath,
          bindRemoteWorkspaceIdentity,
          upsertWorkspaceTab,
          commitRemoteWorkspaceSessionMutation,
          getRemoteSessions: () => remoteWorkspaceSessionsRef.current,
          logger,
          toast,
          shouldKeepReconnectedWorkspace: ({ workspacePath, workspaceIdentity }) =>
            shouldKeepRemoteWorkspaceInTabs({
              tabStoreApi,
              workspacePath,
              workspaceIdentity,
            }),
          onWorkspaceActivated: (target) => {
            logger.debug("[Root] 远程 workspace ready，提交 tab 与 draft 激活", target);
            onWorkspaceActivated?.(target);
          },
          options: {
            ...options,
            requestId,
          },
        });
        return true;
      } finally {
        inflightReconnectWorkspaceKeysRef.current.delete(workspaceKey);
        if (pendingReconnectRequestIdsRef.current.get(workspaceKey) === requestId) {
          pendingReconnectRequestIdsRef.current.delete(workspaceKey);
        }
      }
    },
    [
      activateTabByPath,
      bindRemoteWorkspaceSessionContext,
      commitRemoteWorkspaceSessionMutation,
      connectRemoteWorkspaceTarget,
      handleCancelRemoteProject,
      onWorkspaceActivated,
      resolveRemoteWorkspaceCanonicalPath,
      resetLogsForWorkspaceKey,
      services.credentialService,
      tabStoreApi,
    ],
  );

  const runReconnectRemoteWorkspace = useCallback(
    async (
      sessionEntry: RemoteWorkspaceSessionEntry,
      options?: ReconnectRemoteWorkspaceOptions,
    ) => {
      const reconnectGroup = collectSshReconnectGroup({
        selected: sessionEntry,
        sessions: remoteWorkspaceSessionsRef.current,
        tabs: tabStoreApi.getState().tabs,
      });
      await reconnectRemoteWorkspaceGroup({
        selected: sessionEntry,
        reconnectGroup,
        reconnectEntry: runReconnectRemoteWorkspaceEntry,
        options,
      });
    },
    [runReconnectRemoteWorkspaceEntry, tabStoreApi],
  );

  useEffect(() => {
    // This was previously the startup automatic-reconnect effect.
    // Removing the effect would shift all later hooks in an already-mounted RootInner during Fast Refresh,
    // and reusing the old effect slot as a useCallback could trigger a React hook-queue mismatch.
    // This empty effect only preserves the hook slot; startup restoration still creates disconnected tabs and does not connect remotely.
    const preserveRemoteStartupReconnectEffectSlot = true;
    void preserveRemoteStartupReconnectEffectSlot;
  }, []);

  const restorePersistedSession = useCallback(
    async (settings: AppSettings) => {
      const persistedRemoteSessions = getRemoteWorkspaceSessionEntries(settings);
      setRemoteWorkspaceSessions(persistedRemoteSessions);
      remoteWorkspaceSessionsRef.current = persistedRemoteSessions;
      let conversationWorkspacePath: string | undefined;
      if (ensureConversationWorkspaceOnRestore) {
        try {
          conversationWorkspacePath = (await services.fileService.ensureConversationWorkspace())
            .path;
        } catch (error) {
          // Failure to create a path must not suppress restoration of the actual project; a later explicit new conversation still uses the existing retryable error path.
          logger.warn("[Root] 恢复阶段解析 conversation workspace 失败", { error });
        }
      }
      // At startup, restore remote workspaces only as disconnected tabs in the task list.
      // A background effect previously initiated SSH/WSL/Docker reconnects and runtime uploads even when the user only opened the app to view the task list.
      // Reconnect now starts only when the user clicks “Reconnect” or opens an item from remote history, avoiding hidden startup side effects.
      // Standard Web mode also sets allowRemoteWorkspaceRestore to false: keep remote snapshots in settings, but do not restore tabs or show the entry point.
      const workspaceRestore = restorePersistedRemoteWorkspaceSessions({
        settings,
        tabStoreApi,
        allowRemoteWorkspaceRestore,
        unavailableWorkspacePath,
        conversationWorkspacePath,
        restoreMode: deferInactiveWorkspaceRestore ? "active-first" : "all",
      });
      return {
        ...(conversationWorkspacePath
          ? { excludedRecentProjectPaths: [conversationWorkspacePath] }
          : {}),
        ...(workspaceRestore?.deferredRestore
          ? { deferredRestore: workspaceRestore.deferredRestore }
          : {}),
      };
    },
    [
      allowRemoteWorkspaceRestore,
      deferInactiveWorkspaceRestore,
      ensureConversationWorkspaceOnRestore,
      services.fileService,
      tabStoreApi,
      unavailableWorkspacePath,
    ],
  );

  const handleSelectRemoteProject = useCallback(
    async (sessionId: string, path: string, localWorkspacePath?: string) => {
      try {
        await selectRemoteWorkspaceProjectFromDialog({
          canUseRemoteWorkspace,
          sessionId,
          path,
          localWorkspacePath,
          loadingMessage: intl.formatMessage({ id: "common.loading" }),
          getRemoteWorkspaceSession,
          connectionTarget: pendingConnectionTargetsBySessionIdRef.current.get(sessionId),
          getWorkspaceTabs: () => tabStoreApi.getState().tabs,
          resolveRemoteWorkspaceCanonicalPath,
          activateTabByPath,
          handleCancelRemoteProject,
          bindRemoteWorkspaceSessionContext,
          commitRemoteWorkspaceSessionMutation,
          getRemoteSessions: () => remoteWorkspaceSessionsRef.current,
          bindRemoteWorkspacePath,
          bindRemoteWorkspaceIdentity,
          addTab,
          onWorkspaceActivated,
          refreshPinnedTasks: refreshRemotePinnedTasksForSession,
          refreshTimelineTasks: refreshRemoteTimelineTasksForSession,
        });
      } finally {
        pendingConnectionTargetsBySessionIdRef.current.delete(sessionId);
      }
    },
    [
      activateTabByPath,
      addTab,
      bindRemoteWorkspaceSessionContext,
      tabStoreApi,
      commitRemoteWorkspaceSessionMutation,
      handleCancelRemoteProject,
      intl,
      onWorkspaceActivated,
      resolveRemoteWorkspaceCanonicalPath,
      canUseRemoteWorkspace,
    ],
  );

  const handleConnectRemote = useCallback(
    async (
      options: Parameters<IPlatformService["connectRemote"]>[0],
      requestId?: string,
      context?: Parameters<IPlatformService["connectRemote"]>[2],
    ) => {
      if (!canUseRemoteWorkspace) {
        throw new Error("Remote workspace is disabled in this mode");
      }

      return connectRemoteWorkspaceTarget(options, requestId, context);
    },
    [canUseRemoteWorkspace, connectRemoteWorkspaceTarget],
  );

  const handleReconnectRemoteWorkspace = useCallback(
    async (workspaceKey: string, options?: ReconnectRemoteWorkspaceOptions) => {
      await reconnectRemoteWorkspaceByKey({
        workspaceKey,
        canUseRemoteWorkspace,
        getRemoteSessions: () => remoteWorkspaceSessionsRef.current,
        runReconnectRemoteWorkspace,
        options: {
          activateWorkspaceAfterReconnect: true,
          showErrorToast: true,
          throwOnFailure: false,
          ...options,
        },
      });
    },
    [canUseRemoteWorkspace, runReconnectRemoteWorkspace],
  );

  const handleOpenRemoteWorkspaceFromHistory = useCallback(
    async (workspaceKey: string) => {
      if (!canUseRemoteWorkspace) {
        return;
      }

      // Remote-history entry and sidebar reconnect can both hit the race where the user removes a workspace during reconnect.
      // Use one shared entry point so both paths have the same concurrency protection, retention check, and error handling.
      await openRemoteWorkspaceFromHistoryEntry({
        workspaceKey,
        tabStoreApi,
        getRemoteSessions: () => remoteWorkspaceSessionsRef.current,
        inflightReconnectWorkspaceKeys: inflightReconnectWorkspaceKeysRef.current,
        activateTabByPath,
        setReconnectingRemoteWorkspaceKeys,
        loadCredential: services.credentialService.load,
        connectRemoteWorkspaceTarget,
        resolveRemoteWorkspaceCanonicalPath,
        disposeRemoteWorkspaceSession: handleCancelRemoteProject,
        bindRemoteWorkspaceSessionContext,
        addTab,
        commitRemoteWorkspaceSessionMutation,
        createReconnectRequestId: createUuid,
        pendingReconnectRequestIds: pendingReconnectRequestIdsRef.current,
        resetLogsForWorkspaceKey,
        onWorkspaceActivated,
      });
    },
    [
      activateTabByPath,
      addTab,
      bindRemoteWorkspaceSessionContext,
      commitRemoteWorkspaceSessionMutation,
      connectRemoteWorkspaceTarget,
      handleCancelRemoteProject,
      resolveRemoteWorkspaceCanonicalPath,
      resetLogsForWorkspaceKey,
      onWorkspaceActivated,
      services.credentialService,
      tabStoreApi,
      canUseRemoteWorkspace,
    ],
  );

  const handleRemoteWorkspaceSessionClosed = useCallback(
    async (event: RemoteSessionClosedEvent) => {
      const sessionId = event.sessionId.trim();
      if (!sessionId) {
        return;
      }

      const matchedTabs = tabStoreApi
        .getState()
        .tabs.filter(
          (tab): tab is import("@/store/tabStore.js").WorkspaceTabState =>
            isWorkspaceTab(tab) && tab.remoteSessionId === sessionId,
        );
      if (matchedTabs.length === 0) {
        unregisterRemoteWorkspaceSession(sessionId);
        return;
      }

      // When the remote host exited, the tab's remoteSessionId previously remained set.
      // The UI continued to show “Connected” and route requests to the dead session.
      // On the main process's session-close event, immediately downgrade to disconnected; reconnect afterward only by user action.
      tabStoreApi.setState((state) => ({
        tabs: state.tabs.map((tab) =>
          isWorkspaceTab(tab) && tab.remoteSessionId === sessionId
            ? { ...tab, remoteSessionId: undefined }
            : tab,
        ),
      }));
      unregisterRemoteWorkspaceSession(sessionId);

      const matchedWorkspaceKeys = [
        ...new Set(matchedTabs.map((tab) => buildWorkspaceSessionKey(tab))),
      ];
      const reason = [
        "远程连接已断开",
        event.exitCode != null ? `exitCode=${event.exitCode}` : null,
        event.signal ? `signal=${event.signal}` : null,
      ]
        .filter(Boolean)
        .join(" ");
      const zcodeSessionStore = useZCodeSessionStore.getState();
      const failedTaskCount = markRemoteWorkspaceRunningTasksFailed({
        tabs: matchedTabs,
        getWorkspaceState: zcodeSessionStore.getWorkspaceState,
        setTaskRuntimeState: zcodeSessionStore.setTaskRuntimeState,
        reason,
      });

      logger.warn("[Root] 远程 workspace session 已关闭", {
        sessionId,
        reason: event.reason,
        exitCode: event.exitCode,
        signal: event.signal,
        matchedWorkspaceKeys,
        failedTaskCount,
      });

      for (const workspaceKey of matchedWorkspaceKeys) {
        const sessionEntry = remoteWorkspaceSessionsRef.current.find(
          (entry) => buildWorkspaceSessionKey(entry) === workspaceKey,
        );
        if (!sessionEntry) {
          continue;
        }

        const pendingReconnectRequestId = pendingReconnectRequestIdsRef.current.get(workspaceKey);
        if (
          !shouldPersistRemoteWorkspaceFailure({
            pendingReconnectRequestIds: pendingReconnectRequestIdsRef.current,
            sessionEntry,
            workspaceKey,
          })
        ) {
          logger.info("[Root] WSL workspace session 关闭时跳过失败落盘，等待重连结果", {
            pendingReconnectRequestId,
            sessionId,
            workspaceIdentity: sessionEntry.workspaceIdentity ?? null,
            workspacePath: sessionEntry.workspacePath,
            workspaceKey,
          });
          continue;
        }

        await commitRemoteWorkspaceSessionMutation(
          buildRemoteWorkspaceSessionMutation({
            remoteSessions: remoteWorkspaceSessionsRef.current,
            workspacePath: sessionEntry.workspacePath,
            workspaceIdentity: sessionEntry.workspaceIdentity,
            target: createRemoteTargetFromSnapshot(sessionEntry.target, {
              password: null,
              privateKeyPassphrase: null,
            }),
            lastConnectionStatus: "failed",
            lastConnectionError: reason,
            touchOpenedAt: false,
          }),
        );
      }
    },
    [commitRemoteWorkspaceSessionMutation, tabStoreApi],
  );

  const handleBotRemoteWorkspaceReconnected = useCallback(
    async (event: BotRemoteWorkspaceReconnectedEvent) => {
      if (!canUseRemoteWorkspace) {
        return;
      }

      const sessionId = event.sessionId.trim();
      if (!sessionId) {
        return;
      }

      try {
        await waitForRemoteWorkspaceSessionReady(sessionId);
        const remoteSession = getRemoteWorkspaceSession(sessionId);
        if (!remoteSession) {
          throw new Error(`远程 workspace session 不存在: ${sessionId}`);
        }
        if (!remoteSession.target) {
          // Bugfix: Bot reconnect events come from main/host and must include a persistable target.
          // Web relay bridge sessions have no target and cannot enter the remote-history reconnect branch.
          throw new Error(`远程 workspace session 缺少连接目标: ${sessionId}`);
        }

        const resolvedWorkspacePath = await resolveRemoteWorkspaceCanonicalPath(
          sessionId,
          event.workspacePath,
        );
        const resolvedWorkspaceIdentity = resolveBotRemoteWorkspaceReconnectedIdentity({
          event,
          resolvedWorkspacePath,
          target: remoteSession.target,
        });

        bindRemoteWorkspacePath(resolvedWorkspacePath, sessionId);
        bindRemoteWorkspaceIdentity(resolvedWorkspaceIdentity, sessionId);
        // Bugfix: Bot-triggered remote reconnect happens in main/host and does not go through the sidebar's manual reconnect React flow.
        // After receiving main's success event, bind the created session back to the tab and remote history so the UI changes from “Disconnected” to “Connected.”
        tabStoreApi.getState().ensureWorkspaceTab(resolvedWorkspacePath, {
          remoteSessionId: sessionId,
          remoteTarget: remoteSession.target,
          workspaceIdentity: resolvedWorkspaceIdentity,
        });
        await commitRemoteWorkspaceSessionMutation(
          buildRemoteWorkspaceSessionMutation({
            remoteSessions: remoteWorkspaceSessionsRef.current,
            workspacePath: resolvedWorkspacePath,
            workspaceIdentity: resolvedWorkspaceIdentity,
            target: remoteSession.target,
            lastConnectionStatus: "connected",
            touchOpenedAt: true,
          }),
        );
        await Promise.all([
          refreshRemotePinnedTasksForSession({
            sessionId,
            workspacePath: resolvedWorkspacePath,
            workspaceIdentity: resolvedWorkspaceIdentity,
          }),
          refreshRemoteTimelineTasksForSession({
            sessionId,
            workspacePath: resolvedWorkspacePath,
            workspaceIdentity: resolvedWorkspaceIdentity,
          }),
        ]);
      } catch (error) {
        logger.warn("[Root] Bot 远端 workspace 重连成功后同步 UI 状态失败", {
          sessionId,
          workspacePath: event.workspacePath,
          workspaceIdentity: event.workspaceIdentity,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [
      canUseRemoteWorkspace,
      commitRemoteWorkspaceSessionMutation,
      resolveRemoteWorkspaceCanonicalPath,
      tabStoreApi,
      waitForRemoteWorkspaceSessionReady,
    ],
  );

  useEffect(() => {
    return platform.onRemoteSessionClosed((event) => {
      void handleRemoteWorkspaceSessionClosed(event);
    });
  }, [handleRemoteWorkspaceSessionClosed, platform]);

  useEffect(() => {
    return platform.onBotRemoteWorkspaceReconnected((event) => {
      void handleBotRemoteWorkspaceReconnected(event);
    });
  }, [handleBotRemoteWorkspaceReconnected, platform]);

  const handleRemoteWorkspaceTabsClosed = useCallback(
    (workspaceKeys: string[]) => {
      if (workspaceKeys.length === 0) {
        return;
      }

      const workspaceKeySet = new Set(workspaceKeys);

      void (async () => {
        // When closing a disconnected remote tab, it has no remoteSessionId yet, but the main process may already be uploading the remote runtime.
        // Cancel the pending host by reconnect requestId so an upload does not continue after the UI removes the tab.
        await cancelPendingRemoteReconnectsForWorkspaceKeys({
          workspaceKeys,
          pendingRequestIds: pendingReconnectRequestIdsRef.current,
          cancelPendingRemoteConnection: platform.cancelPendingRemoteConnection
            ? (requestId) =>
                platform.cancelPendingRemoteConnection?.(requestId) ?? Promise.resolve()
            : undefined,
          logger,
        });
        setReconnectingRemoteWorkspaceKeys((currentKeys) =>
          currentKeys.filter((key) => !workspaceKeySet.has(key)),
        );

        const removal = removeRemoteWorkspaceSessionEntries(
          remoteWorkspaceSessionsRef.current,
          workspaceKeys,
        );
        if (
          removal.nextRemoteSessions.length === remoteWorkspaceSessionsRef.current.length &&
          removal.credentialKeysToDelete.length === 0
        ) {
          return;
        }

        // Removing a remote workspace from the sidebar requires more than deleting its tab:
        // remoteWorkspaceSessionsRef is merged back into setting.json by persistence patches,
        // so the same disconnected item would return on next startup. Treat explicit removal as deleting remote history,
        // and also clear SSH credentials owned exclusively by that history to avoid an unreachable credential key.
        await syncPersistedWorkspaceSession(removal.nextRemoteSessions);
        for (const credentialKey of removal.credentialKeysToDelete) {
          try {
            await services.credentialService.delete(credentialKey);
          } catch (error) {
            logger.warn("[Root] 删除已移除远程 workspace 凭据失败", {
              credentialKey,
              error,
            });
          }
        }
      })();
    },
    [platform, services.credentialService, syncPersistedWorkspaceSession],
  );

  const remoteWorkspaceErrorByWorkspaceKey = useMemo(
    () =>
      Object.fromEntries(
        remoteWorkspaceSessions.flatMap((entry) =>
          entry.lastConnectionError?.trim()
            ? [[buildWorkspaceSessionKey(entry), entry.lastConnectionError] as const]
            : [],
        ),
      ),
    [remoteWorkspaceSessions],
  );

  return {
    remoteWorkspaceSessions,
    reconnectingRemoteWorkspaceKeys,
    remoteWorkspaceErrorByWorkspaceKey,
    reconnectingRemoteWorkspaceLogsByWorkspaceKey,
    buildPersistedTabPatch,
    restorePersistedSession,
    handleCancelRemoteProject,
    handleSelectRemoteProject,
    handleConnectRemote,
    handleReconnectRemoteWorkspace,
    handleOpenRemoteWorkspaceFromHistory,
    handleRemoteWorkspaceTabsClosed,
  };
}
