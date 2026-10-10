import { useCallback, useEffect, useMemo, useState } from "react";
import { isZCodeAgentProvider, ZCODE_AGENT_PROVIDER, type ZCodeProvider } from "@zcode/shared";
import type { IModelSelectionService, ModelSelectionView } from "@zcode/services";
import {
  buildModelConfigMissingUiError,
  type ModelConfigMissingUiError,
} from "@/lib/chatPrepareError.js";
import { logger } from "@/logger.js";

type DraftModelReadinessStatus = "checking" | "ready" | "missing" | "check-failed";

interface DraftModelReadinessState {
  gateKey: string;
  status: DraftModelReadinessStatus;
  dismissed: boolean;
}

interface DraftModelReadinessGate {
  /** Allow workspace prepare/prewarm only after readiness is confirmed or the check itself is unavailable. */
  agentStartupAllowed: boolean;
  error: ModelConfigMissingUiError | null;
  dismissError(): void;
  /** Authoritative recheck at first-send admission; false means keep the composer and return blocked. */
  ensureReadyForSend(): Promise<boolean>;
  /** Reproject the same error into the draft banner if the Host gate wins a race after the UI recheck. */
  markProviderNotReady(): void;
}

function resolveModelSelectionReadinessStatus(
  view: ModelSelectionView,
): Extract<DraftModelReadinessStatus, "ready" | "missing"> {
  return view.providers.some((provider) => provider.models.length > 0) ? "ready" : "missing";
}

/**
 * Provider/model admission for V4 drafts.
 *
 * The V4 migration removed the renderer readiness gate from the old useWorkspacePrepare; the first draft send
 * now registers a pending command before Host rejects it with provider_not_ready. The recovery ledger then misclassifies this deterministic rejection as
 * unknown. Restore a UI preflight gate here; the Host gate remains as process-level race protection.
 */
export function useDraftModelReadinessGate(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  provider?: ZCodeProvider;
  sessionId: string | null;
  modelSelectionService: Pick<IModelSelectionService, "getView" | "onDidChange">;
}): DraftModelReadinessGate {
  const { workspacePath, workspaceIdentity, provider, sessionId, modelSelectionService } = params;
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const displayProvider = provider ?? ZCODE_AGENT_PROVIDER;
  const enabled = sessionId === null && isZCodeAgentProvider(displayProvider);
  const gateKey = `${workspaceKey}\u0000${displayProvider}`;
  const [state, setState] = useState<DraftModelReadinessState>(() => ({
    gateKey,
    status: enabled ? "checking" : "ready",
    dismissed: false,
  }));

  const commitStatus = useCallback(
    (status: DraftModelReadinessStatus, options: { revealMissing?: boolean } = {}) => {
      setState((current) => ({
        gateKey,
        status,
        dismissed:
          status === "missing"
            ? options.revealMissing
              ? false
              : current.gateKey === gateKey && current.status === "missing"
                ? current.dismissed
                : false
            : false,
      }));
    },
    [gateKey],
  );

  useEffect(() => {
    if (!enabled) {
      commitStatus("ready");
      return;
    }

    commitStatus("checking");
    let disposed = false;
    let registryEventVersion = 0;
    const applyStatus = (status: DraftModelReadinessStatus) => {
      if (disposed) return;
      commitStatus(status);
    };
    const subscription = modelSelectionService.onDidChange((view) => {
      registryEventVersion += 1;
      applyStatus(resolveModelSelectionReadinessStatus(view));
    });
    const initialReadVersion = registryEventVersion;
    void modelSelectionService
      .getView()
      .then((view) => {
        // If a read starts before a change event but returns afterward, the event snapshot is newer; prevent the old read from overwriting it.
        if (registryEventVersion !== initialReadVersion) return;
        applyStatus(resolveModelSelectionReadinessStatus(view));
      })
      .catch((error) => {
        handleReadinessFailure(error);
      });

    function handleReadinessFailure(error: unknown) {
      if (disposed) return;
      // Registry read failure does not mean “there are definitely no models.” Keep the Host gate as a fallback to avoid
      // incorrectly showing a transient app-global service failure as a user configuration problem.
      commitStatus("check-failed");
      logger.warn("[v4-draft-readiness] provider registry 检查失败，回落 Host 门禁", {
        error: error instanceof Error ? error.message : String(error),
        workspaceKey,
      });
    }

    return () => {
      disposed = true;
      subscription?.dispose();
    };
  }, [commitStatus, enabled, modelSelectionService, workspaceKey]);

  const effectiveState: DraftModelReadinessState =
    state.gateKey === gateKey
      ? state
      : { gateKey, status: enabled ? "checking" : "ready", dismissed: false };

  const markProviderNotReady = useCallback(() => {
    commitStatus("missing", { revealMissing: true });
  }, [commitStatus]);

  const ensureReadyForSend = useCallback(async (): Promise<boolean> => {
    if (!enabled) return true;
    try {
      const view = await modelSelectionService.getView();
      const status = resolveModelSelectionReadinessStatus(view);
      commitStatus(status, { revealMissing: status === "missing" });
      if (status === "missing") {
        logger.info("[v4-draft-readiness] 无可用 provider/model，草稿首发在 UI admission 拒绝", {
          providerCount: view.providers.length,
          revision: view.revision,
          workspaceKey,
        });
        return false;
      }
      return true;
    } catch (error) {
      // Match the mount check: registry read failure does not masquerade as “no models”; let the Host launch gate decide.
      commitStatus("check-failed");
      logger.warn("[v4-draft-readiness] 首发复查 provider registry 失败，回落 Host 门禁", {
        error: error instanceof Error ? error.message : String(error),
        workspaceKey,
      });
      return true;
    }
  }, [commitStatus, enabled, modelSelectionService, workspaceKey]);

  const error = useMemo(
    () =>
      enabled && effectiveState.status === "missing" && !effectiveState.dismissed
        ? buildModelConfigMissingUiError()
        : null,
    [effectiveState.dismissed, effectiveState.status, enabled],
  );

  const dismissError = useCallback(() => {
    setState((current) =>
      current.gateKey === gateKey && current.status === "missing"
        ? { ...current, dismissed: true }
        : current,
    );
  }, [gateKey]);

  return {
    agentStartupAllowed:
      !enabled || effectiveState.status === "ready" || effectiveState.status === "check-failed",
    error,
    dismissError,
    ensureReadyForSend,
    markProviderNotReady,
  };
}
