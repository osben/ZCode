// ============================================================
// Dynamic Workflow Run launch executor (shared implementation for submit and resume)
// ============================================================
// submit (new runId) and resume (existing runId, taking the engine's resume branch) are identical
// from "assemble driver → run runWorkflowScript," so share that implementation here. Duplicating
// it at both entry points would eventually leave one without event-sequence capture or actor rehydration.
//
// This file owns three responsibilities:
//   1. Journal-sequence capture (the emit side gets the sequence of the event just appended).
//   2. RunEvent → session-event payload (bounded payload + two derived fields).
//   3. Actor-runtime integration: new runtime (persist session row + task link) or rehydration (resumeFromStore).

import { randomUUID } from "node:crypto";
import {
  boundDynamicWorkflowRunEventPayload,
  CoreErrorType,
  ZCODE_DWF_CHILD_COMMAND,
  type CreateSessionTaskLinkInput,
  type DynamicWorkflowRunEvent,
  type DynamicWorkflowRunProgressPayload,
  type SessionId,
} from "@zcode/contracts";
import type { AgentRuntime } from "@zcode/core";
import { parseModelPickerValue, type ModelSelection } from "@zcode/shared/model-selection";
import {
  type ActorSubmitProfile,
  refToString,
  validate,
  type ActorRef,
  type AskSpec,
  type Caps,
  type ImportedRunCache,
  type JournalStorePort,
  type JsonSchema,
  type RunEvent,
  type RunSettlement,
  type ValidateFn,
} from "@zcode/dynamic-workflow";
import { runWorkflowScript } from "@zcode/dynamic-workflow-runtime";
import { createJournalSequenceCapture } from "./dynamic-workflow-run-sequence-capture.js";
import { isResumableSettlement } from "./dynamic-workflow-run-observation.js";
import {
  readRunLaunchAnchor,
  readRunSubagentModel,
  type RunLaunch,
} from "./dynamic-workflow-run-launch-anchor.js";
import { resolveWorkflowConcurrencyCeiling } from "./workflow-concurrency-ceiling.js";
import type { ActorSessionQuiescence } from "./workflow-driver-quiescence.js";
import { createAgentRuntimeWorkflowDriver, mintActorSessionId } from "./workflow-driver.js";
import type { WorkflowEscalationRegistry } from "./workflow-escalation-registry.js";
import type { WorkflowRunControl } from "./workflow-run-control.js";
import { createWorkflowRunSeatGate } from "./workflow-seat-gate.js";
import type { DynamicWorkflowRunServiceDeps } from "./dynamic-workflow-run-service.js";

/** Adapt the package validator to the engine's ValidateFn contract (launch is the only caller of runWorkflowScript). */
const validateFn: ValidateFn = (schema, value) => validate(schema as JsonSchema, value);

/** All outputs from one compilation. Four consumers share the same ts.Program (compile once; see run-service invariant 2). */
export interface CompiledDynamicWorkflowScript {
  lowered: string;
  scriptHash: string;
  askSpecs: Map<string, AskSpec>;
  /** Approved world.run commands (collected as literals at compile time). */
  declaredRunCommands: ReadonlySet<string>;
  /** Submit profile for each actor site. */
  actorSubmitProfiles: ReadonlyMap<string, ActorSubmitProfile>;
}

