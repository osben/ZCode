import {
  builtInTools,
  createConfiguredHookRunner,
  createInMemoryHookRunner,
  createSessionMailboxHookRegistrations,
  createToolExecutor,
  getCurrentTraceContext,
  registerBuiltInTools,
  traceContextToLogContext,
} from "../deps.js";
import type { HookRunner, SessionId, ToolExecutor, TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { AgentRuntimeDeps } from "../types.js";
import { resolveRuntimeEmbeddedSearchEnabled } from "../methods/embedded-search-branch.js";
import { getSessionShellSelectionFromConfig } from "../methods/session-shell-environment.js";
import { createRuntimeSessionModePort } from "../session-mode-port.js";
import { shouldSuppressSealedSubagentBashNotification } from "../../runtime-task/notification-policy.js";
import {
  resolveRuntimeDynamicWorkflowToolSurfaceDeferral,
  resolveBuiltInToolAllowlist,
  resolveRuntimeAgentAlwaysBackground,
  resolveRuntimeDisallowedTools,
  resolveRuntimeAutomationToolsIncluded,
  resolveRuntimeDynamicWorkflowToolsIncluded,
  resolveRuntimeLspToolIncluded,
} from "./tool-allowlist.js";
import { isStaleBranchRuntimeTaskEvent } from "../methods/runtime-command-generation.js";
import { resolveEnabledProjectMemoryRoot } from "./project-memory.js";
import { sessionHasLoadedSkill } from "../../agent/loaded-skills.js";
import { createRuntimeNestedInstructionContext } from "./nested-instructions-context.js";
import { getMissingExecutionWorktreeToolError } from "./execution-worktree-guard.js";
import type {
  ToolMetadata,
  ToolRuntimePermissionCapabilityContext,
  ToolRuntimeScope,
} from "../../tool/types.js";
import { sessionControlForRuntime } from "../../tool/session-control/contract.js";
import {
  createMcpServerWaitPort,
  describeUnavailableMcpTool,
  resolveUnregisteredMcpTool,
} from "../methods/mcp.js";

const DEFAULT_SUBAGENT_BACKGROUND_BASH_MAX_MS = 3_600_000;
const EMPTY_RUNTIME_HOOK_CONFIG = {
  enabled: false,
  events: {},
  maxOutputBytes: 32_768,
  timeoutMs: 60_000,
} as const;

export function initializeRuntimeTooling(
  runtime: AgentRuntimeInternal,
  deps: AgentRuntimeDeps,
  sessionId: SessionId,
): { executor: ToolExecutor; hookRunner?: HookRunner } {
  registerRuntimeBuiltInTools(runtime, deps);
  const hookRunner = createRuntimeHookRunner(runtime, deps, sessionId);
  return {
    executor: deps.toolExecutor ?? createRuntimeToolExecutor(runtime, deps, hookRunner),
    hookRunner,
  };
}

function registerRuntimeBuiltInTools(runtime: AgentRuntimeInternal, deps: AgentRuntimeDeps): void {
  const nodeReplEnabled = runtime.config.runtimeFeatures?.nodeRepl === true;
  runtime.sessionControlKind = sessionControlForRuntime(
    deps.sessionControl,
    runtime.config.taskType,
    runtime.sessionId,
  )?.kind;
  const browserUseEnabled = resolveRuntimeBrowserUseEnabled(runtime, deps);
  // Cron and OffPeak are main-session automation; both also follow the `automationTools` toggle.
  const mainAutomationToolsIncluded =
    runtime.config.taskType !== "subagent_child" &&
    resolveRuntimeAutomationToolsIncluded(runtime.config);
  registerBuiltInTools(runtime.registry, {
    bashTimeoutPolicy: runtime.config.bashTimeoutPolicy,
    includeSkill: Boolean(runtime.skillPort),
    includeAgent: Boolean(runtime.subagentPort),
    includeSendMessage: runtime.subagentPort?.sendMessage !== undefined,
    includeRespondToCoordinator:
      runtime.config.taskType === "subagent_child" && Boolean(deps.coordinatorResponsePort),
    // Register submit_result only in workflow actor sessions with workflowSubmitPort injected. Gate on port presence, independent of
    // taskType: a workflow actor is workflow_child, but its runtimeScope is currently "main".
    includeSubmitResult: Boolean(deps.workflowSubmitPort),
    // Mono subagents use the typed declaration; the gate is still port presence.
    ...(deps.workflowSubmitSchema === undefined
      ? {}
      : { submitResultSchema: deps.workflowSubmitSchema }),
    // escalate uses the same gate and rationale as submit_result: register when the port exists (no opt-in; the actor most likely to
    // hit a blocker is the one the author did not mark).
    includeEscalate: Boolean(deps.workflowEscalatePort),
    includeWorkflow: Boolean(deps.workflowPort),
    sessionControlKind: runtime.sessionControlKind,
    includeAutomation: Boolean(deps.automationPort) && mainAutomationToolsIncluded,
    // offPeakPort is injected only when the host enables offPeakToolEnabled (rollout/remote gate is on the host), so port presence
    // means exposure is allowed. Do not expose it in subagent sessions, matching automation.
    includeOffPeak: Boolean(deps.offPeakPort) && mainAutomationToolsIncluded,
    // Topic resources are readable only in App-hosted runtimes. The CLI does not know whether a session is a bot session, so
    // authorization is checked at call time against trusted input.
    includeTopicResource: Boolean(deps.topicResourcePort),
    // Dynamic-workflow rollout gate: unlike off-peak, port presence cannot be the criterion here; all ten tool ports are wired in
    // every CLI, and rollout is a Host decision. The value is defined in tool-allowlist.ts and shared with the branch-refresh entry point.
    includeDynamicWorkflow: resolveRuntimeDynamicWorkflowToolsIncluded(runtime),
    agentAlwaysBackground: resolveRuntimeAgentAlwaysBackground(runtime.config),
    includePluginDiscovery:
      Boolean(deps.pluginDiscoveryPort) && runtime.config.taskType !== "subagent_child",
    // 与 MCP 会话同门（agent-runtime 在有 mcpPort 时创建会话）；本轮是否可见由 getTools(model) 决定。
    includeMcpServerWait: Boolean(deps.mcpPort),
    // 修复原因：browserControlPort 只是宿主能力，不应隐式暴露高权限 node_repl。
    // node_repl/browser-use 由 ZCode 官方 browser-use 插件启停推导出的 runtimeFeatures 控制。
    includeNodeRepl: nodeReplEnabled,
    // Language-server tool: gated by wired service plus availability (shared helper, also used by the branch refresh path).
    includeLsp: resolveRuntimeLspToolIncluded(runtime),
    includeBrowserUse: browserUseEnabled,
    embeddedSearchEnabled: resolveRuntimeEmbeddedSearchEnabled(runtime),
    allowedTools: resolveBuiltInToolAllowlist(runtime.config),
    // Structural workflow_child exclusions (CreateWorkflow/SaveWorkflow invisibly hang on alwaysAsk; ResumeWorkflowRun no longer
    // asks but remains excluded because children cannot orchestrate) are merged with the turn-level list in the helper; see the root
    // cause comment in tool-allowlist.ts.
    disallowedTools: resolveRuntimeDisallowedTools(runtime.config),
  });
}

function createRuntimeHookRunner(
  runtime: AgentRuntimeInternal,
  deps: AgentRuntimeDeps,
  sessionId: SessionId,
): HookRunner | undefined {
  let hookRunner =
    deps.hookRunner ??
    ((runtime.config.hooks?.enabled || deps.workspaceHookSnapshot) && deps.executionPort
      ? createConfiguredHookRunner({
          config: runtime.config.hooks ?? EMPTY_RUNTIME_HOOK_CONFIG,
          emitEvent: async (event) => {
            await runtime.appendEvent(event, getCurrentTraceContext() ?? runtime.rootTraceContext);
          },
          executionPort: deps.executionPort,
          getWorkingDirectory: () => runtime.workingDirectory,
          logger: runtime.logger,
          workspaceHookAdmission: deps.workspaceHookAdmission,
          workspaceHookSnapshot: deps.workspaceHookSnapshot,
        })
      : undefined);

  if (!deps.sessionMailboxPort) {
    return hookRunner;
  }

  hookRunner ??= createInMemoryHookRunner({
    emitEvent: async (event) => {
      if (isStaleBranchRuntimeTaskEvent(runtime, event)) return;
      await runtime.appendEvent(event, getCurrentTraceContext() ?? runtime.rootTraceContext);
    },
    logger: runtime.logger,
  });
  for (const hook of createSessionMailboxHookRegistrations({
    enqueuePendingInput: async (input, traceContext) => {
      const result = await runtime.steerTurn({
        delivery: "guide",
        expectedTurnId: traceContext.turnId,
        input,
        traceContext,
      });
      if (result.kind === "rejected") {
        runtime.logger?.warn("Session mailbox input was not queued", {
          ...traceContextToLogContext(traceContext),
          event: "session.mailbox.queue_rejected",
          module: "core.runtime",
          reason: result.reason,
          status: "completed",
        });
      }
    },
    mailbox: deps.sessionMailboxPort,
    sessionId,
  })) {
    if ("register" in hookRunner && typeof hookRunner.register === "function") {
      hookRunner.register(hook);
    }
  }
  return hookRunner;
}

function createRuntimeToolExecutor(
  runtime: AgentRuntimeInternal,
  deps: AgentRuntimeDeps,
  hookRunner: HookRunner | undefined,
): ToolExecutor {
  const browserUseEnabled = resolveRuntimeBrowserUseEnabled(runtime, deps);
  return createToolExecutor({
    agentTelemetry: runtime.agentTelemetry.port,
    agentTelemetryActorKind: runtime.agentTelemetry.actorKind,
    registry: runtime.registry,
    permissionService: runtime.permissionService,
    permissionBroker: runtime.permissionBroker,
    emitEvent: async (event) => {
      await runtime.appendEvent(event, getCurrentTraceContext() ?? runtime.rootTraceContext);
    },
    enqueueBackgroundTaskNotification: (notification) => {
      runtime.enqueueBackgroundTaskNotification(notification);
    },
    shouldEnqueueBackgroundTaskNotification: (input) =>
      shouldEnqueueRuntimeBackgroundTaskNotification(runtime, input),
    logger: runtime.logger,
    backgroundTaskControlPort: {
      stopBackgroundTask: runtime.stopBackgroundTask.bind(runtime),
    },
    executionPort: deps.executionPort,
    browserControlPort: browserUseEnabled ? deps.browserControlPort : undefined,
    browserDocumentationRoot: browserUseEnabled
      ? runtime.config.runtimeFeatures?.browserDocumentationRoot
      : undefined,
    fileSystemPort: deps.fileSystemPort,
    lsp: deps.lsp,
    httpClientPort: deps.httpClientPort,
    imageProcessorPort: deps.imageProcessorPort,
    // A previous connection-merge deletion accidentally omitted this port; Read pagination rendering and full-PDF page-count checks
    // still depend on host injection.
    pdfDocumentPort: deps.pdfDocumentPort,
    embeddedSearchBackend: runtime.config.embeddedSearchBackend,
    nativeSearchEnhancementsEnabled: runtime.config.nativeSearchEnhancementsEnabled,
    skillPort: deps.skillPort,
    subagentPort: runtime.subagentPort,
    coordinatorResponsePort: deps.coordinatorResponsePort,
    workflowSubmitPort: deps.workflowSubmitPort,
    workflowEscalatePort: deps.workflowEscalatePort,
    webSearchBudget: deps.webSearchBudget,
    artifactStore: deps.artifactStore,
    sessionControl: sessionControlForRuntime(
      deps.sessionControl,
      runtime.config.taskType,
      runtime.sessionId,
    ),
    automationPort: deps.automationPort,
    offPeakPort: deps.offPeakPort,
    topicResourcePort: deps.topicResourcePort,
    pluginDiscoveryPort: deps.pluginDiscoveryPort,
    sessionStore: deps.sessionStore,
    sessionModePort: createRuntimeSessionModePort(runtime),
    workflowPort: deps.workflowPort,
    dynamicWorkflowRunPort: deps.dynamicWorkflowRunPort,
    dynamicWorkflowSnippetPort: deps.dynamicWorkflowSnippetPort,
    modelCatalogPort: deps.modelCatalogPort,
    runtimeTaskRegistry: runtime.runtimeTaskRegistry,
    registerResidencyBlockingWork: (work) => {
      void runtime.trackResidencyBlockingWork(work).catch(() => undefined);
    },
    readFileState: runtime.readFileState,
    nestedInstructions: createRuntimeNestedInstructionContext(runtime),
    // Skill gate for workflow-authoring tools (tool/handlers/workflow-skill-gate.ts): answer “has the skill been read?” from history
    // currently visible to the model. Add the probe only when this session has a Skill tool; a session without skillPort cannot load the
    // skill, so leaving the gate enabled would create an impassable wall.
    ...(deps.skillPort === undefined
      ? {}
      : {
          hasLoadedSkill: (skillName: string) =>
            sessionHasLoadedSkill(runtime.messageHistory.borrowReadOnlyRuntimeEntries(), skillName),
        }),
    // Skill 工具的未激活提示（tool/handlers/skill.ts）：只读 runtime 自己的激活态，每次调用现取，
    // 所以 `/workflow` 激活之后的下一次 Skill 调用就读到 "none"。
    getDynamicWorkflowToolSurfaceDeferral: () =>
      resolveRuntimeDynamicWorkflowToolSurfaceDeferral(runtime),
    describeUnavailableTool: (toolName, model) =>
      describeUnavailableMcpTool(runtime, toolName, model) ||
      describeUnavailableBuiltInTool(runtime, toolName),
    ...(deps.mcpPort === undefined
      ? {}
      : {
          mcpServerWaitPort: createMcpServerWaitPort(runtime),
          resolveUnregisteredTool: (toolName, options) =>
            resolveUnregisteredMcpTool(runtime, toolName, options),
        }),
    subagentBackgroundBashMaxMs:
      runtime.config.taskType === "subagent_child"
        ? normalizeSubagentBackgroundBashMaxMs(runtime.config.subagents?.backgroundBashMaxMs)
        : undefined,
    getBashShellSelection: () => getSessionShellSelectionFromConfig(runtime.config),
    hookRunner,
    validateToolExecution: (metadata: ToolMetadata) =>
      getMissingExecutionWorktreeToolError(
        runtime.config.executionWorktree,
        metadata.sideEffectScope,
        metadata.name,
        undefined,
        (directoryExists) => {
          const current = runtime.config.executionWorktree;
          if (!current) return;
          if (directoryExists) {
            if (current.missing) {
              const { missing: _missing, ...restored } = current;
              runtime.config.executionWorktree = restored;
            }
          } else if (!current.missing) {
            runtime.config.executionWorktree = { ...current, missing: true };
          }
        },
      ),
    getWorkingDirectory: () => runtime.workingDirectory,
    setWorkingDirectory: runtime.setWorkingDirectory.bind(runtime),
    getWorkspaceRoot: () => runtime.workspaceRoot,
    workspaceIdentity: runtime.config.workspaceIdentity?.toString(),
    workspaceKey: runtime.config.workspaceKey,
    remoteSessionId: runtime.config.remoteSessionId,
    clientMode: runtime.config.clientMode,
    deliveryKind: runtime.config.deliveryKind,
    getMemoryRoot: () =>
      deps.memoryRoot ?? resolveEnabledProjectMemoryRoot(runtime.config, runtime.workspaceRoot),
    runtimeScope: resolveRuntimeToolScope(runtime),
    syncSubagent:
      runtime.config.taskType === "subagent_child" &&
      runtime.config.subagents?.startedInForeground === true,
    permissionTimeoutMs: runtime.config.permissionTimeoutMs,
    sessionId: runtime.sessionId,
    traceContext: runtime.rootTraceContext,
    getMode: () => runtime.config.mode ?? "build",
    maxConcurrency: runtime.config.toolConcurrency?.maxConcurrency,
  });
}

export function resolveRuntimeToolScope(runtime: AgentRuntimeInternal): ToolRuntimeScope {
  return runtime.config.taskType === "subagent_child" ? "subagent" : "main";
}

/**
 * Single construction point for input-aware capability resolution outside the executor
 * (scheduling, streaming early execution, ledger). Guarded only reports a dangerous Bash
 * match when both `mode` and the shell dialect are present.
 */
export function resolveRuntimeToolCapabilityContext(
  runtime: AgentRuntimeInternal,
): ToolRuntimePermissionCapabilityContext {
  return {
    bashShellSelection: getSessionShellSelectionFromConfig(runtime.config),
    mode: runtime.config.mode ?? "build",
    runtimeScope: resolveRuntimeToolScope(runtime),
    workingDirectory: runtime.workingDirectory,
    workspaceRoot: runtime.workspaceRoot,
  };
}

/**
 * Error suffix for unregistered tools other than MCP; for the decision order see "Suffix for unknown tools" in docs/model-tool-call-validation.md.
 * Fix reason: only MCP tools used to get a suffix. When the case was wrong, a removed Grep/Glob was called, or a subagent called a built-in tool
 * it was not given, the model only saw "No such tool available", did not know which tool to switch to, and tended to repeat the same call.
 */
function describeUnavailableBuiltInTool(runtime: AgentRuntimeInternal, toolName: string): string {
  // Embedded search does not register Grep/Glob, but they are still in builtInTools, so this check comes before the built-in tool check.
  if (toolName === "Grep" || toolName === "Glob") {
    if (!runtime.registry.has("Bash")) return `. ${toolName} is disabled for this session.`;
    return toolName === "Grep"
      ? ". Grep is not available in this session \u2014 search file contents with `grep` via the Bash tool instead."
      : ". Glob is not available in this session \u2014 find files with `find` via the Bash tool instead.";
  }
  if (builtInTools.some((entry) => entry.metadata.name === toolName)) {
    return runtime.config.taskType === "subagent_child"
      ? `. ${toolName} is not available inside subagents. Complete the task with the tools provided and return your findings in your final response.`
      : `. ${toolName} is not among the tools available here. Continue with the tools you have.`;
  }
  const lowerName = toolName.toLowerCase();
  const matches = runtime.registry.list().filter((name) => name.toLowerCase() === lowerName);
  return matches.length === 1 ? `. Tool names are case-sensitive: call ${matches[0]} instead.` : "";
}

function resolveRuntimeBrowserUseEnabled(
  runtime: AgentRuntimeInternal,
  deps: AgentRuntimeDeps,
): boolean {
  return (
    runtime.config.runtimeFeatures?.browserUse === true && deps.browserControlPort !== undefined
  );
}

function shouldEnqueueRuntimeBackgroundTaskNotification(
  runtime: AgentRuntimeInternal,
  input: {
    status: string;
    taskId: string;
    toolName: string;
    traceContext: TraceContext;
  },
): boolean {
  if (runtime.shuttingDown) {
    runtime.logger?.info?.("Suppressed background task notification during runtime shutdown", {
      ...traceContextToLogContext(input.traceContext),
      event: "runtime.background_task_notification.shutdown_suppressed",
      module: "core.runtime",
      taskId: input.taskId,
      taskStatus: input.status,
      toolName: input.toolName,
    });
    return false;
  }
  const registryTask = runtime.runtimeTaskRegistry.get(input.taskId);
  if (
    !shouldSuppressSealedSubagentBashNotification({
      isSubagentChildRuntime: runtime.config.taskType === "subagent_child",
      notificationSealed: runtime.backgroundTaskNotificationsSealed,
      registryTask,
      toolName: input.toolName,
    })
  ) {
    return true;
  }
  runtime.logger?.info?.("Suppressed sealed subagent background Bash notification", {
    ...traceContextToLogContext(input.traceContext),
    event: "runtime.background_task_notification.suppressed",
    module: "core.runtime",
    reason: runtime.backgroundTaskNotificationSealReason,
    taskId: input.taskId,
    taskStatus: input.status,
    toolName: input.toolName,
  });
  return false;
}

function normalizeSubagentBackgroundBashMaxMs(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_SUBAGENT_BACKGROUND_BASH_MAX_MS;
  }
  return Math.trunc(value);
}
