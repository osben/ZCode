import { updateUiLocaleInFileConfig, type ConfigResult } from "@zcode/adapters/config";
import type { AgentRuntime } from "@zcode/core";
import { resolveLocale } from "@zcode/i18n";
import { normalizeModelSelection, type ModelSelection } from "@zcode/provider";
import {
  SESSION_ENTRY_MODEL_SELECTION,
  traceContextToLogContext,
  type CollaborationMode,
  type ExecutionPort,
  type GoalStatus,
  type Logger,
  type LoggerFactory,
  type LocalSettingStorePort,
  type McpPort,
  type McpServerConfig,
  type MessageId,
  type ProjectId,
  type SessionId,
  type SessionStorePort,
  type SupportedLocale,
  type TraceContext,
  type TurnInputIntentMetadata,
  type UiLocale,
  type UiThemePreference,
} from "@zcode/contracts";
import { listMcpServerStatuses } from "../mcp-config.js";
import { loadSessionTranscriptFromStore } from "../session-transcript.js";
import { createSubagentObservation } from "./subagent-observation.js";
import { getLocaleConfigPath } from "./locale-selection.js";
import { isClosableSessionStore } from "./session-store.js";
import type { ProviderRegistryModelSource } from "./provider-registry-model-runtime.js";
import {
  completeAuxiliaryRegistryModelSelection,
  getRegistryBackedModel,
  listRegistryBackedModels,
  requireRegistryThoughtLevel,
  resolveRegistryModelSelection,
  resolveRegistryOwnedModelSelection,
  resolveRegistryOwnedSelection,
  resolveRegistryThoughtLevel,
  type ResolvedRegistrySelection,
} from "./provider-registry-selection.js";
import type { PrepareUserExecutionBoundary, ZCodeApp } from "./types.js";

type SessionFacade = Pick<
  ZCodeApp,
  | "readBackgroundBashOutput"
  | "cancelBackgroundTask"
  | "clearTarget"
  | "close"
  | "connectMcpServer"
  | "disconnectMcpServer"
  | "generateWorkspaceText"
  | "testModelConnectivity"
  | "forkFromCheckpoint"
  | "getMode"
  | "getModel"
  | "getCurrentModelOption"
  | "getModelOption"
  | "getLocale"
  | "getDefaultThoughtLevel"
  | "getThoughtLevel"
  | "getTheme"
  | "getPalette"
  | "listCheckpoints"
  | "listMcpServers"
  | "listModels"
  | "listThoughtLevels"
  | "loadSessionTranscript"
  | "readSubagents"
  | "readSubagentTranscript"
  | "readTodos"
  | "readTarget"
  | "setCustomSessionTitle"
  | "setMode"
  | "setModel"
  | "setThoughtLevel"
  | "setLocale"
  | "setTarget"
  | "updateTargetStatus"
>;

const DEFAULT_SESSION_RESOURCE_CLOSE_TIMEOUT_MS = 6_000;

interface SessionResourceCloseInput {
  beginShutdown: () => void;
  closeBrowserSession: () => Promise<void>;
  closeExecution?: () => Promise<void> | void;
  closeMcp?: () => Promise<void> | void;
  closeNodeReplBrowserBroker?: () => Promise<void> | void;
  closeSessionStore?: () => void;
  logger: Logger;
  timeoutMs?: number;
}

interface CreateSessionFacadeDeps {
  /**
   * Stop DWF runs owned by this session using the run service's `close()`.
   * Absence means this assembly has no DWF port (journal capability narrowing failed or this is a test setup).
   */
  closeDynamicWorkflowRuns?: () => Promise<void>;
  closeNodeReplBrowserBroker?: () => Promise<void> | undefined;
  configResult: ConfigResult;
  configuredMcpServers: Record<string, McpServerConfig>;
  configuredDefaultModelSelection?: ModelSelection;
  executionPort: ExecutionPort;
  localSettingStore?: LocalSettingStorePort;
  logger: Logger;
  loggerFactory: LoggerFactory;
  mcpPort?: McpPort;
  ownsExecutionPort: boolean;
  ownsMcpPort: boolean;
  ownsSessionStore: boolean;
  prepareUserExecutionBoundary: PrepareUserExecutionBoundary;
  prepareResume(traceContext?: TraceContext): Promise<void>;
  projectID: ProjectId;
  providerRegistry: ProviderRegistryModelSource;
  resolveUiLocale(locale: UiLocale): SupportedLocale;
  runtime: AgentRuntime;
  sessionId: SessionId;
  sessionStore: SessionStorePort;
  traceContext: TraceContext;
  untrustedProjectMcpServers: Set<string>;
  workingDirectory: string;
}

