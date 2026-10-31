// ============================================================
// AgentRuntime-backed WorkflowDriver（Boundary B）
// ============================================================
// Bind the dynamic-workflow engine's core downward-effect port, WorkflowDriver, to the real
// ZCode AgentRuntime: one **persistent** child runtime per actor (repeated executeTurn calls
// accumulate messageHistory), one executeTurn per ask, and typed ask results bridge back to
// the engine for a verdict through the session-level WorkflowSubmitPort.
//
// The other two parts of Boundary B, `executeWorldRead` and `executeArtifactPublish`, live in
// workflow-world-read.ts and workflow-artifact-publish.ts; this file only forwards to them.
// They share no state with this module (they do not touch sessions, turns, or submit bridging),
// so after extraction this file has one responsibility: session and turn orchestration.
//
// Three sequences (the core invariants of this file):
//   1. accept: the model calls submit_result → the handler blocks in port.respond → this driver
//      reports askSubmitAttempted → the engine validates → respondToSubmit(accept) resolves the
//      deferred with {accept:true} → the handler succeeds (turnControl stops the turn) →
//      executeTurn resolves → only askStats is reported (not askTurnEnded, because the engine
//      has already settled this ask).
//   2. reject (repair within the same turn): respondToSubmit(reject, violations) resolves the
//      deferred with {accept:false, violations} → the handler throws → error tool_result (no
//      turnControl) → the same turn continues → the model retries → another respond and deferred.
//      When the repair budget is exhausted, the engine calls cancelAsk instead.
//   3. nudge (turn ends without submission): executeTurn resolves without acceptance → report
//      askTurnEnded → the engine chooses nudge → respondToSubmit(nudge) (there is **no** parked
//      deferred because the turn has ended) → start one **fresh** executeTurn on the same
//      persistent runtime with the nudge prompt.
//
// Three-to-two-value verdict mapping (engine SubmitVerdict has three values; the contracts
// WorkflowSubmitPort has two): accept → {accept:true}; reject → {accept:false, violations}
// (one-to-one Violation mapping); nudge → no deferred, start a new turn. See respondToSubmit.
//
// The fourth sequence (escalation questions) is at the **same level** as the three above:
//   4. escalate: the model calls escalate → the handler blocks in escalatePort → the driver
//      creates a qid, parks a deferred, registers the question, and emits escalation-raised to
//      both the journal and emit stream → the main agent looks it up through the run service's
//      resolveQuestion → driver.respondToEscalation resolves the deferred and emits
//      escalation-resolved → the tool result is the answer text → the actor continues its turn
//      in place and the ask settles normally. The engine core is **unaware** of escalation: it
//      occurs within the driver's ask boundary (at the same level as repair/nudge turns) and
//      writes no dwf_node row. cancelAsk is the escape hatch; it also rejects a parked escalation
//      deferred.
//
// Amend-resume added two driver-private responsibilities to this file. Both concern only
// session transcripts, so their mechanisms live in workflow-actor-transcript.ts; this file
// handles orchestration (the three implementation bodies are in
// workflow-driver-transcript.ts）：
//   - **Ask boundary accounting**: when an exchange ends (including repair/nudge turns and
//     cleanup messages after submit), write the actor session's persisted message count to this
//     ask's journal row. Write it for every ask; any run can be a predecessor for a future amend.
//   - **Transcript truncation**: when `createActorSession` receives a seed, copy the first N
//     messages from the source session into the newly created session before rehydrating it.
// This change adds a third transcript-only responsibility in its own module
// (workflow-driver-quiescence.ts):
//   - **Session quiescence record**: on dispose, record whether each session still has a turn
//     writing to it. When amending an in-flight predecessor, amend uses this to decide whether
//     the current message count is trustworthy before continuing that unfinished ask.