interface LaunchDynamicWorkflowRunInput {
  caps: Caps;
  compiled: CompiledDynamicWorkflowScript;
  cwd: string;
  deps: DynamicWorkflowRunServiceDeps;
  /** Display name for the run (optional `CreateWorkflow` `input.name`), persisted to dwf_run.name during createRun via EngineConfig. */
  name?: string;
  /**
   * Arguments for this run (validated argument bag for a saved workflow). Used in two places: persisted
   * to `dwf_run.args_json` through EngineConfig, and injected into the sandbox as the `args` global
   * in the spawn payload.
   *
   * The resume branch passes the value **read back from the journal**, not a new caller-provided
   * value; see the run-service resume comment.
   */
  args?: Record<string, unknown>;
  parentSessionId?: string;
  runId: string;
  scriptText: string;
  signal: AbortSignal;
  toolCallId?: string;
  /**
   * Lineage pointer (`dwf_run.resumed_from`) and import cache for an amended resume. They always occur
   * **together**: the pointer is a row-level fact (UI's "resumed from run X" and restart recovery use
   * it), while the cache accelerates this execution.
   *
   * It follows the same path as other metadata — launch → harness → EngineConfig — with no processing
   * in between. Construction (read predecessor journal, follow the `resumed_from` chain, resolve
   * transcript sources) all happens in the run service. Building it here would make resume and
   * submit construct it separately, though they must be calls to the same pure function.
   */
  resumedFrom?: string;
  importedCache?: ImportedRunCache;
  /**
   * Usage starting point when creating the run: `spentTokens` after predecessor settlement.
   * Follows the same path as the lineage pointer — launch → harness → EngineConfig — without
   * intermediate processing. Supplied by amend; absent for fresh submit and resume (the latter
   * restores usage from the existing row).
   */
  inheritedTokens?: number;
  /**
   * Anchor for the turn that launched the run. Supplied by submit (the engine records
   * `run-launched` at run creation); absent on resume, so this function reads it from the journal.
   * Both paths use the same value to derive `launchInputId` for `actor-created`/`run-settled`
   * progress events. Submit also carries the script-declared phase table (`phaseNames`) and this
   * run's subagent model (`subagentModel`, canonical picker string); all three are recorded in the
   * journal only when the run is created, and resume always reads them from that event.
   */
  launch?: RunLaunch;
  /**
   * Suspension registry for escalation questions. The run service owns one registry shared across
   * all its in-flight runs, and both entry points (submit/resume) pass the **same object**. The
   * registry is indexed by full qid; separate registries would prevent a resumed run from answering
   * a question it just asked.
   */
  escalationRegistry: WorkflowEscalationRegistry;
  /**
   * Live control plane for this run. The run service creates one per **registry entry** (all three
   * entry points: submit/amend/resume); this function connects both ends: the harness handles
   * `bind(engine)`, and this function handles `bindSeatGate`.
   *
   * If absent, this launch has no control plane (for example, snippet execution): the run completes
   * normally, but its limits cannot be changed while running.
   */
  control?: WorkflowRunControl;
  /**
   * Receives the **session-quiescence probe** (workflow-driver-quiescence.ts) from the driver created
   * by this launch. All three entry points pass the same probe and attach it to this run's registry
   * entry, so a future amend can check whether "the predecessor has finished writing to the session."
   * Pass it through unchanged; this file does not inspect it.
   */
  onQuiescenceProbe?: (probe: ActorSessionQuiescence) => void;
}

/**
 * Start (or resume) a run: assemble sequence capture → emit hook → real driver → runWorkflowScript.
 * The caller chooses fire-and-forget behavior (this function returns the settlement promise and does
 * not manage the registry).
 */
