/**
 * Boundary types for the execution engine.
 *
 * This module is a vocabulary of types, structured errors, and constants; all three boundaries use it as their contract:
 * - Boundary A (host API): the sandbox script's facade shim calls {@link WorkflowHostApi}.
 * - Boundary B (driver port): the engine core (deterministic state machine) drives {@link WorkflowDriver} downward,
 *   the driver reports progress upward through {@link WorkflowReportSink}.
 * - Journal: {@link JournalStorePort} exposes run/actor/node/event records through repository-style methods,
 *   Both in-memory and future SQLite implementations fit naturally here (synchronous methods match node:sqlite's DatabaseSync and keep the core deterministic).
 */

import type {
  ArtifactContentOp,
  ArtifactOp,
  ArtifactPresetOp,
  WorldReadOp,
} from "../facade/registry.js";
import type { AskProgress, AskStats } from "./ask-observation-types.js";
import type { ActorSessionSeed } from "./imported-cache-types.js";

// ————————————————————————————————————————————————————————————————
// Identity
// ————————————————————————————————————————————————————————————————

/**
 * Identity of one ask instance: site id × per-site execution ordinal.
 * The nth call to `ask("ask#3", …)` is instance `ask#3@n` (ordinal starts at 1).
 */
export interface InstanceRef {
  siteId: string;
  ordinal: number;
}

/** Actor identity: creation site × ordinal (same structure as InstanceRef, but refers to an actor rather than an ask). */
export interface ActorRef {
  siteId: string;
  ordinal: number;
}

/**
 * Opaque actor handle passed to the script. The script-side `Agent` is only a thin wrapper around it.
 * The engine maps ActorId back to {@link ActorRef}; the format is hidden from scripts but must remain stably parseable.
 */
export type ActorId = string;

/** Render InstanceRef / ActorRef as the stable `site@ordinal` string for logs and handles. */
export function refToString(ref: InstanceRef | ActorRef): string {
  return `${ref.siteId}@${ref.ordinal}`;
}

// ————————————————————————————————————————————————————————————————
// Persona / ask messages
// ————————————————————————————————————————————————————————————————

/**
 * Frozen actor persona passed to {@link WorkflowDriver.createActorSession}.
 *
 * A persona now contains identity only (name + system prompt). Model tier (`model?: "main" | "lite"`)
 * and tool tier (`tools?: "default" | "readonly" | "none"`) were removed: the host has no lite-model
 * source, and the only effect of the tool tier was "the reviewer cannot edit files"—ordinary subagents
 * do not rely on a tier for that; their ask instructions can state it. Subagents always use the
 * parent session's current model and full work-tool set, minus interactive tools that could hang or
 * exceed permissions. The driver decides whether to register submit_result based on the site graph
 * (actors whose asks are all untyped do not register it); that is not represented here, keeping the
 * persona limited to identity.
 */
export interface PersonaSpec {
  name?: string;
  system?: string;
}

/**
 * Message dispatched for one ask: instruction text + whether it is typed + its schema when typed
 * (opaque to the core, which only passes it to {@link ValidateFn} and the driver's schema suffix).
 * The schema is produced by schema synthesis; the core never interprets its shape.
 */
export interface AskMessage {
  instructions: string;
  typed: boolean;
  schema?: unknown;
}

// ————————————————————————————————————————————————————————————————
// Validation
// ————————————————————————————————————————————————————————————————

/**
 * One validation violation, designed to be readable to the model in a repair tool_result: JSON path +
 * expected + actual. Shared with the schema submodule (declared separately during parallel development,
 * unified in schema/types afterward).
 */
export type { Violation } from "../schema/types.js";
import type { Violation } from "../schema/types.js";

/**
 * Injected validation function: `(schema, value) => violation list` (an empty list means valid). The
 * actual validator is implemented separately in parallel (`src/schema/`); the core depends only on
 * this minimal contract and never imports its implementation.
 */
export type ValidateFn = (schema: unknown, value: unknown) => Violation[];

/** Static specification for each ask site: whether it is typed and its schema. Untyped sites have no schema. */
export interface AskSpec {
  typed: boolean;
  schema?: unknown;
}

// ————————————————————————————————————————————————————————————————
// Metrics / budgets
// ————————————————————————————————————————————————————————————————

/** Reasons to close the import cache: a subagent mutation tool or live `world.run`. */
export type ImportCloseCause = "mutating-tool" | "world-run";

/**
 * Run-level capacity limits, set at submit time and stored in dwf_run. Stores the concurrency ceiling;
 * stopping a run is controlled through the cancellation interface.
 *
 * Values **may change more than once while a run is alive**: an amendment that changes only
 * `max_concurrency` applies to the live run ({@link WorkflowEngine.setMaxConcurrency}). The engine
 * therefore replaces its entire caps object rather than mutating a field in place—the copies recorded
 * in `run-started` / `run-caps-changed` events must retain their original values.
 */
export interface Caps {
  maxConcurrency: number;
}

// Structured terminal details (ProviderStop details and run-level stall observations) live in
// run-terminal.ts and are re-exported unchanged here: this file has reached the 400-line limit, while
// consumers conventionally import from types.
import type { ProviderStopDetails, RunStallInfo } from "./run-terminal.js";

export type { ProviderStopDetails, RunStallInfo };

// ————————————————————————————————————————————————————————————————
// Structured errors (errors are first-class)
// ————————————————————————————————————————————————————————————————

// Error codes, serializable forms, and WorkflowError live in errors.ts and are re-exported unchanged
// here (same reason as run-terminal.ts above: this file has reached its 400-line limit, and consumers
// conventionally import from types).
import type { WorkflowError, WorkflowErrorJson } from "./errors.js";

export { WorkflowError } from "./errors.js";
export type { WorkflowErrorCode, WorkflowErrorJson, WorkflowErrorMismatch } from "./errors.js";