import type { SessionId, WorkflowEscalatePort } from "@zcode/contracts";
import type { TurnResult } from "@zcode/core";
import {
  GENERIC_SUBMIT_PROFILE,
  refToString,
  WorkflowError,
  type ActorRef,
  type ActorSessionSeed,
  type ArtifactPublishRequest,
  type ArtifactVersionRecord,
  type AskMessage,
  type InstanceRef,
  type JournalStorePort,
  type PersonaSpec,
  type RunEvent,
  type SessionRef,
  type SubmitVerdict as EngineSubmitVerdict,
  type WorkflowDriver,
  type WorkflowReportSink,
  type WorldReadOp,
} from "@zcode/dynamic-workflow";
import { executeArtifactPublish } from "./workflow-artifact-publish.js";
import { qualityEpilogue } from "./workflow-ask-epilogue.js";
import { ensureSubmitProfileFits } from "./workflow-driver-submit-profile.js";
import { executeWorldRead } from "./workflow-world-read.js";
import {
  createActorModelActivity,
  createRunStallClock,
  type RunStallClock,
} from "./workflow-driver-concurrency.js";
import { handleModelTurnFailure, type ModelFailureHost } from "./workflow-driver-model-failure.js";
import {
  createActorSessionQuiescence,
  releaseActorSessions,
  type ActorSessionQuiescenceLedger,
} from "./workflow-driver-quiescence.js";
import {
  makeSessionEscalatePort,
  respondToParkedEscalation,
  withdrawSessionEscalations,
  type EscalationHost,
} from "./workflow-driver-escalation.js";
import {
  NUDGE_PROMPT,
  TYPED_TOOL_EPILOGUE,
  effectiveActorName,
  isTurnCancelled,
  mapViolations,
  mintActorSessionId,
  reportTurnObservations,
  schemaEpilogue,
  toWorkflowError,
} from "./workflow-driver-helpers.js";
import { makeSessionSubmitPort, type SubmitBridgeHost } from "./workflow-driver-submit-bridge.js";
import {
  countSessionTranscript,
  journalAskMessageBoundary,
  seedActorSession,
} from "./workflow-driver-transcript.js";
import type { AgentRuntimeWorkflowDriverDeps, SessionState } from "./workflow-driver-types.js";

/**
 * Concrete WorkflowDriver implementation. Construct it through
 * {@link createAgentRuntimeWorkflowDriver} (bind deps and fill in the sink).
 */
class AgentRuntimeWorkflowDriver implements WorkflowDriver {
  readonly journal: JournalStorePort;
  readonly emit: (event: RunEvent) => void;

  private readonly sink: WorkflowReportSink;
  private readonly deps: AgentRuntimeWorkflowDriverDeps;
  private readonly sessions = new Map<string, SessionState>();
  /** refToString(instance) → owning session, for lookup by respondToSubmit / cancelAsk. */
  private readonly instanceToSession = new Map<string, SessionState>();
  /** qid → session where it is parked, for lookup by respondToEscalation (parallel to instanceToSession). */
  private readonly qidToSession = new Map<string, SessionState>();
  /** Monotonic per-run escalation sequence; the second qid segment. Combined with runId it forms a collision-free ID. */
  private escalationSeq = 0;
  /** Idempotency guard for dispose (the engine guarantees exactly once, but guarding here is cheaper and safer). */
  private disposed = false;
  /** This run's subscription to governor cap changes (once per run, unsubscribed on dispose). */
  private readonly concurrencyUnsubscribe?: () => void;
  /**
   * Host surface passed to escalation bridging (workflow-driver-escalation.ts): the two maps
   * are shared by reference, while the sequence and record callbacks return to this class through
   * closures. Private state stays private, and bridge functions need not know the class shape.
   */
  private readonly escalationHost: EscalationHost;
  /** Host surface passed to model-side failure handling (workflow-driver-model-failure.ts), using the same by-reference sharing. */
  private readonly modelFailureHost: ModelFailureHost;
  /** Host surface passed to submit bridging (workflow-driver-submit-bridge.ts), likewise sharing both values by reference. */
  private readonly submitHost: SubmitBridgeHost;
  /** Run-level stall clock (decision 4): success/retry beats from all actors feed into this one table. */
  private readonly stallClock: RunStallClock;
  /**
   * Session quiescence ledger (workflow-driver-quiescence.ts): whether each session still has in-flight turn writes at dispose time.
   * amend queries turn quiescence; App.close waits for full actor release via drain.
   */
  private readonly quiescence: ActorSessionQuiescenceLedger;

