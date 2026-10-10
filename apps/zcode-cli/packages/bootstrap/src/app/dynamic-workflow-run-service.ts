// ============================================================
// Dynamic Workflow Run Service (production implementation of DynamicWorkflowRunPort)
// ============================================================
// This service compiles once → registers an AbortController → starts the engine (fire-and-forget;
// implementation in dynamic-workflow-run-launch.ts) → exposes run observation (snapshot / wait /
// cancel / resume / enumeration / event pagination) through a narrow port.
//
// Seven invariants are documented here because violating any one of them would produce symptoms
// far removed from the cause:
//
//   1. **The engine exclusively owns createRun.** This service never inserts a dwf_run row first.
//      A preexisting row sends the engine constructor down its resume branch (engine.ts): node
//      counts are recomputed from completed records, budgets are restored from the record, and
//      status is overwritten by updateRunStatus. A fresh run entering this branch does not fail; it
//      silently "resumes" from an empty journal. Resume intentionally **depends** on this behavior:
//      it launches an existing runId so the engine finds its row. These opposite entry paths must
//      never share a gate.
//   2. **Compile exactly once.** One ts.Program supplies the site table, schema synthesis, and
//      lowering. This service computes scriptHash (the harness intentionally does not: hashing the
//      text it sees would persist a hash of the lowered function body, silently mismatching resume's
//      source comparison).
//   3. **Do not construct this service without a journal.** Durability is a prerequisite for a run:
//      a silently unpersisted run is worse than no run (resume has no basis, detail has no source,
//      cancellation leaves no record). If narrowing fails, the caller of
//      {@link createDynamicWorkflowRunService} receives undefined and CreateWorkflow returns to its
//      placeholder-diagnostic path—a visible degradation rather than a broken feature.
//   4. **Reconcile only this session's orphan runs during construction.** See
//      {@link reconcileOrphanRuns}: a `running` row left by a dead process can only be identified at
//      this point, and this session is the only safe scope. Reconciliation writes
//      `stopped(interrupted)` (with the `Interrupted` failure code), which is resumable like other
//      stopped runs.
//   5. **Replace the registry entry before resuming, then launch.** `waitForTask` returns a journal
//      snapshot directly for a runId absent from the registry. If the entry is added later, the
//      rearmed notification watcher immediately settles against the old terminal row.
//   6. **Register each launch as residency-blocking work in the same synchronous turn.** The engine
//      is closed over by the parent session App and is not in the runtime task registry. The
//      residency pool would therefore see only a retired registry and close the App as idle after
//      10 minutes despite its active engine; resume would then start a second engine. There is one
//      registration point, {@link trackSettlement}, shared by submit / amend / resume. The count is
//      incremented in the same synchronous turn as launch and released in settlement's finally.
//   7. **On close, stop every run this service owns and let the engine write its row.** The service
//      aborts every active entry with `"interrupted"` and **awaits settlement** (no timeout or
//      polling). The harness normalizes this to `engine.stop("interrupted", Interrupted)`, so the
//      engine's normal finishRun tail writes resumable `stopped(interrupted)`. The service never
//      writes terminal rows itself: bypassing the engine would create a second dwf_run writer (see
//      invariant 1) and omit the matching run-settled journal event. submit / amend / resume throw
//      after close—the residency pool's close gate already blocks commands, so reaching this point
//      is a wiring error and should not widen the contracts refusal union (same rationale as invariant 1).

