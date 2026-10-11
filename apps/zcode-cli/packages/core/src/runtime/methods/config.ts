import type {
  CollaborationMode,
  ExecutionShellSelection,
  Model,
  ModelSelection,
  ModelToolContract,
  PermissionBrokerRequest,
  ProjectId,
  SessionEvent,
  SessionEventSink,
  SessionEventStorePort,
  SessionId,
  SessionProjection,
  TraceContext,
  ToolExecutor,
  ToolRegistry,
  ContextBuilder,
} from "../deps.js";
import { isInspectablePermissionBroker, projectIdFromDirectory } from "../helpers/index.js";
import {
  deriveChildClientPorts,
  type ChildClientPortsContext,
  type ClientFacingPorts,
} from "../helpers/child-client-ports.js";
import type { AgentRuntimeConfig, ActiveTurnInfo } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { cloneModelSelection } from "../model-selection.js";
import { applyRuntimeExecutionState } from "../execution-state.js";

import { mirrorSubagentInteractionEvent } from "../../subagent/tool-event-mirror.js";
import { orderProviderVisibleToolContracts } from "../../tool/provider-visible-order.js";
import { projectToolModelContract } from "../../tool/model-contract.js";
import { rebuildContextPrefix } from "./context-refresh.js";
import { filterEmbeddedSearchRuntimeVisibleTools } from "./embedded-search-branch.js";
import {
  getSessionShellSelection as readSessionShellSelection,
  initializeSessionShellEnvironmentIfNeeded as initializeSessionShellEnvironment,
  type SessionShellEnvironmentCandidate,
} from "./session-shell-environment.js";

export async function setExecutionState(
  this: AgentRuntimeInternal,
  input: { mode?: string; planEnabled?: boolean },
  traceContext?: TraceContext,
): Promise<void> {
  await applyRuntimeExecutionState(this, input, { source: "command", traceContext });
}

export function updateConfig(
  this: AgentRuntimeInternal,
  patch: Pick<AgentRuntimeConfig, "mode" | "planEnabled" | "language" | "outputStyle">,
): void {
  if (patch.mode !== undefined || patch.planEnabled !== undefined) {
    const previous = resolveExecutionState(this.config);
    const next = resolveExecutionState(patch, previous);
    Object.assign(this.config, next);
    if (previous.planEnabled !== next.planEnabled)
      this.needsPlanModeExitReminder = !next.planEnabled;
  }
  if (patch.language !== undefined) {
    this.config.language = patch.language;
    if (!this.activeTurn) {
      rebuildContextPrefix(this);
    }
  }
  if ("outputStyle" in patch) {
    this.config.outputStyle = patch.outputStyle;
    if (!this.activeTurn) {
      rebuildContextPrefix(this);
    }
  }
}

export function initializeSessionShellEnvironmentIfNeeded(
  this: AgentRuntimeInternal,
  selection: SessionShellEnvironmentCandidate,
): boolean {
  return initializeSessionShellEnvironment(this, selection);
}

export function getSessionShellSelection(
  this: AgentRuntimeInternal,
): ExecutionShellSelection | undefined {
  return readSessionShellSelection(this);
}

export function getMode(this: AgentRuntimeInternal): CollaborationMode {
  return this.config.mode ?? "build";
}

export function getPlanEnabled(this: AgentRuntimeInternal): boolean {
  return resolveExecutionState(this.config).planEnabled;
}

export function getSessionModelSelection(this: AgentRuntimeInternal): ModelSelection | undefined {
  return this.sessionModelSelection && cloneModelSelection(this.sessionModelSelection);
}

export function setSessionModelSelection(
  this: AgentRuntimeInternal,
  selection: ModelSelection | undefined,
): void {
  // Recovery/config refresh may clear an invalid selection; an unbound session should not borrow the default model or affect the running Active Model.
  this.sessionModelSelection = selection && cloneModelSelection(selection);
}

