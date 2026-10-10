// ============================================================
// Dynamic Workflow Run Port - submit / inspect / cancel boundary for dwf engine runs
// ============================================================

import type {
  DynamicWorkflowRunHealth,
  DynamicWorkflowRunPhaseView,
  DynamicWorkflowRunSubagentView,
} from "./dynamic-workflow-run-roster.port.js";
import type {
  DynamicWorkflowRunRetuneRequest,
  DynamicWorkflowRunRetuneResult,
} from "./dynamic-workflow-run-retune.port.js";
import type {
  DynamicWorkflowRunWorkspaceNode,
  DynamicWorkflowRunWorkspaceNodeResult,
  DynamicWorkflowRunWorkspaceNodeResultQuery,
} from "./dynamic-workflow-run-workspace.port.js";
import type { DynamicWorkflowRunProgressPayload } from "../events/session.events.js";
import type { ModelSelection } from "../model/model.js";
import type { SessionId, ToolCallId } from "./shared.js";
import type { TraceContext } from "../tracing/tracer.js";
import type { WorkflowTaskSnapshot } from "./workflow.port.js";

/**
 * Submission request for one workflow run. Script text is the authoritative input (compilation,
 * site tables, schema synthesis, and lowering are all derived from it), so this carries only the
 * script and execution context, not compiled artifacts. "Compile once" happens in the port
 * implementation (run service); callers should not need to know about compiled artifacts.
 */
export interface DynamicWorkflowRunSubmitRequest {
  /** Workflow script source. Persisted byte-for-byte in dwf_run.script_text; resume relies on its hash. */
  scriptText: string;
  /** Run working directory (sandbox subprocess cwd and world-read root). */
  cwd: string;
  /**
   * Run display name (optional `input.name` in `CreateWorkflow`). Stored in `dwf_run.name` for
   * use as a label in listings. Display metadata only: does not affect execution or resume
   * validation. Omitted means unnamed (readers fall back to the script's first line).
   */
  name?: string;
  /**
   * Arguments for this run (declarative parameters of a saved workflow, already validated
   * against the declaration and filled with defaults by the tool layer).
   *
   * Unlike `name`, this is **not** display metadata: it is stored in `dwf_run.args_json` and
   * injected into the sandbox as the script-readable `args` global. It is part of the run's
   * identity; resume replays these stored arguments and never accepts new ones. Inline scripts
   * have no arguments, so an omitted field means `{}`.
   */
  args?: Record<string, unknown>;
  /** Session that started this run; engine events are projected back to it. */
  parentSessionId?: SessionId | string;
  /** CreateWorkflow tool call that started this run (link from the tool card to its detail page). */
  toolCallId?: ToolCallId | string;
  /**
   * inputId of the turn that started the run: the subagent's `agent_step` is associated with this
   * message. Only direct hub launches set it (`startSavedWorkflowRun` creates the UUID v7 shared
   * with the controlOnly launch turn); chat launches omit it, and the run service resolves it
   * from the parent runtime's active turn.
   */
  launchInputId?: string;
  /**
   * Declared phase table for the script (named phases in the causal graph, in declaration order,
   * ≤ 32 × 128; `createWorkflowPhaseNames`). The engine records it with the anchor in
   * `run-launched`, and sessions-index projection uses it to show upcoming stops on the sidebar
   * mini-track. Display metadata only: does not affect execution or resume validation; omitted
   * when the script has no `phase()` markers.
   */
  phaseNames?: string[];
  /**
   * This run's concurrency limit: number of asks in flight at once. Stored in
   * `dwf_run.caps_max_concurrency` and reused by resume. **Omitted means the ceiling** (derived
   * from the machine by `resolveWorkflowConcurrencyCeiling`); a supplied value is clamped to
   * `[1, ceiling]` and can only lower concurrency, never raise it. The tool layer already clamps
   * in `resolveInput` so the confirmation dialog can show the effective value; clamping here
   * again is the port's own contract.
   */
  maxConcurrency?: number;
  /**
   * Model used by this run's subagents. The canonical value recorded in journal event
   * `run-launched` is authoritative and reused by resume; **omitted means inherit the model of
   * the session that started the run**.
   *
   * Accept a structured {@link ModelSelection}, not a string: the tool layer has **already**
   * resolved the user's name through the model catalog (an unresolvable name returns before
   * the confirmation dialog). The port must not match names again, which would create two
   * answers to where resolution happens. The main agent is unaffected and stays on the
   * session's model.
   */
  subagentModel?: ModelSelection;
  /**
   * Absolute path of the file **from which this run's script came**. Same treatment as
   * {@link subagentModel}: recorded once in `run-launched`, never read by the engine, and never
   * stored in SQL (there is no column for it in `dwf_run`); both read surfaces recover it from
   * the event.
   *
   * ⚠ Unrelated to `sourcePath` on artifacts in this file: that is where an artifact was saved;
   * this is where the **script** lives.
   *
   * Omitted means this run has no editable script file (for example, the project cannot write a
   * draft or the run predates this feature), so the model falls back to the usual "edit the
   * script and submit it inline." Model-facing metadata only; Desktop and TUI do not display it.
   */
  scriptPath?: string;
  /**
   * "Running alongside" table (`createWorkflowPhaseAlongside`), **positionally aligned** with
   * {@link DynamicWorkflowRunSubmitRequest.phaseNames}: `phaseAlongside[i]` contains the
   * **indexes** of other phases whose strands are still running when entering
   * `phaseNames[i]` (indexes refer to the same `phaseNames` array). The sidebar mini-track uses
   * this to draw parallel stops as a double line.
   *
   * Same treatment as `phaseNames`: display metadata only, recorded with the anchor in
   * `run-launched`, and not read by the engine. Omitted when no phases run in parallel (omission
   * means "this track is a straight line").
   */
  phaseAlongside?: number[][];
  trace: TraceContext;
}

export interface DynamicWorkflowRunSubmitOptions {
  signal?: AbortSignal;
}

/**
 * Result of submit. Success returns only runId: it is also the backgroundTaskId and the
 * workId for cancelBackgroundWork (`runId ≡ taskId ≡ workId`), so the three paths need no
 * separate identity maps. A brand-new run has no business refusal case; wiring failures
 * (corrupt compiled artifacts, unavailable journal) still throw.
 */
export type DynamicWorkflowRunSubmitResult = { ok: true; runId: string };

/**
 * Request for {@link DynamicWorkflowRunPort.amend}.
 *
 * Amendment means **supersede**: create a **new run** from the new script and import the
 * predecessor journal's cache of each named actor's completed ask prefix and world nodes. The
 * predecessor **may still be running**—that is why this method exists. The service stops it,
 * waits for settlement, imports the cache, and starts the new run in one call. The model no
 * longer needs three steps (TaskStop + polling + resubmitting).
 * Independent of `scriptText`: the amended run declares its script again; arguments (which
 * exist only for saved sources) are not passed along.
 */