import type { DwfRunSessionListItem } from "@zcode/adapters/storage";
import type {
  TraceContext,
  DynamicWorkflowRunEvent,
  DynamicWorkflowRunArtifact,
  DynamicWorkflowRunArtifactBytes,
  DynamicWorkflowRunArtifactItem,
  DynamicWorkflowRunArtifactItemPage,
  DynamicWorkflowRunWorkspaceNode,
  DynamicWorkflowRunWorkspaceNodeResult,
  DynamicWorkflowRunWorkspaceNodeResultQuery,
  DynamicWorkflowRunEventPage,
  DynamicWorkflowResolveQuestionResult,
  DynamicWorkflowRunPort,
  DynamicWorkflowRunProgressPayload,
  DynamicWorkflowRunResumeResult,
  DynamicWorkflowRunRetuneRequest,
  DynamicWorkflowRunRetuneResult,
  DynamicWorkflowRunSessionSummary,
  DynamicWorkflowRunSnapshot,
  DynamicWorkflowRunAmendRequest,
  DynamicWorkflowRunAmendResult,
  DynamicWorkflowRunCancelInitiator,
  DynamicWorkflowRunSubmitRequest,
  DynamicWorkflowRunSubmitResult,
  ExecutionPort,
  FileSystemPort,
  Logger,
  SessionId,
  ModelRequestAdmission,
  ModelSelection,
  ToolArtifactStorePort,
  WorkflowEscalatePort,
  WorkflowSubmitPort,
} from "@zcode/contracts";
import type { AgentRuntime } from "@zcode/core";
import { WORKFLOW_RUNS_LIMITS } from "@zcode/shared/zcode-protocol-v4";
import type {
  ActorSubmitProfile,
  ActorRef,
  Caps,
  JournalStorePort,
  PersonaSpec,
} from "@zcode/dynamic-workflow";
import { toProtocolEvent } from "./dynamic-workflow-run-launch.js";
import { readWorkflowArtifactBytes } from "./dynamic-workflow-run-artifact-read.js";
import { replayRunProgress } from "./dynamic-workflow-run-replay.js";
import { listArtifactItemsFrom } from "./dynamic-workflow-run-artifact-queries.js";
import {
  supportsRunEnumeration,
  supportsRunIntrospection,
  type DynamicWorkflowTaskLinkStore,
} from "./dynamic-workflow-run-journal.js";
import { createRunIntrospectionMethods } from "./dynamic-workflow-run-introspection.js";
import { reconcileOrphanRuns } from "./dynamic-workflow-run-reconcile.js";
import {
  resumeDynamicWorkflowRun,
  amendDynamicWorkflowRun,
  submitDynamicWorkflowRun,
  type DynamicWorkflowRunEntryContext,
} from "./dynamic-workflow-run-submit.js";
import {
  listWorkspaceNodesFrom,
  readWorkspaceNodeResultFrom,
} from "./dynamic-workflow-run-workspace.js";
import {
  artifactsOf,
  settleOrAbort,
  snapshotOf,
  toSessionSummary,
  type RunRegistryEntry,
} from "./dynamic-workflow-run-observation.js";
import {
  createRunServiceLifecycle,
  type DynamicWorkflowRunSettledNotice,
} from "./dynamic-workflow-run-lifecycle.js";
import { retuneRunConcurrency } from "./dynamic-workflow-run-retune.js";
import type { ActorTranscriptStore } from "./workflow-actor-transcript.js";
import {
  clampRunConcurrency,
  resolveWorkflowConcurrencyCeiling,
} from "./workflow-concurrency-ceiling.js";
import type { WorkflowConcurrencyPort } from "./workflow-concurrency-governor.js";
import type { AgentRuntimeWorkflowDriverDeps } from "./workflow-driver-types.js";
import {
  createWorkflowEscalationRegistry,
  type WorkflowEscalationRegistry,
} from "./workflow-escalation-registry.js";

/** Default and maximum number of listRunsForSession items (bounded enumeration; never scan without a limit). */
const DEFAULT_LIST_RUNS_LIMIT = 16;
const MAX_LIST_RUNS_LIMIT = 64;

