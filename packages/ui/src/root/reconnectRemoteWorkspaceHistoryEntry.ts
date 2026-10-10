import type { Dispatch, SetStateAction } from "react";
import type { IPlatformService, RemoteWorkspaceSessionEntry } from "@zcode/shared";
import { stripRemoteTargetSecrets } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import { toast } from "@/components/ui/toast.js";
import {
  buildRemoteWorkspaceSessionMutation,
  buildRemoteWorkspaceIdentity,
  createRemoteTargetFromSnapshot,
  resolveRemoteWorkspaceSessionIdentity,
} from "@/lib/remoteWorkspaceHistory.js";
import { logger } from "@/logger.js";
import {
  bindRemoteWorkspaceIdentity,
  bindRemoteWorkspacePath,
} from "@/store/remoteWorkspaceSessionStore.js";
import { refreshRemotePinnedTasksForSession } from "@/store/remotePinnedTaskStore.js";
import { refreshRemoteTimelineTasksForSession } from "@/store/remoteTimelineTaskStore.js";

/** Bind the canonical workspacePath/workspaceIdentity chosen by the UI back to the logical session in main/host. */
export type BindRemoteWorkspaceSessionContextFn = (params: {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity: string;
}) => Promise<void>;

type ManualReconnectRemoteWorkspaceParams = {
  sessionEntry: RemoteWorkspaceSessionEntry;
  activateTabByPath: (workspacePath: string, options?: { workspaceIdentity?: string }) => boolean;
  setReconnectingRemoteWorkspaceKeys: Dispatch<SetStateAction<string[]>>;
  loadCredential: IServiceAccessor["credentialService"]["load"];
  connectRemoteWorkspaceTarget: (
    target: Parameters<IPlatformService["connectRemote"]>[0],
    requestId?: string,
    context?: Parameters<IPlatformService["connectRemote"]>[2],
  ) => Promise<string>;
  resolveRemoteWorkspaceCanonicalPath: (
    sessionId: string,
    workspacePath: string,
  ) => Promise<string>;
  disposeRemoteWorkspaceSession: (sessionId: string) => Promise<void>;
  bindRemoteWorkspaceSessionContext: BindRemoteWorkspaceSessionContextFn;
  bindRemoteWorkspacePath: typeof bindRemoteWorkspacePath;
  bindRemoteWorkspaceIdentity: typeof bindRemoteWorkspaceIdentity;
  upsertWorkspaceTab: (
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
  getRemoteSessions: () => RemoteWorkspaceSessionEntry[];
  logger: Pick<typeof logger, "warn">;
  toast: typeof toast;
  shouldKeepReconnectedWorkspace?: (
    context: Pick<RemoteWorkspaceSessionEntry, "workspacePath" | "workspaceIdentity">,
  ) => boolean;
  onWorkspaceActivated?: (target: { workspacePath: string; workspaceIdentity: string }) => void;
  options?: ReconnectRemoteWorkspaceOptions;
};

export interface SshReconnectCredentials {
  password: string | null;
  privateKeyPassphrase: string | null;
}

export interface ReconnectRemoteWorkspaceOptions {
  activateWorkspaceAfterReconnect?: boolean;
  showErrorToast?: boolean;
  requestId?: string;
  throwOnFailure?: boolean;
  /** After the shared Host is ready, siblings attach using the initiator’s credentials; do not reread their own historical credentials. */
  sshCredentialsOverride?: SshReconnectCredentials;
  /** logical connect has returned, meaning the shared SSH Host is ready; workspace initialization may still continue or fail. */
  onSshHostReady?: (credentials: SshReconnectCredentials) => void;
}

export async function reconnectRemoteWorkspaceHistoryEntry({
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
  upsertWorkspaceTab,
  commitRemoteWorkspaceSessionMutation,
  getRemoteSessions,
  logger,
  toast,
  shouldKeepReconnectedWorkspace,
  onWorkspaceActivated,
  options,
}: ManualReconnectRemoteWorkspaceParams): Promise<void> {
  const activateWorkspaceAfterReconnect = options?.activateWorkspaceAfterReconnect ?? true;
  const showErrorToast = options?.showErrorToast ?? true;
  const fallbackWorkspaceIdentity = resolveRemoteWorkspaceSessionIdentity(sessionEntry);
  const reconnectWorkspaceKey = fallbackWorkspaceIdentity?.trim() || sessionEntry.workspacePath;

  setReconnectingRemoteWorkspaceKeys((currentKeys) =>
    currentKeys.includes(reconnectWorkspaceKey)
      ? currentKeys
      : [...currentKeys, reconnectWorkspaceKey],
  );

  let reconnectTarget = createRemoteTargetFromSnapshot(sessionEntry.target, {
    password: null,
    privateKeyPassphrase: null,
  });
  let resolvedWorkspacePath = sessionEntry.workspacePath;
  let resolvedWorkspaceIdentity = fallbackWorkspaceIdentity;
  try {
    const sshCredentials = options?.sshCredentialsOverride ?? {
      password:
        sessionEntry.target.kind === "ssh" && sessionEntry.target.passwordCredentialKey
          ? await loadCredential(sessionEntry.target.passwordCredentialKey)
          : null,
      privateKeyPassphrase:
        sessionEntry.target.kind === "ssh" && sessionEntry.target.privateKeyPassphraseCredentialKey
          ? await loadCredential(sessionEntry.target.privateKeyPassphraseCredentialKey)
          : null,
    };
    reconnectTarget = createRemoteTargetFromSnapshot(sessionEntry.target, sshCredentials);
    const sessionId = await connectRemoteWorkspaceTarget(reconnectTarget, options?.requestId, {
      workspacePath: sessionEntry.workspacePath,
      workspaceIdentity: fallbackWorkspaceIdentity,
      connectTrigger: "reconnect",
    });
    if (reconnectTarget.kind === "ssh") {
      // Notify in stages: Host readiness first, then provider/task and other workspace initialization.
      // From this point, siblings can attach using the initiator’s credential without waiting for or rereading credentials.
      options?.onSshHostReady?.(sshCredentials);
    }
    resolvedWorkspacePath = await resolveRemoteWorkspaceCanonicalPath(
      sessionId,
      sessionEntry.workspacePath,
    );
    resolvedWorkspaceIdentity = buildRemoteWorkspaceIdentity(
      resolvedWorkspacePath,
      reconnectTarget,
    );

    if (
      resolvedWorkspacePath !== sessionEntry.workspacePath ||
      resolvedWorkspaceIdentity !== fallbackWorkspaceIdentity
    ) {
      // connect carries only the path/identity from the historical record, and main’s logical session descriptor also keeps those values;
      // if realpath normalization produces a different value, the tab uses the new one while the descriptor remains old,
      // so the mobile remote-control bridge rejects it with REMOTE_WORKSPACE_IDENTITY_MISMATCH when it compares the tab path/identity to the descriptor.
      // A binding failure means the session and tab cannot be aligned: reclaim the session and persist failure rather than leave a half-connected workspace.
      // Await this before the retention check below: there must be no further async gap between validation and upsertWorkspaceTab,
      // or if the user removes the tab while bind waits for the ready ACK, the validation result becomes stale and the workspace gets re-added.
      try {
        await bindRemoteWorkspaceSessionContext({
          sessionId,
          workspacePath: resolvedWorkspacePath,
          workspaceIdentity: resolvedWorkspaceIdentity,
        });
      } catch (error) {
        await disposeRemoteWorkspaceSession(sessionId);
        throw error;
      }
    }

    // During manual reconnect, the user may click reconnect and immediately remove the remote tab.
    // Without another retention check before persisting success, this code would re-add the workspace the user just removed.
    if (
      shouldKeepReconnectedWorkspace &&
      !shouldKeepReconnectedWorkspace({
        workspacePath: resolvedWorkspacePath,
        workspaceIdentity: resolvedWorkspaceIdentity,
      })
    ) {
      logger.warn("[Root] 远程 workspace 在重连过程中已被移除，跳过恢复并回收 session", {
        workspacePath: resolvedWorkspacePath,
      });
      await disposeRemoteWorkspaceSession(sessionId);
      return;
    }
    bindRemoteWorkspacePath(resolvedWorkspacePath, sessionId);
    bindRemoteWorkspaceIdentity(resolvedWorkspaceIdentity, sessionId);
    upsertWorkspaceTab(resolvedWorkspacePath, {
      remoteSessionId: sessionId,
      remoteTarget: stripRemoteTargetSecrets(reconnectTarget),
      workspaceIdentity: resolvedWorkspaceIdentity,
      localWorkspacePath: sessionEntry.localWorkspacePath,
    });
    if (activateWorkspaceAfterReconnect) {
      // The sidebar reconnect first activates a disconnected tab with only identity and no remoteSessionId yet,
      // so the conversation provider returns null while remote-waiting and leaves the entire right side black during connection.
      // Bind services and silently backfill the tab’s session metadata first, then activate the tab and draft together.
      const activated = activateTabByPath(resolvedWorkspacePath, {
        workspaceIdentity: resolvedWorkspaceIdentity,
      });
      if (activated) {
        onWorkspaceActivated?.({
          workspacePath: resolvedWorkspacePath,
          workspaceIdentity: resolvedWorkspaceIdentity,
        });
      }
    }
    await commitRemoteWorkspaceSessionMutation(
      buildRemoteWorkspaceSessionMutation({
        remoteSessions: getRemoteSessions(),
        workspacePath: resolvedWorkspacePath,
        localWorkspacePath: sessionEntry.localWorkspacePath,
        workspaceIdentity: resolvedWorkspaceIdentity,
        target: reconnectTarget,
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
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("[Root] 手动重连远程 workspace 失败", {
      workspacePath: resolvedWorkspacePath,
      error: message,
    });
    await commitRemoteWorkspaceSessionMutation(
      buildRemoteWorkspaceSessionMutation({
        remoteSessions: getRemoteSessions(),
        workspacePath: resolvedWorkspacePath,
        workspaceIdentity: resolvedWorkspaceIdentity,
        target: reconnectTarget,
        lastConnectionStatus: "failed",
        lastConnectionError: message,
        touchOpenedAt: false,
      }),
    );
    if (showErrorToast) {
      toast(message);
    }
    if (options?.throwOnFailure) {
      // The Desktop reconnect button must swallow the exception and report it through a toast/persisted status,
      // but mobile Web remote control has RPC semantics and must return the failure explicitly to the phone.
      throw error;
    }
  } finally {
    setReconnectingRemoteWorkspaceKeys((currentKeys) =>
      currentKeys.filter((key) => key !== reconnectWorkspaceKey),
    );
  }
}