// ————————————————————————————————————————————————————————————————
// Boundary A: host API (called by sandbox scripts)
// ————————————————————————————————————————————————————————————————

/**
 * World-read operations (read-only, journalable). The vocabulary is derived from the world-read
 * registry—adding a primitive means adding one line to `facade/registry.ts`; this file needs no change
 * (see the container-key note at the top of that module).
 */
export type { WorldReadOp };

/**
 * User-facing artifact operations (vocabulary derived from the artifact registry; see
 * `facade/registry.ts`). `ArtifactContentOp` uses {@link WorkflowHostApi.publishArtifact} (an effect,
 * through the driver); `ArtifactPresetOp` uses {@link WorkflowHostApi.declareArtifact} (a declaration,
 * without the driver).
 */
export type { ArtifactContentOp, ArtifactOp, ArtifactPresetOp };

/**
 * Artifact reference passed to the script (facade `ArtifactRef`): id + version minted for this
 * publication. The content member's promise resolves to it.
 */
export interface ArtifactRef {
  id: string;
  version: number;
}

/**
 * Persisted shape of one artifact version (the shape of `dwf_node.result_json`; shared has a Zod mirror).
 *
 * Content and preset members share one shape and populate only their respective half: content has
 * `bytes` / `uri` / `sourcePath`, while presets have `spec`. Bytes **never** enter the journal—`uri`
 * points to the tool-artifact store, where the bytes live.
 */
export interface ArtifactVersionRecord {
  id: string;
  kind: ArtifactOp;
  /** Starts at 1. Preset declarations always use 1 (a declaration has no versions; it happens once). */
  version: number;
  title?: string;
  description?: string;
  /** MIME type of content members (extension table or `opts.contentType`). */
  contentType?: string;
  /** Byte size of a content member. */
  bytes?: number;
  /** `zcode-artifact://…` returned by the store (content members). */
  uri?: string;
  /** Original workspace-relative path (only for `file`; records provenance and supports "show in workspace"). */
  sourcePath?: string;
  /** Spec for preset members (normalized shape; the engine compares duplicate declarations by canonicalJson). */
  spec?: unknown;
  /** Publication time (epoch milliseconds). Written by the driver / host; the engine has no clock. */
  publishedAt?: number;
  /**
   * This id is the run's deliverable. Stamped by the **engine**, not the driver, and sticky by id: once
   * set on one version, it remains on subsequent versions whether or not `primary` is passed again.
   */
  primary?: true;
}

/**
 * Request for the driver to publish one content artifact (Boundary B).
 *
 * `version` is computed by the **engine** before dispatch (number of completed journal rows for this
 * id + 1) and passed down, rather than counted by the driver: the driver should not know the journal
 * shape, and the store's `toolCallId` needs the version (one byte artifact per version). Exactly one
 * of `path` / `content` is provided depending on `op`; argument validation belongs to the driver.
 */
export interface ArtifactPublishRequest {
  runId: string;
  siteId: string;
  ordinal: number;
  op: ArtifactContentOp;
  id: string;
  version: number;
  /** `file`: workspace-relative path. */
  path?: string;
  /** `markdown`: body text. */
  content?: string;
  /** Script-provided `opts` (passed through unchanged; shape validation belongs to the driver). */
  opts?: unknown;
}

/**
 * Host API: surface called by the lowered script's facade shim across the sandbox boundary. All
 * operations are serializable and asynchronous. `createActor` synchronously returns an opaque handle;
 * the session is created lazily on first live dispatch.
 *
 * `worldRead` carries an **array of positional arguments**, not an op-specific payload object:
 * `files.grep(pattern, glob?)` and `git.diff(base?, path?)` take multiple arguments, while
 * `git.status()` takes none, so a single-string signature is insufficient. Payload objects would put
 * op-specific branching in lowering—the place that should require no changes when adding a primitive.
 * Lowering passes arguments through unchanged; the driver owns each op's arity and validation (it is
 * the side that knows what a base ref looks like).
 */
export interface WorkflowHostApi {
  createActor(siteId: string, name?: string, persona?: string | PersonaSpec): ActorId;
  ask(siteId: string, actor: ActorId, instructions: string): Promise<unknown>;
  worldRead(siteId: string, op: WorldReadOp, args: unknown[]): Promise<unknown>;
  /**
   * Publish an intermediate result. **Fire-and-forget (synchronous signature, no return value), yet
   * has a site and must be journaled**—both halves of this design are necessary: the script is
   * publishing a finding, with nothing to await; the run panel and completion notification must not
   * show the same finding twice after resume, so it must be journaled.
   *
   * No driver round-trip: the engine records the node and emits an event in core (or silently skips on
   * a replay hit), then returns.
   */
  report(siteId: string, item: unknown, artifactId?: string): void;
  /**
   * Control flow passed a `phase("…")` marker. Synchronous, no return value, no driver round-trip,
   * and **no journal row**: the engine emits one `phase-entered` event and returns. `name` is extracted
   * from the literal by lowering and trimmed.
   */
  enterPhase(name: string): void;
  /**
   * Publish a **content artifact** (`artifact.file` / `artifact.markdown`). Effect: the driver copies
   * bytes to the store and records one journal row; on success it resolves to {@link ArtifactRef}, and
   * on failure it rejects in a way that can be **caught**.
   *
   * Like `worldRead`, `args` are positional arguments from the script call site (`[id, path, opts]`);
   * lowering packages them unchanged. This layer extracts only the id needed by the engine (for caps
   * and version numbers) and passes the rest through to the driver.
   */
  publishArtifact(siteId: string, op: ArtifactContentOp, args: unknown[]): Promise<ArtifactRef>;
  /**
   * Declare a **preset artifact** (`artifact.chart` / `table` / `metrics` / `board`). Synchronous, no
   * return value, and **does not go through the driver**: a declaration has nothing to await, so the
   * engine validates the spec, records the node, and emits an event in core.
   *
   * Any failure (invalid spec / same id with different spec / over limit) fails the run—void return
   * has no rejection channel, for the same reason as `report`.
   */
  declareArtifact(siteId: string, op: ArtifactPresetOp, args: unknown[]): void;
  log(message: string): void;
}

