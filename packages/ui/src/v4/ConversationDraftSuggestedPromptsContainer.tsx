import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useOnboardingRecordService } from "@/hooks/useOnboardingRecordService.js";
import {
  advanceRecommendedPromptPane,
  getRecommendedPromptsForPane,
  getRecommendedPromptsRevision,
  registerRecommendedPromptPane,
  subscribeRecommendedPrompts,
  unregisterRecommendedPromptPane,
} from "@/v4/featureSuggestedPromptRotation.js";
/* oxlint-disable eslint(max-lines) -- Recommended prompts centralize latest-wins, cancellation, trusted parsing, operation feedback, and Composer cleanup; splitting them would scatter this state machine. */
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import type { AutomationsNavigationTab } from "@/lib/taskNavigationHistory.js";
import { reportPromptTemplateClick } from "@/lib/promptTemplateTelemetry.js";
import { invalidateDeferredDraftSessionForSkillChange } from "@/lib/zcodeDraftSkillInvalidation.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import {
  ConversationDraftSuggestedPrompts,
  type DraftSuggestedPromptItem,
} from "@/v4/ConversationDraftSuggestedPrompts.js";
import { buildDraftSuggestedPluginMention } from "@/v4/draftSuggestedPromptPrefill.js";
import { resolveDraftSuggestedPromptText } from "@/v4/draftSuggestedPromptItems.js";
import {
  DRAFT_SUGGESTED_PROMPT_NAVIGATE_AUTOMATIONS,
  DRAFT_SUGGESTED_PROMPT_NAVIGATE_AUTOMATIONS_OFFPEAK,
} from "@/v4/draftSuggestedPromptItems.js";
import {
  resolveDraftSuggestedPluginFlowStage,
  type ConversationDraftSuggestedPromptsContainerProps,
  type DraftSuggestedPluginFlow,
  type DraftSuggestedPluginOperation,
  trackDraftSuggestedPluginOperation,
} from "@/v4/ConversationDraftSuggestedPluginFlow.js";
import { useDraftSuggestedPromptItems } from "@/v4/useDraftSuggestedPromptItems.js";
import { useDraftSuggestedPluginActionPopover } from "@/v4/useDraftSuggestedPluginActionPopover.js";
import { getComposerDraftRevision } from "@/v4/composer/composerDraftRevision.js";
import { useComposerTextInsertApplied } from "@/v4/useComposerTextInsertApplied.js";

type PluginMutationKind = "install" | "enable";

const INSTALL_OPERATION_TIMEOUT_MS = 10_000;

type Props = ConversationDraftSuggestedPromptsContainerProps & {
  proactive?: boolean;
  onOpenAutomations?: (automationTab?: AutomationsNavigationTab) => void;
};

let draftSuggestedPluginOperationSequence = 0;

function createDraftSuggestedPluginOperation(
  requestVersion: number,
): DraftSuggestedPluginOperation {
  return {
    operationId:
      globalThis.crypto?.randomUUID?.() ??
      `suggested-${Date.now()}-${requestVersion}-${++draftSuggestedPluginOperationSequence}`,
    abort: new AbortController(),
  };
}

function toPluginMutationErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ConversationDraftSuggestedPromptsContainer({
  className,
  proactive = false,
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  onOpenAutomations,
  isDesktop = false,
}: Props) {
  const { intl, locale } = useZCodeIntl();
  const platform = usePlatform();
  const isOfficeMode = useIsOfficeMode();
  const { update } = useSettings();
  const onboardingRecordService = useOnboardingRecordService();
  const recommendationPaneId = useId();
  const recommendationMode = isOfficeMode ? "office" : "coding";
  const recommendationRevision = useSyncExternalStore(
    subscribeRecommendedPrompts,
    getRecommendedPromptsRevision,
  );
  useEffect(() => {
    if (!proactive) return;
    registerRecommendedPromptPane(recommendationPaneId, recommendationMode);
    return () => unregisterRecommendedPromptPane(recommendationPaneId);
  }, [proactive, recommendationMode, recommendationPaneId]);
  const recommendedItems = useMemo(
    () => getRecommendedPromptsForPane(recommendationPaneId, recommendationMode),
    [recommendationMode, recommendationPaneId, recommendationRevision],
  );
  const [closing, setClosing] = useState(false);
  const closeRecommendations = async () => {
    setClosing(true);
    try {
      // The close button shares the persisted setting with onboarding and settings so a separate local switch cannot show suggestions again.
      await update({ proactiveSuggestionsEnabled: false });
      // Write manual changes back to the record so account synchronization does not revive dismissed suggestions; failure does not block closing.
      await onboardingRecordService
        ?.updateRecordPreferences({ proactiveSuggestionsEnabled: false })
        .catch((cause: unknown) => {
          logger.warn("[v4-suggested-prompts] 回写引导记录失败", { error: String(cause) });
        });
    } catch (error) {
      logger.warn("[v4-suggested-prompts] 关闭推荐失败", { error: String(error) });
      toast(intl.formatMessage({ id: "chat.officeSuggestions.closeError" }));
    } finally {
      setClosing(false);
    }
  };
  const resolution = useWorkspaceServicesResolution(
    workspacePath,
    remoteSessionId,
    workspaceIdentity,
  );
  // Plugin RPC is asynchronous; only the latest click may finalize the draft, Popover, and chip.
  const requestVersionRef = useRef(0);
  const activeOperationRef = useRef<DraftSuggestedPluginOperation | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const allItems = useDraftSuggestedPromptItems({
    clientScenesService: resolution.services.clientScenesService,
    rpcReady: resolution.rpcReady,
    workspaceKey,
  });
  const items = useMemo(
    () =>
      (proactive ? recommendedItems : allItems).filter(
        (item) =>
          !item.actions?.some(
            (action) =>
              action === DRAFT_SUGGESTED_PROMPT_NAVIGATE_AUTOMATIONS ||
              action === DRAFT_SUGGESTED_PROMPT_NAVIGATE_AUTOMATIONS_OFFPEAK,
          ) || Boolean(onOpenAutomations),
      ),
    [allItems, onOpenAutomations, proactive, recommendedItems],
  );
  const {
    clearPluginActionPopover,
    pluginActionPopover,
    showPluginActionPopover,
    showPluginActionResultPopover,
  } = useDraftSuggestedPluginActionPopover();
  const clearOperationFeedback = useCallback(
    (operationId?: string) => {
      clearPluginActionPopover(operationId);
    },
    [clearPluginActionPopover],
  );
  const waitForComposerTextInsertApplied = useComposerTextInsertApplied(
    workspacePath,
    workspaceIdentity,
  );

  const targetParams = useCallback(
    () => ({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      ...(resolution.remoteSessionId ? { remoteSessionId: resolution.remoteSessionId } : {}),
    }),
    [resolution.remoteSessionId, workspaceIdentity, workspacePath],
  );

  const cancelOperation = useCallback(
    (operation: DraftSuggestedPluginOperation): Promise<void> => {
      if (operation.cancellation) return operation.cancellation;
      operation.abort.abort();
      operation.cancellation = (async () => {
        try {
          await resolution.services.pluginManagementService.cancelPluginOperation({
            operationId: operation.operationId,
          });
        } catch (error) {
          logger.warn("[v4-suggested-prompts] 取消旧插件操作失败，继续丢弃其迟到结果", {
            operationId: operation.operationId,
            error: error instanceof Error ? error.message : String(error),
            workspaceKey,
          });
        } finally {
          await operation.pending?.catch(() => undefined);
          if (activeOperationRef.current === operation) {
            activeOperationRef.current = null;
          }
        }
      })();
      return operation.cancellation;
    },
    [resolution.services.pluginManagementService, workspaceKey],
  );

  useEffect(() => {
    return () => {
      // Remove old feedback immediately after workspace/attachment switches; version and abort checks still block late remote results.
      requestVersionRef.current += 1;
      clearOperationFeedback();
      const active = activeOperationRef.current;
      if (active) void cancelOperation(active);
    };
  }, [cancelOperation, clearOperationFeedback, resolution.remoteSessionId, workspaceKey]);

  const prependResolvedPlugin = useCallback(
    (plugin: { stableId: string; label: string }, requestVersion: number, icon?: string) => {
      if (requestVersion !== requestVersionRef.current) return null;
      // The recommendation state and display icon both come from the target Host's same trusted resolution. There is currently no
      // workspace-level Plugin, so reading referenceCatalog again would repeat validation and add another RPC.
      const mention = buildDraftSuggestedPluginMention(plugin, icon);
      return useZCodeSessionStore
        .getState()
        .requestComposerTextInsert(
          workspacePath,
          mention.markdown,
          workspaceIdentity,
          mention,
          "prepend-if-missing",
        );
    },
    [workspaceIdentity, workspacePath],
  );

  const replacePlainPrompt = useCallback(
    (prompt: string, requestVersion: number, expectedRevision?: number) => {
      if (
        requestVersion !== requestVersionRef.current ||
        (expectedRevision !== undefined &&
          getComposerDraftRevision(workspacePath, workspaceIdentity) !== expectedRevision)
      ) {
        return null;
      }
      return useZCodeSessionStore
        .getState()
        .requestComposerTextInsert(workspacePath, prompt, workspaceIdentity);
    },
    [workspaceIdentity, workspacePath],
  );

  const replaceWithResolvedPluginAndPrompt = useCallback(
    (
      plugin: { stableId: string; label: string },
      prompt: string,
      requestVersion: number,
      expectedRevision: number,
      icon?: string,
    ) => {
      if (
        requestVersion !== requestVersionRef.current ||
        getComposerDraftRevision(workspacePath, workspaceIdentity) !== expectedRevision
      ) {
        return null;
      }
      if (prompt.includes("](plugin://")) {
        // When the body already contains plugin references, let Composer resolve all inline mentions. Keep the target plugin in
        // its existing position if present; otherwise add one leading reference. The old single-mention path left other references as plain text.
        const hasTarget = prompt.includes(`(plugin://${plugin.stableId})`);
        const text = hasTarget
          ? prompt
          : `${buildDraftSuggestedPluginMention(plugin, icon).markdown} ${prompt}`;
        return useZCodeSessionStore
          .getState()
          .requestComposerTextInsert(workspacePath, text, workspaceIdentity);
      }
      const mention = buildDraftSuggestedPluginMention(plugin, icon);
      const text = prompt.trim() ? `${mention.markdown} ${prompt.trim()}` : mention.markdown;
      return useZCodeSessionStore
        .getState()
        .requestComposerTextInsert(workspacePath, text, workspaceIdentity, mention);
    },
    [workspaceIdentity, workspacePath],
  );

  const revalidateAndPrependPlugin = useCallback(
    async (current: DraftSuggestedPluginFlow, requestVersion: number) => {
      await invalidateDeferredDraftSessionForSkillChange({
        zcodeSessionService: resolution.services.zcodeSessionService,
        workspacePath,
        workspaceIdentity,
        reason: "suggested-prompt-plugin-change",
      });
      if (requestVersion !== requestVersionRef.current) return null;
      const resolved =
        await resolution.services.pluginManagementService.resolveSuggestedPluginReference({
          ...targetParams(),
          clientMode: "desktop-continuous" as const,
          deliveryKind: "desktop-continuous" as const,
          stableId: current.plugin.stableId,
          operationId: current.operationId,
        });
      if (requestVersion !== requestVersionRef.current) return null;
      if (resolveDraftSuggestedPluginFlowStage(resolved) !== "checking") return null;
      return prependResolvedPlugin(current.plugin, requestVersion, resolved.icon);
    },
    [
      prependResolvedPlugin,
      resolution.services.pluginManagementService,
      resolution.services.zcodeSessionService,
      targetParams,
      workspaceIdentity,
      workspacePath,
    ],
  );

  const finishMutation = useCallback(
    (flow: DraftSuggestedPluginFlow, kind: PluginMutationKind, succeeded: boolean) => {
      const active = activeOperationRef.current;
      if (active?.operationId === flow.operationId) activeOperationRef.current = null;
      // Do not always use installSucceeded for success; enabling an already-installed plugin would incorrectly show “Installation succeeded.”
      const messageId = `chat.draft.suggestedPrompt.pluginFlow.${kind}${
        succeeded ? "Succeeded" : "Failed"
      }`;
      showPluginActionResultPopover(flow, messageId, succeeded);
    },
    [showPluginActionResultPopover],
  );

  const showMutationConfirmation = useCallback(
    (
      flow: DraftSuggestedPluginFlow,
      operation: DraftSuggestedPluginOperation,
      requestVersion: number,
      kind: PluginMutationKind,
      onAction: () => void,
    ) => {
      showPluginActionPopover(
        flow,
        `chat.draft.suggestedPrompt.pluginFlow.${kind}Confirmation`,
        "confirmation",
        {
          label: intl.formatMessage({
            id: "chat.draft.suggestedPrompt.pluginFlow.confirm",
          }),
          onAction,
          onDismiss: () => {
            if (
              requestVersion !== requestVersionRef.current ||
              activeOperationRef.current !== operation
            ) {
              return;
            }
            // The confirmation state previously exited on a fixed countdown, interrupting users who were still reading and providing no explicit cancel intent.
            // Now it closes only on a primary pointer click outside the Popover and cancels the same operation to keep blocking late results.
            clearOperationFeedback(operation.operationId);
            void cancelOperation(operation);
          },
        },
      );
    },
    [cancelOperation, clearOperationFeedback, intl, showPluginActionPopover],
  );

  const handleMutation = useCallback(
    async function runPluginMutation(
      flow: DraftSuggestedPluginFlow,
      requestVersion: number,
      kind: PluginMutationKind,
    ) {
      const operation = activeOperationRef.current;
      if (
        !operation ||
        operation.operationId !== flow.operationId ||
        requestVersion !== requestVersionRef.current ||
        (kind === "install" &&
          (!flow.result?.pluginName ||
            flow.result.marketplace !== ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID ||
            flow.result.sourceTrust !== "official"))
      ) {
        return;
      }
      showPluginActionPopover(
        flow,
        kind === "install"
          ? "chat.draft.suggestedPrompt.pluginFlow.installing"
          : "chat.draft.suggestedPrompt.pluginFlow.enabling",
        "progress",
      );
      let installTimedOut = false;
      let mutationCompleted = false;
      const restoreInstallConfirmation = (errorMessage: string) => {
        // Installation failure used to remove the action entry with the result state. Restore the same PopoverContent with a new operation,
        // allowing immediate retry while preventing a late timeout/failure from the old operation from overwriting new state.
        operation.abort.abort();
        const retryOperation = createDraftSuggestedPluginOperation(requestVersion);
        const retryFlow: DraftSuggestedPluginFlow = {
          ...flow,
          operationId: retryOperation.operationId,
        };
        activeOperationRef.current = retryOperation;
        logger.warn("[v4-suggested-prompts] 推荐插件安装失败，恢复确认态以便重试", {
          error: errorMessage,
          operationId: flow.operationId,
          pluginId: flow.plugin.stableId,
          workspaceKey,
        });
        toast(
          intl.formatMessage(
            { id: "chat.draft.suggestedPrompt.pluginFlow.installFailureToast" },
            { pluginLabel: flow.plugin.label, error: errorMessage },
          ),
          { variant: "warning" },
        );
        showMutationConfirmation(
          retryFlow,
          retryOperation,
          requestVersion,
          "install",
          () => void runPluginMutation(retryFlow, requestVersion, "install"),
        );
      };
      try {
        if (kind === "install") {
          let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
          const installRequest = resolution.services.pluginManagementService.installPlugin({
            ...targetParams(),
            pluginName: flow.result!.pluginName!,
            marketplace: flow.result!.marketplace!,
            scope: "user",
            operationId: flow.operationId,
          });
          const timedInstallRequest = installRequest.finally(() => {
            if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
          });
          const timeoutRequest = new Promise<never>((_, reject) => {
            // Cancel the same operation after an install timeout; ending only the UI wait would let a late remote success keep changing the draft.
            timeoutHandle = setTimeout(() => {
              installTimedOut = true;
              void cancelOperation(operation);
              reject(
                new Error(
                  intl.formatMessage({
                    id: "chat.draft.suggestedPrompt.pluginFlow.installTimedOut",
                  }),
                ),
              );
            }, INSTALL_OPERATION_TIMEOUT_MS);
          });
          const result = await trackDraftSuggestedPluginOperation(
            operation,
            Promise.race([timedInstallRequest, timeoutRequest]),
          );
          const errorDiagnostic = result.diagnostics.find(
            (diagnostic) => diagnostic.severity === "error",
          );
          if (errorDiagnostic || result.installedPlugins.length === 0) {
            restoreInstallConfirmation(
              errorDiagnostic?.message ??
                intl.formatMessage({
                  id: "chat.draft.suggestedPrompt.pluginFlow.installReturnedEmpty",
                }),
            );
            return;
          }
        } else {
          await trackDraftSuggestedPluginOperation(
            operation,
            resolution.services.pluginManagementService.setPluginEnabled({
              ...targetParams(),
              pluginId: flow.plugin.stableId,
              enabled: true,
              operationId: flow.operationId,
            }),
          );
        }
        mutationCompleted = true;
        if (operation.abort.signal.aborted || requestVersion !== requestVersionRef.current) return;
        const composerRequestId = await trackDraftSuggestedPluginOperation(
          operation,
          revalidateAndPrependPlugin(flow, requestVersion),
        );
        if (operation.abort.signal.aborted || requestVersion !== requestVersionRef.current) return;
        if (composerRequestId === null) {
          finishMutation(flow, kind, false);
          return;
        }
        const applied = await trackDraftSuggestedPluginOperation(
          operation,
          waitForComposerTextInsertApplied(composerRequestId, operation.abort.signal),
        );
        if (operation.abort.signal.aborted || requestVersion !== requestVersionRef.current) return;
        finishMutation(flow, kind, applied);
      } catch (error) {
        if (
          (operation.abort.signal.aborted && !installTimedOut) ||
          requestVersion !== requestVersionRef.current
        )
          return;
        if (kind === "install" && !mutationCompleted) {
          restoreInstallConfirmation(toPluginMutationErrorMessage(error));
          return;
        }
        logger.warn(`[v4-suggested-prompts] 推荐插件${kind === "install" ? "安装" : "启用"}失败`, {
          error: toPluginMutationErrorMessage(error),
          operationId: flow.operationId,
          pluginId: flow.plugin.stableId,
          workspaceKey,
        });
        finishMutation(flow, kind, false);
      }
    },
    [
      cancelOperation,
      finishMutation,
      intl,
      revalidateAndPrependPlugin,
      resolution.services.pluginManagementService,
      showMutationConfirmation,
      showPluginActionPopover,
      targetParams,
      waitForComposerTextInsertApplied,
      workspaceKey,
    ],
  );

  const handleSelect = useCallback(
    async (item: DraftSuggestedPromptItem) => {
      const requestVersion = requestVersionRef.current + 1;
      requestVersionRef.current = requestVersion;
      const templateName = resolveDraftSuggestedPromptText(item.label, locale);
      const prompt = resolveDraftSuggestedPromptText(item.prompt, locale);
      if (isDesktop) {
        // Telemetry is side-channel observation; run it before navigation or async plugin resolution without blocking existing interactions.
        void reportPromptTemplateClick(platform, {
          templateId: item.id,
          templateName,
          templatePrompt: prompt,
        });
      }
      if (
        onOpenAutomations &&
        item.actions?.includes(DRAFT_SUGGESTED_PROMPT_NAVIGATE_AUTOMATIONS_OFFPEAK)
      ) {
        onOpenAutomations("idle");
        return;
      }
      if (
        onOpenAutomations &&
        item.actions?.includes(DRAFT_SUGGESTED_PROMPT_NAVIGATE_AUTOMATIONS)
      ) {
        onOpenAutomations();
        return;
      }
      const plugin = item.plugin
        ? {
            stableId: item.plugin.stableId,
            label: resolveDraftSuggestedPromptText(item.plugin.label, locale),
          }
        : undefined;

      // Recommendations without a Plugin need no remote validation, so replace the ordinary draft immediately. Plugin-backed recommendations must wait
      // for trusted resolution and then decide at once whether to write a plain prompt or Plugin + prompt, avoiding a two-stage Composer update.
      if (!plugin || !resolution.rpcReady) {
        replacePlainPrompt(prompt, requestVersion);
      }

      const previous = activeOperationRef.current;
      if (previous) {
        // Manually switching recommendations is an expected takeover: close old feedback without showing a cancel/interruption notice.
        clearOperationFeedback(previous.operationId);
        setCancelling(true);
        await cancelOperation(previous);
        if (requestVersion !== requestVersionRef.current) return;
        setCancelling(false);
      }
      if (!plugin || !resolution.rpcReady) return;
      // Capture the baseline after the old operation's cancellation settles: it may just have passed its ordinary prompt
      // to Composer. That is a procedural write from the recommendation flow and should not make the new recommendation look user-edited.
      const draftRevision = getComposerDraftRevision(workspacePath, workspaceIdentity);

      const operation = createDraftSuggestedPluginOperation(requestVersion);
      activeOperationRef.current = operation;
      const checkingFlow: DraftSuggestedPluginFlow = {
        anchorItemId: item.id,
        operationId: operation.operationId,
        plugin,
        stage: "unavailable",
      };
      // Trusted resolution for a missing item must wait for the official Marketplace refresh. Previously, the flow did not open
      // the confirmation Popover until the request completed, making the click appear stuck during network latency. Subscribe to the same operation's local check result first,
      // updating only the phase of the existing single Popover; confirmation/action/result continue to reuse the same mount point.
      const progressSubscription =
        resolution.services.pluginManagementService.onDynamicPluginOperationProgress(
          operation.operationId,
        )((event) => {
          if (
            event.state !== "refreshing" ||
            operation.abort.signal.aborted ||
            activeOperationRef.current !== operation ||
            requestVersion !== requestVersionRef.current ||
            getComposerDraftRevision(workspacePath, workspaceIdentity) !== draftRevision
          ) {
            return;
          }
          showPluginActionPopover(
            checkingFlow,
            "chat.draft.suggestedPrompt.pluginFlow.checking",
            "progress",
          );
        });
      try {
        const result = await trackDraftSuggestedPluginOperation(
          operation,
          resolution.services.pluginManagementService.resolveSuggestedPluginReference({
            ...targetParams(),
            clientMode: "desktop-continuous" as const,
            deliveryKind: "desktop-continuous" as const,
            stableId: plugin.stableId,
            operationId: operation.operationId,
          }),
        );
        if (operation.abort.signal.aborted || requestVersion !== requestVersionRef.current) return;
        if (getComposerDraftRevision(workspacePath, workspaceIdentity) !== draftRevision) {
          clearOperationFeedback(operation.operationId);
          activeOperationRef.current = null;
          return;
        }
        const flow: DraftSuggestedPluginFlow = {
          anchorItemId: item.id,
          operationId: operation.operationId,
          plugin,
          result,
          stage: resolveDraftSuggestedPluginFlowStage(result),
        };
        if (flow.stage === "checking") {
          replaceWithResolvedPluginAndPrompt(
            flow.plugin,
            prompt,
            requestVersion,
            draftRevision,
            result.icon,
          );
          if (operation.abort.signal.aborted || requestVersion !== requestVersionRef.current)
            return;
          activeOperationRef.current = null;
          clearOperationFeedback(flow.operationId);
          return;
        }
        if (flow.stage === "missing" || flow.stage === "disabled") {
          // disabled does not require a Marketplace refresh and may not produce an Agent progress notice. Before writing a plain prompt,
          // move the same Popover into checking, then wait for Composer to apply it and switch to confirmation in place.
          showPluginActionPopover(
            flow,
            "chat.draft.suggestedPrompt.pluginFlow.checking",
            "progress",
          );
          const composerRequestId = replacePlainPrompt(prompt, requestVersion, draftRevision);
          if (composerRequestId === null) {
            clearOperationFeedback(flow.operationId);
            activeOperationRef.current = null;
            return;
          }
          // If the confirmation Popover opens before Composer consumes the plain prompt, the input area later grows and moves
          // the recommendation anchor, causing the overlay to appear at the old coordinates before jumping. Wait until insertion settles before measuring the anchor for install/enable.
          const applied = await trackDraftSuggestedPluginOperation(
            operation,
            waitForComposerTextInsertApplied(composerRequestId, operation.abort.signal),
          );
          if (operation.abort.signal.aborted || requestVersion !== requestVersionRef.current)
            return;
          if (!applied) {
            clearOperationFeedback(flow.operationId);
            activeOperationRef.current = null;
            return;
          }
          const kind: PluginMutationKind = flow.stage === "missing" ? "install" : "enable";
          showMutationConfirmation(
            flow,
            operation,
            requestVersion,
            kind,
            () => void handleMutation(flow, requestVersion, kind),
          );
          return;
        }
        replacePlainPrompt(prompt, requestVersion, draftRevision);
        clearOperationFeedback(flow.operationId);
        activeOperationRef.current = null;
      } catch (error) {
        if (operation.abort.signal.aborted || requestVersion !== requestVersionRef.current) return;
        logger.warn("[v4-suggested-prompts] 推荐插件可信解析失败", {
          error: error instanceof Error ? error.message : String(error),
          pluginId: plugin.stableId,
          workspaceKey,
        });
        replacePlainPrompt(prompt, requestVersion, draftRevision);
        clearOperationFeedback(operation.operationId);
        activeOperationRef.current = null;
      } finally {
        progressSubscription.dispose();
      }
    },
    [
      cancelOperation,
      clearOperationFeedback,
      locale,
      onOpenAutomations,
      platform,
      replacePlainPrompt,
      replaceWithResolvedPluginAndPrompt,
      resolution.rpcReady,
      resolution.services.pluginManagementService,
      handleMutation,
      isDesktop,
      showMutationConfirmation,
      showPluginActionPopover,
      targetParams,
      waitForComposerTextInsertApplied,
      workspaceIdentity,
      workspaceKey,
      workspacePath,
    ],
  );

  return (
    <div data-v4-draft-suggested-prompts-slot="true" className={cn(!proactive && "h-8", className)}>
      <ConversationDraftSuggestedPrompts
        // Absolute positioning removes recommendations from Composer's normal structure, making debugging and spacing unintuitive.
        // Keep a fixed slot for legacy recommendations; active recommendation lists must grow with their content or multiple lines overflow and cover content below.
        items={items}
        layout={proactive ? "list" : "chips"}
        onSelect={handleSelect}
        onRefresh={proactive ? () => advanceRecommendedPromptPane(recommendationPaneId) : undefined}
        onClose={proactive ? closeRecommendations : undefined}
        disabled={cancelling || closing}
        refreshDisabled={Boolean(pluginActionPopover)}
        pluginActionPopover={pluginActionPopover}
      />
    </div>
  );
}
