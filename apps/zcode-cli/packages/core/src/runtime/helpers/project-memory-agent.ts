import type {
  ExecutableToolCall,
  Model,
  ModelToolContract,
  ToolCall,
  ToolExecutionResult,
  TraceContext,
} from "../deps.js";
import type { AgentTelemetryCausation, ModelApiOperation } from "@zcode/contracts";
import {
  PermissionService,
  createChildTraceContext,
  createDenyPermissionBroker,
  createToolExecutor,
  defaultPermissionConfig,
  traceContextToLogContext,
} from "../deps.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import type { MemoryAgentLoopRequestUsage } from "../../memory/memory-agent-loop.js";
import type { ReadFileStateMap } from "../../tool/types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { getSessionShellSelectionFromConfig } from "../methods/session-shell-environment.js";
import { scheduleTools } from "../methods/tools.js";
import { prepareRuntimeProviderRequest } from "./runtime-provider-request-messages.js";
import { createRefreshRuntimeHeadersBeforeModelAttempt } from "../methods/model-runtime-headers.js";
import { createRuntimeModel, withModelInvocationContext } from "../methods/runtime-model.js";
import { recordModelUsageFact } from "../methods/usage-observability.js";

export interface ProjectMemoryAgentContext {
  causation?: AgentTelemetryCausation;
  memoryRoot: string;
  providerEntries: readonly RuntimeMessageEntry[];
  midConversationSystem: AgentRuntimeInternal["config"]["midConversationSystem"];
  model: Model;
  operation: ModelApiOperation;
  readFileState: ReadFileStateMap;
  tools: readonly ModelToolContract[];
  traceContext: TraceContext;
  workingDirectory: string;
  workspaceRoot: string;
}

export function captureProjectMemoryAgentContext(
  runtime: AgentRuntimeInternal,
  input: {
    memoryRoot: string;
    /** Turn Model inherited by the Extraction that produced this work. */
    model?: Model;
    operation: ModelApiOperation;
    traceContext: TraceContext;
  },
): ProjectMemoryAgentContext {
  const baseModel =
    input.model ??
    createRuntimeModel(runtime, {
      selection: runtime.getSessionModelSelection(),
    });
  const model = withModelInvocationContext(baseModel, (request) => ({
    metadata: {
      ...traceContextToLogContext(input.traceContext),
      querySource: input.operation,
      // Extraction consumes the transcript; writing its own requests back to the same model-io
      // directory would occupy rollout slots in the background path and feed back into later
      // Extractions. Manual Dream is the exception: its model-io records are the data source for
      // the Model Trajectory pane, so Dream requests must be recorded.
      skipTranscript: input.operation !== "project_memory_dream",
    },
    modelCall: { operation: input.operation },
    refreshRuntimeHeadersBeforeAttempt: createRefreshRuntimeHeadersBeforeModelAttempt(runtime, {
      abortSignal: request.abortSignal,
      model,
      traceContext: input.traceContext,
    }),
    traceContext: input.traceContext,
  }));
  return {
    causation: runtime.agentTelemetry.captureCausation(),
    memoryRoot: input.memoryRoot,
    // Extraction consumes this shallow member snapshot across async boundaries and relies on RuntimeMessageEntry
    // remaining immutable after entering MessageHistory. Later changes must append, replace the whole collection, or use copy-on-write;
    // do not mutate shared entry/message/content objects in place, or scheduled Memory context will be corrupted.
    providerEntries: [...runtime.messageHistory.borrowReadOnlyRuntimeEntries()],
    midConversationSystem: runtime.config.midConversationSystem,
    model,
    operation: input.operation,
    readFileState: new Map(runtime.readFileState),
    // Memory's existing execution policy does not allow ToolSearch; historical references are downgraded in this request projection only.
    tools: runtime
      .getTools(model)
      .filter((tool) => tool.name !== "ToolSearch")
      .map((tool) => ({ ...tool })),
    traceContext: input.traceContext,
    workingDirectory: runtime.workingDirectory,
    workspaceRoot: runtime.workspaceRoot,
  };
}