// ————————————————————————————————————————————————————————————————
// Boundary B：driver port
// ————————————————————————————————————————————————————————————————

/** Opaque reference to an actor session (a zcode session id in production). */
export interface SessionRef {
  readonly id: string;
}

/** Core's decision for one submit attempt, sent to the driver through respondToSubmit. */
export type SubmitVerdict =
  | { kind: "accept" }
  | { kind: "reject"; violations: Violation[] }
  | { kind: "nudge" };

/**
 * Downward port: effects the core requests the driver to perform. The core is a pure deterministic
 * state machine; effects and progress reporting live in the driver.
 * Journal and emit are owned by the driver: the core makes journal decisions through `driver.journal`
 * and fans out Boundary C through `driver.emit`.
 */
export interface WorkflowDriver {
  /**
   * Mint an actor session. `seed` is **present only when the actor consumed at least one imported ask
   * entry** (transcript truncation for amend-resume; see {@link ActorSessionSeed}): before returning,
   * the driver must copy the first `messageCount` messages from the source session into the newly
   * minted session. This must be **idempotent**—skip if the target session already has content, which
   * is the resume-after-crash case where the same session id is reattached (the driver deterministically
   * mints session ids from (runId, actorRef)).
   *
   * Parameter is optional: existing driver implementations with one fewer parameter remain valid in
   * TypeScript, and drivers without seed semantics (fakes, pure replay tests) can ignore it.
   */
  createActorSession(
    actor: ActorRef,
    persona: PersonaSpec,
    seed?: ActorSessionSeed,
  ): Promise<SessionRef>;
  startAsk(session: SessionRef, instance: InstanceRef, message: AskMessage): void;
  respondToSubmit(instance: InstanceRef, verdict: SubmitVerdict): void;
  cancelAsk(instance: InstanceRef): void;
  /**
   * Execute one world read. `args` are **positional arguments** from the script call site; lowering
   * packages them unchanged without validation. The driver owns arity and argument validation for each
   * op (see {@link WorkflowHostApi.worldRead}).
   */
  executeWorldRead(op: WorldReadOp, args: unknown[]): Promise<unknown>;
  /**
   * Publish content-artifact bytes: validate argument shape, resolve the workspace-relative path
   * (reject traversal), read bytes (probe with cap+1; reject over-limit content without truncating),
   * determine contentType by extension, write to the tool-artifact store, and return the persisted record.
   *
   * **Optional**: pure replay / fake setups have neither a store nor a filesystem. If absent, the
   * engine rejects this node with `ArtifactStoreUnavailable`—an explicit named failure, not a silent
   * downgrade (preset members are unaffected because they do not use the driver).
   */
  executeArtifactPublish?(request: ArtifactPublishRequest): Promise<ArtifactVersionRecord>;
  journal: JournalStorePort;
  emit(event: RunEvent): void;
  /**
   * Release resources after run settlement: the engine calls this exactly once after recording
   * `run-settled` on each terminal path (complete / cancel / fail). The production driver runs the
   * same session-shutdown path used by the app for every actor runtime (`closeBrowserSession` in the
   * runtime: beginShutdown + release node_repl session + close browser session) and clears its session
   * table; in-flight asks have already been aborted by cancelAsk. Optional: fake / pure replay setups
   * have nothing to release.
   */
  dispose?(): void;
}

/**
 * A model request for an in-flight ask is **waiting**:
 * - `cause: "slot"`: the next request is queued at the process-level admission gate (driver `tryAdmit` missed); no other fields.
 * - `cause: "backoff"`: the runner scheduled a retry (`model_retry_scheduled`), with reason / attempt / delayMs / retryAfterMs.
 *   `reason` is a contracts `ModelRetryReason` value (`rate_limited` / `provider_overloaded` / `server_error` /
 *   `network_error` / `timeout` / `stream_idle_timeout` / `stale_connection` / `offpeak_queued` …），
 *   This package does not import contracts, so it uses an open string. `delayMs` is relative; the engine has no clock.
 */
export interface AskWaitInfo {
  cause: "slot" | "backoff";
  reason?: string;
  attempt?: number;
  delayMs?: number;
  retryAfterMs?: number;
}

/** Reason for a process-level concurrency-cap change. */
export type ConcurrencyChangeReason =
  | "rate_limited"
  | "provider_overloaded"
  | "offpeak_queued"
  | "recovered"
  | "idle_reset";

/**
 * Governor adjustment to a provider key's cap, fanned out to every run with an in-flight or waiting
 * ask for that key. (Persisting a process-level fact once per run is acceptable redundancy: the
 * journal can explain "why this run slowed down.")
 */
export interface ConcurrencyChange {
  /** provider key（`${providerId}/${modelId}`）。 */
  key: string;
  previous: number;
  next: number;
  reason: ConcurrencyChangeReason;
  lastGood?: number;
  lastBad?: number;
  /** For rate limiting with Retry-After: duration to freeze new dispatches (relative value). */
  cooldownMs?: number;
}

/**
 * Upward surface: the driver reports session progress to the core. The core implements this interface
 * (the production driver holds its reference; in phase-one tests, the test directly plays the "model"
 * and calls these methods).
 */