  constructor(deps: AgentRuntimeWorkflowDriverDeps, sink: WorkflowReportSink) {
    this.deps = deps;
    this.sink = sink;
    this.journal = deps.journal;
    // The engine calls driver.emit immediately after record() for **every** event (engine.ts),
    // so this is the only place where the driver can see an ask finish. `node-settled` is the
    // common exit for all three settlement paths (settleOk / settleFailed / abortInFlight),
    // and it is the "this actor is no longer working" signal awaited by the seat gate.
    //
    // Why not inspect the driver's own state? `state.currentInstance` is never cleared, and
    // after an untyped ask settles in the engine through askTurnEnded, `live()` is still true.
    // Releasing seats from that state would never free them, leaving FIFO waiting forever.
    //
    // Pass down the **same object reference**: sequence capture on launch checks sequence
    // numbers by reference equality (createJournalSequenceCapture in dynamic-workflow-run-launch.ts).
    this.emit =
      deps.seatGate === undefined
        ? deps.emit
        : (event) => {
            if (event.type === "node-settled") deps.seatGate?.askSettled(event.instance);
            deps.emit(event);
          };
    this.escalationHost = {
      deps,
      sessions: this.sessions,
      qidToSession: this.qidToSession,
      nextEscalationSeq: () => ++this.escalationSeq,
      record: (event) => this.record(event),
    };
    this.submitHost = { sessions: this.sessions, sink };
    this.modelFailureHost = {
      deps,
      sink,
      isDisposed: () => this.disposed,
      runTurn: (state, instance, input, epilogueStart) =>
        this.runTurn(state, instance, input, epilogueStart),
    };
    this.stallClock = createRunStallClock({
      ...(deps.clock?.now === undefined ? {} : { now: deps.clock.now }),
      ...(deps.clock?.schedule === undefined ? {} : { schedule: deps.clock.schedule }),
      ...(deps.clock?.stallAfterMs === undefined ? {} : { afterMs: deps.clock.stallAfterMs }),
      onStalled: (info) => this.sink.runStalled(info),
    });
    this.quiescence = createActorSessionQuiescence({
      ...(deps.clock === undefined ? {} : { clock: deps.clock }),
      ...(deps.clock?.quiesceMs === undefined ? {} : { quiesceMs: deps.clock.quiesceMs }),
    });
    // Hand off the probe at **construction time**: the run service stores it on the entry, and
    // amend can arrive at any point during this run's lifetime. Handing it off after dispose is
    // too late; the service will already be counting sessions.
    deps.onQuiescenceProbe?.(this.quiescence);
    if (deps.concurrency !== undefined) {
      // Fan-out reaches only runs with in-flight/queued requests for this key, so the
      // subscription can be established once at construction.
      this.concurrencyUnsubscribe = deps.concurrency.subscribe(deps.runId ?? "run", (change) => {
        this.stallClock.noteCap(change.next);
        this.sink.concurrencyChanged(change);
      });
    }
  }

  createActorSession(
    actor: ActorRef,
    persona: PersonaSpec,
    seed?: ActorSessionSeed,
  ): Promise<SessionRef> {
    if (this.disposed) return Promise.reject(new Error("Workflow driver is closed"));
    const creation = this.createOwnedActorSession(actor, persona, seed);
    // dispose must still see it while the factory persists asynchronously, so the new actor never falls outside the close snapshot.
    this.quiescence.trackRelease(
      creation.then(
        () => undefined,
        () => undefined,
      ),
    );
    return creation;
  }

