import { useCallback, useEffect, useRef, useState } from "react";
import type { Hook } from "@zcode/shared";
import type { IHooksService } from "@zcode/services";
import { toast } from "@/components/ui/toast.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { useHooksStore } from "@/store/hooksStore.js";
import {
  findWorkspaceHookCommandBinding,
  findWorkspaceHookReviewBinding,
  useWorkspaceHookReviewStore,
} from "@/store/workspaceHookReviewStore.js";
import { trustWorkspaceHookWithReview } from "./workspaceHookReviewCommands.js";
import {
  didWorkspaceHookReviewSettle,
  resolveWorkspaceHookReasonCodeMessageId,
  shouldSilenceStaleRejection,
} from "./workspaceHookTrustState.js";

export function useWorkspaceHookInlineTrust(input: {
  workspacePath?: string | null;
  workspaceIdentity?: string;
  authorityKey?: string;
  hooksService?: IHooksService;
  rpcReady?: boolean;
  /**
   * 列表的加载目标，缺省等于 workspacePath/workspaceIdentity。受管 worktree 审核时发现路径是
   * worktree、identity 是项目 key（D23）：review/command binding 仍按项目匹配，刷新与无会话
   * 授权必须按 worktree 发现，否则会写入源仓库的摘要（ZP-20261110-06）。
   */
  hooksTarget?: { workspacePath: string; workspaceIdentity?: string };
}) {
  const { intl } = useZCodeIntl();
  const contextServices = useServices();
  const loadWorkspacePath = input.hooksTarget?.workspacePath ?? input.workspacePath;
  const loadWorkspaceIdentity = input.hooksTarget
    ? input.hooksTarget.workspaceIdentity
    : input.workspaceIdentity;
  // Settings' PluginScopeMenu can select a workspace (including remote) that is not currently active.
  // If post-trust list refresh or the settings pre-trust fallback uses the context service from useServices() (which points to the active
  // tab's host), the RPC goes to the wrong host; while remote-waiting, the fallback may send an out-of-scope RPC to a
  // disconnected proxy. Therefore hooksService must be supplied by the caller, resolved for the target workspace, and
  // when rpcReady=false both fallback and refresh must be disabled (the trust path may be unavailable, but must not target the wrong host).
  const hooksService =
    input.rpcReady === false
      ? undefined
      : (input.hooksService ??
        (input.rpcReady === true ? contextServices.hooksService : undefined));
  const canUseHooksService = hooksService !== undefined;
  const refreshHooks = useHooksStore((state) => state.refresh);
  const [trustingHookId, setTrustingHookId] = useState<string | null>(null);
  const activeReview = useWorkspaceHookReviewStore((state) =>
    findWorkspaceHookReviewBinding(state.bindings, input.workspacePath, input.workspaceIdentity),
  );
  const activeReviewInteractionId = activeReview?.request.interactionId;
  const hasWorkspaceGrantAuthority =
    canUseHooksService && Boolean(hooksService!.grantWorkspaceHookTrust);
  const trustActionAvailable = useWorkspaceHookReviewStore(
    (state) =>
      hasWorkspaceGrantAuthority ||
      Boolean(
        findWorkspaceHookReviewBinding(
          state.bindings,
          input.workspacePath,
          input.workspaceIdentity,
        ) ??
        findWorkspaceHookCommandBinding(
          state.commandBindings,
          input.workspacePath,
          input.workspaceIdentity,
        ),
      ),
  );

  // Refresh the list after the review binding ends so a persisted Trust does not leave the inline button on a stale snapshot.
  const previousReviewInteractionId = useRef(activeReviewInteractionId);
  useEffect(() => {
    const settled = didWorkspaceHookReviewSettle({
      previousInteractionId: previousReviewInteractionId.current,
      currentInteractionId: activeReviewInteractionId,
    });
    previousReviewInteractionId.current = activeReviewInteractionId;
    if (!settled || !loadWorkspacePath || !canUseHooksService) return;
    // Capture the tuple and service at the same time to avoid contaminating a new workspace if scope changes while refresh is pending.
    const service = hooksService!;
    const target = {
      workspacePath: loadWorkspacePath,
      workspaceIdentity: loadWorkspaceIdentity,
      authorityKey: input.authorityKey,
    };
    void refreshHooks(service, target);
  }, [
    activeReviewInteractionId,
    canUseHooksService,
    hooksService,
    input.authorityKey,
    loadWorkspaceIdentity,
    loadWorkspacePath,
    refreshHooks,
  ]);

  const trustHook = useCallback(
    async (hook: Hook) => {
      if (!canUseHooksService) return;
      const service = hooksService!;
      setTrustingHookId(hook.id);
      try {
        const result = await trustWorkspaceHookWithReview({
          hook,
          workspacePath: input.workspacePath,
          workspaceIdentity: input.workspaceIdentity,
          grantWorkspacePath: loadWorkspacePath,
          ...(service.grantWorkspaceHookTrust
            ? {
                grantWithoutSession: (target) => service.grantWorkspaceHookTrust!(target),
              }
            : {}),
        });
        if (!result.accepted) {
          const currentBinding = findWorkspaceHookReviewBinding(
            useWorkspaceHookReviewStore.getState().bindings,
            input.workspacePath,
            input.workspaceIdentity,
          );
          const hasLivePendingBinding = Boolean(currentBinding);
          if (
            !shouldSilenceStaleRejection({
              reasonCode: result.reasonCode,
              hasLivePendingBinding,
            })
          ) {
            toast(
              intl.formatMessage({
                id: resolveWorkspaceHookReasonCodeMessageId(result.reasonCode),
              }),
            );
          }
          return;
        }
        // After success, refresh atomically for the target captured at invocation; if scope changed while waiting, the store guard discards it.
        await refreshHooks(service, {
          workspacePath: loadWorkspacePath,
          workspaceIdentity: loadWorkspaceIdentity,
          authorityKey: input.authorityKey,
        });
      } catch (cause) {
        logger.error("[workspace-hook-trust] 行内信任命令失败", { cause });
        toast(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setTrustingHookId(null);
      }
    },
    [
      canUseHooksService,
      hooksService,
      input.authorityKey,
      input.workspaceIdentity,
      input.workspacePath,
      intl,
      loadWorkspaceIdentity,
      loadWorkspacePath,
      refreshHooks,
    ],
  );

  return {
    activeReviewInteractionId,
    trustActionAvailable,
    trustingHookId,
    trustHook,
  };
}