export interface WorkflowReportSink {
  /** One submit attempt; after validation, the core sends its decision back through respondToSubmit. */
  askSubmitAttempted(instance: InstanceRef, payload: unknown): void;
  /** A turn ended without submission: the core decides whether to nudge or settle an untyped ask from finalText. */
  askTurnEnded(instance: InstanceRef, finalText: string): void;
  /**
   * Progress observation from one parsed turn: the engine only records it as `node-progress` and makes
   * no decisions from it. **Must be called before askStats for the same turn**—event ordering is part
   * of the read-surface contract. Calls arriving after run settlement are ignored.
   */
  askProgress(instance: InstanceRef, progress: AskProgress): void;
  /** Usage stats: accumulate run usage and broadcast usage / instance updates. */
  askStats(instance: InstanceRef, stats: AskStats): void;
  /** Unrecoverable driver-side error; settle this ask as failed. */
  askFailed(instance: InstanceRef, error: WorkflowError): void;
  /**
   * Deterministic model-side error: **do not** settle the node; stop the entire run as
   * `stopped(provider)` instead (abort all in-flight asks, as with cancel). `error.code` must be
   * `ProviderStop`. Calls arriving after run settlement are ignored.
   */
  stopRun(error: WorkflowError): void;
  /** Run-level stall observation: the engine only records it. */
  runStalled(info: RunStallInfo): void;
  /**
   * Three pure observations: the engine only records them and makes no decisions.
   * Calls arriving after run / node settlement are ignored.
   */
  /** The ask's next model request is waiting: at the process-level admission gate (slot) or in runner backoff. */
  askWaiting(instance: InstanceRef, info: AskWaitInfo): void;
  /** A model request for the ask was actually sent (`model_request_started`, and it was not executing beforehand). */
  askExecuting(instance: InstanceRef): void;
  /**
   * The subagent for this ask is **about to** execute a workspace-mutating tool:
   * the engine closes the import cache. This is the only driver observation that affects an engine
   * decision—the cache contains answers about the predecessor's world, which ceases to exist after
   * the first write. Report before the tool acts (after PreToolUse, before the handler), so the cache
   * closes before the first byte is written. Calls arriving after run / node settlement are ignored.
   */
  askMutating(instance: InstanceRef): void;
  /** The process-level governor adjusted the cap for this run's provider key. */
  concurrencyChanged(change: ConcurrencyChange): void;
}

// ————————————————————————————————————————————————————————————————
// Boundary C: run events
// ————————————————————————————————————————————————————————————————

/**
 * Node kinds: ask, world-read, world-run, or report (the last three have no actor or actorSeq).
 * `world-run` is the journaled command execution for world.run—the mechanism matches world-read, but
 * it has its own kind so the audit surface is accurate (an effect should not masquerade as a read).
 * `report` has a journal row but is not a node in either graph—it reports progress, not ordering.
 * `artifact` is one publication or declaration of a **user-facing artifact**; like `report`, it has a
 * row but no node because a deliverable is not a step someone waits for. ⚠ Unrelated to
 * `RunSettlement.artifact` (the top-level return value).
 */
export type NodeKind = "ask" | "world-read" | "world-run" | "report" | "artifact";

/**
 * **Bounded** input for one world-read / world-run node (`dwf_node.input_json`). `args` retain their
 * positional shape, but if serialized size exceeds {@link WORLD_READ_INPUT_MAX_BYTES}, each item is
 * reduced to a string preview and `truncated` is set. The audit surface should say "truncated"
 * honestly rather than putting an entire 200 KB `node -e` script into a frequently read table.
 */
export interface WorldReadInput {
  op: string;
  args: unknown[];
  truncated?: true;
}

/** Byte limit for serialized `WorldReadInput` (4 KB). */
export const WORLD_READ_INPUT_MAX_BYTES = 4096;

/** Semantic result of node settlement. Replay hits are distinguished by the event's `cached` flag, not included here. */
export type NodeOutcome = "ok" | "failed" | "cancelled";

/**
 * Run lifecycle status. Three terminal states:
 * - `completed`: the script returned;
 * - `errored`: script error (script threw, or engine contract was violated)—cannot resume; only amend with `resume_from`;
 * - `stopped`: the run was stopped (`RunStopReason`), **always resumable**.
 *
 * The physical `dwf_run.status` column retains its legacy five values (`failed` / `cancelled`) and is
 * not migrated: this is the **logical** vocabulary. Mapping between old and new values exists only in
 * SQLite repository codecs (`adapters/dwf-journal-codecs.ts`).
 */
export type RunStatus = "pending" | "running" | "completed" | "errored" | "stopped";

/**
 * Why the run stopped: `user` (user cancellation) / `model` (main-agent TaskStop) / `provider`
 * (deterministic model-side error; see `ProviderStop`) / `interrupted` (owning-process death, sandbox
 * crash / timeout / protocol corruption—host-side issues that may resolve on retry) / `superseded`
 * (stopped and replaced by AmendWorkflow; successor id is in `supersededBy`; **not resumable**—the
 * successor is active).
 */
export type RunStopReason = "user" | "model" | "provider" | "interrupted" | "superseded";

/**
 * Run-event vocabulary (Boundary C). Emit an event for every state transition worth observing.
 * `compaction` is reserved for long-context compaction—v1 never emits it; it is a placeholder for a
 * future non-breaking addition.
 */