  private async createOwnedActorSession(
    actor: ActorRef,
    persona: PersonaSpec,
    seed?: ActorSessionSeed,
  ): Promise<SessionRef> {
    const sessionId = mintActorSessionId(this.deps.runId ?? "run", actor);
    // Cross-check resumed session identity: dwf_actor.session_id in the journal is only a
    // **record**; the ID factory is authoritative (it is deterministic from (runId, actorRef),
    // so reattachment must produce the same ID). A mismatch can only mean the ID rule drifted
    // (renamed or implemented a second time). The consequences—rehydrating from the wrong
    // session or opening a nonexistent session in the detail page—are far removed from the
    // cause, so fail loudly at the first reattachment step with a structured mismatch, matching
    // the shape of the two-hash mismatch error.
    const journaled = this.journal.getActor(
      this.deps.runId ?? "run",
      actor.siteId,
      actor.ordinal,
    )?.sessionId;
    if (journaled !== undefined && journaled !== sessionId) {
      throw new WorkflowError(
        "DriverError",
        `Subagent session identity mismatch for ${refToString(actor)}: the journaled session ` +
          `id and the minted one differ.`,
        { mismatch: { expected: journaled, got: sessionId } },
      );
    }
    const ref: SessionRef = { id: sessionId };
    // Session-level submit port (implemented in workflow-driver-submit-bridge.ts and symmetric
    // with the escalation port below): the closure binds this session, so the model cannot
    // override routing identity (instance comes from currentInstance).
    const submitPort = makeSessionSubmitPort(this.submitHost, sessionId);
    // The escalation port has the same structure: it is bound to the session by a closure and
    // is always injected (see the ActorRuntimeFactory field comment). Include persona in the
    // closure too: its effective name is **frozen** when the engine calls createActor, so
    // computing it here once is cheaper than looking it up on each escalate and cannot change
    // midway through the run.
    const escalatePort = this.makeEscalatePort(sessionId, actor, persona);
    // Model activity surface: the admission port is passed through runtime deps (the runner
    // checks the gate before each attempt). Report waiting/executing observations only while an
    // ask is in flight and has not been settled/cancelled by the engine; late observations are
    // meaningless for a completed ask, and the engine checks again as well. State is created
    // below, so bind it later through a closure.
    let state: SessionState | undefined;
    const live = (): InstanceRef | undefined =>
      state === undefined ||
      state.currentInstance === undefined ||
      state.accepted ||
      state.cancelled
        ? undefined
        : state.currentInstance;
    const modelActivity = createActorModelActivity({
      port: this.deps.concurrency,
      runId: this.deps.runId ?? "run",
      live,
      // The seat gate is keyed by **actor** (not ask instance): per-actor FIFO guarantees at
      // most one in-flight ask per actor, so "working subagents" and "in-flight asks" have the
      // same count, and the admission port is already created per actor session.
      // See docs/dynamic-workflow/concurrency.md "Park and unpark".
      ...(this.deps.seatGate === undefined
        ? {}
        : { seat: { gate: this.deps.seatGate, key: refToString(actor) } }),
      handlers: {
        // The subagent's first workspace write ⇒ the engine closes the import cache.
        onMutating: (instance) => this.sink.askMutating(instance),
        onWaiting: (info) => {
          const instance = live();
          if (instance !== undefined) this.sink.askWaiting(instance, info);
        },
        onExecuting: () => {
          const instance = live();
          if (instance !== undefined) this.sink.askExecuting(instance);
        },
        // Two beats for the run-level stall clock: any actor's success resets it; any retry arms it.
        onRequestCompleted: () => this.stallClock.noteSuccess(),
        onRetryScheduled: (reason) => this.stallClock.noteRetryScheduled(reason),
      },
    });
    // Look up the submit profile by actor **site**: every ordinal (fan-out lane) at the same
    // site runs the same ask sites, so the profile is the same. Missing means generic.
    const submitProfile =
      this.deps.actorSubmitProfiles?.get(actor.siteId) ?? GENERIC_SUBMIT_PROFILE;
    // Await this: the production factory persists the session and creates its task link before
    // returning (the FK requires the session row to exist first). The engine's ensureSession
    // awaits this method, so persistence is complete before the first ask is dispatched.
    const runtime = await this.deps.runtimeFactory({
      sessionId,
      actor,
      persona,
      submitPort,
      submitProfile,
      escalatePort,
      ...(seed === undefined ? {} : { seed }),
      ...(modelActivity.admission === undefined
        ? {}
        : { modelRequestAdmission: modelActivity.admission }),
    });
    state = {
      ref,
      sessionId,
      runtime,
      submitProfile,
      currentTyped: false,
      accepted: false,
      cancelled: false,
      turnGeneration: 0,
      pendingEscalations: new Map(),
      escalationsUsed: 0,
      modelActivity,
      actor,
      actorName: effectiveActorName(persona),
      transientAttempts: 0,
    };
    try {
      if (seed !== undefined) {
        await seedActorSession(this.deps, {
          journaledSessionId: journaled,
          runtime,
          seed,
          sessionId,
        });
      }
      if (this.disposed) throw new Error("Workflow driver closed during actor creation");
      modelActivity.observe(runtime, sessionId);
      this.sessions.set(sessionId, state);
      return ref;
    } catch (error) {
      // Even before registration the creation belongs to this driver; if seed recovery fails or close arrives first, the created instance must still be released.
      await releaseActorSessions(this.deps, [state], this.quiescence);
      throw error;
    }
  }