export function createSessionFacade(deps: CreateSessionFacadeDeps): SessionFacade {
  let closePromise: Promise<void> | undefined;
  let currentLocale = resolveLocale(deps.configResult.config.ui.locale);
  const currentRegistrySelection = ():
    | { owned: false }
    | {
        owned: true;
        registry: ProviderRegistryModelSource;
        selection?: ResolvedRegistrySelection;
      } => {
    const registry = deps.providerRegistry;
    const selection = deps.runtime.getSessionModelSelection();
    if (!selection) return { owned: false };
    const { providerId } = selection;
    if (!registry.getProvider(providerId)) return { owned: false };
    const resolved = resolveRegistryModelSelection(registry, selection);
    return resolved ? { owned: true, registry, selection: resolved } : { owned: true, registry };
  };

  const readTargetWithInterruptedRunRecovery = async () => {
    const target = await deps.sessionStore.readTarget({
      sessionID: deps.sessionId,
    });
    if (
      !deps.runtime.getActiveTurnInfo() &&
      target?.activeInputId &&
      target.activeRunStartedAtMs != null &&
      deps.sessionStore.recoverInterruptedTargetRun
    ) {
      // The previous app/agent exit may have left active_run_started_at uncleared.
      // Do not settle it with the current time, or offline time would count toward goal runtime; the store closes it using last_seen.
      return await deps.sessionStore.recoverInterruptedTargetRun({
        sessionID: deps.sessionId,
      });
    }
    return target;
  };

  const setTargetStatus = async (
    action: "cleared" | "set" | "status_updated",
    input: {
      objective?: string;
      displayText?: string;
      status?: GoalStatus;
      tokenBudget?: number | null;
      intent?: TurnInputIntentMetadata;
    },
  ) => {
    const visibleObjective = action === "set" ? (input.objective ?? "").trim() : undefined;
    const visibleGoalQuery =
      action === "set" ? input.displayText?.trim() || visibleObjective : undefined;
    // /goal does not use the normal prompt-submission flow, but it persists the session first.
    // Apply the unified user-execution boundary before that initial persistence, or runtime/bash_shell_selection
    // will be missing because selection is empty at that point, causing cold recovery to use the legacy shell fallback.
    await deps.prepareUserExecutionBoundary({
      traceContext: deps.traceContext,
    });
    await deps.runtime.ensureSessionPersistedForExternalActivity(
      visibleObjective ?? `/goal ${input.status ?? "clear"}`,
      { traceContext: deps.traceContext },
    );
    const previousTarget = await deps.sessionStore.readTarget({
      sessionID: deps.sessionId,
    });
    const target =
      action === "set"
        ? await deps.sessionStore.setTarget({
            objective: visibleObjective ?? "",
            sessionID: deps.sessionId,
            status: input.status,
            tokenBudget: input.tokenBudget,
          })
        : action === "status_updated"
          ? await deps.sessionStore.updateTargetStatus({
              sessionID: deps.sessionId,
              status: input.status ?? "active",
            })
          : null;

    if (action === "cleared") {
      const cleared = await deps.sessionStore.clearTarget({
        sessionID: deps.sessionId,
      });
      if (cleared) {
        await deps.runtime.recordGoalStateChangeReminder({
          text: goalStateChangeReminderText("cleared"),
          traceContext: deps.traceContext,
        });
      }
      // The TUI and protocol clients may retain an old goal after reconnecting or recovering.
      // Even if the session store is already empty, project an explicit clear as target:null so
      // clients do not keep showing a stale panel just because the text says "No goal to clear."
      await deps.runtime.recordTargetChanged({
        action,
        previousTarget,
        source: "command",
        target,
        traceContext: deps.traceContext,
      });
      return cleared;
    }
    if (target) {
      if (visibleObjective !== undefined) {
        // /goal is both a control command and a user query. The old path persisted only the parsed
        // objective and omitted the input from live events, leaving the first live list empty and
        // losing the original `/goal` / `/target` / `replace` text during cold recovery. Keep the
        // canonical objective in target and preserve the original protocol display text separately
        // as the visible message.
        await deps.runtime.recordExternalUserPrompt(visibleGoalQuery ?? visibleObjective, {
          goalSummaryTargetID: target.targetID,
          intent: input.intent,
          traceContext: deps.traceContext,
        });
      }
      const reminderAction =
        input.status === "paused" && previousTarget?.status !== "paused"
          ? "paused"
          : input.status === "active" && previousTarget?.status === "paused"
            ? "resumed"
            : undefined;
      const reminderText = goalStateChangeReminderText(reminderAction);
      if (reminderText) {
        await deps.runtime.recordGoalStateChangeReminder({
          text: reminderText,
          traceContext: deps.traceContext,
        });
      }
      await deps.runtime.recordTargetChanged({
        action,
        previousTarget,
        source: "command",
        target,
        traceContext: deps.traceContext,
      });
    }
    return target;
  };

  return {
    close: async () => {
      closePromise ??= (async () => {
        // The close entry point first blocks new scheduling and cancels in-flight Memory Extraction,
        // then waits for cancellation to settle.
        deps.runtime.beginShutdown();
        await deps.runtime.drainMemoryExtractions(60_000);
        // This App owns the engine, so closing must stop it explicitly.
        // The placement satisfies two constraints: **after** beginShutdown, terminal notifications
        // emitted during settlement are dropped (background-notifications.ts does not enqueue while
        // shutting down), so they cannot wake a model in a closing session; **before**
        // closeSessionResources, subagents still have execution, MCP, and session-store resources to
        // abort cleanly, and the engine can write its stopped(interrupted) journal entry.
        if (deps.closeDynamicWorkflowRuns !== undefined) {
          try {
            await deps.closeDynamicWorkflowRuns();
          } catch (error: unknown) {
            // A stuck or failed DWF shutdown must never prevent resource cleanup (see the rationale
            // in the parallel-close comment below): log a warning and continue. At worst, that run
            // remains orphaned until the next construction reconciles it.
            deps.logger.warn?.(
              "Closing dynamic workflow runs failed; continuing to close resources",
              {
                errorMessage: error instanceof Error ? error.message : String(error),
                event: "dynamic_workflow.service.close_failed",
                module: "bootstrap.app",
              },
            );
          }
        }
        const closableSessionStore =
          deps.ownsSessionStore && isClosableSessionStore(deps.sessionStore)
            ? deps.sessionStore
            : undefined;
        await closeSessionResources({
          beginShutdown: () => deps.runtime.beginShutdown(),
          closeBrowserSession: () => deps.runtime.closeBrowserSession(),
          closeExecution:
            deps.ownsExecutionPort && deps.executionPort.close
              ? () => deps.executionPort.close?.()
              : undefined,
          closeMcp: deps.ownsMcpPort && deps.mcpPort ? () => deps.mcpPort?.close() : undefined,
          closeNodeReplBrowserBroker: deps.closeNodeReplBrowserBroker,
          closeSessionStore: closableSessionStore ? () => closableSessionStore.close() : undefined,
          logger: deps.logger,
        });
      })();
      return await closePromise;
    },
    getMode: () => deps.runtime.getMode(),
    getModel: () => formatLegacyRuntimeModelValue(deps.runtime.getSessionModelSelection()),
    getLocale: () => currentLocale,
    getTheme: () => deps.configResult.config.ui.theme as UiThemePreference,
    getPalette: () => deps.configResult.config.ui.palette,
    getDefaultThoughtLevel: () => {
      const registryState = currentRegistrySelection();
      return registryState.owned
        ? resolveRegistryThoughtLevel(registryState.selection)
        : deps.runtime.getSessionModelSelection()?.options?.reasoningLevel;
    },
    // Read the current tier only from session facts; do not use the default tier to pretend a selection was made when it is missing.
    getThoughtLevel: () => deps.runtime.getSessionModelSelection()?.options?.reasoningLevel,
    loadSessionTranscript: async () =>
      await loadSessionTranscriptFromStore({
        sessionId: deps.sessionId,
        sessionStore: deps.sessionStore,
      }),
    ...createSubagentObservation(deps),
    readTodos: async () => deps.sessionStore.readTodos({ sessionID: deps.sessionId }),
    readTarget: readTargetWithInterruptedRunRecovery,
    setCustomSessionTitle: async (input) =>
      deps.runtime.setCustomSessionTitle({
        title: input.title,
        traceContext: input.traceContext ?? deps.traceContext,
      }),
    setTarget: async (input) =>
      (await setTargetStatus("set", input)) as Awaited<ReturnType<ZCodeApp["setTarget"]>>,
    updateTargetStatus: async (status) =>
      (await setTargetStatus("status_updated", { status })) as Awaited<
        ReturnType<ZCodeApp["updateTargetStatus"]>
      >,
    clearTarget: async () => (await setTargetStatus("cleared", {})) as boolean,
    listModels: () => {
      return listRegistryBackedModels(deps.providerRegistry);
    },
    getCurrentModelOption: () => {
      const selection = deps.runtime.getSessionModelSelection();
      return selection && getRegistryBackedModel(deps.providerRegistry, selection);
    },
    getModelOption: (selection) => getRegistryBackedModel(deps.providerRegistry, selection),
    listThoughtLevels: () => {
      const registryState = currentRegistrySelection();
      return registryState.owned
        ? [...(registryState.selection?.model.config.optionSpecs.reasoningLevel.values ?? [])]
        : [];
    },
    listMcpServers: async () =>
      listMcpServerStatuses(
        deps.mcpPort,
        deps.configuredMcpServers,
        deps.untrustedProjectMcpServers,
      ),
    connectMcpServer: async (name) => {
      const config = deps.configuredMcpServers[name];
      if (!config) {
        throw new Error(`MCP server is not configured: ${name}`);
      }
      if (!deps.mcpPort) {
        throw new Error("MCP is disabled");
      }
      return deps.mcpPort.connectServer(name, config, {
        trace: deps.traceContext,
        workingDirectory: deps.workingDirectory,
      });
    },
    readBackgroundBashOutput: (workId, sessionId) =>
      deps.runtime.readBackgroundBashOutput(workId, sessionId),
    cancelBackgroundTask: async (taskId, options) =>
      deps.runtime.cancelBackgroundTask(taskId, {
        traceContext: options?.traceContext ?? deps.traceContext,
      }),
    disconnectMcpServer: async (name) => {
      if (!deps.mcpPort) return undefined;
      return deps.mcpPort.disconnectServer(name);
    },
    listCheckpoints: async (options) => {
      await deps.prepareResume();
      return deps.runtime.listWorkspaceCheckpoints(options);
    },
    forkFromCheckpoint: async (options) => {
      await deps.prepareResume(options?.traceContext);
      return deps.runtime.forkWorkspaceFromCheckpoint({
        targetCheckpointId: options?.targetCheckpointId,
        targetMessageId: options?.targetMessageId as MessageId | undefined,
        traceContext: options?.traceContext ?? deps.traceContext,
      });
    },
    generateWorkspaceText: async (input, options) => {
      // The helper-text entry point normalizes only model identity; Core's helper request call site explicitly chooses the minimum tier.
      const selection =
        normalizeModelSelection(deps.providerRegistry.getView(), input.selection) ??
        input.selection;
      return await deps.runtime.generateWorkspaceText(
        { ...input, selection },
        {
          abortSignal: options?.abortSignal,
          traceContext: options?.traceContext ?? deps.traceContext,
        },
      );
    },
    testModelConnectivity: async (input, options) => {
      // The Model used for connection testing must also be assigned the minimum tier first, or the strict Factory fails due to the missing tier.
      const selection = completeAuxiliaryRegistryModelSelection(
        deps.providerRegistry,
        input.selection,
      );
      await deps.runtime.testModelConnectivity(
        { ...input, selection },
        {
          abortSignal: options?.abortSignal,
          traceContext: options?.traceContext ?? deps.traceContext,
        },
      );
    },
    setMode: async (mode: CollaborationMode) => {
      const previousMode = deps.runtime.getMode();
      await deps.runtime.setExecutionState({ mode }, deps.traceContext);
      if (deps.localSettingStore) {
        try {
          await deps.localSettingStore.saveProjectPermissionMode({
            mode: deps.runtime.getMode(),
            projectID: deps.projectID,
          });
        } catch (error) {
          deps.logger.warn("Project mode preference write failed", {
            ...traceContextToLogContext(deps.traceContext),
            error: error instanceof Error ? error.message : String(error),
            event: "local_setting.permission_mode.write_failed",
            mode,
            module: "bootstrap",
            projectId: deps.projectID,
            status: "failed",
          });
        }
      }
      deps.logger.info("Session mode updated", {
        ...traceContextToLogContext(deps.traceContext),
        event: "session.mode.updated",
        mode,
        module: "bootstrap",
        previousMode,
        status: "completed",
      });
      return {
        mode: deps.runtime.getMode(),
        previousMode,
        traceId: deps.traceContext.traceId,
      };
    },
    setModel: async (modelId, options) => {
      // The configuration command submitted a complete Selection; converting it to a string would
      // lose the tier. Validate the whole selection before updating/saving once so an invalid tier
      // cannot leave a partially changed model. The legacy string entry point still changes identity only.
      const registrySelection =
        typeof modelId === "string"
          ? resolveRegistryOwnedSelection(
              deps.providerRegistry,
              modelId,
              deps.configuredDefaultModelSelection,
              { allowMissingReasoning: true },
            )
          : resolveRegistryOwnedModelSelection(deps.providerRegistry, modelId);
      if (!registrySelection) {
        throw new Error(`Provider Registry 中不存在 Model: ${modelId}`);
      }
      const previousSelection = deps.runtime.getSessionModelSelection();
      const previousModel = formatLegacyRuntimeModelValue(previousSelection);
      const model = formatLegacyRuntimeModelValue(registrySelection.selection);
      const sessionSelection: ModelSelection = {
        providerId: registrySelection.selection.providerId,
        modelId: registrySelection.selection.modelId,
        ...(typeof modelId !== "string" && registrySelection.selection.options
          ? { options: { ...registrySelection.selection.options } }
          : {}),
      };
      deps.runtime.setSessionModelSelection(sessionSelection);
      if (!options?.transient) {
        deps.runtime.recordPendingModelChange({
          fromModel: previousSelection,
          fromModelLabel: previousModel,
          toModel: sessionSelection,
          toModelLabel: model,
        });
        await persistSessionModelSelection(deps);
      }
      deps.logger.info("Session model updated", {
        ...traceContextToLogContext(deps.traceContext),
        event: "session.model.updated",
        model,
        module: "bootstrap",
        previousModel,
        status: "completed",
      });
      return {
        model,
        previousModel,
        traceId: deps.traceContext.traceId,
      };
    },
    setThoughtLevel: async (level) => {
      const registryState = currentRegistrySelection();
      if (registryState.owned) {
        const currentSelection = deps.runtime.getSessionModelSelection();
        if (!currentSelection) throw new Error("Select a model before choosing reasoning effort");
        const registrySelection =
          registryState.selection ??
          resolveRegistryOwnedModelSelection(registryState.registry, {
            providerId: currentSelection.providerId,
            modelId: currentSelection.modelId,
          })!;
        const previousThoughtLevel = resolveRegistryThoughtLevel(
          registrySelection,
          currentSelection.options?.reasoningLevel,
        );
        const thoughtLevel = requireRegistryThoughtLevel(registrySelection, level);
        deps.runtime.setSessionModelSelection({
          ...currentSelection,
          options: {
            ...currentSelection.options,
            reasoningLevel: thoughtLevel,
          },
        });
        await persistSessionModelSelection(deps);
        deps.logger.info("Session reasoning effort updated", {
          ...traceContextToLogContext(deps.traceContext),
          event: "session.reasoning_effort.updated",
          module: "bootstrap",
          previousThoughtLevel,
          status: "completed",
          thoughtLevel,
        });
        return {
          previousThoughtLevel,
          thoughtLevel,
          traceId: deps.traceContext.traceId,
        };
      }
      throw new Error("当前 Session Model 不属于 Provider Registry");
    },
    setLocale: async (locale) => {
      const previousLocale = currentLocale;
      const configPath = getLocaleConfigPath(deps.configResult);
      const persisted = await updateUiLocaleInFileConfig(configPath, locale);
      currentLocale = deps.resolveUiLocale(locale);
      deps.configResult.config.ui.locale = currentLocale;
      deps.logger.info("Session locale updated", {
        ...traceContextToLogContext(deps.traceContext),
        event: "session.locale.updated",
        locale: currentLocale,
        module: "bootstrap",
        previousLocale,
        requestedLocale: locale,
        status: "completed",
      });
      return {
        configPath: persisted.path,
        locale: currentLocale,
        previousLocale,
        requestedLocale: locale,
        traceId: deps.traceContext.traceId,
      };
    },
  };
}