export type RunEvent =
  | { type: "run-started"; runId: string; caps: Caps }
  /**
   * Launching turn: `inputId` is the inputId of the parent-session turn that launched this run (a UUID
   * v7 minted for direct central launches). **Recorded once when the run is created**, immediately
   * after the first `run-started`; a resumed `run-started` does not repeat it, so subagent steps for
   * the same run always remain attached to the same message. No SQL: the anchor lives in the journal
   * event, not a dwf_run column (intentionally no migration).
   * `phaseNames` is the script's declared phase list (declaration order), populated by the submitter
   * from the causality graph; the sidebar mini-track uses it to draw upcoming stations. Also recorded
   * once and reconstructed freely on cold replay; omitted if the script has no `phase()` markers.
   * `subagentModel` is the model used by this run's subagents, in canonical
   * `providerId/modelId[$reasoningLevel]` form. Like the anchor and phase list, this is host metadata:
   * the engine **never reads it**, and it is recorded only once on the initial run event. On resume and
   * both read surfaces, the host reads the same string from the event header (subagent model selection
   * order is this field > resume pin > parent-session model; see bootstrap `workflow-actor-model.ts`).
   * Again, no SQL—it is not a dwf_run column. Omission means subagents use the session model.
   * `phaseAlongside` is **position-aligned** with `phaseNames`: `phaseAlongside[i]` contains indexes
   * from the same `phaseNames` list for other phases whose strands were still running when
   * `phaseNames[i]` was entered. The sidebar uses this to draw a double segment between parallel
   * stations; omitted when no phases run alongside, meaning "this track is a straight line."
   * `scriptPath` is the file the script **came from** (absolute path). It follows the same rules as
   * `subagentModel`: never read by the engine, recorded once when the run is created, no SQL, and read
   * back from the event header on both read surfaces. Omitted when this run has no editable script
   * file (draft write failed, or the run predates this feature), so the model falls back to the legacy
   * inline-resubmission guidance.
   */
  | {
      type: "run-launched";
      inputId: string;
      toolCallId?: string;
      parentSessionId?: string;
      phaseNames?: string[];
      subagentModel?: string;
      scriptPath?: string;
      phaseAlongside?: number[][];
    }
  /**
   * `phaseName` records the latest phase name specified by `enterPhase` when the instance was created.
   * Appears only on **creation events**—actor `actor-created`, node `node-queued`, and
   * `node-settled { cached: true }` when a cache hit (replay / amend-resume) replaces queued. Other
   * `node-*` events omit it; reducers carry it forward, following the `actorSiteId` precedent.
   * Instances created before any marker omit the field entirely.
   *
   * It is **not** the current phase when the event is emitted: hold rules may delay node-queued until
   * after the next marker even though the instance was created in the previous phase.
   */
  | {
      type: "actor-created";
      actor: ActorRef;
      name?: string;
      persona?: PersonaSpec;
      phaseName?: string;
    }
  | {
      type: "node-queued";
      instance: InstanceRef;
      kind: NodeKind;
      actor?: ActorRef;
      actorSeq?: number;
      phaseName?: string;
      /**
       * First {@link INSTRUCTIONS_HEAD_MAX_CHARS} characters of the author's instructions (trimmed,
       * no ellipsis), present only on ask nodes. The only answer on the event stream to "what is this
       * subagent doing?": full instructions exist only in `dwf_node.input_json`, and read surfaces
       * (run details, GetWorkflowRun) do not query that table for a one-line summary.
       *
       * Uses the instructions at **admission time**, before the engine appends its suffix—the suffix is
       * the engine's text, not the author's.
       */
      instructionsHead?: string;
    }
  /**
   * Dispatch: the driver was told to start. For asks, this event **repeats its own creation facts**—
   * `kind` / `actor` / `phaseName` / `instructionsHead` exactly match this instance's `node-queued`,
   * while `actorName` / `actorPhaseName` are the `name` / `phaseName` carried by its subagent's
   * `actor-created` event.
   *
   * Why repeat facts already emitted: the read-side table is **bounded**, and the important moment is
   * dispatch, not queueing. A run with 2,000 agents may emit every `actor-created` / `node-queued`
   * event in the first few seconds; the table can fill with the first 1,024 queued items before any
   * settle, leaving every instance that is **actually running** out of the table. Including creation
   * facts makes this a self-contained creation event: readers can add the instance and its subagent
   * without looking up a queued event that may already have been evicted.
   *
   * Both phase names are **creation stamps**, not the current phase when this event is emitted: an ask
   * may wait behind the concurrency limit while the script has already entered a later phase (see
   * engine-phase-stamp.ts; it reads the table written at creation time). world-read dispatch does not
   * carry these keys: it immediately follows its own `node-queued` and has no subagent.
   */
  | {
      type: "node-dispatched";
      instance: InstanceRef;
      kind?: NodeKind;
      actor?: ActorRef;
      actorName?: string;
      actorPhaseName?: string;
      phaseName?: string;
      instructionsHead?: string;
    }
  | { type: "node-repairing"; instance: InstanceRef; attempt: number; violations: Violation[] }
  | { type: "node-nudged"; instance: InstanceRef }
  /**
   * Three adaptive-concurrency observation events. Like escalation, the engine core makes no decisions
   * from them; they are facts observed by the driver / governor, recorded in the journal and fanned out
   * through the engine's `record()`. `node-waiting` ⇄ `node-executing` is a self-loop between dispatch
   * and settlement (`executing` thereby becomes an **observable** phase); it does not change the
   * node's journal record (no dwf_node write).
   */
  | ({ type: "node-waiting"; instance: InstanceRef } & AskWaitInfo)
  | { type: "node-executing"; instance: InstanceRef }
  | ({ type: "concurrency-changed" } & ConcurrencyChange)
  /**
   * This run's **own** concurrency limit changed in place: an amendment that changes only
   * `max_concurrency` applies to the live run, keeping the same runId, minting no successor, and
   * retaining every in-flight ask.
   *
   * It belongs to **a different limit** than the adjacent `concurrency-changed`: that one is the
   * process-level shared-cap observation from the governor (measured in model requests; the engine
   * only records it). This event is the limit on this run's in-flight asks and is the result of a
   * **command**—changing caps, writing `dwf_run.caps_max_concurrency`, and emitting this event happen
   * in one synchronous step and always agree. `previous` is the value before the change; readers need
   * it to report "8 → 2," which cannot be inferred from a single cap value.
   */
  | { type: "run-caps-changed"; runId: string; caps: Caps; previous: Caps }
  | {
      type: "node-settled";
      instance: InstanceRef;
      outcome: NodeOutcome;
      cached?: boolean;
      error?: WorkflowErrorJson;
      /** Present only when `cached: true`: a cache-hit node has no queued event, so this is its creation event. */
      phaseName?: string;
    }
  /**
   * Progress of one ask during a parsed turn.
   * Like escalation / concurrency observations, **the engine core does not interpret it**; it only
   * records it. It does not change scheduling decisions, enter inputHash, or participate in replay
   * comparisons. The order of two events from the same turn is meaningful: this event precedes
   * `usage-updated`, so a reader seeing new usage has already seen the progress that produced it.
   */
  | ({ type: "node-progress"; instance: InstanceRef } & AskProgress)
  /** Run-level token usage update: carries the total spent so far (written to journal spent_tokens in sync; they always match). */
  | { type: "usage-updated"; spentTokens: number }
  | { type: "log"; message: string }
  /**
   * The amend-resume import cache was closed: a live subagent is about to modify the workspace
   * (`cause: "mutating-tool"`, with its effective name in `actorName`), or a `world.run` is executing
   * live (`cause: "world-run"`). At most one event per run. If an amended run crashes, resume uses this
   * event to restore "gate closed"—the **only** source of truth for closure, no longer inferred from
   * "an ask was live." Non-amended runs have no cache to close, so they emit no event.
   */
  | {
      type: "import-cache-closed";
      instance: InstanceRef;
      cause: ImportCloseCause;
      actorName?: string;
    }
  /**
   * Control flow passed a `phase("…")` marker. **No site, journal row, or driver round-trip**—a
   * marker is not a unit of work; it is a tick indicating "how far the script has progressed."
   * `name` is the author's original wording (trimmed, and also the key the analyzer uses to mint phase
   * ids). `ordinal` counts by name, and the event is emitted **on every evaluation**: re-entering the
   * same phase increments it, and the analyzer likewise interprets the second same-name marker as a
   * back edge. When resume reruns the script, it emits the prefix again (no journal row exists for
   * deduplication); consumers are protected by monotonic reduction.
   */
  | { type: "phase-entered"; name: string; ordinal: number }
  /**
   * One published intermediate result, exactly once for each **non-skipped** report call (a replay hit
   * silently skips it and does not emit again). Uses the same route as other run events (progress sink
   * → bounded session event → projection reducer), ending in the run panel's Results section.
   *
   * When `artifactId` is present, this item was also supplied to that preset artifact
   * (`report(item, "perf")`); the projection increments its `itemCount`, and the board hook uses the
   * count change as a signal to fetch incremental data.
   */
  | { type: "report"; instance: InstanceRef; item: unknown; artifactId?: string }
  /**
   * A new version of a **user-facing artifact** is ready: one event per successful content publication
   * and per persisted preset declaration (no event for an idempotent no-op). Like report, replay hits
   * do not re-emit; cold recovery reads from the journal.
   *
   * The success path emits **only this event**, no node-lifecycle events (node-queued / dispatched /
   * settled). Same rationale as `report`: an artifact is a deliverable, not a step that someone can
   * wait for, so it is not a node in either graph.
   */
  | { type: "artifact-published"; instance: InstanceRef; artifact: ArtifactVersionRecord }
  /**
   * One content-artifact publication failed (the node is persisted as `failed`, and the script receives
   * a rejection it can catch).
   *
   * **Intentionally does not reuse `node-settled{failed}`**: readers of that event reduce it into
   * `nodes[]` and require a matching site in the graph, but artifact sites **are not in either graph**.
   * A node-settled event on such a site would appear as an unexplained "unknown node" in the run panel,
   * and the graph layer would report an unknown site id. Publication failures therefore need their
   * own event with enough data for a failure card (id / kind / structured error), without masquerading
   * as a unit of work. **Do not re-emit** when replay hits a failed record (same as report / artifact-published).
   */
  | {
      type: "artifact-failed";
      instance: InstanceRef;
      id: string;
      op: ArtifactContentOp;
      error: WorkflowErrorJson;
    }
  | { type: "compaction"; actor: ActorRef }
  /**
   * An actor escalated a blocking question to the main agent and is parked in its ask while waiting for an answer.
   *
   * **The engine core never emits these two events**—the driver emits them at the ask boundary (at
   * the same level as repair / nudge turns); the zero-I/O state machine is unaware of escalation.
   * They still live in this vocabulary because they use the same two paths as all run events (journal
   * dwf_event + live fan-out through driver.emit), whose shape is defined by `RunEvent`. Escalation
   * **does not write a dwf_node row** (waiting is not work).
   */
  | {
      type: "escalation-raised";
      qid: string;
      actor: ActorRef;
      /**
       * Actor's **effective name** (= `spec.name` after `normalizePersona`, also the value on the
       * `actor-created` event and used as the amend-resume cache identity key). Omitted for anonymous
       * actors; no fallback label is synthesized—each consumer decides how to render "unnamed."
       */
      actorName?: string;
      question: string;
      context?: string;
      /**
       * Time the question was asked (epoch milliseconds). **Required**: the reader's first question is
       * always "how long has this question been waiting?" There is no other clock on the event stream—
       * `dwf_event.time_created` exists only on the durable path, not the live path (driver.emit →
       * progress sink → sidebar). If the UI fell back to local receipt time, cold replay would make
       * every historical question look newly asked.
       *
       * **Same instant** as snapshot `pendingQuestions[].askedAt` (the driver calls `Date.now()` once
       * and shares it between the event and parked-question record), so wait durations match across both read surfaces.
       */
      askedAt: number;
    }
  | { type: "escalation-resolved"; qid: string; answer: string }
  /** Run-level stall observation (see {@link RunStallInfo}); calls received after settlement are ignored. */
  | ({ type: "run-stalled" } & RunStallInfo)
  /**
   * `stopReason` is present only when `status === "stopped"`; `error` is always present for `errored`,
   * and for `stopped` only with `provider` (`ProviderStop`) or `interrupted` (`Interrupted`).
   */
  | {
      type: "run-settled";
      status: RunStatus;
      stopReason?: RunStopReason;
      /** Present when `stopReason === "superseded"`: successor run minted by the amendment that stopped this run. */
      supersededBy?: string;
      error?: WorkflowErrorJson;
    };