  startAsk(session: SessionRef, instance: InstanceRef, message: AskMessage): void {
    const state = this.sessions.get(session.id);
    if (state === undefined) {
      // Should be impossible (the engine creates the session before ask); report a normalized
      // DriverError instead of failing silently.
      this.sink.askFailed(
        instance,
        new WorkflowError("DriverError", `Unknown subagent session: ${session.id}`),
      );
      return;
    }
    // Withdraw any parked items left by the previous ask on an exceptional path (the turn was
    // interrupted by something other than abort). Once the new ask starts, nobody will read
    // those answers; leaving them in the registry would make the snapshot inaccurate.
    this.withdrawEscalations(state);
    state.currentInstance = instance;
    state.currentTyped = message.typed;
    state.accepted = false;
    state.cancelled = false;
    state.pendingSubmit = undefined;
    // Reset the per-ask budget (nudge uses runTurn, not this path; it remains within the same ask).
    state.escalationsUsed = 0;
    state.abortController = new AbortController();
    // Do not carry the previous ask's waiting/executing phase or tool count into this ask; the
    // transient retry count is reset for the same reason.
    state.modelActivity.reset();
    // Feed the ask start to the seat gate (emit recognizes `node-settled` as the end): from this
    // point the subagent counts as "working," so its next turn step must pass the gate. If the
    // same actor receives another ask immediately, this is an idempotent join; it was already
    // working and never became idle.
    this.deps.seatGate?.askStarted(refToString(state.actor), instance);
    state.transientAttempts = 0;
    state.cancelRedrive?.();
    state.cancelRedrive = undefined;
    this.instanceToSession.set(refToString(instance), state);

    // The quality suffix applies to typed and untyped asks; only typed asks get a schema suffix.
    // Both are appended after the scheduler computes inputHash, so they do not affect cache identity.
    // The typed ask's schema suffix depends on the submit profile: mono subagents already have
    // the schema in their tool declaration, so the suffix is one sentence; generic subagents
    // still include the full schema in the suffix. The guard runs first: if the static profile
    // does not match this ask, it downgrades the session to generic (or fails the ask), so the
    // value read below is already corrected.
    if (message.typed && !ensureSubmitProfileFits(this.deps, this.sink, state, instance, message)) {
      return;
    }
    const input = message.typed
      ? `${message.instructions}${qualityEpilogue(message.schema)}${
          state.submitProfile.kind === "mono" ? TYPED_TOOL_EPILOGUE : schemaEpilogue(message.schema)
        }`
      : `${message.instructions}${qualityEpilogue(undefined)}`;
    // Suffix boundary: the GUI uses it to fold the suffix into the disclosure. Everything
    // after the instruction body is engine text, so the boundary is the body length; the model
    // and persisted text part still receive the full text.
    // Fire and forget: never await turn completion inside startAsk (Boundary B contract).
    this.runTurn(state, instance, input, message.instructions.length);
  }

