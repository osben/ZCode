// ============================================================
// AgentRuntime-backed WorkflowDriver: pure helpers
// ============================================================
// workflow-driver.ts reached oxlint's max-lines limit (400 lines), so pure functions and constants
// that do not touch driver state moved here (deferred, actor session ID generation, escalation
// budget and qid fragments, nudge/schema epilogues, decision/stat mapping, turn-failure
// normalization). The public API (mintActorSessionId) is still exported from workflow-driver.ts.

import {
  CoreErrorType,
  createSessionId,
  type SessionId,
  type SubmitVerdict as ContractsSubmitVerdict,
  type SubmitViolation,
} from "@zcode/contracts";
import type { TurnResult } from "@zcode/core";
import {
  refToString,
  WorkflowError,
  type ActorRef,
  type AskStats,
  type InstanceRef,
  type PersonaSpec,
  type Violation,
  type WorkflowReportSink,
} from "@zcode/dynamic-workflow";
import type { ActorToolCounts } from "./workflow-driver-tool-activity.js";
import type { Deferred, SessionState } from "./workflow-driver-types.js";

export function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Actor session ID: run-scoped and safe for the allowed character set.
 *
 * The old `createSessionId("wf-actor-" + refToString(actor))` had two flaws: it omitted runId, so
 * actors with the same site × ordinal in concurrent runs collided; and it included `#`/`@`
 * (`refToString` looks like `actor#1@1`), even though session IDs appear in URLs, file paths, and logs.
 */
/**
 * Actor session ID: run-scoped and safe for the allowed character set.
 *
 * **The export is intentional**: progress projection needs the session ID on `actor-created`
 * events (Boundary C does not include it), and `(runId, actorRef) -> session ID` must have one
 * implementation. Computing it separately in two places could eventually produce different IDs,
 * making the detail page open a nonexistent session. The run service calls this function (tests
 * assert both sides match).
 */
export function mintActorSessionId(runId: string, actor: ActorRef): SessionId {
  return createSessionId(
    `dwf-${sanitizeIdSegment(runId)}-${sanitizeIdSegment(refToString(actor))}`,
  );
}

/**
 * Fold any string into `[A-Za-z0-9.\-_]`, using `_` only as escaped output.
 *
 * **Two steps, in contractual order**: first escape literal `_` as `__`, then map characters
 * outside `[A-Za-z0-9.-]` to a single `_`. Reversing the order breaks escaping (underscores
 * produced by step two would be escaped again by step one). Underscores produced by step one pass
 * unchanged through step two, so the steps can be safely chained.
 *
 * Why escape: without it, `my_actor#1` and `my#actor#1` both fold to `my_actor_1`, a real collision.
 * A plain allowlist is collision-free only if the site-ID vocabulary contains no `_`, and that
 * vocabulary belongs to the analyzer, not this file. Escaping replaces dependence on another
 * module's vocabulary with a property that can be proven locally.
 *
 * Remaining (smaller) assumption: two **different** special characters still map to `_`, so
 * hypothetical `a#b` and `a@b` would collide. In current and foreseeable site IDs, special
 * characters occur in fixed positions (`actor#N@M`, site-specific `kind#N/M`), so this pair does
 * not arise. Eliminating the assumption entirely would require a distinct encoding per special character.
 */
function sanitizeIdSegment(value: string): string {
  return value.replace(/_/g, "__").replace(/[^A-Za-z0-9.-]/g, "_");
}

/**
 * Maximum number of escalations within one ask (same family as the nudge budget).
 *
 * Exceeding the limit is **a policy, not an error**: the fourth call returns an ordinary result
 * telling the model to proceed using its best judgment. Escalations do not write dwf_node rows
 * (waiting is not work), so this counter is the sole limit.
 */
export const MAX_ESCALATIONS_PER_ASK = 3;

/** Tool result returned to the model when the budget is exhausted (ordinary result, not an error). */
export const ESCALATION_BUDGET_EXHAUSTED =
  `Escalation budget exhausted: at most ${MAX_ESCALATIONS_PER_ASK} escalations per task. ` +
  "Do not call escalate again. Proceed on your best judgement with the information you have, " +
  "and state in your final result the assumptions you relied on and the doubts that remain.";