export function getProjectId(this: AgentRuntimeInternal): ProjectId {
  // Bash cd can change the execution cwd, but project identity must not drift with a tool's cwd.
  return projectIdFromDirectory(this.workspaceRoot);
}

export function setWorkingDirectory(this: AgentRuntimeInternal, cwd: string): void {
  // Persisting Bash cwd should affect only the current runtime session, not workspace identity.
  this.workingDirectory = cwd;
}

export async function ensureSessionPersistedForExternalActivity(
  this: AgentRuntimeInternal,
  input: string,
  options?: { traceContext?: TraceContext },
): Promise<void> {
  await this.ensureSessionPersisted(input, options?.traceContext ?? this.rootTraceContext);
}

export function getActiveTurnInfo(this: AgentRuntimeInternal): ActiveTurnInfo | undefined {
  const activeTurn = this.activeTurn;
  if (!activeTurn) return undefined;
  return {
    kind: activeTurn.kind,
    ...(activeTurn.inputId === undefined ? {} : { inputId: activeTurn.inputId }),
    queueLength: activeTurn.pendingInputs.length,
    steerable: activeTurn.steerable,
    turnId: activeTurn.turnId,
  };
}

export function getTools(this: AgentRuntimeInternal, model?: Model): ModelToolContract[] {
  if (this.cachedTools === null) {
    this.cachedTools = filterRuntimeVisibleTools.call(this, this.registry.toContracts());
  }
  return this.cachedTools
    .filter((tool) => tool.name !== "WebSearch" || shouldExposeWebSearch.call(this, model))
    .map((tool) =>
      projectToolModelContract(tool, this.registry.get(tool.name), {
        model,
      }),
    );
}

export function invalidateToolCache(this: AgentRuntimeInternal): void {
  this.cachedTools = null;
}

export function getToolRegistry(this: AgentRuntimeInternal): ToolRegistry {
  return this.registry;
}

export function getToolExecutor(this: AgentRuntimeInternal): ToolExecutor {
  return this.executor;
}

export function subscribeEvents(this: AgentRuntimeInternal, sink: SessionEventSink): () => void {
  this.eventSinks.add(sink);
  return () => {
    this.eventSinks.delete(sink);
  };
}

/**
 * External child-runtime seam (1): expose this runtime's session event store.
 *
 * Child runtimes constructed outside the class (bootstrap's DWF actor / legacy script workflow) must share the parent's store.
 * Otherwise, child events would be written to a private store no one can read, and v4's `loadPersistedEvents(childSessionId)` would
 * always be empty, leaving the transcript permanently blank. Child events are still stored under their own sessionId; both sessions
 * coexist without overwriting each other in the shared store (same contract as `eventStore: this.eventStore` in `subagent.ts:280`).
 */
export function getSessionEventStore(this: AgentRuntimeInternal): SessionEventStorePort {
  return this.eventStore;
}

/**
 * External child-runtime seam (2): fan raw child-session events out to this runtime's external sink set.
 *
 * Semantics match `notifyEventSinks(event, {...trace, sessionId: childSessionId})` at `subagent.ts:338`: preserve child sessionId
 * (the protocol layer routes to the detached live session by it), notify only, and do not append.
 *
 * The child runtime must install this call as its `deps.eventSink` **during construction**: `ensureSessionPersistedForExternalActivity`
 * writes SessionTitleUpdated as sequenceNumber 1, and the v4 gateway drains only contiguous sequence numbers. A subscription added
 * after construction would start at seq 2 and wait forever for a seq 1 that will never arrive.
 */