export function launchDynamicWorkflowRun(
  input: LaunchDynamicWorkflowRunInput,
): Promise<RunSettlement> {
  const {
    args,
    caps,
    compiled,
    control,
    cwd,
    deps,
    escalationRegistry,
    importedCache,
    name,
    parentSessionId,
    resumedFrom,
    runId,
    scriptText,
    signal,
    toolCallId,
  } = input;
  const childSpawn = dynamicWorkflowChildSpawn();
  // **Second** enforcement point for this run's own cap: the scheduler checks "can we dispatch
  // another ask?" while this gate checks "can the already-running asks send their next request?"
  // The starting caps are those supplied for this launch (clamped request for submit, journal row
  // for resume), so a run never retuned stays on the gate's fast path — no event, no permit, exactly
  // the same behavior as before.
  const seatGate = createWorkflowRunSeatGate({ limit: caps.maxConcurrency });
  control?.bindSeatGate(seatGate);
  // Anchor: supplied by submit (this run's creation) or read from the journal (resume). Runs created
  // before the upgrade have neither, so omit it and do not report subagents in progress events.
  const launch = input.launch ?? readRunLaunchAnchor(deps.journal, runId);
  // Lineage pointer: supplied for submit/amend; absent on resume because createRun already persisted
  // it, so read it from the journal row. This keeps `run-started` payloads identical across both paths.
  const lineageFrom = resumedFrom ?? deps.journal.getRun(runId)?.resumedFrom;
  // Concurrency ceiling: second host-derived field in the `run-started` payload. Calculate once per
  // launch rather than for every event: it is a process fact, CPU count does not change mid-run, and
  // `availableParallelism()` is a system call.
  const concurrencyCeiling = resolveWorkflowConcurrencyCeiling(deps.availableParallelism);
  // Subagent model: supplied by submit (alongside the anchor) or read from the same run-launched
  // journal event on resume. Same reasoning as the anchor, so both paths have the same shape; older
  // runs have neither, so absence means use the session model.
  const subagentModel = input.launch?.subagentModel ?? readRunSubagentModel(deps.journal, runId);
  // Parse string → selection once per launch. Progress payloads use the original string (see
  // toProgressPayload below); the actor-runtime factory needs a structured selection, including
  // reasoning level, which cannot be recovered from the pin's two-part identity.
  const runSubagentModel =
    subagentModel === undefined ? undefined : parseModelPickerValue(subagentModel);

  // Only appendEvent knows the journal sequence. In engine record(), `driver.emit(...)` is called
  // **synchronously** right after `journal.appendEvent(...)`, and the returned StoredEvent is
  // discarded (engine.ts). Wrap the journal here to capture the assigned sequence; emit is then
  // guaranteed to receive that just-appended event. Alternatives are worse: a local counter would
  // drift on resume (which continues from the existing maximum), while querying the journal for
  // every event adds unnecessary I/O.
  // Tests enforce the "append immediately followed by emit, one-to-one" assumption: the sequence
  // observed by the hook must exactly match each entry returned by listEvents.
  const sequenceCapture = createJournalSequenceCapture(deps.journal);

  const makeDriver = createAgentRuntimeWorkflowDriver({
    journal: sequenceCapture.journal,
    emit: (event) => {
      // Event fan-out must never crash the run: the hook is an observer, so catch and log failures here.
      try {
        if (deps.onRunEvent === undefined) return;
        deps.onRunEvent(
          toProgressPayload({
            event,
            runId,
            sequence: sequenceCapture.sequenceOf(event),
            ...(toolCallId === undefined ? {} : { toolCallId }),
            ...(launch === undefined ? {} : { launchInputId: launch.inputId }),
            ...(lineageFrom === undefined ? {} : { resumedFrom: lineageFrom }),
            concurrencyCeiling,
            ...(subagentModel === undefined ? {} : { subagentModel }),
          }),
          // Routing and payload are separate: the event must go to the session that **launched this
          // run**, and parentSessionId is the only way to identify that session.
          parentSessionId === undefined ? {} : { parentSessionId },
        );
      } catch (error) {
        deps.logger?.warn?.("Dynamic workflow run event hook failed", {
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "dynamic_workflow.run_event.hook_failed",
          module: "bootstrap.app",
          runId,
        });
      }
    },
    executionPort: deps.executionPort,
    fileSystemPort: deps.fileSystemPort,
    escalationRegistry,
    cwd,
    // Destination for user-facing artifacts. Use the parent session **of this service** (the app's
    // own session), not the optional parentSessionId launch argument. They are equal in production
    // (run start passes the runtime's own sessionId), but only the former is required, and there
    // should be no undefined branch for "which session's directory receives these bytes." If the
    // store is absent, omit both values so the driver fails clearly with ArtifactStoreUnavailable.
    ...(deps.artifactStore === undefined
      ? {}
      : {
          artifactStore: deps.artifactStore,
          parentSessionId: deps.parentSessionId as SessionId,
        }),
    declaredRunCommands: compiled.declaredRunCommands,
    // Which submit_result variant each actor site uses (typed/generic/none) is determined at compile time.
    actorSubmitProfiles: compiled.actorSubmitProfiles,
    runId,
    // Boundary accounting and seed copying both read/write actor-session messages on the driver
    // side (see the workflow-driver.ts header).
    ...(deps.actorTranscriptStore === undefined
      ? {}
      : { actorTranscriptStore: deps.actorTranscriptStore }),
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    // Narrow port to the process-level concurrency controller: when present, the driver gives each
    // actor runtime a request-level admission port (passed through by runtimeFactory below); when
    // absent, actors are not gated.
    ...(deps.concurrency === undefined ? {} : { concurrency: deps.concurrency }),
    // Seat gate for this run: the driver wraps each actor's admission port and reports ask start/end
    // (startAsk and the engine's `node-settled`).
    seatGate,
    // Driver clock injected by tests (failure matrix); absent in production, where the driver uses real time.
    ...(deps.driverClock === undefined ? {} : { clock: deps.driverClock }),
    // Backfill for the session-quiescence probe (see the input-field comment); the driver calls this once during construction.
    ...(input.onQuiescenceProbe === undefined
      ? {}
      : { onQuiescenceProbe: input.onQuiescenceProbe }),
    runtimeFactory: async ({
      sessionId,
      actor,
      persona,
      escalatePort,
      seed,
      submitPort,
      submitProfile,
      modelRequestAdmission,
    }) => {
      const runtime = deps.createActorRuntime({
        runId,
        sessionId,
        actor,
        persona,
        submitPort,
        // The factory uses the profile to decide whether to inject the ports and declare the result typed (createActorRuntime in create-app.ts).
        submitProfile,
        // Pass the request-level admission port to runtime deps along with the two tool ports.
        ...(modelRequestAdmission === undefined ? {} : { modelRequestAdmission }),
        // Pass the escalation port along with the submit port; core's registration gate checks only
        // for the port, so always pass it.
        escalatePort,
        // Resume pin: the model this actor used last time. Read it **before creating the runtime**,
        // because journalActorResolvedModel below writes this turn's resolved model back to the same field.
        //
        // A seed-provided pin is **inherited** (amend-resume): during the amended run's first dispatch,
        // its journal has no resolved model yet, so the pin can come only from the predecessor. The
        // pin prevents an identity change that silently switches models while continuing a
        // transcript. If both are present (resume after the amended run crashed), use this run's
        // record: it is more specific about the model this actor actually used **in this run**, and
        // should equal the predecessor's value. Keep malformed-pin failures on the existing path
        // (WorkflowActorPinnedModelError in workflow-actor-model.ts); do not fork the behavior here.
        pinnedModel:
          pinnedActorModel({ actor, journal: deps.journal, runId }) ?? seed?.resolvedModel,
        // This run's subagent model takes precedence over the pin (see the priority table in
        // workflow-actor-model.ts). It is the user's explicit choice for this run (AmendWorkflow
        // with subagent_model means "explicitly switch models on resume"); the pin protects only the
        // implicit default when this value is absent. Unlike a pin, this value includes the
        // reasoning level; the journal pin stores only the two-part identity.
        ...(runSubagentModel === undefined ? {} : { runSubagentModel }),
      });
      // Only the constructed runtime knows which model a persona's model tier resolved to (see the
      // tier mapping in workflow-actor-model.ts). Persist it before connecting to the session: if
      // session persistence fails, this ask fails, but the audit fact "which model was selected"
      // remains in the journal. Write it on rehydration too; this may be the first resolved model
      // for older runs with no pin.
      journalActorResolvedModel({
        actor,
        journal: deps.journal,
        selection: requireActorModelSelection(runtime, actor),
        runId,
      });
      const attached = await attachActorSession({
        actor,
        deps,
        runId,
        runtime,
        sessionId,
      });
      if (attached === "rehydrated") return runtime;
      await persistActorSession({
        actor,
        deps,
        parentSessionId,
        runId,
        runtime,
        sessionId,
      });
      return runtime;
    },
  });

  return runWorkflowScript({
    askSpecs: compiled.askSpecs,
    caps,
    // SEA requires a different spawn strategy; do not pass it outside SEA.
    ...(childSpawn === undefined ? {} : { childSpawn }),
    cwd,
    lowered: compiled.lowered,
    makeDriver,
    // If the entry file cannot be written to the project's `.zcode/`, the harness falls back to the
    // OS temporary directory and logs a warning. The run still starts, but this log is the only clue
    // when investigating "why the project has no workflow-runs archive."
    onWarning: (warning) => {
      deps.logger?.warn?.("Dynamic workflow entry file fell back to the OS temp dir", {
        event: "dynamic_workflow.entry_file.fallback",
        module: "bootstrap.app",
        runId,
        ...warning,
      });
    },
    // name follows the same metadata path as scriptText: the harness passes it unchanged to
    // EngineConfig. On resume, the journal hits createRun's short circuit, so passing it is harmless
    // and keeps submit/resume launch inputs identical.
    ...(name === undefined ? {} : { name }),
    // Arguments follow the same metadata path as name/scriptText, with one additional destination:
    // the harness passes them to EngineConfig (persisted as args_json) and includes them in the spawn
    // payload for sandbox injection.
    ...(args === undefined ? {} : { args }),
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
    runId,
    // Persist the author's source text and its hash, not the lowered function body (resume compares
    // against the original source).
    scriptHash: compiled.scriptHash,
    scriptText,
    // Persist the correlation anchor with the run: after restart, the tool-card join and resume
    // notification can recover it only from dwf_run.
    ...(toolCallId === undefined ? {} : { toolCallId }),
    // Amended resume: persist the lineage pointer (write once in createRun) and inject the import
    // cache into the engine (plain data; no core I/O).
    ...(resumedFrom === undefined ? {} : { resumedFrom }),
    ...(importedCache === undefined ? {} : { importedCache }),
    // Usage starting point travels with the cache: the engine writes it as initial spent_tokens in
    // createRun and ignores it when reusing an existing row.
    ...(input.inheritedTokens === undefined ? {} : { inheritedTokens: input.inheritedTokens }),
    // The anchor is journaled only when the run is created (engine-side gate); passing it on resume is harmless.
    ...(launch === undefined ? {} : { launch }),
    signal,
    // Control plane uses the same seam as signal: one stops the run, the other changes one run
    // setting. The harness binds it in the same synchronous section that constructs the engine
    // (harness.ts), so the run is mutable starting with its first event.
    ...(control === undefined ? {} : { control }),
    validate: validateFn,
  });
}