// ————————————————————————————————————————————————————————————————
// Journal storage port + records
// ————————————————————————————————————————————————————————————————

/** dwf_run record (the core depends only on caps/status/failure; other fields are reserved for phase-two shaping). */
export interface RunRecord {
  runId: string;
  parentSessionId?: string;
  cwd?: string;
  /**
   * User-provided run name (optional `input.name` on `CreateWorkflow`). Display metadata only: the
   * engine does not read it. Persisted with scriptText / cwd only on createRun so the host's listing
   * surface can use it as a label; otherwise cross-session lists would contain only bare runIds.
   * Omitted if unnamed (readers fall back to the first script line without writing it back).
   */
  name?: string;
  /**
   * CreateWorkflow tool-call id that launched this run. Host metadata only: the engine does not read
   * it; it is persisted with scriptText / cwd only on createRun. This is the only join anchor left
   * after restart—`workflowRuns` projection does not survive across processes, so tool-card joins and
   * resume-notification anchors can only be restored from here.
   */
  toolCallId?: string;
  scriptText?: string;
  scriptHash?: string;
  /**
   * Arguments for this run (declarative parameters of a saved workflow, validated with defaults filled in).
   *
   * Part of the run's **identity**, at the same level as `scriptText`, not display metadata: resume
   * replays the saved arguments and never accepts new ones—new arguments mean a different run and
   * require a new confirmation window. Omission (NULL on legacy rows) means `{}` and is not backfilled
   * (invariants 6/7).
   */
  args?: Record<string, unknown>;
  /**
   * Lineage pointer for amend-resume: the predecessor run this run was amended from. Host metadata;
   * the engine does not read it, and it is persisted with the other metadata only on createRun.
   * Amendments **supersede**—new runId, new script, predecessor row untouched—so this pointer is the
   * only connection between them. Resume uses it to rebuild the import cache (`port.resume` rebuilds
   * ImportedCache when present), and the UI uses it for "continued from run X." Omitted for runs that
   * are not amendments (the vast majority).
   */
  resumedFrom?: string;
  caps: Caps;
  /** Cumulative token usage (observation surface, not control surface). */
  spentTokens: number;
  status: RunStatus;
  /** Present when `status === "stopped"` (absent on legacy rows decodes to `user`; see repository codecs). */
  stopReason?: RunStopReason;
  /** Present when `stopReason === "superseded"`: successor run replacing this one (the other endpoint of its `resumedFrom` edge). */
  supersededBy?: string;
  failure?: WorkflowErrorJson;
  /** Script's top-level return value. Present only for completed runs (an `undefined` result omits the whole field). */
  result?: unknown;
}

