// ============================================================
// Shared types for the AgentRuntime-backed WorkflowDriver.
// ============================================================
// workflow-driver.ts reached oxlint's max-lines limit (400), so its dependency bundle
// (AgentRuntimeWorkflowDriverDeps), runtime factory signature (ActorRuntimeFactory), and
// per-actor session state (SessionState) were moved here for use by workflow-driver.ts,
// workflow-driver-escalation.ts, and workflow-driver-helpers.ts. The public surface
// (ActorRuntimeFactory) is still exported from workflow-driver.ts. This file contains types only;
// no runtime code.

import type {
  ExecutionPort,
  FileSystemPort,
  Logger,
  ModelRequestAdmission,
  SessionId,
  SubmitVerdict as ContractsSubmitVerdict,
  ToolArtifactStorePort,
  WorkflowEscalatePort,
  WorkflowSubmitPort,
} from "@zcode/contracts";
import type { AgentRuntime } from "@zcode/core";
import type {
  ActorSubmitProfile,
  ActorRef,
  ActorSessionSeed,
  InstanceRef,
  JournalStorePort,
  PersonaSpec,
  RunEvent,
  SessionRef,
} from "@zcode/dynamic-workflow";
import type { ActorTranscriptStore } from "./workflow-actor-transcript.js";
import type { WorkflowConcurrencyPort } from "./workflow-concurrency-governor.js";
import type { ActorModelActivity, WorkflowClock } from "./workflow-driver-concurrency.js";
import type { ActorSessionQuiescence } from "./workflow-driver-quiescence.js";
import type { WorkflowEscalationRegistry } from "./workflow-escalation-registry.js";
import type { WorkflowRunSeatGate } from "./workflow-seat-gate.js";

/** A promise that can be resolved externally. */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

/**
 * Actor runtime factory: given a session ID / actor / persona / session-level submit port,
 * produce an assembled child AgentRuntime. Injecting submitPort registers the submit_result
 * tool for that session (core uses port presence as the registration gate).
 *
 * Make runtime construction injectable: production wraps createScriptWorkflowAgentRuntime
 * (with the real model adapter and full deps); tests use a minimal deps bag and scripted model
 * adapter. The driver itself handles only lifecycle and bridging.
 *
 * May return a Promise: production must persist the actor session and create its task link before
 * returning, and `session_task_link.child_session_id` has a foreign key to `session(id)`, so the
 * session row must exist before the link. The engine's ensureSession awaits createActorSession,
 * making this await safe; persistence is complete before the first ask is dispatched.
 */
export type ActorRuntimeFactory = (input: {
  sessionId: SessionId;
  actor: ActorRef;
  persona: PersonaSpec;
  submitPort: WorkflowSubmitPort;
  /**
   * Submit profile for this actor. The factory uses it to choose the submit_result registration:
   * `untyped` → **do not inject** submitPort (core registers the tool only when a port is present,
   * so no tool is added); `mono` → inject the port + `workflowSubmitSchema` (typed declaration);
   * `generic` → inject only the port (the current generic declaration). The driver looks it up
   * by actor site in deps.actorSubmitProfiles; missing means generic.
   */
  submitProfile: ActorSubmitProfile;
  /**
   * Session-level escalation port. Injection matches submitPort exactly: port presence registers
   * `escalate` for this session (core's registration gate checks for the port). **Always inject;
   * do not opt in**—the actor most likely to hit an unforeseen blocker is the one the author did
   * not mark.
   */
  escalatePort: WorkflowEscalatePort;
  /**
   * Session seed for amend-resume, present only if this actor consumed at least one imported ask entry.
   *
   * The factory needs only one field: `resolvedModel` is the **model pin resolved from the
   * predecessor** and must override level re-resolution just like the journal pin. Silently
   * changing models while continuing a transcript is the identity change the pin prevents.
   * Transcript copying itself does not belong to the factory; the driver performs it **after**
   * the factory returns (the session row must exist first because `message.session_id` has a
   * foreign key to `session(id)`).
   */
  seed?: ActorSessionSeed;
  /**
   * Model-request admission port for this actor runtime. Present only when the driver has a
   * governor port; the factory places it in runtime deps as `modelRequestAdmission`, and the
   * runner checks it before every model request attempt. If absent, this runtime is not gated.
   */
  modelRequestAdmission?: ModelRequestAdmission;
}) => AgentRuntime | Promise<AgentRuntime>;