export interface DynamicWorkflowRunAmendRequest {
  scriptText: string;
  cwd: string;
  /** Predecessor run being amended, in any state. */
  predecessorRunId: string;
  /** Display name for the new run; service reuses the predecessor's name when omitted. */
  name?: string;
  parentSessionId?: SessionId | string;
  /** AmendWorkflow tool call that started this amendment (link from the new run's tool card to its detail page). */
  toolCallId?: ToolCallId | string;
  /** Declared phase table for the **new script**; same semantics as {@link DynamicWorkflowRunSubmitRequest.phaseNames}. */
  phaseNames?: string[];
  /**
   * Concurrency limit for the new run; same semantics as
   * {@link DynamicWorkflowRunSubmitRequest.maxConcurrency} (omitted means the ceiling).
   * "Omitted means reuse the predecessor; `null` means remove the limit" is a three-state
   * **tool-surface** rule normalized to a number or omission by `AmendWorkflow.resolveInput`.
   * This rule must live before the handler so the confirmation dialog can show the inherited value.
   */
  maxConcurrency?: number;
  /**
   * Subagent model for the new run; same semantics as
   * {@link DynamicWorkflowRunSubmitRequest.subagentModel} (omitted means inherit the session
   * model). "Omitted means reuse the predecessor; `null` means clear" is a three-state
   * **tool-surface** rule normalized, with one re-resolution, to a selection or omission by
   * `AmendWorkflow.resolveInput`.
   */
  subagentModel?: ModelSelection;
  /**
   * Absolute path of the file from which the **new script** came; same semantics as
   * {@link DynamicWorkflowRunSubmitRequest.scriptPath}.
   *
   * Unlike concurrency limit and subagent model, it has **no three-state behavior**: the
   * amendment always records the source file for this amendment's script (`path` submission
   * uses that file; inline submission uses the draft just written). Never reuse the
   * predecessor's path; it points to the **old script**, and recording it on the new run would
   * send the model to edit a file that is no longer running.
   */
  scriptPath?: string;
  /**
   * "Running alongside" table for the **new script**; same semantics as
   * {@link DynamicWorkflowRunSubmitRequest.phaseAlongside} (indexes refer to this request's
   * `phaseNames`, not the predecessor's table).
   */
  phaseAlongside?: number[][];
  /**
   * Arguments persisted for the predecessor (`dwf_run.args_json`) and reused by the new run.
   * Omitted means the amendment has no arguments (tool-path contract is unchanged).
   * Only GUI "Configure" passes this: it reruns the predecessor's own script, which reads the
   * arguments supplied when the predecessor started. Without reusing them, a saved workflow
   * with arguments launched from the hub would rerun with empty `args`.
   */
  inheritArgs?: true;
  trace: TraceContext;
}

/**
 * Structured reason an amend was refused. These imply **different next steps** for the model
 * (use another run id / abandon the amendment and create a fresh run), so they must be
 * distinguishable. Actionable wording belongs in the tool layer; the port carries only the
 * discriminant.
 *
 * There is no "predecessor still running" refusal: a running predecessor is stopped rather than
 * rejected. This removes the old `not_amendable` case and the resulting race of "stop, poll
 * until stopped, then submit again."
 *
 * **Refusal has zero side effects**: preflight completes **before** stopping the predecessor.
 * A refusal creates no dwf_run row or registry entry, and the predecessor keeps running.
 */
export type DynamicWorkflowRunAmendRefusalReason =
  /** The predecessor run does not exist in the journal. */
  | "run_not_found"
  /** The predecessor has a completed ask without message-boundary accounting, so its transcript cannot be safely imported (reject the whole amendment, with no fallback). */
  | "missing_boundaries";

export type DynamicWorkflowRunAmendResult =
  | {
      ok: true;
      runId: string;
      /** Present with the predecessorRunId when this amendment stopped a running predecessor; omitted if the predecessor had already settled. */
      supersededRunId?: string;
    }
  | { ok: false; reason: DynamicWorkflowRunAmendRefusalReason };

/**
 * Initiator of cancellation. `user` / `model` identify the two stop entry points; `{ superseded }`
 * is passed when the amend path stops a running predecessor. The new run id is persisted with
 * the reason in the predecessor's settlement data (`supersededBy`).
 */
export type DynamicWorkflowRunCancelInitiator = "user" | "model" | { superseded: string };

/**
 * Run snapshot: reuses the shape of {@link WorkflowTaskSnapshot} (read by the background task
 * tracker and notification pipeline), relaxing only `output`. A workflow run's artifact is the
 * script's top-level return value, whose shape is determined by the script; it is not the
 * legacy `Workflow` tool's output type. The legacy port is not widened; the two workflow
 * mechanisms do not share a port.
 *
 * `reports` are the original progressive artifacts emitted by the script's `report(item)`, in
 * report order, from journal node rows with `kind = "report"`—the durable home for these
 * entries (`workflowRuns.reports` is only a bounded memory-only display surface). Completion
 * notifications return them for completed / failed / cancelled runs alike: a run that died on
 * ask 12 still completed the work from 11 asks; retrieving that work is why `report` exists.
 */