/**
 * Spawn strategy for the sandbox subprocess: under SEA, use the hidden subcommand to re-exec;
 * otherwise leave it unspecified (the harness default
 * `node --max-old-space-size=… <entry>`）。
 *
 * A SEA single-file binary does not interpret Node CLI flags. The harness's default argv includes
 * `--max-old-space-size`, which reaches the CLI's strict parseArgs unchanged and makes the child
 * process exit immediately — **every workflow run fails under SEA**. Use the same fix as the
 * official plugin host (`officialPluginHostPrefixArgs` in official-plugin-runtime.ts).
 *
 * Keep SEA detection in bootstrap rather than moving it into the harness: the harness is app-free
 * (depends only on `@zcode/dynamic-workflow` and Node built-ins), has no access to the contracts
 * subcommand constant, and should not know which host packaged it. Inject `isSea` only for testing;
 * the default probe necessarily returns false in tests, making "non-SEA must not set argsPrefix" an
 * assertable fact too.
 */
export function dynamicWorkflowChildSpawn(
  isSea: boolean = isSeaRuntime(),
): { argsPrefix: readonly string[] } | undefined {
  return isSea ? { argsPrefix: [ZCODE_DWF_CHILD_COMMAND] } : undefined;
}

/** Runtime SEA probe (local mirror of the private helper with the same name in official-plugin-runtime.ts; intentionally not shared across files). */
function isSeaRuntime(): boolean {
  const getBuiltinModule = process.getBuiltinModule as
    | ((id: "node:sea") => { isSea(): boolean })
    | undefined;
  try {
    return getBuiltinModule?.("node:sea").isSea() === true;
  } catch {
    return false;
  }
}