/** Candidate sequence of qid fragments, from shortest to longest, with the full runId last. */
export function questionIdFragments(runId: string): string[] {
  // The `dwfrun-` prefix is identical for every run; keeping it lengthens qid without making it more distinctive.
  const body = runId.startsWith("dwfrun-") ? runId.slice("dwfrun-".length) : runId;
  const full = sanitizeIdSegment(body);
  const candidates = [full.slice(0, 8), full.slice(0, 16), full];
  // For short runIds, all three candidates may collapse to the same string; deduplicate to avoid redundant lookups.
  return [...new Set(candidates)];
}

/**
 * Actor's **effective name**: use `persona.name` directly; absent or empty means anonymous.
 *
 * No need to normalize again here: the driver receives the persona already produced by the engine's
 * `normalizePersona` (the scheduler passes `actor.persona` unchanged to `createActorSession`), so
 * `spec.name` is the effective name determined by the engine. It is used for the `actor-created`
 * event name, amend-resume cache identity key, and DuplicateActorName deduplication key.
 *
 * **Deliberately do not trim**, unlike {@link normalizeEscalationContext}: the engine's anonymous
 * check is `name !== undefined && name !== ""` (createActor in engine.ts), so an actor named `"  "`
 * is **named** to the engine and occupies a cache identity key. Trimming it to anonymous here would
 * give the same actor two answers to "does it have a name?"—the name identifies the asker in
 * escalation records. Follow the engine's rule.
 */
export function effectiveActorName(persona: PersonaSpec): string | undefined {
  const name = persona.name;
  return name === undefined || name === "" ? undefined : name;
}

/** Optional context for `escalate`: whitespace means absent (the model often sends an empty string, which is noise in events). */
export function normalizeEscalationContext(context: string | undefined): string | undefined {
  const trimmed = context?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

/** Nudge prompt asking the model to submit when the turn ended without a submission. */
export const NUDGE_PROMPT =
  "You ended your turn without submitting a result. Call the submit_result tool now with a payload conforming to the required schema.";

/**
 * Schema epilogue for a typed ask: append it to the instructions, telling the model to submit a
 * schema-conforming result through submit_result. Format (this comment is the contract): separator
 * + one sentence requesting a tool call + JSON Schema indented by two spaces + one result constraint.
 * Do not say "exactly once"; the model may legitimately call submit_result more than once during a repair turn.
 */
export function schemaEpilogue(schema: unknown): string {
  const rendered = schema === undefined ? "(any JSON value)" : JSON.stringify(schema, null, 2);
  return [
    "",
    "",
    "---",
    "When you have finished, call the `submit_result` tool to submit your final result. Its `result` argument must be a JSON value conforming to this JSON Schema:",
    "",
    rendered,
    "",
    "Pass the conforming JSON as the `result` argument — do not wrap it or add commentary.",
  ].join("\n");
}

/**
 * Typed-ask epilogue for a mono subagent: the schema is already in the tool declaration, so only
 * the instruction "call the tool when done" remains. It shares the format skeleton (two blank lines
 * + separator) with {@link schemaEpilogue}; GUI epilogue collapsing uses boundary indices, not text,
 * so it is unaffected.
 */
export const TYPED_TOOL_EPILOGUE = [
  "",
  "",
  "---",
  "When you have finished, call the `submit_result` tool to submit your final result. Its `result` argument must match the tool's declared schema — pass the conforming JSON directly, do not wrap it or add commentary.",
].join("\n");

/** Engine Violation -> contracts SubmitViolation (same shape, 1:1). */
export function mapViolations(violations: readonly Violation[]): SubmitViolation[] {
  return violations.map((v) => ({ path: v.path, expected: v.expected, got: v.got }));
}

/** Construct a binary rejection (for driver-local interception, without going through the engine). */
export function rejectWith(message: string): ContractsSubmitVerdict {
  return {
    accept: false,
    violations: [{ path: "$", expected: message, got: "submit_result call" }],
  };
}

/**
 * Derive AskStats from TurnResult and observed tool activity. `tokens` is the only field the engine
 * depends on strongly (budget deduction); `turns` and both tool counts are recorded in the journal.
 * `toolCalls === 0` makes an ask **pure** and eligible for an import-cache hit after the cache
 * closes. `worldToolCalls` records whether it read or changed the external world. Protocol tools
 * (`submit_result`/`escalate`) are excluded or every typed ask would become non-pure simply by submitting its result.
 *
 * Counting used to look for ToolCallStarted in `result.events`, but TurnResult's event array does
 * not contain tool events: all 2,097 ask rows in the production journal had `toolCalls` = 0,
 * including subagents that clearly wrote files. If purity relied on that zero, every cached entry
 * would keep hitting after the cache closed, allowing exactly what closing the cache is meant to
 * prevent. The driver now counts from the **session event stream**, where tool calls actually
 * appear, accumulating them per ask before passing the values in.
 */
function statsFromTurn(result: TurnResult, toolCounts: ActorToolCounts): AskStats {
  const usage = result.usage;
  return {
    tokens: usage?.totalTokens ?? 0,
    toolCalls: toolCounts.toolCalls,
    turns: usage?.modelRequestCount ?? 1,
    worldToolCalls: toolCounts.worldToolCalls,
  };
}

/** Whether executeTurn rejected because of user/engine cancellation (normal termination, not a driver failure). */
export function isTurnCancelled(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { type?: unknown }).type === CoreErrorType.TurnCancelled
  );
}

