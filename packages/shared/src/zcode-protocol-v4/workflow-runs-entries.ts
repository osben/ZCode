// ============================================================
// How birth facts are read: turning script-authored strings into an actor entry within wire limits
// ============================================================
// Split from workflow-runs-reducer.ts (the main file's max-lines gate), following the same
// precedent and discipline as -caps.ts / -eviction.ts / -started.ts: pure functions, no clock,
// no I/O.
//
// These limits are **safety limits**, not display budgets. Names and phase names are arbitrary
// strings assembled by script authors (`agent("reader-" + paths.join("+"))`,
// `phase("check " + file)`), and while the CLI does not validate outbound frames, the renderer
// strictly validates every frame — on 2026-09-04 a 131-character subagent name caused every frame
// (online / recovery / initial snapshot) in the parent session after that actor appeared to be
// rejected, and the subscription permanently failed with `fault.subscription.recoveryFailed`.
// So producers trim to schema limits and stay wire-legal forever; full values remain in the journal.

import { WORKFLOW_RUNS_LIMITS, type WorkflowRunActor } from "./workflow-runs.js";

/**
 * Create one actor entry. Both call sites must be **identical**: `actor-created` and the `node-dispatched`
 * activation with birth facts in workflow-runs-eviction.ts. The same subagent can arrive through either
 * path; different entries would not match during cold replay.
 *
 * `status` is a placeholder; the following `withDerivedWorkflowActorStatuses` recalculates it from node
 * and run terminal states.
 */
export function workflowActorEntry(
  ref: { siteId: string; ordinal: number },
  name: unknown,
  phaseName: string | undefined,
  sessionId: string | undefined,
  model: unknown,
): WorkflowRunActor {
  const bounded = boundedActorName(nonEmptyString(name));
  const canonical = boundedActorModel(nonEmptyString(model));
  return {
    siteId: ref.siteId,
    ordinal: ref.ordinal,
    ...(bounded === undefined ? {} : { name: bounded }),
    ...(sessionId ? { sessionId } : {}),
    ...(phaseName === undefined ? {} : { phaseName }),
    ...(canonical === undefined ? {} : { model: canonical }),
    status: "waiting",
  };
}

/**
 * Wire limit for subagent models: oversized values are **dropped entirely** rather than
 * truncated — a truncated canonical string would name a different (nonexistent) model, which is
 * a lie when rendered; absence merely falls back to the "runs on the run's subagent model" slot.
 */
function boundedActorModel(model: string | undefined): string | undefined {
  return model === undefined || model.length > WORKFLOW_RUNS_LIMITS.maxSubagentModelLength
    ? undefined
    : model;
}

/** Wire limit for subagent display names (see the subscription failure described at the file top). */
export function boundedActorName(name: string | undefined): string | undefined {
  return name === undefined ? undefined : name.slice(0, WORKFLOW_RUNS_LIMITS.maxActorNameLength);
}

/**
 * Wire limit for an instance's birth phase name (docs/dynamic-workflow/presentation.md). It
 * follows {@link boundedActorName} for the same reason, but **truncates directly without an
 * ellipsis**: this is a correlation key, not user-facing text, and the UI's `phaseNameMatches`
 * matches the truncated name to a display phase by prefix.
 */
export function boundedPhaseName(name: string | undefined): string | undefined {
  return name === undefined ? undefined : name.slice(0, WORKFLOW_RUNS_LIMITS.maxPhaseNameLength);
}

/**
 * Wire reading of session ids: non-empty strings within the limit are accepted as-is; everything
 * else is treated as absent. **No truncation** — for the same reason as the subagent model
 * string, a shortened id points to a different session; better to not recognize it at all.
 */
export function boundedSessionId(value: unknown): string | undefined {
  const text = nonEmptyString(value);
  return text !== undefined && text.length <= WORKFLOW_RUNS_LIMITS.maxSessionIdLength
    ? text
    : undefined;
}

/** Treat an empty string as absent; on the wire, the protocol has only two states: key present or key absent. */
export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Isomorphic to the engine's `InstanceRef` / `ActorRef`: site id × ordinal. Missing either makes it unaddressable; return null. */
export function workflowInstanceRef(value: unknown): { siteId: string; ordinal: number } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const siteId = nonEmptyString(record.siteId);
  const ordinal = record.ordinal;
  if (siteId === undefined || typeof ordinal !== "number") return null;
  return { siteId, ordinal };
}