/**
 * Resume rehydration: if the journal already contains this actor's session ID, reattach to it (the
 * session row and messages were persisted already; `mintActorSessionId` is deterministic, so the
 * sessionId is the original one, with an additional check on the driver side).
 * `resumeFromStore` rebuilds messageHistory from persisted message/part rows. The hydrator marks an
 * interrupted tool call as "[Tool execution was interrupted before resume]", which is the correct
 * semantics for a killed ask.
 *
 * `SessionNotFound` (the session row was cleaned up) is a documented exception, not an error: fall
 * back to fresh persistence and restart the actor with empty context. This is more honest than
 * hanging the whole run. Rethrow all other exceptions (the low-level rule is not to swallow errors).
 */
async function attachActorSession(input: {
  actor: ActorRef;
  deps: DynamicWorkflowRunServiceDeps;
  runId: string;
  runtime: AgentRuntime;
  sessionId: SessionId;
}): Promise<"fresh" | "rehydrated"> {
  const { actor, deps, runId, runtime } = input;
  const journaledSessionId = deps.journal.getActor(runId, actor.siteId, actor.ordinal)?.sessionId;
  if (journaledSessionId === undefined) return "fresh";
  try {
    await runtime.resumeFromStore();
    // Session row and task link were persisted in the prior run (both are upserts); do not recreate them when reattaching.
    return "rehydrated";
  } catch (error) {
    if (!isSessionNotFound(error)) throw error;
    deps.logger?.warn?.("Dynamic workflow actor session pruned; starting fresh", {
      actor: refToString(actor),
      event: "dynamic_workflow.actor.rehydrate_fallback",
      module: "bootstrap.app",
      runId,
      sessionId: input.sessionId,
    });
    return "fresh";
  }
}

/** Structurally identify core's SessionNotFound error (do not use error text for control flow). */
function isSessionNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { type?: unknown }).type === CoreErrorType.SessionNotFound
  );
}

