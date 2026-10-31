import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useCallback, useRef, useState } from "react";
import type { IServiceAccessor } from "@zcode/services";
import type { ZCodeProvider } from "@zcode/shared";
import { toast } from "@/components/ui/toast.js";
import {
  buildWorkspaceSessionReloadDraftError,
  shouldDebounceWorkspaceSessionReload,
} from "@/lib/workspaceSessionReloadPlan.js";
import { resolveWorkspaceModelConfigSyncScope } from "@/lib/modelConfigSync.js";
import { prepareWorkspaceWithZCodeSessionService } from "@/hooks/useWorkspacePrepare.js";
import { logger } from "@/logger.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";

export function useWorkspaceSessionReload({
  intl,
  services,
  workspaceAbsPath,
  reloadSessionDisabled,
}: {
  intl: { formatMessage: (descriptor: { id: string }) => string };
  services: IServiceAccessor;
  workspaceAbsPath: string;
  reloadSessionDisabled: boolean;
}) {
  const [reloadSessionPending, setReloadSessionPending] = useState(false);
  const workspaceIdentity = useTabStore((state) => {
    if (!state.activeTabId) {
      return undefined;
    }

    const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);
    if (!activeTab || !isWorkspaceTab(activeTab) || activeTab.workspacePath !== workspaceAbsPath) {
      return undefined;
    }

    return activeTab.workspaceIdentity;
  });
  const lastReloadSessionTriggeredAtRef = useRef<number | null>(null);

  const handleReloadSession = useCallback(
    async (options?: { resumeTaskId?: string | null; provider?: ZCodeProvider | null }) => {
      if (reloadSessionDisabled || reloadSessionPending) {
        return;
      }

      const now = Date.now();
      if (shouldDebounceWorkspaceSessionReload(lastReloadSessionTriggeredAtRef.current, now)) {
        // Both the header and error banner can trigger reload, allowing closely spaced clicks to rebuild concurrently.
        // Debounce at the entry point to prevent concurrent restartWorkspaceProcess calls from competing for the same provider-workspace.
        logger.info(`[App] 忽略重复 workspace session 重建请求 workspace=${workspaceAbsPath}`);
        return;
      }
      lastReloadSessionTriggeredAtRef.current = now;
      setReloadSessionPending(true);

      const zcodeSessionStore = useZCodeSessionStore.getState();
      const latestWorkspaceState = zcodeSessionStore.getWorkspaceState(
        workspaceAbsPath,
        workspaceIdentity,
      );
      const actionScope = resolveWorkspaceModelConfigSyncScope(latestWorkspaceState);
      const provider: ZCodeProvider = options?.provider ?? actionScope.provider;
      const resumeTaskId =
        options?.resumeTaskId?.trim() || latestWorkspaceState.activeTaskId || undefined;
      const shouldPrepareWorkspace = !resumeTaskId;

      // Reload session previously called only the service-layer rebuild flow and did not sync workspaceInit state to the UI store.
      // In draft state, the next preparation flow continued reading stale state, making users think this rebuild did not take effect.
      // Explicitly write initializing/ready/failed here to keep rebuild state aligned with the session flow.
      zcodeSessionStore.setWorkspaceInitState(
        workspaceAbsPath,
        "initializing",
        null,
        workspaceIdentity,
      );
      if (shouldPrepareWorkspace) {
        zcodeSessionStore.setConfigOptionsStatus(workspaceAbsPath, "loading", workspaceIdentity);
        // If a reload from draft state does not clear the old error, the input area continues showing the previous failure,
        // making users think the current rebuild also failed. Clear draft errors when the new rebuild starts.
        zcodeSessionStore.setDraftError(workspaceAbsPath, null, workspaceIdentity);
        zcodeSessionStore.setTaskState(workspaceAbsPath, "idle", null, workspaceIdentity);
      }

      try {
        await services.zcodeTaskService.restartWorkspaceProcess({
          workspacePath: workspaceAbsPath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          provider,
          resumeTaskId,
        });

        if (shouldPrepareWorkspace) {
          const prepareResult = await prepareWorkspaceWithZCodeSessionService({
            workspacePath: workspaceAbsPath,
            workspaceIdentity,
            provider,
            zcodeSessionService: services.zcodeSessionService,
          });

          const latestAfterPrepare = zcodeSessionStore.getWorkspaceState(
            workspaceAbsPath,
            workspaceIdentity,
          );
          if (latestAfterPrepare.selectedProvider === provider) {
            const latestAfterResolve = zcodeSessionStore.getWorkspaceState(
              workspaceAbsPath,
              workspaceIdentity,
            );
            if (latestAfterResolve.selectedProvider === provider) {
              zcodeSessionStore.setConfigOptions(
                workspaceAbsPath,
                prepareResult.configOptions ?? [],
                workspaceIdentity,
              );
              zcodeSessionStore.setConfigOptionsStatus(
                workspaceAbsPath,
                "ready",
                workspaceIdentity,
              );
              zcodeSessionStore.setSlashCommands(
                workspaceAbsPath,
                prepareResult.slashCommands ?? [],
                workspaceIdentity,
              );
              zcodeSessionStore.setDraftError(workspaceAbsPath, null, workspaceIdentity);
            }
          }
        }

        zcodeSessionStore.setWorkspaceInitAttempts(workspaceAbsPath, 0, workspaceIdentity);
        zcodeSessionStore.setWorkspaceInitState(workspaceAbsPath, "ready", null, workspaceIdentity);

        logger.info(
          `[App] workspace session 重建完成 workspace=${workspaceAbsPath} provider=${provider} resumeTaskId=${resumeTaskId ?? "<none>"}`,
        );
        toast(intl.formatMessage({ id: "appHeader.reloadSessionSuccess" }));
      } catch (error) {
        const reloadDraftError = buildWorkspaceSessionReloadDraftError(error, {
          workspacePath: workspaceAbsPath,
          provider,
        });
        const message = reloadDraftError.message;
        logger.warn(
          `[App] workspace session 重建失败 workspace=${workspaceAbsPath} provider=${provider}`,
          {
            resumeTaskId: resumeTaskId ?? null,
            message,
          },
        );
        zcodeSessionStore.setWorkspaceInitState(
          workspaceAbsPath,
          "failed",
          message,
          workspaceIdentity,
        );
        if (shouldPrepareWorkspace) {
          zcodeSessionStore.setConfigOptionsStatus(workspaceAbsPath, "error", workspaceIdentity);
          // In draft state, the old error is cleared before reload; if a failure does not restore draftError,
          // only a toast remains in chat and users cannot see the detailed error to retry. Restore the normalized error to the input area here.
          zcodeSessionStore.setDraftError(workspaceAbsPath, reloadDraftError, workspaceIdentity);
        }
        toast(intl.formatMessage({ id: "appHeader.reloadSessionFailed" }));
      } finally {
        setReloadSessionPending(false);
      }
    },
    [
      intl,
      reloadSessionDisabled,
      reloadSessionPending,
      services.zcodeTaskService,
      services.zcodeSessionService,
      workspaceAbsPath,
      workspaceIdentity,
    ],
  );

  return {
    reloadSessionPending,
    handleReloadSession,
  };
}