async function closeSessionResources(input: SessionResourceCloseInput): Promise<void> {
  try {
    // First close runtime admission; later execution cancellation can settle state but must not wake the model again.
    input.beginShutdown();
  } catch (error) {
    input.logger.warn("Failed to begin runtime shutdown", {
      error: error instanceof Error ? error.message : String(error),
      event: "session.shutdown_admission.failed",
    });
  }

  const timeoutMs = Math.max(
    1,
    Math.trunc(input.timeoutMs ?? DEFAULT_SESSION_RESOURCE_CLOSE_TIMEOUT_MS),
  );
  const resources: Array<[name: string, close: (() => Promise<void> | void) | undefined]> = [
    ["browser_session", input.closeBrowserSession],
    ["execution", input.closeExecution],
    ["mcp", input.closeMcp],
    ["node_repl_browser_broker", input.closeNodeReplBrowserBroker],
  ];

  // The old close chain awaited resources serially; if Browser close never settled, Execution/MCP
  // would never run. Close each owner in parallel with its own deadline so one failure cannot skip
  // the other resources.
  await Promise.all(
    resources.flatMap(([name, close]) =>
      close ? [closeSessionResourceWithinDeadline(name, close, timeoutMs, input.logger)] : [],
    ),
  );

  try {
    input.closeSessionStore?.();
  } catch (error) {
    input.logger.warn("Failed to close session store", {
      error: error instanceof Error ? error.message : String(error),
      event: "session.resource_close.failed",
      resource: "session_store",
    });
  }
}