/**
 * Materialize an actor session by persisting its session row and creating a task link
 * (the legacy path is demonstrated in script-workflow-runtime.ts).
 *
 * The order is **required by the schema**: `session_task_link.child_session_id` has a
 * foreign key to `session(id)`, so the session row must be persisted before creating the link.
 * This is also why ActorRuntimeFactory may return a Promise.
 *
 * Do **not** subscribe to actor runtime events here. The live channel is installed while
 * constructing the child runtime (script-workflow-child-runtime.ts wires its eventSink into
 * the parent's external sink set). The old `subscribeEvents` channel was installed after the
 * `ensureSessionPersistedForExternalActivity` call below, which wrote SessionTitleUpdated as
 * sequenceNumber 1. The v4 gateway drains only contiguous sequence numbers, so a subscription
 * starting at sequence 2 would wait forever for the missing sequence 1 and leave the transcript empty.
 */
async function persistActorSession(input: {
  actor: ActorRef;
  deps: DynamicWorkflowRunServiceDeps;
  parentSessionId?: string;
  runId: string;
  runtime: AgentRuntime;
  sessionId: SessionId;
}): Promise<void> {
  const { actor, deps, parentSessionId, runId, runtime, sessionId } = input;
  const title = `workflow subagent ${refToString(actor)}`;

  await runtime.ensureSessionPersistedForExternalActivity(title);

  if (deps.taskLinkStore) {
    await deps.taskLinkStore.createSessionTaskLink({
      childSessionId: sessionId,
      id: `tasklink_${randomUUID()}`,
      // Intentionally leave rootWorkflowRunId empty. **Verified fact, not an assumption**:
      // this column is declared as `root_workflow_run_id text references workflow_run(id)`
      // (migration 0007, in the session_task_link table definition). It references the
      // **legacy** workflow_run table, while workflow run records live in dwf_run; the migration
      // runner enables `pragma foreign_keys = on`. A probe against the real store confirmed that
      // passing the workflow runId fails with `FOREIGN KEY constraint failed`, while omitting it
      // succeeds. Run identity therefore uses the path column below, which has no foreign key.
      //
      // path is a small contract: `dwf/<runId>/<siteId>@<ordinal>`. runId is already safe for
      // this character set; the siteId segment preserves the original `#`/`@` (the column is
      // free text, and the sanitized form is already present in the session ID). **No code
      // currently parses this value**; it is readable by people and may support a future prefix
      // scan for "all actor sessions in this run". An index query by run ID would require a
      // migration that rebuilds session_task_link and changes or removes the foreign key.
      path: `dwf/${runId}/${refToString(actor)}`,
      ...(parentSessionId === undefined ? {} : { parentSessionId: parentSessionId as SessionId }),
      // Intentionally use a distinct role from legacy "workflow_agent" (script-workflow-runtime.ts):
      // these rows serve different consumers. A legacy row has a nonempty root_workflow_run_id
      // referencing workflow_run; a dwf row always leaves that column empty and stores run identity
      // in path. Sharing the role would cause consumers that select by role and dereference
      // root_workflow_run_id to receive null from a dwf row. The column is `text not null`, with no
      // CHECK, enum, or contract-side zod schema (verified), so the new value is valid.
      role: "workflow_actor",
      status: "running",
    } satisfies CreateSessionTaskLinkInput);
  }
}

/**
 * Write the model actually used by an actor to the journal (`ActorRecord.resolvedModel`, stored
 * in the dwf_actor resolved_model column).
 *
 * Why this must be a **read-modify-write**: `putActor` replaces the entire record, and this
 * function does not own its other fields (name / persona / sessionId). Writing a record containing
 * only resolvedModel would erase the frozen persona just written by the engine.
 *
 * Why the driver writes it: the model used by a subagent is a host fact (the parent session's
 * selection at that moment), which the engine cannot see when it synchronously persists the
 * persona during createActor. The engine's two putActor calls carry this field forward unchanged;
 * see engine.ts and scheduler.ts in dynamic-workflow.
 */
export function journalActorResolvedModel(input: {
  actor: ActorRef;
  journal: JournalStorePort;
  selection: ModelSelection;
  runId: string;
}): void {
  const { actor, journal, selection, runId } = input;
  const existing = journal.getActor(runId, actor.siteId, actor.ordinal);
  journal.putActor({
    ...(existing ?? { runId, siteId: actor.siteId, ordinal: actor.ordinal }),
    resolvedModel: formatActorResolvedModel(selection),
  });
}