/** The Memory Agent's initial entries: Main's provider entries plus the prompt. */
export function projectMemoryAgentEntries(
  context: ProjectMemoryAgentContext,
  prompt: string,
): RuntimeMessageEntry[] {
  // Same shape as prepareRuntimeProviderRequest appending the prompt, so the first-round request stays byte-identical.
  return [...context.providerEntries, { message: { role: "user", content: prompt } }];
}

/** Build the Memory request from entries with Main's renderer (MCS, merged tool_result, ToolSearch exposure, cache control). */
export function renderProjectMemoryAgentRequest(
  context: ProjectMemoryAgentContext,
  entries: readonly RuntimeMessageEntry[],
) {
  return prepareRuntimeProviderRequest(
    {
      config: { midConversationSystem: context.midConversationSystem },
    },
    {
      applyCacheControl: true,
      entries,
      model: context.model,
      tools: context.tools,
    },
  ).request;
}

/** The Memory Agent's tools run under Main's scheduling: concurrentSafe in parallel, the rest sequentially. */
export function createProjectMemoryAgentToolRunner(
  runtime: AgentRuntimeInternal,
  context: ProjectMemoryAgentContext,
) {
  const executor = createProjectMemoryAgentToolExecutor(runtime, context);
  return async (
    toolCalls: ExecutableToolCall[],
    options: { abortSignal?: AbortSignal },
  ): Promise<ToolExecutionResult[]> => {
    const schedule = await scheduleTools.call(runtime, toolCalls as ToolCall[]);
    const run = executor.executeSchedule(toolCalls, schedule, {
      signal: options.abortSignal,
      traceContext: context.traceContext,
    });
    for (;;) {
      const next = await run.next();
      if (next.done) return next.value;
    }
  };
}

function createProjectMemoryAgentToolExecutor(
  runtime: AgentRuntimeInternal,
  context: ProjectMemoryAgentContext,
) {
  return createToolExecutor({
    artifactStore: runtime.artifactStore,
    emitEvent: async () => {},
    executionPort: runtime.executionPort,
    fileSystemPort: runtime.fileSystemPort,
    getBashShellSelection: () => getSessionShellSelectionFromConfig(runtime.config),
    getMode: () => "yolo",
    getMemoryRoot: () => context.memoryRoot,
    getWorkingDirectory: () => context.workingDirectory,
    getWorkspaceRoot: () => context.workspaceRoot,
    imageProcessorPort: runtime.imageProcessorPort,
    pdfDocumentPort: runtime.pdfDocumentPort,
    maxConcurrency: runtime.config.toolConcurrency?.maxConcurrency,
    model: context.model,
    permissionBroker: createDenyPermissionBroker(),
    permissionService: new PermissionService(defaultPermissionConfig),
    // The Memory agent must inherit Reads completed by Main; otherwise provider context says the file was read,
    // but the Edit execution boundary rejects that same file, diverging from the baseline cloned tool context.
    readFileState: new Map(context.readFileState),
    registry: runtime.registry,
    runtimeScope: "main",
    sessionId: runtime.sessionId,
    sessionStore: runtime.sessionStore,
    skillPort: runtime.skillPort,
    traceContext: context.traceContext,
  });
}

/** One `model_usage` row per memory-agent request, attributed to the scheduling session. */
export async function recordProjectMemoryAgentModelUsageFact(
  runtime: AgentRuntimeInternal,
  context: ProjectMemoryAgentContext,
  request: MemoryAgentLoopRequestUsage,
  querySource: "dream" | "project_memory_extract",
): Promise<void> {
  await recordModelUsageFact(runtime, {
    attemptIndex: request.index,
    completedAt: request.completedAt,
    error: request.error,
    events: [],
    model: context.model,
    networkEventStartIndex: 0,
    querySource,
    result: request.result,
    startedAt: request.startedAt,
    status: request.status,
    toolCallCount: request.result?.toolCalls?.length,
    traceContext: createChildTraceContext(context.traceContext, {}),
  });
}