async function closeSessionResourceWithinDeadline(
  name: string,
  close: () => Promise<void> | void,
  timeoutMs: number,
  logger: Logger,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const closePromise = Promise.resolve().then(close);
  const outcome = await Promise.race([
    closePromise.then(
      () => ({ type: "completed" as const }),
      (error: unknown) => ({ type: "failed" as const, error }),
    ),
    new Promise<{ type: "timed_out" }>((resolve) => {
      timer = setTimeout(() => resolve({ type: "timed_out" }), timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);

  if (outcome.type === "completed") return;
  if (outcome.type === "timed_out") {
    logger.warn("Session resource close timed out", {
      event: "session.resource_close.timed_out",
      resource: name,
      timeoutMs,
    });
    return;
  }
  logger.warn("Session resource close failed", {
    error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
    event: "session.resource_close.failed",
    resource: name,
  });
}

async function persistSessionModelSelection(deps: CreateSessionFacadeDeps): Promise<void> {
  if (!deps.sessionStore.saveSessionEntry) return;
  const selection = deps.runtime.getSessionModelSelection();
  if (!selection) return;
  const timestamp = Date.now();
  try {
    await deps.sessionStore.saveSessionEntry({
      id: `${deps.sessionId}:runtime-model-selection`,
      sessionID: deps.sessionId,
      type: SESSION_ENTRY_MODEL_SELECTION,
      touchSession: false,
      time: { created: timestamp, updated: timestamp },
      // Model and thinking tier form one session-local selection. Persist them together to the same
      // stable entry immediately after switching; do not wait for another message or read the latest
      // global workspace/draft selection during cold recovery.
      // Writing the configuration is not new user activity and must not update session.time_updated to "just now."
      data: {
        modelId: selection.modelId,
        providerId: selection.providerId,
        ...(selection.options ? { options: selection.options } : {}),
      },
    });
  } catch (error) {
    // The selection has already taken effect in the current runtime; a persistence failure must not
    // make the switch appear to have failed, but it must be recorded in production logs.
    deps.logger.warn("Session model selection persistence failed", {
      ...traceContextToLogContext(deps.traceContext),
      error: error instanceof Error ? error.message : String(error),
      event: "session.model_selection.persist_failed",
      modelId: selection.modelId,
      module: "bootstrap",
      providerId: selection.providerId,
      status: "failed",
      thoughtLevel: selection.options?.reasoningLevel,
    });
  }
}

/** Only for internal App facades that still use provider/model strings; this does not serialize ModelSelection. */
function formatLegacyRuntimeModelValue(selection: ModelSelection | undefined): string {
  return selection ? `${selection.providerId}/${selection.modelId}` : "";
}

type GoalStateChangeReminderAction = "paused" | "resumed" | "cleared";

function goalStateChangeReminderText(action: GoalStateChangeReminderAction): string;
function goalStateChangeReminderText(action: undefined): undefined;
function goalStateChangeReminderText(
  action: GoalStateChangeReminderAction | undefined,
): string | undefined;
function goalStateChangeReminderText(
  action: GoalStateChangeReminderAction | undefined,
): string | undefined {
  switch (action) {
    case "paused":
      return "The active session goal is paused. Do not continue pursuing it unless the user resumes or replaces the goal.";
    case "resumed":
      return "The session goal is active again and will be pursued.";
    case "cleared":
      return "The session goal has been cleared. Do not continue pursuing any previous goal unless the user sets a new goal.";
    default:
      return undefined;
  }
}