/** Format `resolvedModel` in the journal as `providerId/modelId`, inverse to the pin parser (workflow-actor-model.ts). */
function formatActorResolvedModel(selection: ModelSelection): string {
  return `${selection.providerId}/${selection.modelId}`;
}

/**
 * A constructed actor runtime must already have a model selection: the child inherits the parent
 * session's current selection (script-workflow-child-runtime.ts), and without one the parent
 * session cannot send even its first model request. Fail clearly here instead of recording an
 * empty pin for a missing model selection.
 */
function requireActorModelSelection(runtime: AgentRuntime, actor: ActorRef): ModelSelection {
  const selection = runtime.getSessionModelSelection();
  if (selection === undefined) {
    throw new Error(
      `actor 会话没有模型选择，无法记录 resolvedModel: ${actor.siteId}#${actor.ordinal}`,
    );
  }
  return selection;
}

/**
 * Read the resume pin: this actor's journaled `resolvedModel` (`providerId/modelId`).
 *
 * Only resume finds a value: when replaying `createActor`, the engine carries this field forward.
 * A fresh run has no resolved value yet when the runtime factory runs, so the field is naturally
 * absent. **Read it before constructing the runtime**, because `journalActorResolvedModel` writes
 * this run's resolution to the same field; reading afterward would mistake the current result for
 * the previous run's pin. See workflow-actor-model.ts for precedence between the pin and this run's
 * subagentModel (the run selection takes priority; the pin is only the default when no run
 * selection exists, preserving the persisted side of the frozen-persona invariant).
 */
function pinnedActorModel(input: {
  actor: ActorRef;
  journal: JournalStorePort;
  runId: string;
}): string | undefined {
  return input.journal.getActor(input.runId, input.actor.siteId, input.actor.ordinal)
    ?.resolvedModel;
}

/**
 * Map RunEvent to a protocol event (**this comment is the contract**): `type` is the event's
 * discriminator, and `payload` contains the remaining fields of the same event object after
 * removing `type`, bounded by {@link boundDynamicWorkflowRunEventPayload}. Field names are
 * intentionally preserved: readers (the detail-page event log) interpret payload by event kind,
 * and the engine's vocabulary is the schema.
 *
 * Event kinds actually emitted by the engine: run-started / actor-created / node-queued / node-dispatched /
 * node-repairing / node-nudged / node-settled / usage-updated / log / report / phase-entered /
 * run-settled。
 * (`executing` is not an observable event; v1 never emits `compaction`.) The **driver** emits
 * two additional event kinds through the same two tracks: escalation-raised / escalation-resolved
 * (the escalation bridge in workflow-driver.ts).
 *
 * Adding an event kind requires no change to **this function**, which is the benefit of preserving
 * field names: `type` comes from the discriminator and payload contains the remaining fields, so
 * there is no per-kind branch to miss here. **There is, however, a downstream switch by kind**:
 * `applyWorkflowRunEvent` in `zcode-protocol-v4/product-projection.ts` reduces each event kind.
 * Its `eventType` parameter is `string`, not `RunEvent["type"]`, so TypeScript will not report a
 * missing branch. Read that switch when adding an event kind; the compiler will not catch it.
 */
export function toProtocolEvent(sequence: number, event: RunEvent): DynamicWorkflowRunEvent {
  const { type, ...rest } = event;
  const { payload, truncated } = boundDynamicWorkflowRunEventPayload(
    rest as Record<string, unknown>,
  );
  return { sequence, type, payload, ...(truncated ? { truncated } : {}) };
}

/**
 * Map RunEvent to a session-event payload. `payload` uses the same serialization as
 * {@link toProtocolEvent}; derived fields stay outside payload so the original engine event is preserved.
 *
 * `actorSessionId` comes from the same generator used by the driver, so the renderer does not
 * duplicate the session ID rule. Both `actor-created` and `node-dispatched` events with an actor
 * include this field, allowing active instances placed in the bounded table to remain associated
 * with their subagent session. The process concurrency ceiling and subagent source are added under
 * their respective event conditions below.
 */