/** Input to the actor runtime factory. Includes runId because session IDs and task links are run-scoped. */
export interface DynamicWorkflowActorRuntimeInput {
  runId: string;
  sessionId: SessionId;
  actor: ActorRef;
  persona: PersonaSpec;
  submitPort: WorkflowSubmitPort;
  /**
   * Submit profile for this actor: `untyped` does not inject submitPort (no tools), `mono` injects
   * the port plus typed declarations, and `generic` injects only the port. The factory is the sole
   * place for this mapping, aligned with the subagent tool surface's fixed disallowlist.
   */
  submitProfile: ActorSubmitProfile;
  /**
   * Session-level escalation port: injecting it registers the `escalate` tool for this actor
   * session, with the same shape as submitPort. **Always present**, with no opt-in: the actor most
   * likely to hit an unforeseen blocker is precisely the one the author did not mark.
   */
  escalatePort: WorkflowEscalatePort;
  /**
   * The model last resolved for this actor (journal's `resolvedModel`, `providerId/modelId`); only
   * resume supplies it. When {@link DynamicWorkflowActorRuntimeInput.runSubagentModel} is absent,
   * the factory must prefer this over the parent session model. See the pin rationale in
   * `workflow-actor-model.ts` (the persisted side of the frozen-persona invariant).
   */
  pinnedModel?: string;
  /**
   * This run's subagent model (`subagent_model` from `CreateWorkflow` / `AmendWorkflow`, parsed
   * from the journal's `run-launched` event), including the reasoning level.
   *
   * Has the **highest** priority, above {@link DynamicWorkflowActorRuntimeInput.pinnedModel} and the
   * parent session model (`workflowActorModelPolicy` in workflow-actor-model.ts). This is the user's
   * explicit choice for this run; the pin is only the implicit default when it is absent. Applies to
   * subagents only, not the primary agent. Omission means use the pin or session model.
   */
  runSubagentModel?: ModelSelection;
  /**
   * Model-request admission port for this actor runtime. The driver supplies it when a governance
   * port is present, and the factory passes it unchanged to runtime deps. Omission means no gate applies.
   */
  modelRequestAdmission?: ModelRequestAdmission;
}

