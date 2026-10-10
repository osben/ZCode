import { useEffect, useMemo, useRef, useState } from "react";
import type { ZCodeSkillReferenceCatalogEntry } from "@zcode/shared";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";

interface ConversationSkillCatalogState {
  skills: ZCodeSkillReferenceCatalogEntry[];
  authority: "session" | "workspace" | null;
  loading: boolean;
  error: string | null;
}

interface ScopedConversationSkillCatalogState {
  scope: object | null;
  value: ConversationSkillCatalogState;
}

const EMPTY_STATE: ConversationSkillCatalogState = {
  skills: [],
  authority: null,
  loading: false,
  error: null,
};

const EMPTY_SCOPED_STATE: ScopedConversationSkillCatalogState = {
  scope: null,
  value: EMPTY_STATE,
};

interface UseSkillsOptions {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string | null;
  enabled: boolean;
  preferredRemoteSessionId?: string;
}

/**
 * Skill catalog for the Composer.
 * A draft without prewarm uses the current workspace scan as its authority; prewarmed or existing sessions use the corresponding
 * AgentRuntime frozen snapshot as the authority. When the workspace/session/remote attachment/runtime generation changes,
 * stale async results must never be applied.
 */
export function useSkills(options: UseSkillsOptions): ConversationSkillCatalogState {
  const resolution = useWorkspaceServicesResolution(
    options.workspacePath,
    options.preferredRemoteSessionId,
    options.workspaceIdentity,
  );
  const [scopedState, setScopedState] =
    useState<ScopedConversationSkillCatalogState>(EMPTY_SCOPED_STATE);
  const [runtimeRevision, setRuntimeRevision] = useState(0);
  const requestSeqRef = useRef(0);
  const workspaceKey = options.workspaceIdentity?.trim() || options.workspacePath;
  const remoteSessionId =
    resolution.remoteSessionId ?? options.preferredRemoteSessionId ?? undefined;
  const services = resolution.services;
  const rpcReady = resolution.rpcReady;
  const requestKey = `${workspaceKey}|${remoteSessionId ?? "local"}|${options.sessionId ?? "draft"}|runtime:${runtimeRevision}`;

  useEffect(() => {
    if (!options.enabled || !options.sessionId || !rpcReady) return;
    const subscription = services.zcodeAgentService.onAgentRuntimeRestarted((event) => {
      if (event.workspaceKey !== workspaceKey) return;
      // The workspace/session key stays the same after a runtime restart, so the old catalog would still match.
      // Advance the generation explicitly so a cold-restored runtime must provide Session authority again.
      setRuntimeRevision((current) => current + 1);
    });
    return () => subscription.dispose();
  }, [options.enabled, options.sessionId, rpcReady, services, workspaceKey]);

  // Isolate rendering by scope identity: return an empty state even before the effect for a key change runs,
  // so Skills from an old Session or remote attachment cannot leak into the new Composer for one frame.
  const requestScope = useMemo(
    () => ({}),
    [options.enabled, remoteSessionId, requestKey, rpcReady, services],
  );

  useEffect(() => {
    if (!options.enabled || !options.workspacePath || !rpcReady) return;
    const seq = ++requestSeqRef.current;
    let cancelled = false;
    setScopedState({
      scope: requestScope,
      value: { skills: [], authority: null, loading: true, error: null },
    });
    const params = {
      workspacePath: options.workspacePath,
      ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
      ...(remoteSessionId ? { remoteSessionId } : {}),
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    };
    services.zcodeAgentService
      .getSkillReferenceCatalog(params)
      .then((result) => {
        if (cancelled || seq !== requestSeqRef.current) return;
        setScopedState({
          scope: requestScope,
          value: {
            skills: result.skills,
            authority: result.authority,
            loading: false,
            error: null,
          },
        });
      })
      .catch((error: unknown) => {
        if (cancelled || seq !== requestSeqRef.current) return;
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("[useSkills] 拉取对话 Skill catalog 失败", {
          error: message,
          requestKey,
        });
        setScopedState({
          scope: requestScope,
          value: { skills: [], authority: null, loading: false, error: message },
        });
      });
    return () => {
      cancelled = true;
    };
  }, [
    options.enabled,
    options.sessionId,
    options.workspaceIdentity,
    options.workspacePath,
    remoteSessionId,
    requestKey,
    requestScope,
    rpcReady,
    services,
  ]);

  if (
    !options.enabled ||
    !options.workspacePath ||
    !rpcReady ||
    scopedState.scope !== requestScope
  ) {
    return EMPTY_STATE;
  }
  return scopedState.value;
}
