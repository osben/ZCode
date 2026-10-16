import {
  type AgentTelemetryErrorCategory,
  CoreErrorType,
  createChildTraceContext,
  createCoreError,
  createRootTraceContext,
  getCurrentTraceContext,
  traceContextToLogContext,
  type ToolExecutionSpanWriter,
  type SessionEvent,
} from "@zcode/contracts";
import {
  OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION,
  attestOfficialCuaFrameContent,
} from "@zcode/zcode-cua/frame-contract";
import {
  normalizeToolExecutionInput,
  prepareInitialToolExecutionInput,
} from "../input-normalization.js";
import { hasOfficialCuaFrameAuthority } from "../../mcp/image-normalization.js";
import type { SkillTelemetryMetadata } from "@zcode/contracts";
import type { ToolExecutionContext, ToolExecutionResult } from "../types.js";
import type { ToolEntry } from "../types.js";
import type { BackgroundTaskTracker } from "./background-tasks.js";
import {
  createErrorResult,
  createPermissionErrorResult,
  createToolHandlerFailureError,
  isToolHandlerFailure,
  isToolHandlerFailureError,
} from "./errors.js";
import { emitToolCallError, emitToolCallResult, emitToolCallStarted } from "./events.js";
import {
  formatHookAdditionalContexts,
  runPostToolUseFailureHooks,
  runPostToolUseHooks,
  runPreToolUseHooks,
} from "./hook-flow.js";
import { resolveToolCallCapabilityFlags } from "./permission-capability.js";
import { resolveToolPermission } from "./permission-flow.js";
import { snapshotPermissionInput } from "./permission-input.js";
import { buildToolInputResolutionContext } from "./permission-input-adjustments.js";
import { createMcpToolDisplay, createToolResultDisplay } from "./result-display.js";
import { appendHookAdditionalContexts, serializeOutput } from "./result-serialization.js";
import {
  ToolDeadline,
  executeWithTimeout,
  linkAbortSignal,
  observeToolAdmissionClock,
  resolveTimeoutMs,
} from "./timeout.js";
import { createToolModelStatusSink, withDefaultToolModelStatusSink } from "./model-status-sink.js";
import { runToolCallWithTelemetry } from "./telemetry.js";
import {
  withAutomationCreateLimitTurnStop,
  withPlanExitDeniedTurnStop,
  withTerminalToolTurnStop,
  withWorkflowRefineDeniedFollowUp,
} from "./turn-control.js";
import { mergeToolExecutionTelemetry, readToolExecutionTelemetry } from "../handlers/tool-perf.js";
import type { ToolExecuteOptions, ToolExecutorDeps } from "./types.js";
import { validateInitialModelToolInput, validateInput, validateOutput } from "./validation.js";
import type { ExecutableToolCall } from "../types.js";
import { resolveEmbeddedSearchBranchCapability } from "../../embedded-search/capability.js";
import { resolveToolEntryModelContract } from "../model-contract.js";

export async function executeToolCall(
  deps: ToolExecutorDeps,
  backgroundTasks: BackgroundTaskTracker,
  toolCall: ExecutableToolCall,
  options?: ToolExecuteOptions,
): Promise<ToolExecutionResult> {
  const totalStartedAt = Date.now();
  const entry = isEmptyToolName(toolCall.name) ? undefined : deps.registry.get(toolCall.name);
  const canonicalToolCall =
    entry && toolCall.name !== entry.metadata.name
      ? { ...toolCall, name: entry.metadata.name }
      : toolCall;
  // Privacy and cardinality boundary: unregistered tool names come from model output
  // and cannot be treated as a controlled enum. Keep the real name in business errors
  // so the model can self-correct, but map it to a fixed `unknown` bucket in remote traces.
  const telemetryToolCall = entry ? canonicalToolCall : { ...toolCall, name: "unknown" };
  return runToolCallWithTelemetry(deps, telemetryToolCall, options, (telemetry) =>
    executeToolCallImpl(deps, backgroundTasks, toolCall, totalStartedAt, options, telemetry),
  );
}

