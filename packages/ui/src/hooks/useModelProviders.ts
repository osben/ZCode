import { useState, useCallback, useMemo, useRef } from "react";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";
import type { ModelConnectivityResult } from "@zcode/shared";
import type { ProviderSettingsView } from "@zcode/services";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import { useProviderSettingsServiceView } from "@/hooks/useProviderSettingsView.js";
import {
  projectProviderSettingsViewToFormProviders,
  resolveProviderSettingsFormProviders,
  resolveProviderOrdering,
} from "@/lib/providerSettingsFormProjection.js";
import { persistProviderDisplayOrder } from "@/lib/providerDisplayOrderPersistence.js";
import { persistPersonalProviderDeletion } from "@/lib/providerPersonalPersistence.js";
import { persistPersonalProvider } from "@/lib/providerPersonalSave.js";
import type { ProviderOrderView } from "@/lib/modelProviderOrdering.js";

export function useModelProviders(target: {
  workspacePath: string;
  workspaceIdentity?: string;
  /** Local cwd for connectivity tests in Provider Settings; do not reuse a remote activation path. */
  connectivityWorkspacePath?: string;
  /** Under remote activation, never fall back to the remote workspacePath; with no local cwd, use the local Host's conversation directory instead. */
  connectivityWorkspaceRequired?: boolean;
  /** Localized error message shown to the user when even the local Host cannot provide a conversation directory. */
  connectivityUnavailableMessage?: string;
}) {
  const { providerSettingsService, fileService } = useServices();
  const providerSettingsRead = useProviderSettingsServiceView(providerSettingsService);
  // No ACP filter here: the host derives `acp:<agentId>` providers only on a supported platform
  // (specs/acp-agent-runtime.md "Availability (platform rule)"), and ACP-managed providers never
  // reach the custom group.
  const providerSettingsView = useMemo(
    () => (providerSettingsRead.state.status === "ready" ? providerSettingsRead.state.view : null),
    [providerSettingsRead.state],
  );
  const effectiveModelProviders = useMemo(
    () =>
      resolveProviderSettingsFormProviders({
        view: providerSettingsView,
      }),
    [providerSettingsView],
  );
  const providerOrdering = useMemo(
    () =>
      resolveProviderOrdering({
        view: providerSettingsView,
        providers: effectiveModelProviders,
      }),
    [effectiveModelProviders, providerSettingsView],
  );
  const commitProviderSettingsView = useCallback(
    (view: ProviderSettingsView): void => {
      // The remote mutation's return value is the authoritative View after the target Environment was refreshed.
      // Relying only on onDidChange can leave a pre-deletion UI snapshot after an attachment replacement or lost event.
      // Commit the returned View at the hook boundary; useProviderSettingsServiceView still guards by Service/revision.
      providerSettingsRead.commit(view);
    },
    [providerSettingsRead.commit],
  );
  const [refreshing, setRefreshing] = useState(false);
  const latestRefreshTokenRef = useRef(0);

  const refresh = useCallback(async () => {
    const refreshToken = latestRefreshTokenRef.current + 1;
    latestRefreshTokenRef.current = refreshToken;
    setRefreshing(true);
    try {
      const view = await providerSettingsService.refresh("settings-manual");
      commitProviderSettingsView(view);
    } catch (err) {
      logger.error("[useModelProviders] 加载模型供应商失败", err);
    } finally {
      // If the user triggers refresh repeatedly, an older request may return first.
      // Without a token guard, its finally block can clear refreshing early and make the title's loading indicator flicker off.
      if (refreshToken === latestRefreshTokenRef.current) {
        setRefreshing(false);
      }
    }
  }, [commitProviderSettingsView, providerSettingsService]);

  const saveProvider = useCallback(
    async (provider: ProviderSettingsFormProvider) => {
      // A newly created Provider is not yet in the Registry, so it cannot appear in the current Settings View.
      // The save boundary permits a missing inherited layer and builds the full configuration directly from the create form.
      const savedView = await persistPersonalProvider({ provider, providerSettingsService });
      commitProviderSettingsView(savedView);
      return projectProviderSettingsViewToFormProviders(savedView);
    },
    [commitProviderSettingsView, providerSettingsService],
  );

  const createPersonalProvider = useCallback(
    async (input?: Parameters<typeof providerSettingsService.createPersonalProvider>[0]) => {
      const created = await providerSettingsService.createPersonalProvider(input);
      commitProviderSettingsView(created.view);
      return created;
    },
    [commitProviderSettingsView, providerSettingsService],
  );

  const addPersonalModel = useCallback(
    (
      providerId: string,
      modelId: string,
      config: ProviderSettingsFormProvider["models"][number]["personalConfig"],
      useRecommendedConfig?: boolean,
    ) =>
      providerSettingsService
        .addPersonalModel(providerId, modelId, config, useRecommendedConfig)
        .then((view) => {
          commitProviderSettingsView(view);
          return view;
        }),
    [commitProviderSettingsView, providerSettingsService],
  );

  const savePersonalModelDraft = useCallback(
    async (input: Parameters<typeof providerSettingsService.savePersonalModelDraft>[0]) => {
      const view = await providerSettingsService.savePersonalModelDraft(input);
      commitProviderSettingsView(view);
      return view;
    },
    [commitProviderSettingsView, providerSettingsService],
  );

  const setPersonalModelEnabled = useCallback(
    async (providerId: string, modelId: string, enabled: boolean) => {
      const view = await providerSettingsService.setPersonalModelEnabled(
        providerId,
        modelId,
        enabled,
      );
      commitProviderSettingsView(view);
      return view;
    },
    [commitProviderSettingsView, providerSettingsService],
  );

  const deletePersonalModel = useCallback(
    async (providerId: string, modelId: string) => {
      const view = await providerSettingsService.deletePersonalModel(providerId, modelId);
      commitProviderSettingsView(view);
      return view;
    },
    [commitProviderSettingsView, providerSettingsService],
  );

  const deleteProvider = useCallback(
    async (id: string) => {
      const view = await persistPersonalProviderDeletion({
        providerId: id,
        providerSettingsService,
      });
      commitProviderSettingsView(view);
    },
    [commitProviderSettingsView, providerSettingsService],
  );

  const reorderProviderModels = useCallback(
    async (providerId: string, modelIds: readonly string[]) => {
      const view = await providerSettingsService.reorderPersonalModels(providerId, modelIds);
      commitProviderSettingsView(view);
    },
    [commitProviderSettingsView, providerSettingsService],
  );

  const saveDisplayOrder = useCallback(
    async (state: ProviderOrderView) => {
      const normalizedState: ProviderOrderView = {
        providerIds: [...new Set(state.providerIds.map((id) => id.trim()).filter(Boolean))],
      };
      try {
        const view = await persistProviderDisplayOrder({
          state: normalizedState,
          providerSettingsService,
        });
        commitProviderSettingsView(view);
      } catch (err) {
        logger.warn("[useModelProviders] 保存 Personal Provider 顺序失败", err);
        throw err;
      }
    },
    [commitProviderSettingsView, providerSettingsService],
  );

  const testModelConnectivity = useCallback(
    async (providerId: string, modelId: string): Promise<ModelConnectivityResult> => {
      // Under remote activation target.workspacePath is a remote path and cannot serve as the local Agent cwd.
      const remoteActive = Boolean(
        target.connectivityWorkspaceRequired || target.workspaceIdentity?.trim(),
      );
      let workspacePath =
        target.connectivityWorkspacePath?.trim() || (remoteActive ? "" : target.workspacePath);
      if (!workspacePath.trim()) {
        // Bug root cause (ZCT-2112556538453495808): the old logic only recognized opened local tabs and
        // reported "local workspace unavailable" when only remote projects were open. Provider config is a local
        // global config and tests do not depend on the project; the local Host always has its own conversation
        // directory (the Host also uses it to prepare the session store on remote-restore startup), so the Host
        // resolves and creates it — the UI builds no path itself and never hands a remote path to the local machine.
        try {
          workspacePath = (await fileService.ensureConversationWorkspace()).path;
        } catch (err) {
          logger.warn("[useModelProviders] 解析本机对话目录失败，无法测试模型连通性", err);
          return {
            success: false,
            error: {
              message:
                target.connectivityUnavailableMessage ??
                "A local workspace is unavailable for connectivity testing.",
            },
          };
        }
      }
      return providerSettingsService.testModelConnectivity({
        workspacePath,
        providerId,
        modelId,
      });
    },
    [
      fileService,
      providerSettingsService,
      target.connectivityUnavailableMessage,
      target.connectivityWorkspacePath,
      target.connectivityWorkspaceRequired,
      target.workspacePath,
      target.workspaceIdentity,
    ],
  );

  return {
    modelProviders: effectiveModelProviders,
    providerTemplates: providerSettingsView?.providerTemplates ?? [],
    displayOrder: providerOrdering.displayOrder,
    reorderableProviderIds: providerOrdering.reorderableProviderIds,
    loading: providerSettingsRead.state.status === "loading",
    loadError:
      providerSettingsRead.state.status === "error" ? providerSettingsRead.state.error : null,
    reload: providerSettingsRead.reload,
    refreshing,
    refresh,
    saveProvider,
    createPersonalProvider,
    addPersonalModel,
    savePersonalModelDraft,
    setPersonalModelEnabled,
    deletePersonalModel,
    deleteProvider,
    reorderProviderModels,
    saveDisplayOrder,
    testModelConnectivity,
    providerSettingsView,
  };
}