export type DynamicWorkflowRunSnapshot = Omit<WorkflowTaskSnapshot, "output"> & {
  output?: unknown;
  /**
   * The run's actual terminal status. The base `status` uses the background task tracker's
   * generic vocabulary (`stopped` becomes `cancelled`, `errored` becomes `failed`).
   * Notifications and tool text must read these fields to report accurately; `stopReason` is
   * present only when `runStatus === "stopped"`.
   */
  runStatus?: DynamicWorkflowRunLifecycleStatus;
  stopReason?: DynamicWorkflowRunStopReason;
  /** Session that started this run (journal parent_session_id; use the registry entry when present). */
  parentSessionId?: string;
  /** Run this one was amended from; omitted when it is not an amendment. */
  resumedFrom?: string;
  /** Amendment that stopped and replaced this run; omitted if it was not replaced. */
  supersededBy?: string;
  /**
   * This run's concurrency limit (`dwf_run.caps_max_concurrency`), **present only when below
   * the current ceiling**. A run at the ceiling has nothing to report (omission means none, as
   * with `reports`). `AmendWorkflow.resolveInput` uses it to determine what to reuse when
   * `max_concurrency` is omitted.
   */
  maxConcurrency?: number;
  /**
   * Subagent model for this run (recorded in journal event `run-launched`), in canonical form
   * `providerId/modelId[$reasoningLevel]`, **present only when explicitly set**. A run that
   * inherited the session model has nothing to report (omission means none, as with
   * `maxConcurrency`).
   * This is a string rather than {@link ModelSelection}: readers only display it or pass it
   * through unchanged; no one reads individual fields.
   */
  subagentModel?: string;
  /**
   * Script file for this run (absolute path recorded in journal event `run-launched`).
   * **Present only when a file was recorded for this run.**
   *
   * Terminal notifications use this to replace "edit the script and submit inline" with "edit
   * that file in place, then amend by `path`", so it must be available in the snapshot. Never
   * display it to users (unlike `subagentModel`, which appears in the Desktop run panel).
   */
  scriptPath?: string;
  /** Structured failure (same source as {@link DynamicWorkflowRunDetail.error}); the base `error` is its message. */
  failure?: DynamicWorkflowRunError;
  /**
   * **Active** duration in milliseconds for this run and its lineage: sum the active time of
   * this run and every predecessor, excluding gaps between generations. This is the duration
   * shown in the completion card's "time" field.
   *
   * Like `reports` / `artifacts`, **present only for terminal runs** (`getTask` is polled
   * repeatedly, while consumers only receive terminal notifications). Omit the whole field,
   * rather than returning 0, when the journal cannot provide it. Readers then fall back to
   * `completedAt − startedAt`: the duration observed by the process that settled the run, a
   * more conservative answer that never overstates activity.
   */
  activeDurationMs?: number;
  reports?: readonly unknown[];
  /**
   * Escalation question currently parked on this run, waiting for the main agent's answer.
   *
   * **Projected from the in-memory registry, not journal replay**: the journal has
   * `escalation-raised` and `escalation-resolved` events, but "who is still waiting for an
   * answer" is a live in-process fact—an unmatched `raised` event lies after the process dies
   * because the parked deferred promise is already gone; resume makes the actor ask again with a
   * new qid.
   *
   * This is the **query fallback** when a notification is dropped (stale branch generation / shutdown):
   * the main agent can rediscover unanswered questions through the existing observation surface at any
   * time. The whole field is omitted when there are no questions (no empty array).
   */
  pendingQuestions?: readonly DynamicWorkflowRunPendingQuestion[];
  /**
   * **User-facing artifacts** published by this run, in first-seen order, sourced from journal
   * rows with `kind = "artifact"`—the durable home of version history (`workflowRuns.artifacts`
   * contains only latest-version metadata). Like `reports`, these are read **only in terminal states**
   * (`getTask` is polled repeatedly, while artifact rows are consumed by terminal notifications and
   * GetWorkflowRun); the whole field is omitted when there are none.
   *
   * ⚠ Terminology: `artifact` here means output the script publishes for users through `artifact.*`.
   * It is unrelated to this type's `output` (the script's top-level return value, called
   * `RunSettlement.artifact` inside the engine).
   */
  artifacts?: readonly DynamicWorkflowRunArtifact[];
};

/**
 * One version of a user-facing artifact (a JSON mirror of `ArtifactVersionRecord` in journal
 * `dwf_node.result_json`). **Intentionally redeclared here** instead of imported from
 * @zcode/dynamic-workflow: the port carries only JSON shapes (the same rationale as
 * {@link DynamicWorkflowRunLifecycleStatus}).
 *
 * Content artifacts (`file` / `markdown`) populate `contentType` / `bytes` / `uri` / `sourcePath`;
 * built-in boards (`chart` / `table` / `metrics` / `board`) populate `spec`. Bytes are never stored
 * here—`uri` points to the tool-artifact store.
 */
export interface DynamicWorkflowRunArtifactVersion {
  version: number;
  title?: string;
  description?: string;
  contentType?: string;
  bytes?: number;
  uri?: string;
  sourcePath?: string;
  spec?: unknown;
  /** Publication time (epoch milliseconds). The driver always writes this. */
  publishedAt: number;
  /** This version is the run's deliverable. */
  primary?: true;
}

/** User-facing artifact kinds (the six members of the facade's `artifact.*`). */
export type DynamicWorkflowRunArtifactKind =
  | "file"
  | "markdown"
  | "chart"
  | "table"
  | "metrics"
  | "board";

/**
 * A user-facing artifact: all versions under an id (ascending by version number) plus the count of
 * tagged reports associated with it. `title` / `description` / `contentType` / `sourcePath` / `spec`
 * use the **latest version's** values, so readers interested only in the current state need not scan
 * `versions` themselves.
 */
export interface DynamicWorkflowRunArtifact {
  id: string;
  kind: DynamicWorkflowRunArtifactKind;
  title?: string;
  description?: string;
  contentType?: string;
  sourcePath?: string;
  spec?: unknown;
  /** Latest version number (= `version` of the last item in `versions`). */
  version: number;
  versions: readonly DynamicWorkflowRunArtifactVersion[];
  /** Number of `report` items tagged with this id (built-in board data count; always 0 for content artifacts). */
  itemCount: number;
  /** Run deliverable (at most one). It leads the `artifacts` list; remaining items follow first-publication order. */
  primary?: true;
}

/** A `report` item supplied to a built-in artifact, located by journal sequence (the board's data retrieval surface). */
export interface DynamicWorkflowRunArtifactItem {
  sequence: number;
  siteId: string;
  ordinal: number;
  item: unknown;
}

/** Pagination input for {@link DynamicWorkflowRunPort.listArtifactItems} (cursor = journal sequence, strictly greater). */
export interface DynamicWorkflowRunArtifactItemPage {
  afterSequence?: number;
  /** Required; callers may pass "limit + 1" to detect `hasMore`; implementations must not clamp it again. */
  limit: number;
}

/** Return value of {@link DynamicWorkflowRunPort.readArtifact}: all bytes for one version. */
export interface DynamicWorkflowRunArtifactBytes {
  bytes: Uint8Array;
  contentType: string;
}

/** A parked escalation question. Fields share the `escalation-raised` event as their source, with the question timestamp added. */
export interface DynamicWorkflowRunPendingQuestion {
  /** Globally unique question id (form: `dwfq-<runId fragment>-<seq>`); `resolveQuestion` accepts only this id. */
  qid: string;
  /** Actor asking the question, in `refToString` form (for example, `actor#1@1`). Always present and uniquely identifies it within the run. */
  actor: string;
  /**
   * Human-readable name of this actor (the `"poet"` in the script's `agent("poet")`).
   *
   * **Anonymous actors omit this field; no fallback label is synthesized here**: fallback labels are a
   * rendering decision, and notifications and sidebars need different forms (one reads as a sentence,
   * the other fits in a column). Synthesizing `actor#1@1` as a name here would prevent both consumers
   * from recovering the fact that this actor has no name.
   */
  actorName?: string;
  question: string;
  /** Additional context from the actor (optional `context` from `escalate`). */
  context?: string;
  /** Question time (epoch ms). The main agent uses it to tell how long the question has been waiting. */
  askedAt: number;
}

/**
 * Structured refusal reasons for {@link DynamicWorkflowRunPort.resolveQuestion}. The model has
 * **three different next steps** for these cases, so they must be distinguishable: get the correct id
 * from the snapshot / do nothing / this run no longer needs an answer.
 */
export type DynamicWorkflowResolveQuestionRefusalReason =
  /** This qid is absent from the registry: it is misspelled or stale from a dead process (parked questions are not persisted). */
  | "unknown_question"
  /** This question has already been answered; the actor has continued with that answer. */
  | "already_resolved"
  /** The run / ask for this qid is no longer in flight (cancelled, failed, or finished); nobody is waiting for this answer. */
  | "run_not_in_flight";