/** The two UI entries only submit intent; operation merging and lifecycle facts are owned by the CLI. */
export function useSessionRuntimeRestart(
  workspacePath: string,
  sessionId: string | null | undefined,
  remoteSessionId?: string | null,
  workspaceIdentity?: string,
) {
  const services = useWorkspaceServices(
    workspacePath,
    remoteSessionId ?? undefined,
    workspaceIdentity,
  );
  const { intl } = useZCodeIntl();
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const key = `${workspaceIdentity || workspacePath}\0${sessionId ?? ""}`;
  const flight = useRef<{ key: string; promise: Promise<boolean> } | null>(null);
  const restart = useCallback((): Promise<boolean> => {
    if (!sessionId) return Promise.resolve(false);
    if (flight.current?.key === key) return flight.current.promise;
    setPendingKey(key);
    const request = services.zcodeAgentService
      .restartSessionRuntime({
        workspacePath,
        sessionId,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      })
      .then(
        () => true,
        (error: unknown) => {
          logger.warn("[session-lifecycle] 任务重启失败", { sessionId, error });
          toast(
            intl.formatMessage({
              id:
                error instanceof Error &&
                error.message.includes("fault.sessionLifecycle.unsupported")
                  ? "taskList.restartUnsupported"
                  : "taskList.restartFailed",
            }),
          );
          return false;
        },
      )
      .finally(() => {
        if (flight.current?.promise === request) {
          flight.current = null;
          setPendingKey(null);
        }
      });
    flight.current = { key, promise: request };
    return request;
  }, [key, services.zcodeAgentService, workspacePath, workspaceIdentity, sessionId, intl]);
  return { restart, pending: pendingKey === key };
}
