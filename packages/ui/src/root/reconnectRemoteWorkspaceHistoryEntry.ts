import type { Dispatch, SetStateAction } from "react";
import type {
  AppSettings,
  BindRemoteWorkspaceSessionContextResult,
  ConnectionProfile,
  IPlatformService,
  RemoteTargetSnapshot,
  RemoteWorkspaceSessionEntry,
} from "@zcode/shared";
import {
  isCredentialDecryptError,
  REMOTE_WORKSPACE_DIRECTORY_UNAVAILABLE_ERROR_CODE,
  REMOTE_WORKSPACE_DIRECTORY_UNRESPONSIVE_ERROR_CODE,
  stripRemoteTargetSecrets,
} from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import { toast } from "@/components/ui/toast.js";
import {
  buildRemoteWorkspaceSessionMutation,
  createRemoteTargetFromSnapshot,
  resolveRemoteWorkspaceSessionIdentity,
} from "@/lib/remoteWorkspaceHistory.js";
import { logger } from "@/logger.js";
import { shouldShowStandaloneRemoteErrorToast } from "@/lib/remoteConnectionPresentation.js";
import {
  bindRemoteWorkspaceIdentity,
  bindRemoteWorkspacePath,
} from "@/store/remoteWorkspaceSessionStore.js";