export interface DynamicWorkflowRunServiceDeps {
  /** Durable journal (dwf_* tables). Without it, this service is not constructed; see header invariant 3. */
  journal: JournalStorePort;
  /**
   * Resolve the launch anchor: return the parent runtime's active-turn inputId at submit time.
   * Return `undefined` if `trace.turnId` differs from the active turn or there is no active turn
   * (submit then mints a fallback). Omission means the host has no concept of a "current turn" (CLI,
   * test assembly).
   */
  resolveLaunchInputId?: (trace: TraceContext) => string | undefined;
  /**
   * Parent session ID for this service instance (the App's session; see create-app.ts).
   *
   * This defines the **scope for orphan reconciliation and enumeration**, so it is required. Without
   * it, the only choices are a global sweep (which would mark active runs in sibling sessions as
   * dead; they share SQLite but have separate in-memory registries) or no reconciliation (the bug
   * where a run stays `running` forever). Make wiring errors visible at compile time.
   */
  parentSessionId: string;
  /** File-system port used by world-read (files.glob / files.read / files.grep). */
  fileSystemPort: FileSystemPort;
  /** Child-process execution port for git.* world-read (cwd = the run's workspace). */
  executionPort: ExecutionPort;
  /**
   * Byte store for user-facing artifacts (`artifact.file` / `artifact.markdown`), passed unchanged
   * to the driver. ⚠ Here, artifact means **an output delivered to the user**, not the engine's top-level return value.
   *
   * **Optional**: assemblies without a store (tests, minimal stubs) can still run, but content
   * members receive a named `ArtifactStoreUnavailable` rejection—a script-catchable failure, not a
   * silent fallback. Session scope uses this service's {@link DynamicWorkflowRunServiceDeps.parentSessionId}
   * (the App session, i.e. the parent session).
   */
  artifactStore?: ToolArtifactStorePort;
  /** Create an actor's child AgentRuntime (production wraps createScriptWorkflowAgentRuntime). */
  createActorRuntime: (input: DynamicWorkflowActorRuntimeInput) => AgentRuntime;
  /** Persistence surface for an actor session's task link; if absent, skip the link (the session is still persisted). */
  taskLinkStore?: DynamicWorkflowTaskLinkStore;
  /**
   * Transcript access for actor sessions (in production this is the session store). The driver uses
   * it to count ask-boundary bookkeeping and to copy a truncated transcript for the diverged actor
   * during amend-resume.
   *
   * If absent, boundary bookkeeping is omitted and the run still completes, but it **cannot be an
   * amendment predecessor** (the service's "reject predecessors without markers" gate blocks it).
   * Optional because assemblies without session storage have no transcript to count; the driver
   * fails clearly if seeded session creation is attempted without this store.
   */
  actorTranscriptStore?: ActorTranscriptStore;
  /**
   * Engine-event hook: emits an **already-prepared session event payload** (bounded payload + journal
   * sequence + two derived fields). The caller only appends it to the parent session (create-app
   * connects this to the runtime's record method).
   *
   * Why the service prepares it instead of asking the caller to assemble it: sequence and
   * spentTokens can only be read from the journal, which this service depends on; only the session-ID
   * minting function can calculate actor session IDs. Moving these three facts to the caller would
   * duplicate three contracts in a layer without a journal.
   *
   * The second argument is **routing** information, intentionally separate from the payload:
   * `parentSessionId` chooses the destination session but is not payload data (the event is already
   * in that session, so storing it again is redundant). The caller uses it for identity gating; see
   * {@link createDynamicWorkflowRunProgressSink}.
   */
  onRunEvent?: (
    progress: DynamicWorkflowRunProgressPayload,
    routing: { parentSessionId?: string },
  ) => void;
  logger?: Logger;
  /** Inject concurrency detection so tests can fix the caps default to two cores (the floor must be 1). */
  availableParallelism?: () => number;
  /**
   * Narrow port to the process-level concurrency governor, passed unchanged to the driver:
   * effective concurrency = min(this run's caps.maxConcurrency, the shared live cap for this
   * provider key). Omission means only the per-run ceiling applies (test assembly or host without a governor).
   */
  concurrency?: WorkflowConcurrencyPort;
  /**
   * Register a launch as **residency-blocking work** for the parent runtime.
   *
   * The engine is closed over by the session App and is not in the runtime task registry, while the
   * residency pool reads only that registry. It would read an active run as idle, close the App, and
   * resume would start a second engine. Register through the runtime's sole API
   * (`trackResidencyBlockingWork`) so the pool does not need to infer state from a sidecar.
   *
   * Omission means the host has no residency concept (one-shot CLI execution, test assembly): the
   * run still completes but does not block close.
   */
  registerResidencyBlockingWork?: (work: Promise<unknown>) => void;
  /**
   * Driver clock and timers: both the per-run stall clock and transient-failure backoff retries use
   * it. **Injected only for tests** (the failure matrix shrinks the 2s→60s retry curve and 20-minute
   * stall window to milliseconds); production assembly never sets it, so omission uses real time.
   */
  driverClock?: AgentRuntimeWorkflowDriverDeps["clock"];
}

export {
  isDynamicWorkflowTaskLinkStore,
  resolveDynamicWorkflowJournalStore,
  supportsRunIntrospection,
  type DynamicWorkflowTaskLinkStore,
} from "./dynamic-workflow-run-journal.js";

/**
 * Full surface of this service: {@link DynamicWorkflowRunPort} (used by the engine / tool layer)
 * plus two **session-level** lifecycle reads. The latter exist only for the host's provider-registry
 * safety boundary: subagents share the parent session's live adapter, and an active run is part of
 * that session's active Loop, so registry replacement must wait for settlement.
 */
interface DynamicWorkflowRunService extends DynamicWorkflowRunPort {
  /** Number of runs not yet settled (`terminal === undefined` entries in the registry). */
  countLiveRuns(): number;
  /**
   * Subscribe to settlement: notified exactly once after each run reaches a terminal state
   * (completed / errored / stopped, including failures before launch), after bookkeeping completes
   * and the count is decremented. Returns an unsubscribe function. Listener errors are logged and do
   * not affect settlement.
   */
  subscribeRunSettled(listener: (notice: DynamicWorkflowRunSettledNotice) => void): () => void;
  /**
   * Stop every active run owned by this service and await settlement (header invariant 7). **Not on
   * the contracts {@link DynamicWorkflowRunPort}**: this is a host App lifecycle action, not an
   * engine or tool-layer capability. Idempotent: later calls return the same promise and do not abort again.
   */
  close(): Promise<void>;
}