/** dwf_actor record, unique on (runId, siteId, ordinal). */
export interface ActorRecord {
  runId: string;
  siteId: string;
  ordinal: number;
  name?: string;
  persona?: PersonaSpec;
  sessionId?: string;
  /**
   * Model this actor actually used (`providerId/modelId`), written by the driver.
   *
   * Why this is not part of `persona`: persona is frozen identity written synchronously by the engine
   * on createActor, while model is a host fact (the parent session's selection **at that time**) that
   * the engine cannot see. Separate fields give identity and host facts distinct owners; each writer
   * owns its value.
   *
   * Why persist it: run costs become auditable, and resume can reattach to the **same** model. If the
   * parent session changes its main model between runs, the latter part of the same run will not
   * silently switch models (pin; see bootstrap's
   * workflow-actor-model.ts）。
   *
   * Like `sessionId`, this is a driver-owned field: engine putActor only carries the existing value
   * through unchanged (see createActor in engine.ts and ensureSession in scheduler.ts); it never
   * creates the value itself.
   */
  resolvedModel?: string;
}

/**
 * Persisted node status. A node is persisted as `running` **at admission** (with actorSeq and
 * inputHash), then updated to completed / failed at settlement. Thus a node interrupted by a crash
 * retains a `running` record in the journal and is live-dispatched again at the recorded actorSeq on
 * resume (rather than treated as a completed result and short-circuited).
 *
 * **report nodes are the only exception to this two-write rule**: they are written once and persisted
 * as `completed` immediately—there is no driver call between admission and settlement that could fail.
 */
export type NodeRecordStatus = "running" | "completed" | "failed";

/**
 * dwf_node record. Unique on (runId, siteId, ordinal); asks additionally use
 * (runId, actorSiteId, actorOrdinal, actorSeq). world-read and report have empty actor* and actorSeq;
 * report rows also satisfy: one write, status always `completed`, `result` is the reported item, and
 * `inputHash` covers that item (defensive comparison on replay hits).
 */
export interface NodeRecord {
  runId: string;
  siteId: string;
  ordinal: number;
  kind: NodeKind;
  actorSiteId?: string;
  actorOrdinal?: number;
  actorSeq?: number;
  inputHash: string;
  status: NodeRecordStatus;
  result?: unknown;
  error?: WorkflowErrorJson;
  stats?: AskStats;
  /**
   * Id of a **user-facing artifact** (`dwf_node.artifact_id` column). Present on two kinds of rows:
   * `kind: "artifact"` (the artifact being published / declared) and tagged `kind: "report"` (the
   * preset that received the item). The latter grounds the invariant "board = journal projection":
   * each board point is one row with `kind = report ∧ artifact_id = ?`. Empty on other rows.
   */
  artifactId?: string;
  /**
   * **Only for world-read / world-run nodes**: op and arguments actually executed at this site,
   * **bounded** by {@link WorldReadInput}. `inputHash` answers only "was the input the same?" not
   * "what was the input?"—the workspace transcript needs to say *what ran*, not just *something ran*.
   * Written at admission (in the same putNode as `inputHash`) and carried through unchanged by the
   * settlement upsert. Omitted for rows from before 0030 and for asks / reports / artifacts.
   */
  input?: WorldReadInput;
  /**
   * **Ask nodes only**: length of the actor session's message log after this ask's full exchange ends
   * (including repair / nudge turns and cleanup messages after submit)—a count offset, not a message-id range.
   *
   * Driver-owned backfilled field (like `stats`, persisted through getNode + putNode read-modify-write); the
   * engine does not create it. Store a count rather than an id range because counts are **invariant
   * under prefix copying**: copy the first N messages from the source session to a new one, and all
   * message ids change while the count stays the same, so the copied ask's boundary remains valid in
   * the new session. This underpins full-fidelity transcript truncation for amend-resume and chained amendments.
   */
  messageBoundary?: number;
}

