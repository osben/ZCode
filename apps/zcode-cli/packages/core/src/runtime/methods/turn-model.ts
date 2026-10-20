import {
  ModelRetryBudget,
  SESSION_ENTRY_MODEL_SELECTION,
  type Model,
  type ModelSelection,
  type TraceContext,
  type TurnInputIntentMetadata,
} from "@zcode/contracts";
import { getCurrentModelInvocationContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { cloneModelSelection } from "../model-selection.js";
import { createRefreshRuntimeHeadersBeforeModelAttempt } from "./model-runtime-headers.js";
import { createRuntimeModel, withModelInvocationContext } from "./runtime-model.js";
import { applyRuntimeExecutionState } from "../execution-state.js";
import { acceptOffPeakUserTakeover, selectionForPersistence } from "../off-peak/runtime.js";

const selectionAdmissions = new WeakMap<
  AgentRuntimeInternal,
  {
    sequence: number;
    commandId: string;
    persisted: Promise<void>;
  }
>();
// 只用于 ModelSelected 的前后展示边界，不参与选模、续跑或持久化。
const publishedSelections = new WeakMap<AgentRuntimeInternal, ModelSelection | undefined>();

/** 先固定旧会话候选，再接纳用户选择；声明目标失效时仍能退回原会话模型。 */
export function captureHighspeedFallbackSelection(
  runtime: AgentRuntimeInternal,
  execution: import("../types.js").ModelExecutionContext | undefined,
): import("../types.js").ModelExecutionContext | undefined {
  if (!execution?.selectionFallback) return execution;
  return {
    ...execution,
    highspeedFallbackSelection: structuredClone(runtime.getSessionModelSelection()),
  };
}

export function recordPublishedModelSelection(
  runtime: AgentRuntimeInternal,
  selection: ModelSelection,
): void {
  publishedSelections.set(runtime, cloneModelSelection(selection));
}

/** 串行接纳序号决定续跑选择；队列消费只能执行自己的快照，不能倒写较新的选择。 */
export function acceptSubmissionModelSelection(
  runtime: AgentRuntimeInternal,
  intent: TurnInputIntentMetadata | undefined,
  _traceContext: TraceContext,
  modelExecution?: Pick<
    import("../types.js").ModelExecutionContext,
    "selectionScope" | "selectionFallback"
  > & {
    highspeedFallbackSelection?: ModelSelection;
  },
): Promise<void> {
  const selection =
    modelExecution?.selectionScope === "execution"
      ? (modelExecution.selectionFallback?.target ?? modelExecution.highspeedFallbackSelection)
      : intent?.modelSelection;
  if (!selection || !intent) return Promise.resolve();
  const previous = selectionAdmissions.get(runtime);
  if (
    previous &&
    (previous.commandId === intent.sourceCommandId ||
      (Number.isFinite(intent.admissionSeq) && intent.admissionSeq <= previous.sequence))
  ) {
    return previous.persisted;
  }
  const previousSelection = runtime.getSessionModelSelection();
  if (!publishedSelections.has(runtime)) publishedSelections.set(runtime, previousSelection);
  const appliedSelection = cloneModelSelection(selection);
  runtime.setSessionModelSelection(appliedSelection);
  acceptOffPeakUserTakeover(runtime);
  // 保存串行化，防止旧异步写入在新选择之后落库；不引入另一份输入队列。
  const persisted = (previous?.persisted ?? Promise.resolve()).then(async () => {
    // 新 Session 的 entry 由 ensureSessionPersisted 创建时统一写入，避免先写外键失败。
    if (runtime.sessionPersisted !== false)
      await persistRuntimeModelSelection(runtime, appliedSelection);
  });
  selectionAdmissions.set(runtime, {
    sequence: Number.isFinite(intent.admissionSeq)
      ? intent.admissionSeq
      : (previous?.sequence ?? 0),
    commandId: intent.sourceCommandId,
    persisted,
  });
  return persisted;
}

/**
 * An execution handle with a fallback declaration whose Selection points to that provider allows only one physical request: after failure, core falls back to the session model
 * for the rest of the turn. Letting the adapter retry with its default backoff budget would delay fallback by minutes (spec §2.2, “Accelerated requests: 0 retries”).
 * Return undefined for other handles so they use the default budget resolved from taskType.
 */
export function resolveExecutionModelRetryBudget(input: {
  selection: ModelSelection | undefined;
  selectionFallback: import("../types.js").ModelExecutionContext["selectionFallback"];
}): ModelRetryBudget | undefined {
  if (!input.selection || !input.selectionFallback) return undefined;
  return input.selection.providerId === input.selectionFallback.providerId
    ? ModelRetryBudget.SingleAttempt
    : undefined;
}

export function createTurnModel(
  runtime: AgentRuntimeInternal,
  options: {
    selection?: ModelSelection;
    requestDependencies?: import("@zcode/contracts").ModelRequestDependencies;
    retryBudget?: ModelRetryBudget;
  } = {},
): Model {
  const selection = options.selection ?? runtime.getSessionModelSelection();
  const model = createRuntimeModel(runtime, {
    selection,
    requestDependencies: options.requestDependencies,
    retryBudget: options.retryBudget,
  });
  return withModelInvocationContext(model, (request) => ({
    refreshRuntimeHeadersBeforeAttempt: createRefreshRuntimeHeadersBeforeModelAttempt(runtime, {
      abortSignal: request.abortSignal,
      model,
      traceContext: getCurrentModelInvocationContext()?.traceContext ?? runtime.rootTraceContext,
    }),
  }));
}

/**
 * Apply execution configuration when a Submission actually begins or when the next model step consumes a Guide.
 * The selection affects only newly created Models; Models already held by another Loop are not modified.
 */
export async function applySubmissionExecutionState(
  runtime: AgentRuntimeInternal,
  intent: TurnInputIntentMetadata | undefined,
  traceContext: TraceContext,
  modelExecution?: import("../types.js").ModelExecutionContext,
  preparedModel?: Model,
): Promise<Model | undefined> {
  const selection = intent?.modelSelection;
  let model = preparedModel;

  if (selection) {
    model ??= createTurnModel(runtime, {
      selection,
      requestDependencies: modelExecution?.requestDependencies,
      retryBudget: resolveExecutionModelRetryBudget({
        selection,
        selectionFallback: modelExecution?.selectionFallback,
      }),
    });
    await acceptSubmissionModelSelection(runtime, intent, traceContext, modelExecution);
    if (modelExecution?.selectionScope !== "execution") {
      // ModelSelected 展示实际 Loop 的切换；接纳只保存意图，不提前创建可调用 Model。
      const previousSelection = publishedSelections.get(runtime);
      publishedSelections.set(runtime, cloneModelSelection(selection));
      if (!sameModelSelection(previousSelection, selection)) {
        await runtime.emitModelSelected({
          model,
          modelSelection: selection,
          effectiveReasoningLevel: model.options.reasoningLevel,
          previousModelSelection: previousSelection,
          supportedThoughtLevels: model.optionSpecs.reasoningLevel.values,
          traceContext,
        });
      }
    }
  }

  if (intent?.mode !== undefined || intent?.planEnabled !== undefined) {
    await applyRuntimeExecutionState(runtime, intent, { source: "command", traceContext });
  }

  return model;
}

export function sameModelSelection(
  left: ModelSelection | undefined,
  right: ModelSelection,
): boolean {
  return (
    left?.providerId === right.providerId &&
    left.modelId === right.modelId &&
    left.options?.reasoningLevel === right.options?.reasoningLevel
  );
}

export async function persistRuntimeModelSelection(
  runtime: AgentRuntimeInternal,
  selection: ModelSelection,
): Promise<void> {
  if (!runtime.sessionStore?.saveSessionEntry) return;
  const persistentSelection = selectionForPersistence(runtime, selection);
  if (!persistentSelection) return;
  const timestamp = Date.now();
  try {
    await runtime.sessionStore.saveSessionEntry({
      id: `${runtime.sessionId}:runtime-model-selection`,
      sessionID: runtime.sessionId,
      type: SESSION_ENTRY_MODEL_SELECTION,
      touchSession: false,
      time: { created: timestamp, updated: timestamp },
      data: persistentSelection,
    });
  } catch (error) {
    runtime.logger?.warn("Session model selection persistence failed", {
      error: error instanceof Error ? error.message : String(error),
      event: "session.model_selection.persist_failed",
      modelId: selection.modelId,
      module: "core.runtime",
      providerId: selection.providerId,
      status: "failed",
      thoughtLevel: selection.options?.reasoningLevel,
    });
  }
}