async function executeToolCallImpl(
  deps: ToolExecutorDeps,
  backgroundTasks: BackgroundTaskTracker,
  toolCall: ExecutableToolCall,
  totalStartedAt: number,
  options?: ToolExecuteOptions,
  telemetry?: ToolExecutionSpanWriter,
): Promise<ToolExecutionResult> {
  const parentTraceContext =
    options?.traceContext ??
    getCurrentTraceContext() ??
    deps.traceContext ??
    createRootTraceContext({ sessionId: deps.sessionId, turnId: deps.turnId });
  const emptyToolName = isEmptyToolName(toolCall.name);
  const registeredEntry = emptyToolName ? undefined : deps.registry.get(toolCall.name);
  const model = options?.model ?? deps.model;
  const entry = registeredEntry
    ? resolveToolEntryModelContract(registeredEntry, {
        model,
      })
    : undefined;
  const canonicalToolCall =
    entry && toolCall.name !== entry.metadata.name
      ? { ...toolCall, name: entry.metadata.name }
      : toolCall;
  const traceContext = createChildTraceContext(parentTraceContext, {
    sessionId: deps.sessionId,
    turnId: deps.turnId,
    attributes: {
      toolCallId: canonicalToolCall.id,
      toolName: canonicalToolCall.name,
    },
  });
  const traceId = traceContext.traceId;
  const turnId = traceContext.turnId ?? deps.turnId;

  if (!entry) {
    const result = createErrorResult(
      toolCall,
      createCoreError(
        CoreErrorType.ToolNotFound,
        emptyToolName
          ? "Model returned an invalid tool call: tool name is empty."
          : `Tool not found: ${toolCall.name}`,
        {
          context: { toolCallId: toolCall.id, toolName: toolCall.name },
          recoverable: false,
        },
      ),
    );
    if (emptyToolName) {
      // Stopping an empty name at admission would leave the model without a paired
      // result. Reuse the registry-miss lifecycle, while preserving the original blank
      // name from the model in provider content.
      result.modelContent = `<tool_use_error>Error: No such tool available: ${toolCall.name}</tool_use_error>`;
    }
    // A registry miss occurs before the handler/ToolCallStarted. Previously, failure
    // was returned only to the provider, without emitting ToolCallError, leaving the V4
    // tool row permanently in inputStreaming.
    await emitToolCallError(deps, toolCall.id, traceContext, turnId, result.error);
    deps.logger?.warn("Tool call rejected because the tool is not registered", {
      ...traceContextToLogContext(traceContext),
      event: "tool.call.not_found",
      module: "core.tool.executor",
      status: "failed",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
    });
    telemetry?.finishFailed("lookup", "configuration", result.error);
    return result;
  }

  const executionContextFailure = await deps.validateToolExecution?.(entry.metadata);
  if (executionContextFailure) {
    const error = createCoreError(CoreErrorType.ToolExecutionFailed, executionContextFailure, {
      context: { toolName: canonicalToolCall.name },
      recoverable: true,
    });
    const result = createErrorResult(canonicalToolCall, error);
    await emitToolCallError(deps, canonicalToolCall.id, traceContext, turnId, error);
    telemetry?.finishFailed("validation", "configuration", error);
    return result;
  }

  let lifetime: ReturnType<NonNullable<ToolEntry["retainExecution"]>> | undefined;
  try {
    lifetime = entry.retainExecution?.(canonicalToolCall.id);
  } catch (error) {
    const result = createErrorResult(
      canonicalToolCall,
      createCoreError(
        CoreErrorType.ToolCancelled,
        error instanceof Error ? error.message : "Tool instance is unavailable",
      ),
    );
    await emitToolCallError(deps, canonicalToolCall.id, traceContext, turnId, result.error);
    return result;
  }
  if (lifetime)
    options = {
      ...options,
      signal: options?.signal
        ? AbortSignal.any([options.signal, lifetime.signal])
        : lifetime.signal,
    };
  try {
    const mode = deps.getMode();

    if (options?.signal?.aborted) {
      const result = createErrorResult(
        canonicalToolCall,
        createCoreError(CoreErrorType.ToolCancelled, "Tool execution cancelled"),
      );
      telemetry?.finishCancelled("abort_signal");
      return result;
    }

    const preparedInitialInput = prepareInitialToolExecutionInput({
      entry,
      input: canonicalToolCall.input,
      logger: deps.logger,
    });
    let executionInput = preparedInitialInput.input;
    const initialInputValidation = validateInitialModelToolInput(
      executionInput,
      entry,
      preparedInitialInput.runtimeValidationIssues,
    );
    if (initialInputValidation) {
      const result = createErrorResult(canonicalToolCall, initialInputValidation);
      // Schema failures and registry misses both return early, before the handler and ToolCallStarted; the old code
      // only fed the failure back to the model and emitted no ToolCallError, leaving the V4 tool row in
      // inputStreaming for the entire turn (the CreateWorkflow card kept showing “Writing workflow”), with another card added after a model retry.
      await emitToolCallError(deps, canonicalToolCall.id, traceContext, turnId, result.error);
      telemetry?.finishFailed("validation", "parse", result.error);
      return result;
    }

    const toolInputValidation = entry.validateInput?.(executionInput, {
      runtimeTaskRegistry: deps.runtimeTaskRegistry,
    });
    if (toolInputValidation && isToolHandlerFailure(toolInputValidation)) {
      // Tool-specific semantic validation previously lived only in the handler, so invalid calls still ran
      // PreToolUse, permission checks, and failure hooks; semantic validation must finish before hooks.
      const result = createErrorResult(
        canonicalToolCall,
        createToolHandlerFailureError(canonicalToolCall, toolInputValidation),
      );
      await emitToolCallError(deps, canonicalToolCall.id, traceContext, turnId, result.error);
      // Return tool-specific validation failures as ordinary failure results instead of routing them through the handler's try/catch.
      // Emit ToolCallError to update the tool row, then explicitly mark telemetry as failed so it is not recorded as abandoned.
      telemetry?.finishFailed("validation", "parse", result.error);
      return result;
    }

    // Normalize model arguments into the facts about what will execute. This intentionally happens **before** hooks:
    // hooks, permission rules, confirmation payloads, prepareApproval, and the handler all read the same input,
    // so policies see the actual script, it stays visible across versions, and confirmation matches execution byte for byte.
    if (entry.resolveInput) {
      const resolution = await entry.resolveInput(
        executionInput,
        buildToolInputResolutionContext(deps),
      );
      if (isToolHandlerFailure(resolution)) {
        // Use the same lifecycle exit as validateInput: if parsing fails, return it to the model to fix immediately
        // instead of opening a confirmation dialog that is guaranteed to fail.
        const result = createErrorResult(
          canonicalToolCall,
          createToolHandlerFailureError(canonicalToolCall, resolution),
        );
        await emitToolCallError(deps, canonicalToolCall.id, traceContext, turnId, result.error);
        telemetry?.finishFailed("validation", "parse", result.error);
        return result;
      }
      executionInput = resolution.input;
    }

    const preToolHookResult = await runPreToolUseHooks(
      deps,
      canonicalToolCall,
      executionInput,
      entry,
      mode,
      traceContext,
      options?.signal,
    );
    if (preToolHookResult.permissionBehavior === "deny" || preToolHookResult.preventContinuation) {
      const result = appendPreToolAdditionalContextsToErrorResult(
        withPlanExitDeniedTurnStop(
          createPermissionErrorResult(
            canonicalToolCall,
            preToolHookResult.hookPermissionDecisionReason ??
              preToolHookResult.stopReason ??
              "Blocked by PreToolUse hook",
            {
              decision: "deny",
              mode,
              reason:
                preToolHookResult.hookPermissionDecisionReason ?? preToolHookResult.stopReason,
              source: "hook.PreToolUse",
            },
          ),
          {
            mode,
            planEnabled: deps.sessionModePort?.isPlanEnabled?.(),
            toolName: canonicalToolCall.name,
          },
        ),
        preToolHookResult.additionalContexts,
      );
      telemetry?.setPermissionDecision("denied");
      telemetry?.finishDenied("policy_denied");
      return result;
    }
    if (preToolHookResult.updatedInput !== undefined) {
      executionInput = normalizeToolExecutionInput({
        entry,
        input: preToolHookResult.updatedInput,
        logger: deps.logger,
        source: "hook",
      });
      const hookInputValidation = validateInput(executionInput, entry);
      if (hookInputValidation) {
        // When validation fails after a Hook modifies the input, this returns before the handler. The old branch skipped
        // the shared PreToolUse context append, so the model saw only a schema error and missed Hook diagnostics;
        // this did not match the early-failure contract for deny and permission-deny.
        const result = appendPreToolAdditionalContextsToErrorResult(
          createErrorResult(canonicalToolCall, hookInputValidation),
          preToolHookResult.additionalContexts,
        );
        telemetry?.finishFailed("validation", "parse", result.error);
        return result;
      }
    }

    // The session owner has already fixed the shell; matching and execution reuse that choice without creating a snapshot for a hot switch that cannot occur.
    const bashShellSelection = deps.getBashShellSelection?.() ?? deps.bashShellSelection;
    const guardedWorkingDirectory = mode === "guarded" ? deps.getWorkingDirectory() : undefined;
    if (mode === "guarded") executionInput = snapshotPermissionInput(executionInput);
    const permissionResult = await resolveToolPermission(
      deps,
      canonicalToolCall,
      entry,
      executionInput,
      preToolHookResult,
      mode,
      traceContext,
      options?.signal,
      telemetry,
      {
        mode,
        bashShellSelection,
        ...(guardedWorkingDirectory === undefined
          ? {}
          : { workingDirectory: guardedWorkingDirectory }),
      },
    );
    if (!permissionResult.allowed) {
      const result = appendPreToolAdditionalContextsToErrorResult(
        withWorkflowRefineDeniedFollowUp(
          withPlanExitDeniedTurnStop(permissionResult.result, {
            mode,
            planEnabled: deps.sessionModePort?.isPlanEnabled?.(),
            toolName: canonicalToolCall.name,
          }),
          { toolName: canonicalToolCall.name },
        ),
        preToolHookResult.additionalContexts,
      );
      if (result.error?.type === CoreErrorType.PermissionDenied) {
        telemetry?.finishDenied("user_denied");
      } else {
        telemetry?.finishFailed(
          "permission",
          errorCategoryForToolError(result.error?.type),
          result.error,
        );
      }
      return result;
    }
    executionInput = permissionResult.executionInput;
    const permissionWaitMs = permissionResult.permissionWaitMs;
    const inputAdjustments = permissionResult.inputAdjustments;

    const startTime = Date.now();
    // Resolve side-effect flags once from the **execution input** (Bash read-only command detection is finalized here) and emit them with ToolCallStarted:
    // the event precedes the handler, so subscribers (the dynamic-workflow driver's import-cache cutoff) know before the first byte is written.
    await emitToolCallStarted(
      deps,
      canonicalToolCall,
      traceContext,
      turnId,
      startTime,
      createMcpToolDisplay(entry.metadata.mcpPresentation),
      resolveToolCallCapabilityFlags(deps, entry, executionInput),
    );

    deps.logger?.info("Tool call started", {
      ...traceContextToLogContext(traceContext),
      event: "tool.call.started",
      module: "core.tool.executor",
      status: "started",
      toolCallId: canonicalToolCall.id,
      toolName: canonicalToolCall.name,
    });

    const timeoutMs = resolveTimeoutMs(entry, executionInput, deps.defaultTimeoutMs, {
      model,
    });
    const executionAbortController = new AbortController();
    const unlinkParentAbort = linkAbortSignal(options?.signal, executionAbortController);
    // Pausable deadline: pause the timer while model requests inside this call wait at the admission gate. Both queue transitions
    // arrive as ModelNetworkStatus session events for this toolCallId, so intercepting them at the event boundary keeps the handler unaware.
    const deadline = new ToolDeadline(timeoutMs);
    const emitEvent =
      deps.emitEvent === undefined
        ? undefined
        : async (event: SessionEvent): Promise<void> => {
            observeToolAdmissionClock(event, canonicalToolCall.id, deadline);
            await deps.emitEvent(event);
          };
    let readFileStateMetadata: ToolExecutionResult["readFileStateMetadata"];
    let skillTelemetryMetadata: SkillTelemetryMetadata | undefined;
    let failureStage: "handler" | "serialize" | "post_hook" = "handler";

    try {
      const model = options?.model ?? deps.model;
      const embeddedSearchDecision = resolveEmbeddedSearchBranchCapability({
        bashAvailable: deps.registry.has("Bash"),
      });
      const context: ToolExecutionContext = {
        toolCallId: canonicalToolCall.id,
        telemetry,
        automationTurn: options?.automationTurn,
        offPeakTurn: options?.offPeakTurn,
        traceContext,
        traceId,
        spanId: traceContext.spanId,
        parentSpanId: traceContext.parentSpanId,
        abortSignal: executionAbortController.signal,
        backgroundTaskControlPort: deps.backgroundTaskControlPort,
        emitEvent,
        executionPort: deps.executionPort,
        browserControlPort: deps.browserControlPort,
        browserDocumentationRoot: deps.browserDocumentationRoot,
        fileSystemPort: deps.fileSystemPort,
        httpClientPort: deps.httpClientPort,
        imageProcessorPort: deps.imageProcessorPort,
        pdfDocumentPort: deps.pdfDocumentPort,
        // Model requests inside a tool emit status events to the session by default; deadline pausing and driver phases both depend on this stream.
        model: withDefaultToolModelStatusSink(
          model,
          createToolModelStatusSink({ emitEvent, sessionId: deps.sessionId, turnId, traceId }),
        ),
        subagentModelOverride: options?.subagentModelOverride,
        embeddedSearch: {
          ...(deps.embeddedSearchBackend ? { backend: deps.embeddedSearchBackend } : {}),
          enabled: embeddedSearchDecision?.useEmbeddedSearchBranch ?? false,
          ...(deps.nativeSearchEnhancementsEnabled === false ? { findAndGrepEnabled: false } : {}),
        },
        skillPort: deps.skillPort,
        subagentPort: deps.subagentPort,
        coordinatorResponsePort: deps.coordinatorResponsePort,
        workflowSubmitPort: deps.workflowSubmitPort,
        workflowEscalatePort: deps.workflowEscalatePort,
        artifactStore: deps.artifactStore,
        automationPort: deps.automationPort,
        offPeakPort: deps.offPeakPort,
        topicResourcePort: deps.topicResourcePort,
        sessionStore: deps.sessionStore,
        sessionModePort: deps.sessionModePort,
        workflowPort: deps.workflowPort,
        dynamicWorkflowRunPort: deps.dynamicWorkflowRunPort,
        dynamicWorkflowSnippetPort: deps.dynamicWorkflowSnippetPort,
        modelCatalogPort: deps.modelCatalogPort,
        runtimeTaskRegistry: deps.runtimeTaskRegistry,
        readFileState: deps.readFileState,
        recordReadFileStateMetadata: (metadata) => {
          readFileStateMetadata = metadata;
        },
        recordSkillTelemetryMetadata: (metadata) => {
          skillTelemetryMetadata = metadata;
        },
        bashShellSelection,
        setWorkingDirectory: deps.setWorkingDirectory,
        workingDirectory: guardedWorkingDirectory ?? deps.getWorkingDirectory(),
        workspaceRoot: deps.getWorkspaceRoot(),
        workspaceIdentity: deps.workspaceIdentity,
        remoteSessionId: deps.remoteSessionId,
        clientMode: deps.clientMode,
        deliveryKind: deps.deliveryKind,
        memoryRoot: deps.getMemoryRoot?.(),
        runtimeScope: deps.runtimeScope,
        providerVisibleToolNames: deps.registry
          .list()
          .filter((name) => deps.registry.getMetadata(name)?.providerVisible !== false),
        sessionId: deps.sessionId,
        turnId,
        ...(inputAdjustments === undefined ? {} : { inputAdjustments }),
      };

      const output = await executeWithTimeout(
        entry.handler,
        executionInput,
        context,
        deadline,
        executionAbortController,
        entry,
      );
      const durationMs = Date.now() - startTime;
      if (isToolHandlerFailure(output)) {
        // The handler returns expected business failures as values; convert them here to the existing exception flow
        // so they reuse the current failure hook, events, and logs without adding another execution lifecycle.
        throw createToolHandlerFailureError(canonicalToolCall, output);
      }
      validateOutput(output, entry);
      // node_repl hosts both Browser Use and CUA, so the entire server cannot be marked official at registration time.
      // Enable atomic frame protection for this serialization only when the CUA SDK result carries producer integrity metadata;
      // otherwise the generic resultBudget may truncate/reorder image_ref, or the non-authority path may strip the reference.
      const modelOutputEntry = resolveModelOutputEntry(entry, output);
      failureStage = "serialize";
      let serialization = await serializeOutput(
        deps,
        output,
        modelOutputEntry,
        traceContext,
        canonicalToolCall.id,
        executionAbortController.signal,
      );
      failureStage = "post_hook";
      const postToolHookResult = await runPostToolUseHooks(
        deps,
        canonicalToolCall,
        executionInput,
        output,
        serialization.artifactPath,
        traceContext,
        options?.signal,
      );
      serialization = appendHookAdditionalContexts(
        serialization,
        [...preToolHookResult.additionalContexts, ...postToolHookResult.additionalContexts],
        modelOutputEntry,
      );
      const display = createToolResultDisplay(canonicalToolCall.name, output, {
        mcp: entry.metadata.mcpPresentation,
        officialCua: entry.modelContentProtection === OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION,
      });
      const perf = mergeToolExecutionTelemetry(readToolExecutionTelemetry(output), {
        permissionWaitMs,
        // totalMs measures the user-visible tool lifecycle: registry lookup, validation, hooks, permission wait,
        // handler, serialization, and PostToolUse. durationMs continues to cover only the handler's main execution.
        totalMs: Date.now() - totalStartedAt,
      });

      const finalModelContent = serialization.modelContent ?? serialization.content;
      const modelContentProtection = modelOutputEntry.modelContentProtection
        ? attestOfficialCuaFrameContent(finalModelContent, modelOutputEntry.modelContentProtection)
        : undefined;
      if (
        modelOutputEntry.modelContentProtection &&
        Array.isArray(finalModelContent) &&
        finalModelContent.some((block) => block.type === "image") &&
        !modelContentProtection
      ) {
        throw createCoreError(
          CoreErrorType.ToolExecutionFailed,
          "Official CUA frame failed final model-content attestation",
          { recoverable: true },
        );
      }

      const result: ToolExecutionResult = withTerminalToolTurnStop(
        {
          toolCallId: canonicalToolCall.id,
          toolName: canonicalToolCall.name,
          success: true,
          output,
          display,
          modelContent: finalModelContent,
          ...(readFileStateMetadata ? { readFileStateMetadata } : {}),
          performance: perf,
          serialization,
          durationMs,
          startedAt: new Date(startTime),
          completedAt: new Date(),
        },
        { entry },
      );

      await emitToolCallResult(
        deps,
        canonicalToolCall,
        traceContext,
        turnId,
        serialization,
        durationMs,
        display,
        perf,
        skillTelemetryMetadata,
      );

      await backgroundTasks.trackBackgroundTask(canonicalToolCall, output, traceContext, turnId);

      deps.logger?.info("Tool call completed", {
        ...traceContextToLogContext(traceContext),
        durationMs,
        event: "tool.call.completed",
        module: "core.tool.executor",
        status: "completed",
        toolCallId: canonicalToolCall.id,
        toolName: canonicalToolCall.name,
      });

      telemetry?.setOutputBytes(serialization.returnedBytes);
      telemetry?.setOutputTruncated(serialization.truncated);
      telemetry?.finishCompleted();
      return result;
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const failureHookResult = await runPostToolUseFailureHooks(
        deps,
        canonicalToolCall,
        executionInput,
        error,
        traceContext,
        options?.signal,
      );
      let result = createErrorResult(
        canonicalToolCall,
        error instanceof Error ? error : new Error(String(error)),
        durationMs,
      );
      const baseModelContent = result.error
        ? isToolHandlerFailureError(error) && typeof result.modelContent === "string"
          ? result.modelContent
          : result.error.message
        : undefined;
      if (failureHookResult.additionalContexts.length > 0 && baseModelContent) {
        result.modelContent = [
          baseModelContent,
          formatHookAdditionalContexts([
            ...preToolHookResult.additionalContexts,
            ...failureHookResult.additionalContexts,
          ]),
        ].join("\n\n");
      } else if (preToolHookResult.additionalContexts.length > 0 && baseModelContent) {
        result.modelContent = [
          baseModelContent,
          formatHookAdditionalContexts(preToolHookResult.additionalContexts),
        ].join("\n\n");
      }
      result = withAutomationCreateLimitTurnStop(result, {
        error,
        toolName: canonicalToolCall.name,
      });

      // Serialization or post_hook can still fail after a Skill resolves successfully; retain the resolved metadata
      // in the error event so a failed Skill agent_step can still be attributed to that skill.
      await emitToolCallError(
        deps,
        canonicalToolCall.id,
        traceContext,
        turnId,
        result.error,
        skillTelemetryMetadata,
      );

      deps.logger?.error(
        "Tool call failed",
        error instanceof Error ? error : new Error(String(error)),
        {
          ...traceContextToLogContext(traceContext),
          durationMs,
          event: "tool.call.failed",
          module: "core.tool.executor",
          status: "failed",
          toolCallId: canonicalToolCall.id,
          toolName: canonicalToolCall.name,
        },
      );

      if (options?.signal?.aborted || result.error?.type === CoreErrorType.ToolCancelled) {
        telemetry?.finishCancelled("abort_signal");
      } else {
        telemetry?.finishFailed(
          failureStage,
          errorCategoryForToolError(result.error?.type),
          // Pass the original exception only to Telemetry for controlled redaction; result.error is repackaged for the business protocol
          // and must not overwrite the source message/type/code in the Trace that identify the root cause.
          error,
        );
      }
      return result;
    } finally {
      unlinkParentAbort();
    }
  } finally {
    lifetime?.release();
  }
}