/** One persisted event; sequence is assigned monotonically by appendEvent. */
export interface StoredEvent {
  sequence: number;
  event: RunEvent;
  /**
   * Time when the storage layer appended this event (epoch milliseconds). The only clock for all
   * "how long ago" values in the event log: age of a log row, a subagent's latest action, or run stall
   * duration must all be derived from it. Falling back to a reader's `Date.now()` is wrong—it would
   * label a week of history as "just now" during cold replay.
   *
   * Optional in the type so test doubles implementing the port keep compiling; both **real**
   * implementations (SQLite `time_created` column, in-memory append timestamp) must populate it, and
   * contract tests enforce this.
   */
  timeCreated?: number;
}

/**
 * Event pagination input (cursor = journal sequence). The app's run-details page incrementally fetches
 * the event log this way: returning everything would load the entire journal into memory for each page.
 */
export interface ListEventsOptions {
  /** Return only events with a sequence **strictly greater** than this value. Cursor is the last sequence read, not an offset. */
  afterSequence?: number;
  /** Maximum number of items per page; unlimited when omitted. */
  limit?: number;
}

/**
 * Persisted data attached to run settlement. Exists for **single-write atomicity**: separate UPDATEs
 * for terminal status and result could crash between writes, creating a `completed` run whose result
 * cannot be recovered. Omitted keys mean "do not touch this column" (used by the engine's `running`
 * write and historical rows from before the column was introduced).
 */
export interface RunSettlementRecord {
  /** Written with `status === "stopped"`; omitted for other states. */
  stopReason?: RunStopReason;
  /** Written atomically with `stopReason === "superseded}` (the stopped envelope is rewritten as a whole; separate writes could lose data). */
  supersededBy?: string;
  failure?: WorkflowErrorJson;
  result?: unknown;
}

/**
 * Journal storage port: repository-style synchronous methods, with no SQL leakage. The in-memory
 * implementation is in journal-memory.ts; SQLite and in-memory implementations share this port.
 * Legacy test entry points were removed with Vitest cleanup, avoiding a production compile-time
 * dependency on an undeclared test framework.
 */
export interface JournalStorePort {
  createRun(record: RunRecord): void;
  getRun(runId: string): RunRecord | undefined;
  updateRunStatus(runId: string, status: RunStatus, settlement?: RunSettlementRecord): void;
  /**
   * Persist cumulative token usage separately (a frequent small write outside run settlement). Throw
   * for an unknown runId; never touch status / failure—usage updates and run settlement are separate
   * write paths.
   */
  updateRunUsage(runId: string, spentTokens: number): void;
  /**
   * Persist this run's concurrency limit separately (`dwf_run.caps_max_concurrency`). Throw for an
   * unknown runId; **touch only this column**—status, usage, and settlement payload are outside this
   * write, as with {@link updateRunUsage}.
   *
   * This is the **second writer** of that column (the first is {@link createRun}): an amendment that
   * changes only `max_concurrency` applies to the live run, while resume reuses the caps on the row—
   * without persisting the update, resume would restore the old limit.
   */
  updateRunCaps(runId: string, caps: Caps): void;

  putActor(record: ActorRecord): void;
  getActor(runId: string, siteId: string, ordinal: number): ActorRecord | undefined;
  listActors(runId: string): ActorRecord[];

  putNode(record: NodeRecord): void;
  getNode(runId: string, siteId: string, ordinal: number): NodeRecord | undefined;
  listNodes(runId: string): NodeRecord[];

  appendEvent(runId: string, event: RunEvent): StoredEvent;
  /**
   * List events in ascending sequence order. Omitted `opts` means all events (legacy behavior); when a
   * cursor / limit is supplied, filtering must happen in the storage layer, not by fetching all rows
   * and slicing—the purpose of pagination is to avoid loading the entire journal into memory.
   * Unknown runId and out-of-range cursor both return an empty array (no error): during race windows
   * between the projection and journal, a client may normally return a cursor that does not exist
   * yet.
   */
  listEvents(runId: string, opts?: ListEventsOptions): StoredEvent[];
}

// The driver's ask observation vocabulary (usage + progress) lives in ask-observation-types.ts
// (same as above); re-export it here to preserve the import path.
export {
  INSTRUCTIONS_HEAD_MAX_CHARS,
  LAST_TOOL_NAME_MAX_CHARS,
  LAST_TOOL_TARGET_MAX_CHARS,
} from "./ask-observation-types.js";
export type { AskLastTool, AskProgress, AskStats } from "./ask-observation-types.js";

// ————————————————————————————————————————————————————————————————
// Import cache (amend-resume)
// ————————————————————————————————————————————————————————————————

// The import-cache data structures live in imported-cache-types.ts (split out when this file hit
// its max-lines limit); re-export them here to preserve the import path.
export type {
  ActorSessionSeed,
  ImportedActorCandidate,
  ImportedAskEntry,
  ImportedInFlightAsk,
  ImportedRunCache,
  ImportedWorldEntry,
} from "./imported-cache-types.js";

// ————————————————————————————————————————————————————————————————
// Policy constants (part of this contract)
// ————————————————————————————————————————————————————————————————

/** Maximum in-node repair (retry after rejection) attempts: 3. */
export const REPAIR_ATTEMPTS = 3;

/** Maximum nudges when a turn ends without a submission: 1. */
export const NUDGE_ATTEMPTS = 1;
