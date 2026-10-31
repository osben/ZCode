import {
  modelDescriptorOf,
  withExternalAgentTurnDriverOf,
  type ModelRequestSessionType,
  type ModelRetryBudget,
} from "@zcode/contracts";
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
import { getOffPeakModelBinding } from "../off-peak/model-binding.js";
import { readSessionFeatures } from "../session-features/contract.js";

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
  const model = withRuntimeInvocationLayer(
    runtime,
    runtime.modelFactory({ ...factoryInput, selection: factoryInput.selection }),
    scope === "workspace"
      ? "other"
      : resolveModelRequestSessionTypeFromTaskType(runtime.config.taskType),
    retryBudget,
    // Workspace-scoped requests borrow the runtime of some session in that workspace and must not carry its capability tags.
    scope !== "workspace",
  );
  return getOffPeakModelBinding(input.requestDependencies)?.wrap(model) ?? model;
}

/**
 * Runtime-layer invocation context.
 *
 * The admission port and retry budget answer "who is calling" (which governor owns this runtime and how many retries are allowed), not
 * "why it is calling" (agent step / web_search / compact / title). The design gap was that if they were injected only into turn-step
 * invocation context, all nine call sites that set only "why" (WebSearch / WebFetch handling / compaction / title sidecar, etc.) bypassed the gate—
 * in observed cases the governor missed two-thirds of 429s. These fields are now bound once in the handle
 * factory as a host layer (see `withHostInvocationLayer`): it takes precedence over call sites, with no per-call opt-out:
 * a runtime that should not use the gate simply has no admission port.
 */
function withRuntimeInvocationLayer(
  runtime: AgentRuntimeInternal,
  model: Model,
  sessionType: ModelRequestSessionType,
  retryBudget: ModelRetryBudget | undefined,
  includeSessionFeatures: boolean,
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
  // Session capability tags are added mid-session, while the turn model and the parent handle reused by subagents
  // live long, so read the owner's current set on every call instead of snapshotting it at handle creation. Write
  // undefined explicitly so the call site cannot carry in a different value.
  return withHostInvocationLayer(model, "runtime", () => {
    const features = includeSessionFeatures ? readSessionFeatures(runtime) : [];
    return {
      ...layer,
      modelRequestSessionFeatures: features.length === 0 ? undefined : features,
    };
  });
}

const HOST_INVOCATION_LAYERS = Symbol("zcode.hostInvocationLayers");

type HostInvocationLayerKind = "runtime" | "turn";

type HostTaggedInvocationContext = ModelInvocationContext & {
  [HOST_INVOCATION_LAYERS]?: Readonly<Partial<Record<HostInvocationLayerKind, ModelInvocationContext>>>;
};

/**
 * Bind fields owned by the runtime that executes the request (spec: subagent-inherited-model-invocation-context).
 *
 * A subagent reuses the parent's Active Model handle, which already carries the parent's host layers. Plain
 * `withModelInvocationContext` lets inner layers overwrite outer ones, so the parent's layer used to replace the
 * child's session type (`main` instead of `subagent`) on every inherited child request. The outermost host
 * layer of a kind is the executing runtime: it records its values in the context of this call chain, and inner
 * layers of the same kind re-assert them instead of their own. The record is a symbol key, so object spread and
 * the async-iterator context restore carry it, and adapters never see it as a request field.
 */
export function withHostInvocationLayer(
  model: Model,
  kind: HostInvocationLayerKind,
  createLayer: (request: ModelRequest) => ModelInvocationContext,
): Model {
  return withModelInvocationContext(model, (request): HostTaggedInvocationContext => {
    const bound = (getCurrentModelInvocationContext() as HostTaggedInvocationContext | undefined)?.[
      HOST_INVOCATION_LAYERS
    ];
    const outer = bound?.[kind];
    if (outer) return outer;
    const layer = createLayer(request);
    return { ...layer, [HOST_INVOCATION_LAYERS]: { ...bound, [kind]: layer } };
  });
}

export function withModelInvocationContext(
  model: Model,
  createContext: (request: ModelRequest) => ModelInvocationContext,
): Model {
  // A marker Model for an external agent carries its turn driver on a symbol key; the wrapper keeps it
  // so the turn path still recognizes the model after invocation-context layering.
  const wrapped: Model = {
    ...modelDescriptorOf(model),
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
  return Object.freeze(withExternalAgentTurnDriverOf(model, wrapped));
}
