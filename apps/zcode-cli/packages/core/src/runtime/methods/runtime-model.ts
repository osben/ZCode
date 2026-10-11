import type { ModelRequestSessionType, ModelRetryBudget } from "@zcode/contracts";
import {
  CoreErrorType,
  createCoreError,
  getCurrentModelInvocationContext,
  runWithModelInvocationContext,
  type Model,
  type ModelInvocationContext,
  type ModelRequest,
} from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RuntimeModelFactoryInput } from "../types.js";
import {
  resolveModelRequestSessionTypeFromTaskType,
  resolveModelRetryBudgetFromTaskType,
} from "./model-request-session-type.js";

export function createRuntimeModel(
  runtime: AgentRuntimeInternal,
  input: Omit<RuntimeModelFactoryInput, "selection"> & {
    selection: RuntimeModelFactoryInput["selection"] | undefined;
    scope?: "session" | "workspace";
    /**
     * Overrides the retry budget resolved from taskType; binds only to the handle created here and is not passed to Factory input.
     * Currently, only execution-scoped Selections with a selectionFallback declaration use single-attempt.
     */
    retryBudget?: ModelRetryBudget;
  },
): Model {
  const { retryBudget, scope = "session", ...factoryInput } = input;
  // A Session without a bound selection may restore history; reject a missing selection only at execution entry, while keeping the Factory contract strict.
  if (!factoryInput.selection) {
    throw createCoreError(CoreErrorType.ConfigurationError, "Select a model before continuing", {
      recoverable: true,
    });
  }
  return withRuntimeInvocationLayer(
    runtime,
    runtime.modelFactory({ ...factoryInput, selection: factoryInput.selection }),
    scope === "workspace"
      ? "other"
      : resolveModelRequestSessionTypeFromTaskType(runtime.config.taskType),
    retryBudget,
  );
}

/**
 * Runtime-layer invocation context.
 *
 * The admission port and retry budget answer "who is calling" (which governor owns this runtime and how many retries are allowed), not
 * "why it is calling" (agent step / web_search / compact / title). The design gap was that if they were injected only into turn-step
 * invocation context, all nine call sites that set only "why" (WebSearch / WebFetch handling / compaction / title sidecar, etc.) bypassed the gate—
 * in observed cases the governor missed two-thirds of 429s. These fields are now bound once in the handle
 * factory; merge order in `withModelInvocationContext` gives this layer precedence over call sites, with no per-call opt-out:
 * a runtime that should not use the gate simply has no admission port.
 */
function withRuntimeInvocationLayer(
  runtime: AgentRuntimeInternal,
  model: Model,
  sessionType: ModelRequestSessionType,
  retryBudget?: ModelRetryBudget,
): Model {
  const layer: ModelInvocationContext = {
    // Reason: title, Memory, and tool calls previously overwrote other based on purpose, losing the host's classification.
    // Bind session type consistently on the handle; independent workspace requests remain other even when they borrow the session runtime.
    modelRequestSessionType: sessionType,
    // Pass single-attempt explicitly for execution handles with fallback declarations; other handles keep the taskType default budget.
    modelRetryBudget: retryBudget ?? resolveModelRetryBudgetFromTaskType(runtime.config.taskType),
    ...(runtime.modelRequestAdmission === undefined
      ? {}
      : { modelRequestAdmission: runtime.modelRequestAdmission }),
  };
  return withModelInvocationContext(model, () => layer);
}

export function withModelInvocationContext(
  model: Model,
  createContext: (request: ModelRequest) => ModelInvocationContext,
): Model {
  const wrapped: Model = {
    providerId: model.providerId,
    modelId: model.modelId,
    displayName: model.displayName,
    properties: model.properties,
    optionSpecs: model.optionSpecs,
    options: model.options,
    bind(options) {
      return withModelInvocationContext(model.bind(options), createContext);
    },
    generateText(request) {
      return runWithModelInvocationContext(
        { ...getCurrentModelInvocationContext(), ...createContext(request) },
        () => model.generateText(request),
      );
    },
    streamText(request) {
      return runWithModelInvocationContext(
        { ...getCurrentModelInvocationContext(), ...createContext(request) },
        () => model.streamText(request),
      );
    },
  };
  return Object.freeze(wrapped);
}
