// ============================================================
// On-demand activation of the dynamic workflow tool surface (docs/dynamic-workflow/launch.md "On demand: activation")
// ============================================================
// A session in gradual-rollout mode `onDemand` is born without the ten workflow tools registered (the Agent / Task
// descriptions also lack the CreateWorkflow line) until this session first really needs them: the user types `/workflow`,
// the GUI presses Resume / configure on one of this session's runs, a saved workflow is launched directly from the hub,
// or a session whose record already contains workflows is resumed. Activation only adds, never removes:
// once a session has a run, the model keeps needing GetWorkflowRun and friends to receive notifications — compaction
// does not turn it off (contrast with the skill gate: that one asks "can the model still see it right now", this one asks "has this session ever had a workflow").
//
// The state owner is the runtime (dynamicWorkflowToolsActivated), not config: AgentRuntime copies
// config at construction, and the runtimeConfig object captured in the assembly-layer closure never sees the runtime flip.

import {
  SESSION_ENTRY_DYNAMIC_WORKFLOW_ACTIVATION,
  type MessageWithParts,
  type SessionEntryInfo,
  type SessionId,
  type TraceContext,
} from "@zcode/contracts";
import { traceContextToLogContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { AgentRuntimeConfig } from "../types.js";
import { isDynamicWorkflowToolName } from "../../tool/index.js";
import { refreshBranchAwareBuiltInTools } from "./embedded-search-branch.js";

/** Where the activation came from, recorded in the session entry for troubleshooting; behaviorally all four are equivalent. */
export type DynamicWorkflowActivationSource =
  | "command"
  | "run_control"
  | "resume_entry"
  | "resume_history";

export interface DynamicWorkflowActivationEntryData {
  activated: true;
  source: DynamicWorkflowActivationSource;
}

/**
 * Built-in `/workflow` command name (BUILTIN_WORKFLOW_COMMAND_NAME in bootstrap/src/builtin-workflow-command.ts).
 * core does not depend on bootstrap, so this is written as a literal from the reserved-word table; user messages persist `displayInput` — the command text as typed.
 */
const WORKFLOW_COMMAND_TEXT_PATTERN = /^\/workflow(?:\s|$)/i;

/** Sessions activated at birth: not onDemand (alwaysOn; TUI / headless / subagent never set the field). */
export function resolveInitialDynamicWorkflowToolsActivated(config: AgentRuntimeConfig): boolean {
  return config.dynamicWorkflowToolsOnDemand !== true;
}

/**
 * Activate this session's workflow tool surface. When already activated (including activated at birth) this is a no-op returning false.
 * Order: flip the state first, then re-register (the gate shared by both registration entry points reads exactly this state), then write the entry — re-registration
 * completes synchronously, so the first model request the caller issues after it returns necessarily carries the ten tools.
 */
export async function activateDynamicWorkflowTools(
  this: AgentRuntimeInternal,
  input: { source: DynamicWorkflowActivationSource; traceContext?: TraceContext },
): Promise<boolean> {
  if (this.dynamicWorkflowToolsActivated) return false;
  markDynamicWorkflowToolsActivated(this, input.source);
  // An entry write failure is only logged as warn, never rethrown. Reason: throwing used to make `/workflow` / Resume
  // error out even though the tool surface was already activated (add-only), after which every later call no-ops as
  // already-activated, producing "operation failed but state took effect". The entry is only a shortcut for cold-restore
  // history scanning — every activation source leaves a `/workflow` or CreateWorkflow call in the record,
  // and restoreDynamicWorkflowActivationOnResume falls back to history and backfills when the entry is missing.
  try {
    await persistDynamicWorkflowActivation(this);
  } catch (error) {
    this.logger?.warn("Dynamic workflow activation entry write failed", {
      ...traceContextToLogContext(input.traceContext ?? this.rootTraceContext),
      error: error instanceof Error ? error.message : String(error),
      event: "dynamic_workflow.activation_entry_write_failed",
      module: "core.runtime",
      sessionId: this.sessionId,
    });
  }
  this.logger?.info("Dynamic workflow tools activated", {
    ...traceContextToLogContext(input.traceContext ?? this.rootTraceContext),
    event: "dynamic_workflow.tools_activated",
    module: "core.runtime",
    sessionId: this.sessionId,
    source: input.source,
  });
  return true;
}

/**
 * Cold restore: decide from the entry or from history whether this session ever had workflows (launch.md "What activates", third row).
 * The history criterion covers two kinds of sessions: those born in alwaysOn that the Host later switched to onDemand, and
 * those persisted before this rule existed. It only has work to do when the runtime is not yet activated; messages is the full set of persisted
 * messages in the session store (including pre-rewind ones — "ever had" does not change with branches).
 */
export async function restoreDynamicWorkflowActivationOnResume(
  this: AgentRuntimeInternal,
  messages: readonly MessageWithParts[],
): Promise<void> {
  if (this.dynamicWorkflowToolsActivated) return;
  const entries = await this.sessionStore?.sessionEntries?.({
    sessionID: this.sessionId,
    type: SESSION_ENTRY_DYNAMIC_WORKFLOW_ACTIVATION,
  });
  const source: DynamicWorkflowActivationSource | undefined =
    entries !== undefined && entries.length > 0
      ? "resume_entry"
      : persistedMessagesShowDynamicWorkflow(messages)
        ? "resume_history"
        : undefined;
  if (source === undefined) return;
  markDynamicWorkflowToolsActivated(this, source);
  // Do not rewrite when the entry is already present; when detected from history, backfill one so the next restore
  // need not rescan. Written directly instead of going through persistDynamicWorkflowActivation: on resume,
  // sessionPersisted is only set at wrap-up, while a session being restored necessarily already exists in the store.
  if (source === "resume_history") await writeDynamicWorkflowActivationEntryIfActivated(this);
}

/** Whether the persisted messages contain a `/workflow` command or any call to one of the ten tools. */
export function persistedMessagesShowDynamicWorkflow(
  messages: readonly MessageWithParts[],
): boolean {
  for (const message of messages) {
    const role = message.info.role;
    for (const part of message.parts) {
      if (
        role === "user" &&
        part.type === "text" &&
        WORKFLOW_COMMAND_TEXT_PATTERN.test(part.text.trim())
      )
        return true;
      if (role === "assistant" && part.type === "tool" && isDynamicWorkflowToolName(part.tool))
        return true;
    }
  }
  return false;
}

/**
 * Backfill the entry on first persistence (ensureSessionPersisted in events.ts): when `/workflow` arrives as the
 * session's first turn, activation happens before the session is persisted, and at that moment persistDynamicWorkflowActivation has nowhere to write.
 */
export async function writeDynamicWorkflowActivationEntryIfActivated(
  runtime: AgentRuntimeInternal,
): Promise<void> {
  if (runtime.config.dynamicWorkflowToolsOnDemand !== true) return;
  if (
    !runtime.dynamicWorkflowToolsActivated ||
    runtime.dynamicWorkflowActivationSource === undefined
  )
    return;
  await runtime.sessionStore?.saveSessionEntry?.(
    buildDynamicWorkflowActivationEntry(runtime.sessionId, runtime.dynamicWorkflowActivationSource),
  );
}

export function buildDynamicWorkflowActivationEntry(
  sessionId: SessionId,
  source: DynamicWorkflowActivationSource,
): SessionEntryInfo {
  const timestamp = Date.now();
  const data: DynamicWorkflowActivationEntryData = { activated: true, source };
  return {
    id: `${sessionId}:runtime-dynamic-workflow-activation`,
    sessionID: sessionId,
    type: SESSION_ENTRY_DYNAMIC_WORKFLOW_ACTIVATION,
    touchSession: false,
    time: { created: timestamp, updated: timestamp },
    data,
  };
}

function markDynamicWorkflowToolsActivated(
  runtime: AgentRuntimeInternal,
  source: DynamicWorkflowActivationSource,
): void {
  runtime.dynamicWorkflowToolsActivated = true;
  runtime.dynamicWorkflowActivationSource = source;
  // Same entry point as branch refresh: it already re-registers all built-in tools through the shared gate (swapping
  // the Agent / Task descriptions back to the version with CreateWorkflow) and clears cachedTools.
  refreshBranchAwareBuiltInTools(runtime);
}

async function persistDynamicWorkflowActivation(runtime: AgentRuntimeInternal): Promise<void> {
  if (!runtime.sessionPersisted) return;
  await writeDynamicWorkflowActivationEntryIfActivated(runtime);
}