  respondToSubmit(instance: InstanceRef, verdict: EngineSubmitVerdict): void {
    const state = this.instanceToSession.get(refToString(instance));
    if (state === undefined) return;
    switch (verdict.kind) {
      case "accept": {
        // Mark as accepted: when this ask's turn resolves, do not report askTurnEnded (the engine already called settleOk).
        state.accepted = true;
        const deferred = state.pendingSubmit;
        state.pendingSubmit = undefined;
        deferred?.resolve({ accept: true });
        return;
      }
      case "reject": {
        // Repair within the same turn: the handler receives {accept:false} and throws → error tool_result → model retries.
        const deferred = state.pendingSubmit;
        state.pendingSubmit = undefined;
        deferred?.resolve({ accept: false, violations: mapViolations(verdict.violations) });
        return;
      }
      case "nudge": {
        // The turn has ended and no deferred is parked: start a fresh turn on the same persistent
        // runtime to prompt submission. The entire nudge is engine text, so the boundary is 0.
        this.runTurn(state, instance, NUDGE_PROMPT, 0);
        return;
      }
    }
  }

  cancelAsk(instance: InstanceRef): void {
    const state = this.instanceToSession.get(refToString(instance));
    if (state === undefined) return;
    // The engine cancels explicitly (repair/nudge budget exhausted, run cancelled/failed):
    // abort the in-flight turn and resolve any pending submit deferred to avoid blocking the
    // handler forever. Mark it cancelled so a rejected turn does not report askFailed.
    state.cancelled = true;
    const deferred = state.pendingSubmit;
    state.pendingSubmit = undefined;
    deferred?.reject(new WorkflowError("Cancelled", "The ask was cancelled by the engine."));
    // Treat parked escalation questions **the same as** submit deferreds and reject them too;
    // otherwise the `escalate` handler would block forever inside a cancelled ask. This is the
    // escape hatch for "no answer = indefinite blocking" (there is intentionally no timeout):
    // run cancellation and CLI process death therefore retain their existing behavior—ask
    // rejects as Cancelled, run becomes Interrupted, and resume reruns the ask so the actor asks
    // again and receives a new qid.
    this.withdrawEscalations(state);
    // Withdraw retries waiting for backoff too: the engine has settled the ask, so another turn
    // would waste tokens on a node nobody is listening to.
    state.cancelRedrive?.();
    state.cancelRedrive = undefined;
    state.abortController?.abort(new Error("workflow ask cancelled"));
  }

  /**
   * Release resources after run settlement (the engine calls this exactly once after run-settled;
   * see WorkflowDriver.dispose).
   *
   * For every actor runtime, use the app's **same** session-closing chain: `closeBrowserSession`
   * runs beginShutdown, node_repl session release, and browser session close in order. Do not
   * create a separate subagent shutdown chain that could drift. Do not close execution / MCP /
   * session store; subagents do not own them. Wait for an in-flight turn to finish before closing
   * its session (see SessionState.turn); close failures only warn and do not throw through
   * settlement. The three maps are then cleared.
   *
   * This method is **synchronous** and deliberately does not wait for in-flight turns; the
   * engine contract releases resources immediately after settlement. As a result, a resolved
   * settlement promise does not imply that an aborted turn has finished writing its tail. While
   * releasing resources, record each session's in-flight turn in the quiescence ledger so amend
   * can later decide which message counts are trustworthy. The coordination is in
   * {@link releaseActorSessions} (the workflow-driver-quiescence.ts header contains the full rationale).
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stallClock.dispose();
    releaseActorSessions(this.deps, this.sessions.values(), this.quiescence);
    this.concurrencyUnsubscribe?.();
    this.sessions.clear();
    this.instanceToSession.clear();
    this.qidToSession.clear();
  }

  /**
   * Settle a parked escalation question (called by the run service through the registry). The
   * implementation is in workflow-driver-escalation.ts ({@link respondToParkedEscalation}); this method only delegates.
   */
  respondToEscalation(qid: string, answer: string): boolean {
    return respondToParkedEscalation(this.escalationHost, qid, answer);
  }