/**
 * Create the workflow run service. Returns {@link DynamicWorkflowRunService}: the port implementation
 * plus two session-level lifecycle reads (active-run count and settlement subscription). The latter
 * are excluded from the narrow contracts port because they serve the host's registry safety boundary,
 * not the engine or tool layer.
 */
export function createDynamicWorkflowRunService(
  deps: DynamicWorkflowRunServiceDeps,
): DynamicWorkflowRunService {
  const runs = new Map<string, RunRegistryEntry>();
  /**
   * Escalation-question table. **One table shared by every active run owned by this service**:
   * qid is globally unique for this reason—`resolveQuestion` accepts only an opaque token, while
   * asking the model to pair `(runId, qid)` under concurrent runs invites mismatches. In-memory,
   * like the parked deferred; process death clears it and a resumed actor recovers by asking again.
   * Persisting a pending table would misrepresent reality.
   */
  const escalations: WorkflowEscalationRegistry = createWorkflowEscalationRegistry();

  // Reconcile during construction: this instance currently owns no active runs, so every nonterminal
  // row for this session was left by a dead process. See header invariant 4 and {@link reconcileOrphanRuns}.
  reconcileOrphanRuns(deps);

  /**
   * Concurrency ceiling for this process.
   * Uses the same implementation as the process-level governor's bucket ceiling, keeping the run
   * ceiling aligned with the bucket ceiling.
   *
   * Four consumers in this service use this function: the new run's initial caps, the port's
   * {@link DynamicWorkflowRunPort.concurrencyCeiling} (used by tools to clamp and decide whether
   * the value is worth mentioning), the `maxConcurrency` checks in both read paths, and the derived
   * field in the `run-started` payload.
   */
  const concurrencyCeiling = (): number =>
    resolveWorkflowConcurrencyCeiling(deps.availableParallelism);

  // Caps contain only a concurrency ceiling, no wall-clock timeout; cancellation is the only stop mechanism.
  // The ceiling **starts at the host ceiling** and requests may lower it, never raise it:
  // omission means the ceiling; supplied values are clamped to [1, ceiling].
  const caps = (requested?: number): Caps => {
    return { maxConcurrency: clampRunConcurrency(requested, concurrencyCeiling()) };
  };

  // Attach introspection based on capabilities (those four queries are not on the engine port).
  // When unavailable, the two **optional members are not implemented at all**; consumers' test
  // `typeof port.listRuns === "function"` is false and the tool layer returns a business failure
  // meaning "this session lacks the capability," rather than a silent empty list.
  const introspection = supportsRunIntrospection(deps.journal) ? deps.journal : undefined;

  // Lifecycle bookkeeping (settlement / close / close gate / recording foreign terminal rows;
  // header invariants 6 and 7) is implemented in dynamic-workflow-run-lifecycle.ts. It uses this
  // registry and journal, passed through narrow dependencies.
  const {
    countLiveRuns,
    subscribeRunSettled,
    trackSettlement,
    close,
    assertOpen,
    noteForeignTerminalRow,
  } = createRunServiceLifecycle({
    journal: deps.journal,
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    parentSessionId: deps.parentSessionId,
    ...(deps.registerResidencyBlockingWork === undefined
      ? {}
      : { registerResidencyBlockingWork: deps.registerResidencyBlockingWork }),
    runs,
  });

  // The submit and resume entry-point implementations live in dynamic-workflow-run-submit.ts. They
  // use this registry, quiescence table, caps, and settlement bookkeeping, explicitly passed via
  // ctx, rather than duplicating those implementations here.
  const entryContext: DynamicWorkflowRunEntryContext = {
    deps,
    runs,
    escalations,
    caps,
    trackSettlement,
  };

  return {
    countLiveRuns,
    subscribeRunSettled,
    close,

    // Close gate for all three entry points. `async` converts this wiring error into a rejection
    // instead of a synchronous throw. There is no await between the gate and delegation, preserving
    // invariant 6's requirement that registration and launch happen in the same synchronous turn.
    async submit(
      request: DynamicWorkflowRunSubmitRequest,
    ): Promise<DynamicWorkflowRunSubmitResult> {
      assertOpen();
      return submitDynamicWorkflowRun(entryContext, request);
    },

    async amend(request: DynamicWorkflowRunAmendRequest): Promise<DynamicWorkflowRunAmendResult> {
      assertOpen();
      return amendDynamicWorkflowRun(entryContext, request);
    },

    /**
     * Concurrency ceiling for this process (port contract: {@link DynamicWorkflowRunPort.concurrencyCeiling}).
     * Uses the **same** {@link concurrencyCeiling} as the caps starting point: the value clamped by
     * the tool layer must equal the value later persisted by the port, or the confirmation window
     * would display a value different from the one that takes effect.
     */
    concurrencyCeiling,

    /**
     * Change the concurrency ceiling of an active run in place (port contract:
     * {@link DynamicWorkflowRunPort.retuneConcurrency}; implementation in dynamic-workflow-run-retune.ts).
     *
     * Intentionally **does not pass through the close gate**: the three launch entry points call
     * `assertOpen` because they start an engine, while this method starts nothing. During service
     * close, every entry is settling, so the liveness check itself returns `not_live`.
     */
    async retuneConcurrency(
      request: DynamicWorkflowRunRetuneRequest,
    ): Promise<DynamicWorkflowRunRetuneResult> {
      return retuneRunConcurrency({ runs, journal: deps.journal, concurrencyCeiling }, request);
    },

    async resume(runId: string): Promise<DynamicWorkflowRunResumeResult> {
      assertOpen();
      return resumeDynamicWorkflowRun(entryContext, runId);
    },

    async listRunsForSession(limit?: number): Promise<DynamicWorkflowRunSessionSummary[]> {
      if (!supportsRunEnumeration(deps.journal)) {
        // Without an enumeration query (for example, an in-memory journal), an empty list is honest:
        // runs in an in-memory journal cannot outlive the process, so restart discovery has nothing to restore.
        return [];
      }
      const capped = Math.max(1, Math.min(limit ?? DEFAULT_LIST_RUNS_LIMIT, MAX_LIST_RUNS_LIMIT));
      let rows: DwfRunSessionListItem[];
      try {
        rows = deps.journal.listRunsByParentSession(deps.parentSessionId, capped);
      } catch (error) {
        deps.logger?.warn?.("Dynamic workflow run enumeration failed", {
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "dynamic_workflow.run.list_failed",
          module: "bootstrap.app",
        });
        return [];
      }
      // Pass live entries to the summary too: session enumeration shares the same precedence as
      // snapshots / lists / details (rule 3), or this surface alone could show a run marked terminal
      // by an external write.
      return rows.map((row) => toSessionSummary(row, runs.get(row.runId)));
    },

    async replayProgressForSession(input: {
      excludeRunIds: ReadonlySet<string>;
    }): Promise<DynamicWorkflowRunProgressPayload[]> {
      if (!supportsRunEnumeration(deps.journal)) return [];
      let rows: DwfRunSessionListItem[];
      try {
        // Use the same upper bound as projection eviction: cold state should match what a long-lived
        // process would retain at this moment.
        rows = deps.journal.listRunsByParentSession(
          deps.parentSessionId,
          WORKFLOW_RUNS_LIMITS.maxRuns,
        );
      } catch (error) {
        deps.logger?.warn?.("Dynamic workflow run replay enumeration failed", {
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "dynamic_workflow.run.replay_failed",
          module: "bootstrap.app",
        });
        return [];
      }
      const payloads: DynamicWorkflowRunProgressPayload[] = [];
      // Enumeration is newest first; replay oldest first so reducer eviction follows the same
      // arrival order as live execution.
      for (const row of [...rows].reverse()) {
        // Do not replay runs whose events are already in the caller's memory (runs executed in this
        // process) or that are active in the registry. Their events are already in the in-memory
        // store; feeding them again would make run-started reset the phase.
        if (input.excludeRunIds.has(row.runId) || runs.has(row.runId)) continue;
        // Use the same ceiling source as live execution: the cold-replay `run-started` payload must
        // be byte-for-byte equal to the live payload.
        payloads.push(...replayRunProgress(row, deps.journal, concurrencyCeiling()));
      }
      return payloads;
    },

    async getTask(taskId: string): Promise<DynamicWorkflowRunSnapshot | undefined> {
      noteForeignTerminalRow(taskId);
      return snapshotOf(
        taskId,
        runs,
        deps.journal,
        escalations.pendingFor(taskId),
        concurrencyCeiling(),
      );
    },

    /**
     * Script archived for the run (port contract: {@link DynamicWorkflowRunPort.getScript}). Check
     * the registry first: during the gap between submit and createRun, the journal has no row yet,
     * and the entry contains the same bytes. The journal copy is also used for resume's hash check,
     * so `AmendWorkflow` inheritance, the `script_unchanged` preflight, and resume agree on what the
     * run executes.
     */
    async getScript(runId: string): Promise<string | undefined> {
      return runs.get(runId)?.scriptText ?? deps.journal.getRun(runId)?.scriptText;
    },

    async waitForTask(
      taskId: string,
      options?: { signal?: AbortSignal },
    ): Promise<DynamicWorkflowRunSnapshot | undefined> {
      const entry = runs.get(taskId);
      // Not in the registry: it may be an earlier run from this process (with a journal row) or
      // entirely unknown. Neither can be awaited.
      if (entry === undefined) {
        return snapshotOf(
          taskId,
          runs,
          deps.journal,
          escalations.pendingFor(taskId),
          concurrencyCeiling(),
        );
      }
      if (entry.terminal === undefined) await settleOrAbort(entry.settlement, options?.signal);
      // Re-project pending questions **after waiting**: one may have been answered or removed by cancellation while awaiting.
      return snapshotOf(
        taskId,
        runs,
        deps.journal,
        escalations.pendingFor(taskId),
        concurrencyCeiling(),
      );
    },

    /**
     * Answer a blocking question escalated by an actor. Look it up → let the driver settle it → use
     * the `escalate` tool result as the answer, then continue the actor's turn in place. **Run status
     * never changes**: escalation is a slow tool call inside ask, not a run lifecycle event (by
     * design, escalate does not terminate or freeze the run).
     *
     * The registry owns the three structured refusal cases and their messages (it knows whether a
     * qid never existed, was already answered, or was removed along with its ask). This method
     * intentionally does not check again: duplicate decisions in two layers would eventually give
     * the same qid different meanings.
     */
    async resolveQuestion(
      qid: string,
      answer: string,
    ): Promise<DynamicWorkflowResolveQuestionResult> {
      return escalations.resolve(qid, answer);
    },

    async cancel(
      runId: string,
      initiator: DynamicWorkflowRunCancelInitiator = "user",
    ): Promise<boolean> {
      const entry = runs.get(runId);
      // An unknown or settled run has nothing to abort. Return false so the caller can normalize
      // this to a structured not_found instead of reporting a cancellation that did not occur.
      if (entry === undefined || entry.terminal !== undefined) return false;
      // abort is the harness's only true stop: it aborts the active ask and kills child processes;
      // the engine settles through stop(initiator) as stopped (completed journal entries remain,
      // allowing resume). The abort reason is the initiator; the harness reads `signal.reason` to
      // choose stopped(user) or stopped(model), persisting the reason instead of keeping it only in
      // the background task registry.
      entry.controller.abort(initiator);
      return true;
    },

    async listEvents(
      runId: string,
      options: DynamicWorkflowRunEventPage,
    ): Promise<DynamicWorkflowRunEvent[]> {
      const page = deps.journal.listEvents(runId, {
        ...(options.afterSequence === undefined ? {} : { afterSequence: options.afterSequence }),
        ...(options.limit === undefined ? {} : { limit: options.limit }),
      });
      return page.map((stored) => toProtocolEvent(stored.sequence, stored.event));
    },

    /**
     * User-facing artifact list for this run. The durable read path for UI cold recovery and hub
     * details: the `workflowRuns.artifacts` projection is memory-only and empty after restart, while
     * version history has always been persisted in journal rows with `kind = "artifact"`.
     *
     * Reuse the full aggregation rule in {@link artifactsOf}: the terminal snapshot (`getTask`) and
     * this method must return **the same** list. Separate aggregation logic would eventually diverge
     * on details such as whether a failed row counts as a version.
     *
     * ⚠ Terminology: artifact here means output published by a script for the user, not the port's
     * `output` (the script's top-level return value, also called artifact inside the engine).
     *
     * An unknown runId and a journal without artifact reads both return `undefined`: they represent
     * the same business fact to callers.
     */
    async listArtifacts(runId: string): Promise<readonly DynamicWorkflowRunArtifact[] | undefined> {
      return artifactsOf(runId, deps.journal).artifacts;
    },

    /**
     * Paginate `report` entries for a predefined artifact in ascending journal sequence (the
     * dashboard's data surface). An out-of-range cursor returns an empty page, not an error; reaching
     * the end is a normal pagination result.
     */
    async listArtifactItems(
      runId: string,
      artifactId: string,
      page: DynamicWorkflowRunArtifactItemPage,
    ): Promise<readonly DynamicWorkflowRunArtifactItem[]> {
      return listArtifactItemsFrom(deps.journal, runId, artifactId, {
        ...(page.afterSequence === undefined ? {} : { afterSequence: page.afterSequence }),
        limit: page.limit,
      });
    },

    /**
     * Read bytes for an artifact version. The full authorization chain (run belongs to this session
     * and the journal has a completed row for this version, then use its uri) is in
     * {@link readWorkflowArtifactBytes}, with a flow diagram there.
     *
     * Use this service's `parentSessionId` (the App session) and intentionally accept no parameter:
     * the service instance is already constructed for its parent session. Letting callers supply an
     * arbitrary session would create a cross-session read hole—the same rationale as
     * `listRunsForSession`, except that method enumerates and this one returns bytes.
     */
    async readArtifact(
      runId: string,
      artifactId: string,
      version: number,
    ): Promise<DynamicWorkflowRunArtifactBytes | undefined> {
      return readWorkflowArtifactBytes(
        {
          journal: deps.journal,
          parentSessionId: deps.parentSessionId,
          ...(deps.artifactStore === undefined ? {} : { artifactStore: deps.artifactStore }),
        },
        runId,
        artifactId,
        version,
      );
    },

    /**
     * Workspace transcript list and content. It uses the same authorization chain as readArtifact
     * (the run belongs to this session), and checks both: list args already contain paths and command
     * lines. The implementation is in dynamic-workflow-run-workspace.ts.
     */
    async listWorkspaceNodes(
      runId: string,
    ): Promise<readonly DynamicWorkflowRunWorkspaceNode[] | undefined> {
      return listWorkspaceNodesFrom(
        { journal: deps.journal, parentSessionId: deps.parentSessionId },
        runId,
      );
    },

    async readWorkspaceNodeResult(
      runId: string,
      siteId: string,
      ordinal: number,
      query: DynamicWorkflowRunWorkspaceNodeResultQuery,
    ): Promise<DynamicWorkflowRunWorkspaceNodeResult | undefined> {
      return readWorkspaceNodeResultFrom(
        { journal: deps.journal, parentSessionId: deps.parentSessionId },
        runId,
        siteId,
        ordinal,
        query,
      );
    },

    ...(introspection === undefined
      ? {}
      : createRunIntrospectionMethods({
          introspection,
          journal: deps.journal,
          parentSessionId: deps.parentSessionId,
          runs,
          escalations,
          concurrencyCeiling,
        })),
  };
}