function resolveModelOutputEntry(entry: ToolEntry, output: unknown): ToolEntry {
  const isSharedNodeRepl =
    entry.metadata.name === "mcp__node_repl__js" ||
    entry.metadata.mcpPresentation?.serverName === "node_repl";
  if (
    entry.modelContentProtection === OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION ||
    !isSharedNodeRepl ||
    !hasOfficialCuaFrameAuthority(output)
  ) {
    return entry;
  }
  return {
    ...entry,
    modelContentProtection: OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION,
    resultBudget: {
      ...entry.resultBudget,
      maxInlineBytes: Math.max(entry.resultBudget.maxInlineBytes, 256 * 1024),
      maxModelBytes: Math.max(entry.resultBudget.maxModelBytes, 256 * 1024),
      strategy: "truncate",
      preview: { direction: "head" },
    },
  };
}

function isEmptyToolName(toolName: string): boolean {
  return toolName.trim().length === 0;
}

function errorCategoryForToolError(type: string | undefined): AgentTelemetryErrorCategory {
  switch (type) {
    case CoreErrorType.ConfigurationError:
    case CoreErrorType.ToolNotFound:
      return "configuration";
    case CoreErrorType.PermissionDenied:
    case CoreErrorType.PermissionEscalation:
    case CoreErrorType.PermissionTimeout:
      return "permission";
    case CoreErrorType.InvalidInput:
      return "parse";
    case CoreErrorType.ToolCancelled:
      return "cancelled";
    case CoreErrorType.ToolTimeout:
      return "timeout";
    default:
      return "internal";
  }
}

function appendPreToolAdditionalContextsToErrorResult(
  result: ToolExecutionResult,
  additionalContexts: string[],
): ToolExecutionResult {
  if (result.success || !result.error || additionalContexts.length === 0) return result;

  // PreToolUse denial and permission denial return before the handler. Previously,
  // context was appended only on handler success/error paths, so the model could not see
  // additionalContext returned by the hook.
  const baseModelContent =
    typeof result.modelContent === "string" ? result.modelContent : result.error.message;
  return {
    ...result,
    modelContent: [baseModelContent, formatHookAdditionalContexts(additionalContexts)].join("\n\n"),
  };
}