  /** Withdraw all parked escalation questions for a session; see {@link withdrawSessionEscalations}. */
  private withdrawEscalations(state: SessionState): void {
    withdrawSessionEscalations(this.escalationHost, state);
  }

  /**
   * World read: delegate the entire operation to {@link executeWorldRead} (workflow-world-read.ts).
   *
   * This is only a forwarder because world reads share **no state** with the rest of this file:
   * they do not touch actor sessions, turns, or submit bridging and need only three things (two
   * ports and a cwd). After extraction this file handles only session and turn orchestration,
   * while op metadata, limit enforcement, and fixed git argv live together in one place.
   */
  async executeWorldRead(op: WorldReadOp, args: unknown[]): Promise<unknown> {
    if (this.disposed) throw new Error("Workflow driver is closed");
    const work = executeWorldRead(this.deps, op, args);
    this.quiescence.trackRelease(
      work.then(
        () => undefined,
        () => undefined,
      ),
    );
    return await work;
  }

  /**
   * Publish user-facing artifacts by delegating the entire operation to
   * {@link executeArtifactPublish} (workflow-artifact-publish.ts). The reason is exactly the
   * same as for world reads above: it shares no state with this file and needs only two ports,
   * a cwd, and a session ID.
   *
   * The method is **optional** on Boundary B (`executeArtifactPublish?`), but this driver always
   * implements it. Whether storage exists is an assembly fact expressed by `artifactStore` in
   * deps, and that side should fail loudly when absent. Do not express the same fact through a
   * second channel by making the method itself absent; two channels would give the same issue
   * two failure modes.
   */
  async executeArtifactPublish(request: ArtifactPublishRequest): Promise<ArtifactVersionRecord> {
    if (this.disposed) throw new Error("Workflow driver is closed");
    const work = executeArtifactPublish(this.deps, request);
    this.quiescence.trackRelease(
      work.then(
        () => undefined,
        () => undefined,
      ),
    );
    return await work;
  }

  // ——————————————————————————————— Internal: turn orchestration ———————————————————————————————

  private runTurn(
    state: SessionState,
    instance: InstanceRef,
    input: string,
    epilogueStart: number,
  ): void {
    const abortSignal = state.abortController?.signal;
    state.turnGeneration++;
    state.turn = state.runtime
      .executeTurn(input, undefined, {
        ...(abortSignal ? { abortSignal } : {}),
        epilogueStart,
      })
      .then(
        (result) => this.onTurnResolved(state, instance, result),
        (error) => this.onTurnRejected(state, instance, error),
      );
  }

  private onTurnResolved(state: SessionState, instance: InstanceRef, result: TurnResult): void {
    // The two reports for one turn (progress before usage) are ordered and assembled in reportTurnObservations.
    reportTurnObservations(this.sink, state, instance, result);
    if (this.deps.actorTranscriptStore === undefined) {
      // Without transcript access, keep the original synchronous path without adding an await;
      // boundary accounting is omitted entirely (see the deps field comment).
      this.reportTurnOutcome(state, instance, result);
      return;
    }
    void this.settleExchange(state, instance, result);
  }

