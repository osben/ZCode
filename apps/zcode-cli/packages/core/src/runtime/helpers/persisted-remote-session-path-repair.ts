import {
  CoreErrorType,
  createCoreError,
  isCoreError,
  type RepairRemoteSessionPathsInput,
  type SessionInfo,
  type SessionStorePort,
} from "@zcode/contracts";
import { parseRemoteWorkspaceIdentity } from "@zcode/shared";

const REMOTE_SESSION_PATH_CORRUPTION_REASON = "remote_session_workspace_path_corrupted";

type PathFieldResolution = "clean" | "repair" | "unrelated" | "unsafe";

type RemoteSessionPathRepairStore = Pick<SessionStorePort, "getSession"> & {
  repairRemoteSessionPaths?: (input: RepairRemoteSessionPathsInput) => Promise<boolean>;
};

function buildKnownPollutedPath(workspacePath: string, workspaceIdentity: string): string {
  return workspacePath === "/" ? `/${workspaceIdentity}` : `${workspacePath}/${workspaceIdentity}`;
}

function resolvePathField(
  value: string,
  workspacePath: string,
  workspaceIdentity: string,
): PathFieldResolution {
  if (value === workspacePath) return "clean";
  if (
    value === workspaceIdentity ||
    value === buildKnownPollutedPath(workspacePath, workspaceIdentity)
  ) {
    return "repair";
  }
  return value.includes(workspaceIdentity) ? "unsafe" : "unrelated";
}

/**
 * Older versions persisted workspaceIdentity as cwd or appended it to the actual workspacePath.
 * Repair only these two known, provable corruption patterns; do not guess when data contains the identity but the prefix does not match.
 */
export async function repairPersistedRemoteSessionPaths(
  sessionStore: RemoteSessionPathRepairStore,
  session: SessionInfo,
  options?: { onPersistenceFailure?: (error: unknown) => void },
): Promise<SessionInfo> {
  const workspaceIdentity = session.workspaceID?.trim();
  if (!workspaceIdentity) return session;
  const remoteWorkspace = parseRemoteWorkspaceIdentity(workspaceIdentity);
  if (!remoteWorkspace) {
    if (!workspaceIdentity.startsWith("remote:")) return session;
    throw createCoreError(
      CoreErrorType.SessionCorrupted,
      "Persisted remote session workspace identity is invalid",
      {
        context: {
          directory: session.directory,
          path: session.path,
          reason: REMOTE_SESSION_PATH_CORRUPTION_REASON,
          sessionId: session.id,
          workspaceIdentity,
        },
        recoverable: true,
      },
    );
  }

  const directoryResolution = resolvePathField(
    session.directory,
    remoteWorkspace.workspacePath,
    workspaceIdentity,
  );
  const pathResolution =
    session.path === undefined
      ? "clean"
      : resolvePathField(session.path, remoteWorkspace.workspacePath, workspaceIdentity);

  if (directoryResolution === "unsafe" || pathResolution === "unsafe") {
    throw createCoreError(
      CoreErrorType.SessionCorrupted,
      "Remote session workspace path is corrupted and cannot be repaired safely",
      {
        context: {
          directory: session.directory,
          path: session.path,
          reason: REMOTE_SESSION_PATH_CORRUPTION_REASON,
          sessionId: session.id,
          workspaceIdentity,
        },
        recoverable: true,
      },
    );
  }
  if (directoryResolution !== "repair" && pathResolution !== "repair") return session;

  const repairedSession: SessionInfo = {
    ...session,
    ...(directoryResolution === "repair" ? { directory: remoteWorkspace.workspacePath } : {}),
    ...(pathResolution === "repair" ? { path: remoteWorkspace.workspacePath } : {}),
  };
  const repairInput: RepairRemoteSessionPathsInput = {
    sessionID: session.id,
    workspaceID: workspaceIdentity as RepairRemoteSessionPathsInput["workspaceID"],
    expectedDirectory: session.directory,
    expectedPath: session.path ?? null,
    directory: repairedSession.directory,
    path: repairedSession.path ?? null,
    timeUpdated: session.time.updated,
  };
  if (!sessionStore.repairRemoteSessionPaths) {
    const error = new Error("Session store does not support narrow remote path repair");
    options?.onPersistenceFailure?.(error);
    return repairedSession;
  }
  try {
    const persisted = await sessionStore.repairRemoteSessionPaths(repairInput);
    const refreshed = await sessionStore.getSession(session.id);
    if (persisted) return refreshed ?? repairedSession;
    if (!refreshed) {
      throw createCoreError(
        CoreErrorType.SessionCorrupted,
        "Remote session disappeared during path repair",
        {
          context: {
            reason: REMOTE_SESSION_PATH_CORRUPTION_REASON,
            sessionId: session.id,
            workspaceIdentity,
          },
          recoverable: true,
        },
      );
    }

      // A CAS miss means the path or identity was concurrently updated; reassess using the new facts instead of returning the old snapshot.
    const refreshedIdentity = refreshed.workspaceID?.trim();
    if (refreshedIdentity !== workspaceIdentity) {
      throw createCoreError(
        CoreErrorType.SessionCorrupted,
        "Remote session workspace identity changed during path repair",
        {
          context: {
            directory: refreshed.directory,
            path: refreshed.path,
            reason: REMOTE_SESSION_PATH_CORRUPTION_REASON,
            sessionId: refreshed.id,
            workspaceIdentity: refreshedIdentity,
          },
          recoverable: true,
        },
      );
    }
    const refreshedDirectory = resolvePathField(
      refreshed.directory,
      remoteWorkspace.workspacePath,
      workspaceIdentity,
    );
    const refreshedPath =
      refreshed.path === undefined
        ? "clean"
        : resolvePathField(refreshed.path, remoteWorkspace.workspacePath, workspaceIdentity);
    if (refreshedDirectory === "unsafe" || refreshedPath === "unsafe") {
      throw createCoreError(
        CoreErrorType.SessionCorrupted,
        "Remote session workspace path changed to an unsafe value during repair",
        {
          context: {
            directory: refreshed.directory,
            path: refreshed.path,
            reason: REMOTE_SESSION_PATH_CORRUPTION_REASON,
            sessionId: refreshed.id,
            workspaceIdentity,
          },
          recoverable: true,
        },
      );
    }
    if (refreshedDirectory !== "repair" && refreshedPath !== "repair") return refreshed;

      // If the adapter rejects CAS while the persisted value is still the same known corruption pattern, use only a deterministic in-memory repair
      // built from the latest metadata. The next cold read retries; no concurrent session facts are overwritten.
    options?.onPersistenceFailure?.(new Error("Remote session path repair CAS did not match"));
    return {
      ...refreshed,
      ...(refreshedDirectory === "repair" ? { directory: remoteWorkspace.workspacePath } : {}),
      ...(refreshedPath === "repair" ? { path: remoteWorkspace.workspacePath } : {}),
    };
  } catch (error) {
    if (isCoreError(error) && error.type === CoreErrorType.SessionCorrupted) {
      throw error;
    }
    // Once the path is determined, a transient disk-write failure should not keep blocking this recovery; the next read will retry.
    options?.onPersistenceFailure?.(error);
    return repairedSession;
  }
}