export function toProgressPayload(input: {
  event: RunEvent;
  runId: string;
  sequence: number;
  toolCallId?: string;
  /** The run's anchor inputId; derived only for actor-created / run-settled (the two subagent ownership moments). */
  launchInputId?: string;
  /** The predecessor of a revised run; derived only for `run-started` (the card's "revised from run X" label). */
  resumedFrom?: string;
  /**
   * The process concurrency ceiling at the time this payload is created; derived for `run-started`
   * and `run-caps-changed` events.
   *
   * Engine events carry only their own `caps.maxConcurrency`; whether that value is worth displaying
   * depends on comparing it with the ceiling. The ceiling is a host fact (machine CPU count), which
   * the engine neither sees nor should see. The projection records this run's own upper bound when
   * `caps.maxConcurrency < concurrencyCeiling`; the UI concurrency chip then uses
   * min(shared cap, this run's upper bound).
   *
   * An in-place retune emits `run-caps-changed` with the **new** caps, but uses the same rule:
   * record the upper bound when below the ceiling, and clear it when equal to the ceiling (removing
   * the restriction). Both event kinds must therefore receive the same ceiling: this one.
   */
  concurrencyCeiling?: number;
  /**
   * This run's subagent model (the canonical picker string); derived only for `run-started`, and
   * **present only when configured**. Unlike `concurrencyCeiling`, it does not need comparison with
   * a default: the engine does not know about model selection (the model surface is entirely on the
   * host), so absence means "subagents use the session model." Cold replay reads the same key from
   * the same `run-launched` event, keeping payloads byte-for-byte equal on both sides.
   */
  subagentModel?: string;
}): DynamicWorkflowRunProgressPayload {
  const {
    event,
    runId,
    sequence,
    toolCallId,
    launchInputId,
    resumedFrom,
    concurrencyCeiling,
    subagentModel,
  } = input;
  const protocolEvent = toProtocolEvent(sequence, event);
  const actorRef = actorSessionRefOf(event);
  return {
    runId,
    ...(toolCallId === undefined ? {} : { toolCallId }),
    sequence,
    eventType: protocolEvent.type,
    // `run-settled` also carries `resumable`: the resume-gate predicate exists only in the CLI, so
    // the projection and UI transport this value without deriving it from status. The predicate is
    // stopped and not superseded; cold replay gives orphaned, converged rows the same value. Two
    // paths, one predicate (`isResumableSettlement`). stopReason / supersededBy pass through in the
    // event payload unchanged.
    // `run-started` also carries `resumedFrom`: the engine event omits it (the engine does not read
    // lineage), but the card needs to draw this edge. The same seam also carries `concurrencyCeiling`:
    // the engine emits only its own caps, and determining whether the upper bound is the default
    // requires comparing it with the host ceiling (see the field comment above). These fields are
    // independent; absence of either omits only that field.
    // `run-caps-changed` uses the **same** seam and ceiling. After an in-place retune, readers need
    // it to decide whether to record or clear the new upper bound; without it, the event contains
    // only two numbers with no reference point.
    payload:
      event.type === "run-settled" && isResumableSettlement(event.status, event.stopReason)
        ? { ...protocolEvent.payload, resumable: true }
        : event.type === "run-started"
          ? {
              ...protocolEvent.payload,
              ...(resumedFrom === undefined ? {} : { resumedFrom }),
              ...(concurrencyCeiling === undefined ? {} : { concurrencyCeiling }),
              ...(subagentModel === undefined ? {} : { subagentModel }),
            }
          : event.type === "run-caps-changed"
            ? {
                ...protocolEvent.payload,
                ...(concurrencyCeiling === undefined ? {} : { concurrencyCeiling }),
              }
            : protocolEvent.payload,
    ...(protocolEvent.truncated ? { truncated: true } : {}),
    ...(actorRef === undefined ? {} : { actorSessionId: mintActorSessionId(runId, actorRef) }),
    // Third derived field: the telemetry facts layer needs an anchor only for these two events—
    // actor-created records subagent ownership, and run-settled settles all subagents for the run.
    ...((event.type === "actor-created" || event.type === "run-settled") &&
    launchInputId !== undefined
      ? { launchInputId }
      : {}),
  };
}

/**
 * Return the subagent named by this event (the ref used to add `actorSessionId`), or undefined
 * when the event names none.
 *
 * Two event kinds qualify: `actor-created` (subagent creation) and `node-dispatched` with an
 * `actor` (the ask dispatch repeats the creation fact). A world-read dispatch has no `actor`, so
 * it gets no field; there is no transcript to open.
 */
function actorSessionRefOf(event: RunEvent): ActorRef | undefined {
  if (event.type === "actor-created") return event.actor;
  if (event.type === "node-dispatched") return event.actor;
  return undefined;
}