  /**
   * Report a turn's outcome and answer whether this ask's exchange has ended.
   *
   * Without accept, the only path is to give the final text to the engine (typed → nudge or
   * exhausted failure; untyped → settle based on that text). For nudge, the engine starts a fresh
   * turn through respondToSubmit **on this call stack**, changing turnGeneration; that signals
   * the exchange is not over. Repair turns do not apply: they stay in the same turn, so this
   * method is not called for them.
   */
  private reportTurnOutcome(
    state: SessionState,
    instance: InstanceRef,
    result: TurnResult,
  ): boolean {
    // Submitted and accepted by the engine: the ask is settled, and turn completion is only
    // confirmation; do not report askTurnEnded again.
    if (state.accepted) return true;
    const generation = state.turnGeneration;
    this.sink.askTurnEnded(instance, result.response);
    return state.turnGeneration === generation;
  }

  /**
   * Finish an exchange: count messages → report the outcome → if the exchange really ended,
   * write the boundary to the ask's journal row.
   *
   * **Count before reporting**; this order affects the data. After reporting, the engine may
   * immediately dispatch this actor's next ask in the same session (per-actor FIFO guarantees
   * serialization but not a gap between asks). That turn's messages would enter the same session
   * and inflate this count. Counting first captures the session length when this exchange ended.
   */
  private async settleExchange(
    state: SessionState,
    instance: InstanceRef,
    result: TurnResult,
  ): Promise<void> {
    const boundary = await countSessionTranscript(this.deps, state, instance);
    const ended = this.reportTurnOutcome(state, instance, result);
    if (!ended || boundary === undefined) return;
    journalAskMessageBoundary(this.deps, state, instance, boundary);
  }

  private onTurnRejected(state: SessionState, instance: InstanceRef, error: unknown): void {
    // Once the turn is dead, nobody will read tool results. Withdraw parked escalation questions
    // too, or they will remain in snapshot.pendingQuestions forever and ask the main agent to
    // answer a question with no listener.
    this.withdrawEscalations(state);
    if (state.cancelled || isTurnCancelled(error)) {
      // Engine-initiated cancellation (abort): the engine already settled this ask, so the driver does not report it again.
      return;
    }
    // Model-side errors are handled in workflow-driver-model-failure.ts (a policy table decides
    // stop / context_exceeded / transient retry); only non-model errors fail at the driver level.
    if (handleModelTurnFailure(this.modelFailureHost, state, instance, error)) return;
    this.sink.askFailed(instance, toWorkflowError(error));
  }

  // ——————————————————————————————— Internal: escalation question bridge ———————————————————————————————

  /**
   * Create a session-level escalation port. Its implementation is in workflow-driver-escalation.ts
   * ({@link makeSessionEscalatePort}), where the rationale symmetric with
   * {@link makeSessionSubmitPort} is also documented.
   */
  private makeEscalatePort(
    sessionId: SessionId,
    actor: ActorRef,
    persona: PersonaSpec,
  ): WorkflowEscalatePort {
    return makeSessionEscalatePort(this.escalationHost, sessionId, actor, persona);
  }

  /**
   * Persist a driver-side event on both tracks: durable storage in `dwf_event`, and live fan-out through emit.
   *
   * This matches the engine's `record()` (engine.ts) byte for byte, and the order is fixed:
   * launch-side sequence capture depends on emit receiving the assigned sequence immediately
   * after appendEvent, with the same event object reference (createJournalSequenceCapture in
   * dynamic-workflow-run-launch.ts).
   */
  private record(event: RunEvent): void {
    this.journal.appendEvent(this.deps.runId ?? "run", event);
    this.emit(event);
  }
}

/**
 * Create a driver factory bound to deps, ready to serve as the harness's makeDriver. deps
 * provides journal and emit; the caller (test/production) retains their references for
 * assertions and Boundary C fan-out.
 */
export function createAgentRuntimeWorkflowDriver(
  deps: AgentRuntimeWorkflowDriverDeps,
): (sink: WorkflowReportSink) => WorkflowDriver {
  return (sink) => new AgentRuntimeWorkflowDriver(deps, sink);
}

export { mintActorSessionId } from "./workflow-driver-helpers.js";
export type { ActorRuntimeFactory } from "./workflow-driver-types.js";