export async function notifyExternalChildSessionEvent(
  this: AgentRuntimeInternal,
  input: {
    childSessionId: SessionId;
    event: SessionEvent;
    traceContext?: TraceContext;
    interactionOrigin?: ChildClientPortsContext;
  },
): Promise<void> {
  const traceContext = input.traceContext ?? this.rootTraceContext;
  // Notify only; never append. The child runtime has already stored this event under its own sessionId, and appending through the
  // parent runtime would duplicate it in the shared store.
  await this.notifyEventSinks(input.event, { ...traceContext, sessionId: input.childSessionId });
  if (input.interactionOrigin === undefined) return;
  // Root cause (observed on 2026-09-23): a guarded dwf actor's permission request reached desktop through the parent broker, but the V4
  // confirmation dialog is generated only from PermissionRequested projected in the **parent session**. The event existed only in the child session, so no dialog appeared and the actor waited forever.
  // Mirror interactions as for core subagents (the parent timeline does not receive tool activity); emit only, do not append.
  const mirrored = mirrorSubagentInteractionEvent(input.event, {
    ...input.interactionOrigin,
    parentSessionId: this.sessionId,
  });
  if (mirrored === undefined) return;
  await this.notifyEventSinks(mirrored, { ...traceContext, sessionId: this.sessionId });
}

/**
 * External child-runtime seam (3): create the child's **client-facing interaction** ports.
 *
 * A child runtime's ledger identity (child sessionId) is not an identity the protocol client can answer. DWF actors and legacy
 * workflow children used to get `providerRuntimeHeadersPort` / `permissionBroker` directly from `appOptions`, then ask Desktop as
 * `sess_dwf-…`. `requireSession` threw on the response path, no response was sent, and the child hung before its first model request
 * (eight subagents, 80 minutes with no events). Core's built-in subagent had two private wrappers; two of three assembly sites were
 * wrong, showing that a rule scattered across call sites will drift.
 *
 * Fix: centralize derivation in `deriveChildClientPorts`, callable only by the **parent runtime**. The parent supplies
 * `parentSessionId`, so callers cannot provide the wrong value. Every child runtime constructed outside the class (DWF actor, legacy
 * workflow child) must obtain its ports here.
 */
export function createChildClientPorts(
  this: AgentRuntimeInternal,
  context: ChildClientPortsContext,
): ClientFacingPorts {
  return deriveChildClientPorts(
    {
      ...(this.permissionBroker === undefined ? {} : { permissionBroker: this.permissionBroker }),
      ...(this.providerRuntimeHeadersPort === undefined
        ? {}
        : { providerRuntimeHeadersPort: this.providerRuntimeHeadersPort }),
    },
    { ...context, parentSessionId: this.sessionId },
  );
}

export function getContextBuilder(this: AgentRuntimeInternal): ContextBuilder {
  if (!this.contextBuilder) {
    this.contextBuilder = this.createContextBuilderFromSnapshot(
      this.createConfigOnlyContextSnapshot(this.workingDirectory),
      undefined,
      { persistEnvInfo: false },
    );
  }
  // This getter may expose the synchronous preview builder only; it must not initialize messageHistory.
  // Otherwise the first executeTurn would skip asynchronous context-source resolution and lose the actual workspace context.
  return this.contextBuilder;
}

export function getPendingPermissionRequests(
  this: AgentRuntimeInternal,
): PermissionBrokerRequest[] {
  if (!isInspectablePermissionBroker(this.permissionBroker)) return [];
  return this.permissionBroker.listPendingRequests();
}

export async function getProjection(this: AgentRuntimeInternal): Promise<SessionProjection> {
  return this.rebuildProjection();
}

export function getSessionId(this: AgentRuntimeInternal): SessionId {
  return this.sessionId;
}

function filterRuntimeVisibleTools(
  this: AgentRuntimeInternal,
  tools: ModelToolContract[],
): ModelToolContract[] {
  const visibleTools = filterEmbeddedSearchRuntimeVisibleTools(this, tools);
  // Provider-visible tool ordering belongs to the final output boundary; toolset determines only which tools are visible.
  return orderProviderVisibleToolContracts(visibleTools);
}

function shouldExposeWebSearch(this: AgentRuntimeInternal, model?: Model): boolean {
  // Calls without a Model enumerate the full registry only for persistence and UI metadata. Real execution always passes the current
  // Active Model and reads only its frozen, complete capability facts.
  if (!model) return true;
  return model.properties.supportsNativeWebSearch;
}
import { resolveExecutionState } from "@zcode/shared";