type ManualReconnectRemoteWorkspaceParams = {
  sessionEntry: RemoteWorkspaceSessionEntry;
  activateTabByPath: (workspacePath: string, options?: { workspaceIdentity?: string }) => boolean;
  setReconnectingRemoteWorkspaceKeys: Dispatch<SetStateAction<string[]>>;
  loadCredential: IServiceAccessor["credentialService"]["load"];
  getSettings?: IServiceAccessor["settingService"]["get"];
  connectRemoteWorkspaceTarget: (
    target: Parameters<IPlatformService["connectRemote"]>[0],
    requestId?: string,
    context?: Parameters<IPlatformService["connectRemote"]>[2],
  ) => Promise<string>;
  resolveRemoteWorkspaceCanonicalPath: (
    sessionId: string,
    workspacePath: string,
  ) => Promise<string>;
  bindRemoteWorkspaceScope: (
    sessionId: string,
    workspacePath: string,
    workspaceIdentity?: string,
    workspacePurpose?: "project" | "conversation",
  ) => Promise<
    Pick<BindRemoteWorkspaceSessionContextResult, "workspacePath" | "workspaceIdentity">
  >;
  disposeRemoteWorkspaceSession: (sessionId: string) => Promise<void>;
  bindRemoteWorkspacePath: typeof bindRemoteWorkspacePath;
  bindRemoteWorkspaceIdentity: typeof bindRemoteWorkspaceIdentity;
  upsertWorkspaceTab: (
    workspacePath: string,
    options?: {
      remoteSessionId?: string;
      remoteTarget?: Parameters<IPlatformService["connectRemote"]>[0];
      workspaceIdentity?: string;
      previousWorkspaceIdentity?: string;
      localWorkspacePath?: string;
      workspacePurpose?: "project" | "conversation";
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
  onWorkspaceActivated?: (target: {
    workspacePath: string;
    workspaceIdentity: string;
    restoreSelection?: boolean;
  }) => void;
  formatError?: (error: unknown) => string;
  options?: ReconnectRemoteWorkspaceOptions;
};

export interface SshReconnectCredentials {
  password: string | null;
  privateKeyPassphrase: string | null;
}

export interface ReconnectRemoteWorkspaceOptions {
  /** User-initiated in-place reconnect checks stored credentials first and hands off to the wizard when missing; automatic recovery keeps Host admission. */
  requireStoredCredentials?: boolean;
  activateWorkspaceAfterReconnect?: boolean;
  showErrorToast?: boolean;
  requestId?: string;
  throwOnFailure?: boolean;
  recoveryMode?: "automatic" | "manual";
  /** After the shared Host is ready, siblings reuse the initiator's credentials to attach; reading their own stored credentials again is forbidden. */
  sshCredentialsOverride?: SshReconnectCredentials;
  /** Logical connect has returned, meaning the shared SSH Host is ready; workspace initialization may still be running or fail. */
  onSshHostReady?: (credentials: SshReconnectCredentials) => void;
}

/**
 * Read a Profile secret; undecryptable on this machine counts as missing, matching the Host `SourceServerDirectory` rule.
 * Bug cause: after ~/.zcode moved machines/users, saved passwords no longer decrypt. The Renderer read
 * credentials directly and the decrypt error bubbled all the way up, so clicking a project or connecting from
 * settings showed only a generic "connection failed" and never reached the existing supplemental-credential
 * branch. Other read errors still propagate as usual.
 */
async function loadUsableProfileCredential(
  loadCredential: IServiceAccessor["credentialService"]["load"],
  key: string,
): Promise<string | null> {
  try {
    return await loadCredential(key);
  } catch (error) {
    if (!isCredentialDecryptError(error)) throw error;
    logger.warn("[RemoteWorkspace] Profile 凭据在本机无法解密，按缺失处理");
    return null;
  }
}

export async function loadConnectionProfileCredentials(params: {
  profile: ConnectionProfile;
  loadCredential: IServiceAccessor["credentialService"]["load"];
}): Promise<SshReconnectCredentials | null> {
  if (params.profile.target.kind !== "ssh") return null;
  const target = params.profile.target;
  if (!target.passwordCredentialKey && !target.privateKeyPassphraseCredentialKey) {
    return { password: null, privateKeyPassphrase: null };
  }
  return {
    password: target.passwordCredentialKey
      ? await loadUsableProfileCredential(params.loadCredential, target.passwordCredentialKey)
      : null,
    privateKeyPassphrase: target.privateKeyPassphraseCredentialKey
      ? await loadUsableProfileCredential(
          params.loadCredential,
          target.privateKeyPassphraseCredentialKey,
        )
      : null,
  };
}

function resolveSshReconnectSnapshot(params: {
  sessionEntry: RemoteWorkspaceSessionEntry;
  settings?: Pick<AppSettings, "connectionProfiles" | "sourceServerWorkspaceHistory">;
}): RemoteTargetSnapshot {
  const previous = params.sessionEntry.target;
  if (previous.kind !== "ssh") return previous;
  const history = params.settings?.sourceServerWorkspaceHistory?.find(
    (entry) =>
      entry.workspacePath === params.sessionEntry.workspacePath &&
      entry.workspaceIdentity === params.sessionEntry.workspaceIdentity,
  );
  if (!history) return previous;
  const profile = params.settings?.connectionProfiles?.find(
    (candidate) => candidate.profileId === history.profileId && candidate.target.kind === "ssh",
  );
  if (!profile || profile.target.kind !== "ssh") return previous;
  const target = profile.target;
  // Old history may carry only session credential references; compatible only when the auth config matches and
  // the Profile has no new references. After a private-key change, old passwords/passphrases must not be handed
  // to the new key, and old passphrase references must not be misjudged as still needing credentials.
  if (
    !target.passwordCredentialKey &&
    !target.privateKeyPassphraseCredentialKey &&
    target.privateKeyPath === previous.privateKeyPath
  ) {
    return {
      ...target,
      passwordCredentialKey: previous.passwordCredentialKey,
      privateKeyPassphraseCredentialKey: previous.privateKeyPassphraseCredentialKey,
    };
  }
  return target;
}

export async function reconnectRemoteWorkspaceHistoryEntry({
  sessionEntry,
  activateTabByPath,
  setReconnectingRemoteWorkspaceKeys,
  loadCredential,
  getSettings,
  connectRemoteWorkspaceTarget,
  resolveRemoteWorkspaceCanonicalPath,
  bindRemoteWorkspaceScope,
  disposeRemoteWorkspaceSession,
  bindRemoteWorkspacePath,
  bindRemoteWorkspaceIdentity,
  upsertWorkspaceTab,
  commitRemoteWorkspaceSessionMutation,
  getRemoteSessions,
  logger,
  toast,
  shouldKeepReconnectedWorkspace,
  onWorkspaceActivated,
  formatError,
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
    token: null,
  });
  let resolvedWorkspacePath = sessionEntry.workspacePath;
  let resolvedWorkspaceIdentity = fallbackWorkspaceIdentity;
  try {
    const settings = getSettings ? await getSettings() : undefined;
    // Root cause: the original project's reconnect took the Profile's new credentials but kept using the
    // session's old address, so after editing the route it connected back to the old port and the Host
    // registered it as a second Profile. Target and credentials must come from the same config snapshot.
    const targetSnapshot = resolveSshReconnectSnapshot({ sessionEntry, settings });
    const sshCredentials = options?.sshCredentialsOverride ?? {
      password:
        targetSnapshot.kind === "ssh" && targetSnapshot.passwordCredentialKey
          ? await loadUsableProfileCredential(loadCredential, targetSnapshot.passwordCredentialKey)
          : null,
      privateKeyPassphrase:
        targetSnapshot.kind === "ssh" && targetSnapshot.privateKeyPassphraseCredentialKey
          ? await loadUsableProfileCredential(
              loadCredential,
              targetSnapshot.privateKeyPassphraseCredentialKey,
            )
          : null,
    };
    const token =
      sessionEntry.target.kind === "server" && sessionEntry.target.tokenCredentialKey
        ? await loadCredential(sessionEntry.target.tokenCredentialKey)
        : null;
    reconnectTarget = createRemoteTargetFromSnapshot(targetSnapshot, {
      ...sshCredentials,
      token,
    });
    if (options?.requireStoredCredentials && reconnectTarget.kind === "ssh") {
      const expectsPassphrase =
        targetSnapshot.kind === "ssh" && targetSnapshot.privateKeyPassphraseCredentialKey;
      if (
        !sshCredentials.password &&
        (!reconnectTarget.privateKeyPath ||
          (expectsPassphrase && !sshCredentials.privateKeyPassphrase))
      ) {
        throw Object.assign(new Error("credentials-required"), { code: "credentials-required" });
      }
    }
    let sessionId: string;
    try {
      sessionId = await connectRemoteWorkspaceTarget(reconnectTarget, options?.requestId, {
        workspacePath: sessionEntry.workspacePath,
        workspaceIdentity: fallbackWorkspaceIdentity,
        connectTrigger: "reconnect",
      });
    } catch (error) {
      // These two structured errors are emitted only by Host directory admission after the Source is up.
      // The initiating project being deleted does not mean the SSH credentials failed; let siblings reusing
      // the same credentials through first, then record this project's failure on the original path.
      // Bug cause: a 30-second unresponsive directory read was not let through before, so the SSH-group
      // reconnect judged the Host unready and not a single other project on the device reconnected.
      if (
        reconnectTarget.kind === "ssh" &&
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error.code === REMOTE_WORKSPACE_DIRECTORY_UNAVAILABLE_ERROR_CODE ||
          error.code === REMOTE_WORKSPACE_DIRECTORY_UNRESPONSIVE_ERROR_CODE)
      ) {
        options?.onSshHostReady?.(sshCredentials);
      }
      throw error;
    }
    if (reconnectTarget.kind === "ssh") {
      // Host-ready and workspace initialization (provider/task etc.) must be notified in separate stages.
      // From this moment siblings can reuse the initiator credential to create attachments, with no waiting or repeated credential reads.
      options?.onSshHostReady?.(sshCredentials);
    }
    resolvedWorkspacePath = await resolveRemoteWorkspaceCanonicalPath(
      sessionId,
      sessionEntry.workspacePath,
    );
    // Bug cause: the Renderer used to derive identity locally from the transport target, splitting from the
    // authoritative remote:server:* identity bound by the Host. Keep this consistent with first connect:
    // complete the Host bind first, then consume only the returned authoritative scope.
    // This bind is also a prerequisite for the mobile remote-control bridge to pass: the bridge compares the
    // tab's path/identity triple against the main descriptor, and a missing bind — or a bind lagging behind
    // the tab backfill — is rejected with REMOTE_WORKSPACE_IDENTITY_MISMATCH (3.12.0 could not connect to
    // remote projects because of this).
    // The bind must sit before the retention check below: no await may sit between the check and
    // upsertWorkspaceTab, otherwise a stale check result would re-add the workspace after the user removed
    // the tab while waiting for the ready ACK.
    const boundScope = await bindRemoteWorkspaceScope(
      sessionId,
      resolvedWorkspacePath,
      undefined,
      sessionEntry.workspacePurpose ?? "project",
    );
    resolvedWorkspacePath = boundScope.workspacePath;
    resolvedWorkspaceIdentity = boundScope.workspaceIdentity;
    // Bugfix: during a manual reconnect the user may click reconnect and then immediately remove that
    // remote tab. Without one more retention check before the successful commit, the just-removed workspace
    // would be added back.
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
      ...(fallbackWorkspaceIdentity !== resolvedWorkspaceIdentity
        ? { previousWorkspaceIdentity: fallbackWorkspaceIdentity }
        : {}),
      localWorkspacePath: sessionEntry.localWorkspacePath,
      workspacePurpose: sessionEntry.workspacePurpose,
    });
    if (activateWorkspaceAfterReconnect) {
      // The sidebar reconnect used to first activate the disconnected tab that had only an identity and no
      // remoteSessionId yet; the conversation provider returned null due to remote-waiting, blacking out the
      // right pane during connection. Bind services and silently backfill the tab's session metadata first,
      // then activate the tab and draft in one shot.
      const activated = activateTabByPath(resolvedWorkspacePath, {
        workspaceIdentity: resolvedWorkspaceIdentity,
      });
      if (activated) {
        onWorkspaceActivated?.({
          workspacePath: resolvedWorkspacePath,
          workspaceIdentity: resolvedWorkspaceIdentity,
          restoreSelection: true,
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
        workspacePurpose: sessionEntry.workspacePurpose,
        lastConnectionStatus: "connected",
        touchOpenedAt: true,
      }),
    );
  } catch (error) {
    const message =
      formatError?.(error) ?? (error instanceof Error ? error.message : String(error));
    logger.warn("[Root] 手动重连远程 workspace 失败", {
      workspacePath: resolvedWorkspacePath,
      error: message,
    });
    const reasonCode =
      error &&
      typeof error === "object" &&
      "code" in error &&
      typeof error.code === "string" &&
      error.code.trim()
        ? error.code
        : "remote-connection-unknown";
    // Bug cause: failure records used to store only localized copy. Wait points (installation needed etc.)
    // were also written as failures, so handoff could not tell the two apart, route-unrecognized old tabs had
    // to reconnect unconditionally, and after an ordinary failure every click silently redialed without
    // opening the wizard. The error code is persisted alongside the copy now.
    // CR-01: new exceptions may also lack a valid code; write the generic failure code so the record is never
    // again treated as a codeless old one that redials forever.
    await commitRemoteWorkspaceSessionMutation(
      buildRemoteWorkspaceSessionMutation({
        remoteSessions: getRemoteSessions(),
        workspacePath: resolvedWorkspacePath,
        workspaceIdentity: resolvedWorkspaceIdentity,
        target: reconnectTarget,
        lastConnectionStatus: "failed",
        lastConnectionError: message,
        lastConnectionErrorCode: reasonCode,
        touchOpenedAt: false,
      }),
    );
    // Failure facts are written back only here; the manual entry decides whether to hand off to the single wizard after receiving the structured exception.
    if (showErrorToast && shouldShowStandaloneRemoteErrorToast(reasonCode)) {
      toast(message);
    }
    if (options?.throwOnFailure) {
      // The desktop reconnect button needs to swallow the exception and feed back via toast/persisted status,
      // but mobile Web remote control is RPC semantics and must explicitly return the failure to the phone.
      throw error;
    }
  } finally {
    setReconnectingRemoteWorkspaceKeys((currentKeys) =>
      currentKeys.filter((key) => key !== reconnectWorkspaceKey),
    );
  }
}