/** Dependencies for constructing an AgentRuntime-backed driver (journal and emit are provided and retained by the caller/harness). */
export interface AgentRuntimeWorkflowDriverDeps {
  journal: JournalStorePort;
  emit: (event: RunEvent) => void;
  /** Filesystem port for world-read (files.glob / files.read / files.grep). */
  fileSystemPort: FileSystemPort;
  /**
   * Child-process execution port for git.* world-read (cwd = workspace root).
   *
   * **Required, not optional**: making this optional would create a silent-degradation path—
   * `git.*` works in production but silently becomes "not a git repo" in an assembly that forgot
   * the wiring, and the two failures look identical to the script. Prefer a compile-time wiring
   * error (as already done for fileSystemPort in this package).
   */
  executionPort: ExecutionPort;
  /**
   * Parked-question registry for escalations. The driver registers parked questions here, and
   * the run service's `resolveQuestion` sends answers back through the same registry.
   *
   * **Required, not optional**, for the same reason as executionPort above: optional wiring
   * creates a silent-degradation path. Without the registry, `escalate` could hang forever (worst
   * case) or silently degrade to "this capability is unavailable," which looks identical to the
   * model as "the author did not grant the actor escalation." Prefer a compile-time wiring error.
   */
  escalationRegistry: WorkflowEscalationRegistry;
  /** Workspace root used as the shared path-resolution base for world-read and artifact publishing. */
  cwd: string;
  /**
   * Byte destination for user-facing artifacts (`artifact.file` / `artifact.markdown`). Here,
   * artifact means **output delivered to the user**, not the engine-internal artifact (the
   * top-level `RunSettlement.artifact` return value, which is for the model).
   *
   * **Optional**, for the same reason as `actorTranscriptStore`: assemblies without a store
   * (pure replay, fake driver, minimal stub) have nowhere to put bytes. Absence is **not silent
   * degradation**; content methods reject the node with `ArtifactStoreUnavailable` (catchable by
   * the script, and the node is journaled as failed) instead of writing into the workspace or
   * publishing an empty artifact. Predeclared artifacts (chart/table/…) are unaffected; they are
   * declarations and do not pass through the driver.
   */
  artifactStore?: ToolArtifactStorePort;
  /**
   * Parent session ID for this run, **used only for artifact publishing**: store writes are
   * scoped by session (`zcode-artifact://<session>/<id>`), and that scope is the parent session.
   *
   * Paired with `artifactStore` (production assembly supplies both from the same app session).
   * If only one is present, publishing still fails loudly with `ArtifactStoreUnavailable`; see
   * {@link ArtifactPublishDeps}. Actor session IDs do not use this field; they are minted by
   * mintActorSessionId.
   */
  parentSessionId?: SessionId;
  /**
   * Approved command set for world.run (collected from compile-time literals).
   * Structurally part of {@link WorldReadDeps}: missing means reject all world.run calls (fail-closed).
   */
  declaredRunCommands?: ReadonlySet<string>;
  /**
   * Submit profile for each actor site, computed at compile time by
   * `deriveActorSubmitProfiles` (compileOnce in the run submission path). Optional: when absent,
   * every actor is generic (historical behavior), so assemblies without profiles (snippets, fake
   * drivers, existing tests) remain unchanged.
   */
  actorSubmitProfiles?: ReadonlyMap<string, ActorSubmitProfile>;
  runtimeFactory: ActorRuntimeFactory;
  /**
   * Narrow port to the process-level concurrency governor. When present, the driver gives every
   * actor runtime a `ModelRequestAdmission` (passed through runtimeFactory into runtime deps); the
   * runner checks the gate before **every model request attempt**, and this run subscribes to cap
   * changes and fans them out as `concurrency-changed`. When absent, actors are not gated (fake
   * / pure replay assemblies need no changes). The engine is unaware of this (v1's `acquireSlot`
   * was removed).
   */
  concurrency?: WorkflowConcurrencyPort;
  /**
   * Seat gate for this run: if this run's **own** concurrency cap is lowered mid-run, excess
   * subagents stop before their next turn step. When present, the driver does two things: wraps
   * each actor's admission port with the gate, and feeds ask start/end signals to it (startAsk and
   * the engine's `node-settled`; see workflow-driver.ts).
   *
   * Optional: when absent, this run's cap never changes mid-run (for example, snippet assemblies
   * without dynamic concurrency adjustment), and the admission port behaves exactly as before.
   * **Presence also leaves runs whose cap is never lowered unchanged**: requests below the cap
   * pass immediately, and the gate emits no events or holds any tickets.
   */
  seatGate?: WorkflowRunSeatGate;
  /**
   * Transcript access surface for actor sessions (the session store itself in production). Both
   * uses share this surface and **must** use the same instance: ask-boundary counting and seed
   * truncation copying (see the module comment in workflow-actor-transcript.ts).
   *
   * Optional because assemblies without session storage (pure replay tests, minimal stub
   * runtimes) have no transcript to count. If absent, boundary accounting is omitted; the cost
   * is that **this run cannot be a predecessor for amendment** (the service's "reject predecessor
   * without marker" gate blocks it), not an incorrect boundary. Creating a seeded session fails
   * loudly when this is absent: the engine has already determined from import facts that the
   * transcript must continue, so lacking access is a wiring error.
   */
  actorTranscriptStore?: ActorTranscriptStore;
  logger?: Logger;
  /**
   * Run ID. Actor session IDs are scoped to it; without runId, the same site×ordinal actor in
   * two concurrent runs would collide (`createSessionId("wf-actor-" + refToString(actor))` was
   * the buggy form). Defaults to "run" only to preserve existing test assemblies.
   */
  runId?: string;
  /**
   * Clock and timers used by the run-level stall clock, retry backoff for transient failures,
   * and bounded waits for session quiescence. Supports an injected clock; `stallAfterMs` defaults
   * to 20 minutes; `quiesceMs` defaults to {@link AMEND_TRANSCRIPT_QUIESCE_MS}; `random` supplies
   * backoff jitter.
   */
  clock?: WorkflowClock & {
    stallAfterMs?: number;
    quiesceMs?: number;
    random?: () => number;
  };
  /**
   * Expose this driver's **session quiescence probe** (workflow-driver-quiescence.ts). Called
   * exactly once during construction; the caller stores the probe on this run's registry entry,
   * and amend consults it before continuing an in-flight ask.
   *
   * Use a callback instead of making `createAgentRuntimeWorkflowDriver` return a tuple: the
   * **engine** creates the driver later through `makeDriver(sink)`, so the assembly site cannot
   * access its return value. If absent, the caller does not need quiescence information (for
   * example, direct harness use).
   */
  onQuiescenceProbe?: (probe: ActorSessionQuiescence) => void;
}