/**
 * Structured result of `resolveQuestion`. Failures use `reason` rather than throwing, for the same
 * reason as {@link DynamicWorkflowRunSubmitResult}: all three reasons are expected business branches.
 *
 * The implementation prepares `message` (stating the current situation and next step) rather than
 * leaving it to the tool layer: maintaining the discriminator and wording separately would eventually
 * make them disagree, and the reader here is the model—it reads this as its next step.
 */
export type DynamicWorkflowResolveQuestionResult =
  | { ok: true; qid: string }
  | { ok: false; reason: DynamicWorkflowResolveQuestionRefusalReason; message: string };

export interface DynamicWorkflowRunWaitOptions {
  signal?: AbortSignal;
}

/** Event-log pagination input; cursor = journal sequence (assigned monotonically by appendEvent). */
export interface DynamicWorkflowRunEventPage {
  /** Return only events with a sequence strictly greater than this value; defaults to the beginning. */
  afterSequence?: number;
  limit?: number;
}

/**
 * **Protocol shape** of a run event: sequence + event kind + JSON payload.
 *
 * Intentionally does not reuse the engine's `RunEvent`: that belongs to the domain package
 * (@zcode/dynamic-workflow), and importing it into contracts would make every layer holding the port
 * depend on engine-internal types at compile time. The port carries only JSON shapes; `type` is an
 * opaque string and readers interpret `payload` as needed.
 */
export interface DynamicWorkflowRunEvent {
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
  /** Payload was bounded by {@link boundDynamicWorkflowRunEventPayload} (the original facts remain in the journal). */
  truncated?: boolean;
}

/**
 * Bounds for run-event payloads. **Every payload at the protocol boundary is bounded**, while engine
 * events contain two inherently unbounded fields: `persona.system` on `actor-created` (the full system
 * prompt) and node-level error `finalText` (a full model response). They must not be allowed through
 * merely because they are "probably not too long."
 *
 * These are **structural** bounds (string length / array item count / key count / depth), not total
 * byte limits: structural bounds can be applied field by field without serializing and rolling back,
 * and one oversized field cannot cause all other fields to be discarded.
 */
export const DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS = {
  maxStringLength: 2_048,
  maxArrayItems: 32,
  maxKeys: 32,
  maxDepth: 6,
} as const;

/**
 * Bounds a run-event payload to {@link DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS} and normalizes it
 * into a **JSON-serializable** shape.
 *
 * Two consumers share this serialization:
 *   1. The event page returned by `listEvents` (the detail page's event log).
 *   2. The `dynamic_workflow_run_progress` session event appended to the parent session (→ the `workflowRuns` projection).
 *
 * Normalization is required, not optional cleanup: `JSON.stringify` turns any non-finite number
 * (`Infinity` / `NaN`) into `null`, meaning the same payload differs before and after persistence.
 * Rather than making each reader handle this inconsistency, this function converts it to `null` once
 * so the result is structurally equivalent to `JSON.parse(JSON.stringify(x)) === x`.
 */