/** Normalize any non-model-layer turn failure into a node-level WorkflowError (DriverError), preserving the original cause. */
export function toWorkflowError(error: unknown): WorkflowError {
  if (error instanceof WorkflowError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new WorkflowError("DriverError", `Subagent turn failed: ${message}`, { cause: error });
}

// ——————————— Model-side failure handling: constants and pure helpers ———————————

/** Maximum length of the provider's raw ProviderStop details (included in notifications and journal, so it must be bounded). */
export const PROVIDER_STOP_RAW_MESSAGE_MAX_CHARS = 2000;

/** Continuation prompt for transient re-drive (same mechanism as nudge: a new turn on the same persistent runtime). */
export const TRANSIENT_CONTINUE_PROMPT =
  "The previous model request failed transiently and was abandoned; continue from where you left off.";

const TRANSIENT_BACKOFF_BASE_MS = 2_000;
const TRANSIENT_BACKOFF_MAX_MS = 60_000;

/** Same backoff curve as runner: starts at 2s, doubles up to 60s, then applies [0.5, 1] jitter. */
export function transientBackoffMs(attempt: number, random: () => number = Math.random): number {
  const raw = Math.min(TRANSIENT_BACKOFF_MAX_MS, TRANSIENT_BACKOFF_BASE_MS * 2 ** (attempt - 1));
  return Math.round(raw * (0.5 + 0.5 * random()));
}

/** Read Retry-After from an adapter error (`context.retryAfterMs`, within one cause level) by shape. */
export function readRetryAfterMs(error: unknown): number | undefined {
  for (const candidate of [error, (error as { cause?: unknown } | undefined)?.cause]) {
    const context = (candidate as { context?: { retryAfterMs?: unknown } } | undefined)?.context;
    const value = context?.retryAfterMs;
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

/** Subagent label in notifications: use its name if present, otherwise `site@ordinal`. */
export function subagentLabel(state: Pick<SessionState, "actor" | "actorName">): string {
  return state.actorName ?? refToString(state.actor);
}

export const defaultSchedule = (callback: () => void, delayMs: number): (() => void) => {
  const timer = setTimeout(callback, delayMs);
  if (typeof timer === "object" && timer !== null && "unref" in timer) timer.unref();
  return () => clearTimeout(timer);
};

/**
 * Two facts reported to the engine when a turn resolves, in payload order:
 *   1. `askProgress` -> `node-progress`: which turn this ask reached, how many tools it used, and what it most recently did;
 *   2. `askStats` -> `usage-updated`: tokens spent in this turn (report once for accept/text/nudge).
 * Progress comes first, so anyone reading new usage has already seen the progress that produced it.
 * Keep both in one function so the ordering is explicit rather than split across two call-site lines.
 */
export function reportTurnObservations(
  sink: WorkflowReportSink,
  state: SessionState,
  instance: InstanceRef,
  result: TurnResult,
): void {
  sink.askProgress(instance, state.modelActivity.noteTurnResolved());
  sink.askStats(instance, statsFromTurn(result, state.modelActivity.toolCounts()));
}