/**
 * Runtime state for each actor session. The engine guarantees per-actor FIFO, so each session
 * has at most one in-flight ask. Thus currentInstance / pendingSubmit / accepted / cancelled all
 * refer to the current instance and need not be tracked per instance.
 */
export interface SessionState {
  readonly ref: SessionRef;
  /** Same value as `ref.id`, retaining the branded type (transcript access uses SessionId). */
  readonly sessionId: SessionId;
  readonly runtime: AgentRuntime;
  /**
   * submit_result shape actually registered for this session. Read from the static profile at
   * creation; the **only** path that changes it is the runtime guard (ensureSubmitProfileFits in
   * workflow-driver.ts), which downgrades mono to generic when its declaration does not match
   * the actual ask schema. It never upgrades afterward.
   */
  submitProfile: ActorSubmitProfile;
  /** Current in-flight ask instance; set by startAsk. */
  currentInstance?: InstanceRef;
  /** Whether the current ask is typed (untyped asks do not use submit bridging). */
  currentTyped: boolean;
  /** Verdict deferred that the submit_result handler blocks on; at most one (single current instance). */
  pendingSubmit?: Deferred<ContractsSubmitVerdict>;
  /**
   * Parked escalation questions, keyed by qid. Unlike pendingSubmit, this **must be plural**:
   * the model can issue several escalate tool calls in parallel in one turn, each a separate
   * question (the limit is tracked by escalationsUsed).
   */
  readonly pendingEscalations: Map<string, Deferred<string>>;
  /**
   * Escalations used by this ask (attempts short-circuited by the cap are not counted; see
   * makeEscalatePort). Counted per ask and reset by startAsk; **not** reset for a nudge turn
   * (nudge remains in the same ask).
   */
  escalationsUsed: number;
  /** Turn abort controller for the current ask; rebuilt for every ask by startAsk. */
  abortController?: AbortController;
  /** The engine accepted the current ask: when its turn resolves, do not report askTurnEnded (the engine already settled it). */
  accepted: boolean;
  /** The engine cancelled the current ask: a rejected turn does not report askFailed (the engine already settled failed/cancelled). */
  cancelled: boolean;
  /**
   * Turns started on this session. Used only to tell whether the engine **started another turn**
   * after `askTurnEnded` (the nudge path does exactly that), and therefore whether the ask's
   * exchange really ended. Boundary accounting needs the end of the full exchange, not any
   * individual turn.
   */
  turnGeneration: number;
  /**
   * Cleanup chain for the current in-flight turn (executeTurn plus onTurnResolved /
   * onTurnRejected). Only one reader: dispose waits for it before closing the runtime. On the
   * accept path, askStats arrives only after settlement (the turn resolves after submit), so
   * closing synchronously would race with this tail.
   */
  turn?: Promise<void>;
  /**
   * Model activity surface for this actor: admission port + session-event observations (source of waiting/executing badges).
   */
  modelActivity: ActorModelActivity;
  /** Actor identity for this session (ProviderStop details name which subagent triggered the stop). */
  readonly actor: ActorRef;
  readonly actorName: string | undefined;
  /**
   * Driver-side transient retries in the current ask: transient failures reported by the runner
   * (such as exhausted stream recovery) do not settle the node; retry using the backoff curve.
   * Reset by startAsk.
   */
  transientAttempts: number;
  /** Retry timer while waiting for backoff; cancelled by cancelAsk / dispose. */
  cancelRedrive?: () => void;
}