export function boundDynamicWorkflowRunEventPayload(payload: Record<string, unknown>): {
  payload: Record<string, unknown>;
  truncated: boolean;
} {
  let truncated = false;
  const markTruncated = (): void => {
    truncated = true;
  };
  const bounded = boundJsonValue(payload, 0, markTruncated);
  return {
    payload: isJsonRecord(bounded) ? bounded : {},
    truncated,
  };
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Recursively bounds a value. Returns `undefined` when the value cannot be carried (callers omit it from objects / arrays). */
function boundJsonValue(value: unknown, depth: number, markTruncated: () => void): unknown {
  const limits = DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS;

  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    // Infinity / NaN are not valid JSON numbers; convert them to null instead of letting JSON.stringify do so implicitly.
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    if (value.length <= limits.maxStringLength) return value;
    markTruncated();
    return truncateSurrogateSafe(value, limits.maxStringLength);
  }
  if (typeof value !== "object") {
    // Omit undefined / function / symbol / bigint (bigint is not JSON-serializable either).
    return undefined;
  }

  if (depth >= limits.maxDepth) {
    markTruncated();
    return undefined;
  }

  if (Array.isArray(value)) {
    const items =
      value.length > limits.maxArrayItems ? value.slice(0, limits.maxArrayItems) : value;
    if (items.length < value.length) markTruncated();
    const out: unknown[] = [];
    for (const item of items) {
      const boundedItem = boundJsonValue(item, depth + 1, markTruncated);
      // Array holes change index semantics, so unrepresentable items become null instead of being skipped.
      out.push(boundedItem === undefined ? null : boundedItem);
    }
    return out;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const kept = entries.length > limits.maxKeys ? entries.slice(0, limits.maxKeys) : entries;
  if (kept.length < entries.length) markTruncated();
  const out: Record<string, unknown> = {};
  for (const [key, item] of kept) {
    const boundedItem = boundJsonValue(item, depth + 1, markTruncated);
    if (boundedItem !== undefined) out[key] = boundedItem;
  }
  return out;
}

/**
 * Truncates by UTF-16 code units without leaving a lone surrogate—one is not valid text and can
 * cause downstream JSON encoding or decoding to fail in some runtimes. If the cut lands inside a
 * surrogate pair, keep one fewer code unit.
 */
function truncateSurrogateSafe(value: string, maxLength: number): string {
  const cut = value.slice(0, maxLength);
  const lastCode = cut.charCodeAt(cut.length - 1);
  const isHighSurrogate = lastCode >= 0xd800 && lastCode <= 0xdbff;
  return isHighSurrogate ? cut.slice(0, -1) : cut;
}

/**
 * Converts **any script value** in a workflow run (the top-level return value or an item passed to
 * `report(item)`) into text for the model or reader. The implementation moved with the shared
 * `workflowRuns` reducer into `@zcode/shared/zcode-protocol-v4` (`workflow-artifact.ts`; see its
 * comments for the rules and rationale): once `reports[].preview` reduction moved to shared, it
 * became a fourth consumer, and the dependency direction is contracts → shared, so the function had
 * to move with it. This re-export keeps the three existing consumers (completion notifications,
 * TaskOutput's `resultText`, and the v4 projection) unchanged.
 */
export { serializeWorkflowArtifact } from "@zcode/shared/zcode-protocol-v4";

/**
 * Narrow port for workflow runs. It sits alongside the legacy
 * {@link import("./workflow.port.js").WorkflowPort} rather than merging with it: the latter serves
 * the `Workflow` tool and legacy `workflow_*` tables, and sharing one port would recouple the
 * interface to the existing workflow mechanism.
 *
 * Cancellation has no dedicated RPC: the detail-page button and background panel share the existing
 * v4 `cancelBackgroundWork` command, which maps to {@link cancel} here (runId ≡ workId).
 */
export interface DynamicWorkflowRunPort {
  /** Compile once and start the engine; returns the runId (also the backgroundTaskId). */
  submit(
    request: DynamicWorkflowRunSubmitRequest,
    options?: DynamicWorkflowRunSubmitOptions,
  ): Promise<DynamicWorkflowRunSubmitResult>;
  /**
   * Amend a run: validate the predecessor → mint a new id → if the predecessor is in flight, cancel
   * it with `{ superseded: newRunId }` and wait for settlement → import its cache → start the new run
   * (see {@link DynamicWorkflowRunAmendRequest}). A rejected preflight is a structured failure and
   * **changes nothing**. Older hosts may not provide this method (optional member); the tool layer
   * normalizes capability detection to "this session does not support amendments."
   */
  amend?(
    request: DynamicWorkflowRunAmendRequest,
    options?: DynamicWorkflowRunSubmitOptions,
  ): Promise<DynamicWorkflowRunAmendResult>;
  /**
   * Ceiling for a run's concurrency limit (`max(1, min(16, availableParallelism() − 2))`, one value
   * per process). Synchronous and side-effect free.
   *
   * The tool layer has two readers: `resolveInput` in `CreateWorkflow` / `AmendWorkflow` clamps the
   * model's `max_concurrency` to this value (the confirmation window must show the value that will
   * take effect), and `GetWorkflowRun` uses it to decide whether a run's limit is worth mentioning.
   * **Optional member** (consumers detect it with `typeof`): port stubs need not implement it. If
   * absent, the tool layer passes the value through unchanged (the port implementation clamps it again).
   */
  concurrencyCeiling?(): number;
  /**
   * Change the concurrency limit of an **in-flight** run in place: keep the same runId, mint no
   * successor, supersede nothing, import no cache, and do not lose in-flight asks.
   *
   * Kept alongside {@link amend} rather than merged with it: an amendment changes the **script** and
   * pays the cost of stopping the predecessor, minting a new run, and replaying from cache; simply
   * slowing a run should not incur that cost. Both callers (the `AmendWorkflow` handler and GUI's
   * `amendWorkflowRunSettings`) use the same operation, so retuning has one definition.
   *
   * All three actions happen in one synchronous block or none happen: update the engine caps (read by
   * the scheduler), write `dwf_run.caps_max_concurrency` (so resume continues with the new limit), and
   * record a `run-caps-changed` event. The service also updates its in-memory limit, so snapshots,
   * details, and `GetWorkflowRun` report the new value immediately.
   *
   * **Optional member** (consumers detect it with `typeof`), for the same reason as {@link resume}:
   * port stubs need not implement a control-plane method, and callers treat a missing port and a
   * missing method as the same business fact—fall back to a full amendment.
   */
  retuneConcurrency?(
    request: DynamicWorkflowRunRetuneRequest,
  ): Promise<DynamicWorkflowRunRetuneResult>;
  getTask(taskId: string): Promise<DynamicWorkflowRunSnapshot | undefined>;
  waitForTask(
    taskId: string,
    options?: DynamicWorkflowRunWaitOptions,
  ): Promise<DynamicWorkflowRunSnapshot | undefined>;
  /**
   * Stop a run: abort in-flight asks and kill the child process; the run settles as
   * `stopped(initiator)`. `initiator` defaults to `user`; pass `model` when the main agent stops it
   * through TaskStop (the reason is now persisted instead of living only in the background-task
   * registry); the amendment path passes `{ superseded: newRunId }`. Returns false for an unknown runId.
   */
  cancel(runId: string, initiator?: DynamicWorkflowRunCancelInitiator): Promise<boolean>;
  /** Read the event log by cursor; an out-of-range cursor returns an empty page instead of an error. */
  listEvents(
    runId: string,
    options: DynamicWorkflowRunEventPage,
  ): Promise<DynamicWorkflowRunEvent[]>;
  /**
   * List runs for a project (cwd), most recently updated first. Serves the `ListWorkflowRuns` tool.
   *
   * **Optional member**, following the precedent before {@link cancel} (consumers detect it with
   * `typeof`): implementations provide it only when the journal supports introspection queries, so
   * existing port stubs need not implement a read-only listing surface. Consumers treat a missing
   * port and a missing method as the same business failure—the model sees the same fact (this session
   * does not support the capability).
   */
  listRuns?(query: DynamicWorkflowRunListQuery): Promise<DynamicWorkflowRunListResult>;
  /**
   * Single-run details (progress summary + artifacts / failure). Serves the `GetWorkflowRun` tool.
   * Returns `undefined` for an unknown runId (consumers normalize this to `run_not_found`); it has no
   * **wait/block semantics**—waiting belongs to {@link waitForTask}, while this is an immediate
   * snapshot. The optional-member rationale is the same as for {@link listRuns}.
   */
  getRunDetail?(runId: string): Promise<DynamicWorkflowRunDetail | undefined>;
  /**
   * Original source text saved for the run (`dwf_run.script_text`, the exact bytes replayed by resume),
   * returned byte for byte without processing. `AmendWorkflow` reads it in two cases: to fill in the
   * predecessor's script when omitted, and for the `script_unchanged` preflight on a `path` amendment.
   * The latter must compare bytes, not hashes; the tool reads file contents, not compiled output. The
   * GUI's "configure" flow uses the same read path.
   *
   * A separate read method rather than a field on {@link DynamicWorkflowRunSnapshot}: the background
   * tracker polls snapshots repeatedly, and the script is the port's largest string (same rationale
   * as {@link DynamicWorkflowRunSummary.label}). Unknown runs and records without a script (older runs
   * persisted before this field existed) both return `undefined`—the caller sees the same fact: there
   * is no script to reuse. Read-only and available regardless of whether the service is closed.
   * **Optional member** (consumers detect it with `typeof`), for the same reason as {@link listRuns}:
   * without it, an amendment that omits the script fails immediately, while the `script_unchanged`
   * preflight is skipped (it is a safety net, not a gate).
   */
  getScript?(runId: string): Promise<string | undefined>;
  /**
   * Resume a cancelled run or one interrupted by process death: rerun with the same runId (the engine
   * takes its resume branch, short-circuits journal hits, and redispatches unfinished nodes). The
   * implementation enforces the gate: only `cancelled` runs or `failed` runs with failure code
   * `Interrupted` can be resumed.
   *
   * **Optional member**, following the precedent before cancel in {@link listEvents} (consumers detect
   * it with `typeof`): port stubs need not implement resume; consumers treat a missing port and a
   * missing method as the same business failure.
   */
  resume?(runId: string): Promise<DynamicWorkflowRunResumeResult>;
  /**
   * List run summaries belonging to **this service's parent session** (journal-backed, most recently
   * updated first). This is the UI's discovery surface after restart: the `workflowRuns` projection
   * does not survive across processes, so tool-card joins and Resume-button availability can only be
   * restored from here. Intentionally takes no parentSessionId parameter—the service instance is
   * constructed for one parent session (per app), and accepting an arbitrary session would open a
   * cross-session read path. Optional-member rationale is the same as for {@link resume}.
   */
  listRunsForSession?(limit?: number): Promise<DynamicWorkflowRunSessionSummary[]>;
  /**
   * Cold replay: replay journal entries for runs belonging to **this service's parent session** that
   * have not run in this process as progress-event payloads. These are **the same payloads** and use
   * the same construction path as those emitted by `onRunEvent` while live; cold materialization feeds
   * them to the same reducer as in-memory events, keeping the `workflowRuns` projection byte-for-byte
   * consistent across restarts.
   *
   *   - Uses the projection's cap and eviction policy (8 most recently updated runs), returning the oldest run first.
   *   - `excludeRunIds`: do not replay runs for which the caller already has in-memory events (ran or are running in this process).
   *   - For a terminal row with no `run-settled` event (a row rewritten by orphan reconciliation after process death), append a
   *     synthesized **in-memory** settlement payload (carrying the row's status / failure / resumable); never write it to the journal.
   *
   * Optional-member rationale is the same as for {@link listRunsForSession}: an in-memory journal has
   * no enumeration surface, so there is nothing to replay.
   */
  replayProgressForSession?(input: {
    excludeRunIds: ReadonlySet<string>;
  }): Promise<DynamicWorkflowRunProgressPayload[]>;
  /**
   * Answer a blocking question escalated by an actor. Serves the `ResolveWorkflowQuestion` tool.
   *
   * Accepts one opaque token rather than a `(runId, qid)` pair: qids are globally unique across runs,
   * and making the model pair them during concurrent runs invites mismatches. The answer becomes the
   * tool result for that actor's `escalate` call unchanged, and the actor's turn continues; the run's
   * state does not change (an escalation is a slow tool call inside an ask, not a run-lifecycle event).
   *
   * **Optional member**, following the precedent of {@link resume} (consumers detect it with
   * `typeof`): port stubs need not implement the answer surface; consumers treat a missing port and a
   * missing method as the same business failure.
   */
  resolveQuestion?(qid: string, answer: string): Promise<DynamicWorkflowResolveQuestionResult>;
  /**
   * List this run's user-facing artifacts (journal rows with `kind = "artifact"`, grouped by id and
   * ordered by version). Durable read path for UI cold recovery and central details. Returns
   * `undefined` for an unknown runId. **Optional member**, for the same reason as {@link listRuns}
   * (provided only when the journal has artifact reads; consumers detect it with `typeof`).
   */
  listArtifacts?(runId: string): Promise<readonly DynamicWorkflowRunArtifact[] | undefined>;
  /**
   * List `report` items supplied to a built-in artifact, paginated by ascending journal sequence (the
   * board's data retrieval surface). An out-of-range cursor returns an empty page instead of an error.
   * Optional member, for the same reason as {@link listArtifacts}.
   */
  listArtifactItems?(
    runId: string,
    artifactId: string,
    page: DynamicWorkflowRunArtifactItemPage,
  ): Promise<readonly DynamicWorkflowRunArtifactItem[]>;
  /**
   * Read bytes for an artifact version: **first** verify that the journal has a `completed` record
   * for `(runId, artifactId, version)`, then retrieve it through the tool-artifact store using the
   * row's `uri`—no caller-provided id becomes a path directly. Missing version / non-content artifact
   * / unavailable store → `undefined`. Chunking is handled by the gateway (v4
   * `workflowRunArtifactRead`, up to 512 KiB per chunk). Optional member, for the same reason as
   * {@link listArtifacts}.
   */
  readArtifact?(
    runId: string,
    artifactId: string,
    version: number,
  ): Promise<DynamicWorkflowRunArtifactBytes | undefined>;
  /**
   * Workspace transcript for this run: journal rows with `kind ∈ {world-read, world-run}`, ordered by
   * persistence time and **without their contents**.
   *
   * Authorization follows the same path as {@link readArtifact}: the run must belong to this service's
   * parent session; otherwise return `undefined` (the same answer as "no such run," so an unauthorized
   * caller cannot learn which part it guessed correctly). Since contents may include workspace files,
   * the listing is not exposed to other sessions either. Optional member, for the same reason as
   * {@link listArtifacts}.
   */
  listWorkspaceNodes?(
    runId: string,
  ): Promise<readonly DynamicWorkflowRunWorkspaceNode[] | undefined>;
  /**
   * Read the contents of one workspace node, structurally bounded by `maxBytes`. Authorization follows
   * {@link listWorkspaceNodes}; missing node / non-world row / run not owned by this session →
   * `undefined`. Optional member, for the same reason as {@link listArtifacts}.
   */
  readWorkspaceNodeResult?(
    runId: string,
    siteId: string,
    ordinal: number,
    query: DynamicWorkflowRunWorkspaceNodeResultQuery,
  ): Promise<DynamicWorkflowRunWorkspaceNodeResult | undefined>;
}

// ————————————————————————————————————————————————————————————————
// Run introspection (data surface for ListWorkflowRuns / GetWorkflowRun)
// ————————————————————————————————————————————————————————————————

/**
 * Lifecycle status of a run. The literals match `dwf_run.status` in the journal but are **intentionally
 * redeclared here** instead of imported from @zcode/dynamic-workflow: the port carries only JSON
 * shapes, and importing the engine vocabulary into contracts would make every layer holding the port
 * depend on engine-internal types at compile time (same rationale as the `type` field of
 * {@link DynamicWorkflowRunEvent}).
 *
 * Intentionally differs from the status in {@link DynamicWorkflowRunSnapshot}: the latter uses the
 * background-task tracker's vocabulary and folds `pending` into `running`. Introspection must retain
 * `pending`—"submitted, but the engine has not created a row yet" is a meaningful distinction the
 * model can understand.
 */
export type DynamicWorkflowRunLifecycleStatus =
  | "completed"
  | "errored"
  | "pending"
  | "running"
  | "stopped";

/**
 * Reason for `stopped`: `user` user cancellation / `model` main-agent TaskStop / `provider`
 * deterministic model-side error / `interrupted` owning-process death or sandbox failure /
 * `superseded` stopped and replaced by an AmendWorkflow operation. The first four can be resumed;
 * `superseded` cannot (its successor is active). `errored` (script failure) cannot be resumed either.
 * The literals match the engine's `RunStopReason` but are intentionally redeclared here.
 */
export type DynamicWorkflowRunStopReason =
  | "user"
  | "model"
  | "provider"
  | "interrupted"
  | "superseded";

/** Query input for {@link DynamicWorkflowRunPort.listRuns}. */
export interface DynamicWorkflowRunListQuery {
  /**
   * Project key, **required**. Matches `dwf_run.cwd` by exact equality (stored and queried as-is).
   * The port does not guess a default cwd for callers: the tool surface always queries
   * `context.workingDirectory`, and the model cannot scan across projects.
   */
  cwd: string;
  /** Maximum number of results, **required**. The tool surface clamps it to [1, 50]; the port does not enumerate without a bound. */
  limit: number;
  /** Optional status subset. Omission means no filter; an empty array matches no statuses (returns an empty list). */
  statuses?: readonly DynamicWorkflowRunLifecycleStatus[];
}

/**
 * **Shared view** for list and detail. Labels, ownership markers, and timestamps must have the same
 * field-by-field source across both read surfaces: showing different names or ownership for the same
 * run in the list and detail is a hard-to-test inconsistency that directly damages trust. This shared
 * base interface prevents the two field sets from evolving independently.
 */
export interface DynamicWorkflowRunSummary {
  runId: string;
  /**
   * Display label. **Fully prepared** by the implementation (run service) using name → first script
   * line → runId, so consumers can display it directly. The raw inputs (name / scriptText) are not
   * exposed for the tool layer to assemble: that fallback chain is a read-time heuristic that would
   * drift if each tool assembled it independently, and scriptText is the port's largest string (the
   * list surface should not transfer 50 scripts just to read their first lines).
   */
  label: string;
  /** Label source: `"name"` = user-provided name; `"script"` = derived from the script at read time (with runId fallback). */
  labelSource: "name" | "script";
  status: DynamicWorkflowRunLifecycleStatus;
  /** Present only when `status === "stopped"`. */
  stopReason?: DynamicWorkflowRunStopReason;
  /** Run this one was amended from (`dwf_run.resumed_from`); omitted if this is not an amendment. */
  resumedFrom?: string;
  /** Amendment that stopped and replaced this run (the settlement payload for `stopped(superseded)`); omitted if it was not replaced. */
  supersededBy?: string;
  /** Whether this session launched the run (journal parent_session_id matches or it is in this session's registry). */
  ownedByThisSession: boolean;
  /**
   * "This session cannot confirm the run is still alive": journal is non-terminal ∧ run is not from
   * this session ∧ it is absent from this session's registry. It may be a remnant of a dead process
   * or a run active in a sibling session in the same process—so this is a **marker, not a status
   * rewrite**. The read surface never cleans up another session's runs (orphan reconciliation belongs
   * to the owning session at construction time). Present only when true.
   */
  possiblyInterrupted?: boolean;
  /** Journal `time_created` / `time_updated` (epoch ms). */
  createdAt: number;
  updatedAt: number;
}

/** One list item: shared view + usage. Intentionally lightweight—no actors, node counts, or artifact previews. */
export interface DynamicWorkflowRunListItem extends DynamicWorkflowRunSummary {
  /** Read directly from `dwf_run.spent_tokens` (the sole authority for run-level token usage). */
  spentTokens: number;
}

/**
 * Return value of `listRuns`. Intentionally an object rather than a bare array: page-level fields
 * (such as {@link truncated}) can be added without breaking callers, while a bare array would need a
 * complete shape change.
 */
export interface DynamicWorkflowRunListResult {
  runs: DynamicWorkflowRunListItem[];
  /**
   * This project has more runs that are not in this page. **Present only when true.**
   *
   * The criterion is "fetch one extra" (the implementation queries `limit + 1` and drops the extra),
   * not `length === limit`: the latter reports more results when the count is exactly `limit`, causing
   * the model to request a nonexistent history page. The same convention is already used for event
   * pagination in the v4 gateway (`hasMore`).
   */
  truncated?: boolean;
}

/**
 * Run progress and usage (observation surface, with no total limit). `nodesObserved` is the **number
 * of persisted node rows** (sum of the three states), not a "total step count": dynamic workflows
 * have no static total, and `queued` exists only in the event phase, not in storage.
 */
export interface DynamicWorkflowRunUsage {
  spentTokens: number;
  nodesObserved: number;
  nodesRunning: number;
  nodesCompleted: number;
  nodesFailed: number;
}

/** One actor-site instance. `persona` is intentionally omitted: the full system prompt is inherently unbounded on this port. */
export interface DynamicWorkflowRunActor {
  siteId: string;
  ordinal: number;
  name?: string;
}

/** One `log()` narrative entry. */
export interface DynamicWorkflowRunLogEntry {
  sequence: number;
  /** Bounded by the port's string limit ({@link DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS}). */
  message: string;
  /**
   * Time when this event was written to the journal (`dwf_event.time_created`). Sequence locates it;
   * time answers "how long ago"—the three roster fields use this same clock to calculate age, and the
   * narrative tail should too. **Omitted for older journals without this column**; readers then omit
   * the age and never fall back to read-time `Date.now()`.
   */
  at?: number;
}

/** Structured failure. `code` is a stable discriminator—the model must distinguish process death from a real script failure. */
export interface DynamicWorkflowRunError {
  code: string;
  message: string;
  /** Present only when `code === "ProviderStop"` (JSON mirror of the engine's `ProviderStopDetails`). */
  providerStop?: DynamicWorkflowRunProviderStop;
}

/** Structured details for `ProviderStop` (mirror of the engine's `ProviderStopDetails`; the port carries only JSON shapes). */
export interface DynamicWorkflowRunProviderStop {
  kind: "auth" | "not_configured" | "model_unavailable" | "invalid_request" | "quota" | "other";
  reason: string;
  providerId?: string;
  providerLabel?: string;
  modelId?: string;
  providerCode?: string;
  subagent?: string;
  subagentName?: string;
  phase?: string;
  rawMessage?: string;
  resetAt?: number;
}

// Types for the roster view (phases / subagents / health) live in dynamic-workflow-run-roster.port.ts;
// re-export them here unchanged to preserve `@zcode/contracts` import paths.
export type * from "./dynamic-workflow-run-roster.port.js";

// The three retune types (changing an in-flight run's concurrency limit in place) live in
// dynamic-workflow-run-retune.port.ts and are re-exported here unchanged for the same reason.
export type * from "./dynamic-workflow-run-retune.port.js";

// The six workspace-transcript types live in dynamic-workflow-run-workspace.port.ts and are re-exported
// here unchanged for the same reason.
export type * from "./dynamic-workflow-run-workspace.port.js";

/** Single-run details: shared view + progress + roster + artifacts / failure, which vary by terminal state. */
export interface DynamicWorkflowRunDetail extends DynamicWorkflowRunSummary {
  usage: DynamicWorkflowRunUsage;
  /**
   * This run's concurrency limit, with the same semantics as
   * {@link DynamicWorkflowRunSnapshot.maxConcurrency}: present only when below the current ceiling.
   * Intentionally omitted from {@link DynamicWorkflowRunSummary}; list rows should not widen for a
   * rarely set field.
   */
  maxConcurrency?: number;
  /**
   * Model used by this run's subagents, with the same semantics as
   * {@link DynamicWorkflowRunSnapshot.subagentModel}: present only when explicitly set. Like
   * `maxConcurrency`, omitted from {@link DynamicWorkflowRunSummary}; list rows should not widen for a
   * rarely set field.
   */
  subagentModel?: string;
  /**
   * Script file for this run, with the same semantics as
   * {@link DynamicWorkflowRunSnapshot.scriptPath}: present only when a file was recorded.
   * `GetWorkflowRun` uses it to describe the next step in `<amendable>` as "edit this file in place."
   */
  scriptPath?: string;
  actors: DynamicWorkflowRunActor[];
  /** Tail of `log()` events, in chronological order (ascending sequence). Empty when there are no log events. */
  logTail: DynamicWorkflowRunLogEntry[];
  /**
   * Phase list: declared phases in declaration order, followed by phases that were entered but not declared.
   *
   * **Omit the whole field when the script declared no phases and none were entered**—that run has no
   * phases at all; an empty array would read as "the phase list is empty," which means something else.
   */
  phases?: DynamicWorkflowRunPhaseView[];
  /**
   * Subagent roster, ordered by actor rows (= creation order). **Always present**; a run with no actors
   * has an empty array. Unlike `phases`, "how many subagents does this run have?" always has an answer,
   * and 0 is that answer.
   *
   * Intentionally separate from the adjacent `actors`: `actors` is a stable identity table (siteId /
   * ordinal / name) that consumers already join against; each item here is a **read-time snapshot**,
   * so the same run may differ when read a second later.
   */
  subagents: DynamicWorkflowRunSubagentView[];
  /** Whether the run as a whole is still active (see {@link DynamicWorkflowRunHealth}). Always present. */
  health: DynamicWorkflowRunHealth;
  /**
   * The script's top-level return value, as the **original value** (not serialized). Present only for
   * completed runs; an `undefined` result omits the whole field.
   *
   * Why it is not serialized here: the model-facing text projection already has one implementation
   * (`serializeWorkflowArtifact` in core, shared by completion notifications and TaskOutput). Doing it
   * again in the port would make the same run's result look different in its notification and this
   * tool—the exact inconsistency that shared implementation prevents. Serialization stays in core;
   * the port only carries the original value to the boundary.
   */
  result?: unknown;
  /** Always present for errored; present for stopped only with provider / interrupted. The code is passed through unchanged. */
  error?: DynamicWorkflowRunError;
  /**
   * Escalation questions currently parked on this run, waiting for the main agent's answer.
   *
   * **Same source and projection** as {@link DynamicWorkflowRunSnapshot.pendingQuestions} (both read the
   * in-process parked-escalation table and omit the whole field when empty), but on a different read
   * surface: the snapshot serves the background-task tracker, and this field serves `GetWorkflowRun`,
   * the **only discovery surface for the model**. This is necessary: escalation notifications have two
   * known drop paths (stale branch generation / shutdown), and querying is the fallback for both. The
   * `unknown_question` message from `resolveQuestion` also explicitly tells the model to find the qid
   * here. Without this field, both paths would point to a tool that returns nothing.
   */
  pendingQuestions?: readonly DynamicWorkflowRunPendingQuestion[];
  /**
   * User-facing artifacts for this run (included in any state; journal-backed and sourced identically
   * to {@link DynamicWorkflowRunSnapshot.artifacts}). `GetWorkflowRun` uses this to tell the model
   * these have already been shown to the user as cards and can be referenced by title. The whole field
   * is omitted when there are none.
   */
  artifacts?: readonly DynamicWorkflowRunArtifact[];
}

/** Structured failure reasons for {@link DynamicWorkflowRunPort.resume}. */
export type DynamicWorkflowRunResumeErrorReason =
  /** No such run in the journal. */
  | "not_found"
  /** Run is not resumable (completed or errored; only stopped runs can be resumed). */
  | "not_resumable"
  /** Run was stopped and replaced by AmendWorkflow: its successor is active, and replaying it would do the same work twice. */
  | "superseded"
  /** A run with the same runId is already active in this process. */
  | "already_running"
  /** The record has no scriptText (an older run persisted before this field existed); no script is available to rerun. */
  | "script_missing"
  /** The recorded scriptHash differs from the hash recomputed from scriptText (the record itself was modified externally). */
  | "script_mismatch"
  /**
   * The recorded scriptText no longer passes type checking against the **current** facade (an older
   * run predating a facade refactor). Replaying it verbatim would fail; update the script for the
   * current facade and use AmendWorkflow. `message` carries bounded diagnostics.
   */
  | "compile_failed";

/**
 * Structured result of resume. Failures use `reason` rather than throwing: all five reasons are
 * expected business branches (the house rule is to branch on error codes, not error text); throwing
 * is reserved for actual wiring failures.
 */
export type DynamicWorkflowRunResumeResult =
  | { ok: true; runId: string; toolCallId?: string }
  | { ok: false; reason: DynamicWorkflowRunResumeErrorReason; message?: string };

/**
 * Run summary for {@link DynamicWorkflowRunPort.listRunsForSession}. Its literals match the journal's
 * `dwf_run.status` but are **intentionally redeclared here**: the port carries only JSON shapes, and
 * importing the engine vocabulary into contracts would make every layer holding the port depend on
 * engine-internal types at compile time.
 */
export interface DynamicWorkflowRunSessionSummary {
  runId: string;
  /** CreateWorkflow tool-call id that launched the run (join key for tool card → details / Resume); omitted for older runs. */
  toolCallId?: string;
  /**
   * Display label, derived by the server at read time (`name` → first script line → runId; see
   * `resolveDynamicWorkflowRunLabel` in bootstrap). Optional for **skew safety**: older servers do not
   * send this key, and readers can fall back to runId—a missing list label is degraded display, not an error.
   *
   * Centralized on the server for the same reason as `resumable`: if both surfaces assemble the
   * fallback independently, the same run could have different names in `/dwf list` and its tool card.
   */
  label?: string;
  /**
   * Last update time (epoch milliseconds, from journal `dwf_run.time_updated`). Optional for the same
   * reason: older servers omit it, and readers then hide the time column. The storage layer remains
   * responsible for sorting the list (most recently updated first); this field is display-only—readers
   * must not reorder by it, or their tie-break behavior will drift from the server's.
   */
  updatedAt?: number;
  status: "completed" | "errored" | "pending" | "running" | "stopped";
  /** Present only when `status === "stopped"`. */
  stopReason?: DynamicWorkflowRunStopReason;
  /** Run this one was amended from; omitted if this is not an amendment. */
  resumedFrom?: string;
  /** Amendment that stopped and replaced this run; omitted if it was not replaced. */
  supersededBy?: string;
  /** Structured failure code for errored / stopped(provider|interrupted) (for example, `ProviderStop` / `Interrupted`). */
  failureCode?: string;
  failureMessage?: string;
  /**
   * Whether this run can be resumed. **Computed by the server with the same predicate as the resume
   * gate**: if the UI derives it independently from status + failureCode, the predicates will
   * eventually disagree—the button will be enabled but the command rejected.
   */
  resumable: boolean;
}
