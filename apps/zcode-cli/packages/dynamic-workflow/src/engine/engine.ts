/**
 * Deterministic state machine for the execution engine (implements Boundary A, drives Boundary B,
 * and reports upward through the sink).
 *
 * The core performs no I/O, reads no clock, and uses no random numbers. Decisions that could vary
 * with time or scheduling are either journaled or fixed by deterministic rules (per-site ordinals
 * plus actorSeq FIFO per actor), making first execution and replay identical.
 *
 * Key invariants:
 * - Instance identity = site ID × per-site execution ordinal (the nth ask#3 is ask#3@n). Actor
 *   identity = creation site × ordinal.
 * - Journal decisions: each host call first checks (siteId, ordinal). A hit short-circuits without
 *   a driver call and defensively verifies inputHash; a mismatch fails the entire run clearly with
 *   a structured error, never a silent offset.
 * - Per-actor FIFO, actorSeq admission order, and replay hold rules are in scheduler.ts; this file
 *   delegates ask lifecycle to it.
 *
 * This file focuses on the run lifecycle: host API entry points, usage accounting, run settlement,
 * and event recording. Method bodies for user-facing artifacts, reports, world nodes and import
 * cache, and the three run-terminal paths live in sibling modules (engine-artifacts.ts /
 * engine-report.ts / engine-world.ts / engine-settlement.ts). They read and write this private state
 * through the {@link EngineState} seam in engine-state.ts; this class keeps only thin delegates
 * (split to meet oxlint's 400-line limit). The two pure birth-phase stamping functions (events and
 * ProviderStop) are in engine-phase-stamp.ts and read only this class's `instancePhases` table.
 */

import { ImportedWorldQueue, matchImportedActor } from "./imported-cache.js";
import type { ArtifactContentOp, ArtifactPresetOp } from "../facade/registry.js";
import { AskScheduler, type SchedulerHost } from "./scheduler.js";
import type { ArtifactIdState, EngineState, RunSettlement } from "./engine-state.js";
import {
  declarePresetArtifact,
  publishContentArtifact,
  rememberArtifactRow,
} from "./engine-artifacts.js";
import { publishReport } from "./engine-report.js";
import { closeImportCache, readWorld, recoverImportClosure } from "./engine-world.js";
import { recoverSettleOrder, ReplaySettleOrder } from "./replay-order.js";
import { settleCompleted, settleFailed, settleStopped } from "./engine-settlement.js";
import type {
  ActorId,
  ArtifactRef,
  AskProgress,
  AskSpec,
  AskStats,
  AskWaitInfo,
  Caps,
  ConcurrencyChange,
  ImportedRunCache,
  InstanceRef,
  JournalStorePort,
  PersonaSpec,
  RunEvent,
  RunStallInfo,
  RunStatus,
  RunStopReason,
  ValidateFn,
  WorkflowDriver,
  WorkflowHostApi,
  WorkflowReportSink,
  WorldReadOp,
} from "./types.js";
import { refToString, WorkflowError } from "./types.js";
import { runLaunchedEvent, type RunLaunchConfig } from "./engine-launch.js";
import { enrichProviderStopPhase, stampBirthPhase } from "./engine-phase-stamp.js";

/** Engine construction configuration. */
export interface EngineConfig {
  runId: string;
  driver: WorkflowDriver;
  caps: Caps;
  /**
   * Static spec for each ask site (typed + schema). **Must cover every ask site in the script**:
   * the site table and synthesized schemas come from the same compilation, so omission indicates a
   * wiring error and the engine fails hard (MissingAskSpec). Untyped sites must be explicitly
   * recorded as `{ typed: false }`.
   */
  askSpecs: ReadonlyMap<string, AskSpec>;
  /** Injected schema validator (the core does not import a schema implementation). */
  validate: ValidateFn;
  /** Run metadata (persisted to dwf_run only during this createRun; not overwritten on resume). */
  scriptText?: string;
  /**
   * Run display name (optional `input.name` from `CreateWorkflow`). The engine does not read it;
   * it persists alongside `scriptText` at run creation so the host enumeration surface can label
   * the run. See {@link RunRecord.name}.
   */
  name?: string;
  /**
   * Hash of the script source. Compared with the journal value on resume: if both exist and differ,
   * refuse the resume (v1 resume requires a byte-identical script).
   */
  scriptHash?: string;
  /**
   * Args for this run (validated and filled in). The engine does not read them; it persists them
   * with `scriptText` at creation. The harness injects them into the sandbox through the spawn
   * payload, outside the engine. See {@link RunRecord.args}.
   */
  args?: Record<string, unknown>;
  parentSessionId?: string;
  cwd?: string;
  /**
   * CreateWorkflow tool-call ID that launched the run (see {@link RunRecord.toolCallId}). The
   * engine does not read it; it persists with the other metadata during createRun.
   */
  toolCallId?: string;
  /**
   * Predecessor run from which this run was amended (see {@link RunRecord.resumedFrom}). The engine
   * does not read it; it persists with the other metadata during createRun. Import-cache building
   * belongs to the run service, not the core.
   */
  resumedFrom?: string;
  /**
   * Anchor for the turn that launched the run. The engine does not read it; at run creation it
   * records `run-launched` immediately after the first `run-started`. Resume finds the existing row
   * and does not record it again (the anchor is unique across lifetimes).
   * `phaseNames` travels with the anchor: the script-declared phase table, also unread by the engine
   * and persisted only to the journal. `phaseAlongside` is positionally aligned with that table and
   * travels under the same rule.
   * `subagentModel` also travels with it: this run's subagent selection in canonical picker format.
   * The engine does not read it; model selection lives on the host (bootstrap's
   * workflow-actor-model.ts), which reads it from this event without SQL.
   * `scriptPath` follows the same rule: the absolute path of this run's script file. The engine
   * does not read it; the host reads it from this event for the model surface.
   */
  launch?: RunLaunchConfig;
  /**
   * Usage baseline at run creation: predecessor run's `spentTokens`. Amend supplies it; fresh
   * submit omits it (= start from zero). Resume does not need it because usage is restored from the existing row.
   *
   * Semantics: "this run reports total spend for the entire lineage." Each predecessor value is
   * already cumulative, so chained amendments need no summation or traversal of `resumed_from`.
   * Cache hits add no cost (that usage is already included in the inherited value); only live turns
   * executed now add to it.
   */
  inheritedTokens?: number;
  /**
   * Import cache for amend-resume ({@link ImportedRunCache}). **Pure data injection**, so the core
   * remains a deterministic state machine with no I/O: reading predecessor journals, following the
   * `resumed_from` chain, and resolving transcript sources all happen in the run service. The engine
   * receives a built table and matches by runtime identity (actor name + persona, `{op,args}` content
   * + occurrence order). Omission means this is not an amended resume.
   */
  importedCache?: ImportedRunCache;
}

/** Final run settlement (definition moved with the settlement module seam to engine-state.ts; re-exported here). */
export type { RunSettlement } from "./engine-state.js";

interface SettledDeferred {
  promise: Promise<RunSettlement>;
  resolve: (value: RunSettlement) => void;
}

export class WorkflowEngine implements WorkflowHostApi, WorkflowReportSink {
  private readonly runId: string;
  private readonly driver: WorkflowDriver;
  private readonly journal: JournalStorePort;
  /**
   * Concurrency ceiling for this run. **Mutable** (see {@link setMaxConcurrency}): an amendment that
   * changes only `max_concurrency` applies in place to the active run. Replace the whole object rather
   * than mutating fields so caps already recorded in events and the journal retain their original
   * values (the caller's object is not mutated either).
   */
  private caps: Caps;
  private readonly askSpecs: ReadonlyMap<string, AskSpec>;
  private readonly validate: ValidateFn;
  private readonly scheduler: AskScheduler;

  /** Per-site execution ordinal counter (shared by ask / world-read / actor, with distinct site IDs). */
  private readonly ordinals = new Map<string, number>();
  /**
   * Phase-entry counts by name. **Separate from** `ordinals`: phase names are arbitrary author
   * strings, so a phase named `report#1` must not move that site's node ordinal (site-ID stability),
   * and vice versa.
   */
  private readonly phaseOrdinals = new Map<string, number>();
  /**
   * Current phase name for control flow (maintained by `enterPhase`; undefined before the first
   * marker). Read only at the minting point; see {@link nextOrdinal}.
   */
  private currentPhase: string | undefined;
  /**
   * Instance (`siteId@ordinal`) → phase name at its **birth**. Written at minting and read by the
   * stamping funnel in {@link record}. The static causal graph copies sites by phase, so runtime
   * instances need the same coordinate; otherwise every phase copy of a site claims every instance
   * on the lane (the bug looked like five phases with 20 subagents each, each card showing 100).
   */
  private readonly instancePhases = new Map<string, string>();

  /**
   * **Nonempty valid actor name** already claimed in this run → the actor that claimed it (used to
   * identify the earlier occurrence in errors). See duplicate-name and replay-safety notes in {@link createActor}.
   */
  private readonly actorNames = new Map<string, string>();

  /** Import cache for amend-resume (pure data; omission means this is not an amended resume). */
  private readonly importedCache?: ImportedRunCache;
  /** Consumption cursor for the world import queue (nth occurrence matches nth entry). */
  private readonly importedWorld: ImportedWorldQueue;
  /**
   * Whether the import cache has been **closed**: set before the first write and never reopen it—
   * when a live subagent is about to use a mutating tool (driver reports askMutating), or a live
   * world.run executes. After closure, world nodes and asks with tools no longer consult the import
   * table (hashes compare source text and cannot detect workspace changes); pure asks (toolCalls 0)
   * still match. Resume restores closure from the `import-cache-closed` event; see {@link recoverImportClosure}.
   */
  private importClosed = false;
  /**
   * Replay settlement-order gate: cached settlements are released in the **original settlement
   * order** recorded in the journal, not admission order. After join, that order determines every
   * site ordinal. Fresh runs always have an empty gate (all proceed).
   */
  private replaySettleOrder = ReplaySettleOrder.empty();
  /** Ask instances (`siteId@ordinal`) restored from events that were live before a crash; empty for fresh runs. */
  private liveAskInstances: ReadonlySet<string> = new Set();
  /** Ask instances admitted before cache closure, restored from event order on resume; used to recover in-flight ask decisions. */
  private queuedBeforeImportClose: ReadonlySet<string> = new Set();

  /**
   * Number of reports already published by this run (counter for REPORT_CAPS.maxItemsPerRun).
   * Resume restores it from the number of `kind:"report"` journal rows. The limit is run-scoped
   * and must carry across resumes, or a repeatedly resumed run could report without limit.
   */
  private reportCount = 0;
  /**
   * State for each **user-facing artifact** ID in this run. Restored like `reportCount`: rebuild
   * from journal rows of `kind: "artifact"` on resume, then maintain in memory. The limits (32 IDs /
   * 16 versions each) and version numbers are run-scoped and must carry across resumes, or a
   * repeatedly resumed run could publish without limit.
   *
   * ⚠ Terminology: artifact means a user-facing artifact, not `RunSettlement.artifact` (the top-level return value).
   */
  private readonly artifacts = new Map<string, ArtifactIdState>();
  /** Cumulative token usage (observation surface: accounting and broadcast only; never fails the run). */
  private spentTokens = 0;
  private runSettled = false;
  private runFailure?: WorkflowError;

  private readonly settledDeferred: SettledDeferred;
  /** Seam for sibling-module functions to access private state (assembled via an arrow closure in the constructor; see engine-state.ts). */
  private readonly state: EngineState;

  constructor(config: EngineConfig) {
    this.runId = config.runId;
    this.driver = config.driver;
    this.journal = config.driver.journal;
    // Keep our own copy so a retune does not mutate the caller's object (held by the harness / run service).
    this.caps = { maxConcurrency: config.caps.maxConcurrency };
    this.askSpecs = config.askSpecs;
    this.validate = config.validate;
    this.importedCache = config.importedCache;
    this.importedWorld = new ImportedWorldQueue(config.importedCache?.world ?? new Map());

    let resolve!: (value: RunSettlement) => void;
    const promise = new Promise<RunSettlement>((res) => {
      resolve = res;
    });
    this.settledDeferred = { promise, resolve };

    this.state = {
      runId: this.runId,
      driver: this.driver,
      journal: this.journal,
      artifacts: this.artifacts,
      importedCache: this.importedCache,
      importedWorld: this.importedWorld,
      isRunSettled: () => this.runSettled,
      runError: () => this.runError(),
      failRun: (error) => this.failRun(error),
      record: (event) => this.record(event),
      nextOrdinal: (siteId) => this.nextOrdinal(siteId),
      holdForReplay: (instance, release) => {
        this.replaySettleOrder.hold(instance, release);
      },
      reportCount: () => this.reportCount,
      countReport: () => {
        this.reportCount++;
      },
      importClosed: () => this.importClosed,
      closeImport: () => {
        this.importClosed = true;
      },
      markSettled: (failure) => {
        this.runSettled = true;
        if (failure !== undefined) this.runFailure = failure;
        // Settlement permanently opens the gate: release every remaining action in the order table,
        // or the script-side promises will never resolve (the sandbox closes, but in-process script
        // assemblies would hang forever).
        this.replaySettleOrder.open();
      },
      abortInFlight: (error, emitCancelled) => this.scheduler.abortInFlight(error, emitCancelled),
      resolveSettled: (settlement) => this.settledDeferred.resolve(settlement),
    };

    // The scheduler reads caps **live**: setMaxConcurrency replaces this.caps, and dispatch checks
    // must observe the new value (see SchedulerHost.caps). Use an arrow closure instead of `this` in
    // the object literal, where `this` would refer to the object itself.
    const readCaps = (): Caps => this.caps;
    const host: SchedulerHost = {
      runId: this.runId,
      get caps(): Caps {
        return readCaps();
      },
      driver: this.driver,
      validate: this.validate,
      nextOrdinal: (siteId) => this.nextOrdinal(siteId),
      holdForReplay: (instance, release) => {
        this.replaySettleOrder.hold(instance, release);
      },
      record: (event) => this.record(event),
      isRunSettled: () => this.runSettled,
      runError: () => this.runError(),
      failRun: (error) => this.failRun(error),
      importCacheClosed: () => this.importClosed,
      wasLiveBeforeResume: (instance) => this.liveAskInstances.has(refToString(instance)),
      wasQueuedBeforeImportClose: (instance) =>
        this.queuedBeforeImportClose.has(refToString(instance)),
    };
    this.scheduler = new AskScheduler(host);

    const existing = this.journal.getRun(this.runId);
    if (existing === undefined) {
      // Amended runs start with the predecessor's cumulative value; fresh runs default to 0.
      // Normalize here (non-finite and negative values count as absent; decimals are floored): this
      // value is written to `spent_tokens`, whose protocol schema requires a nonnegative integer.
      // It is plain data past the harness boundary; a NaN would poison both the column and the
      // projection patch, so invalid values must fail before persistence, not during projection validation.
      const inherited = config.inheritedTokens ?? 0;
      this.spentTokens = Number.isFinite(inherited) ? Math.max(0, Math.floor(inherited)) : 0;
      this.journal.createRun({
        runId: this.runId,
        caps: this.caps,
        spentTokens: this.spentTokens,
        status: "running",
        // Persist metadata only when creating the run; store the supplied script and session fields
        // for recovery and script_hash validation. name is display metadata on the same path.
        // Keep omitted fields absent rather than writing undefined keys.
        ...(config.scriptText === undefined ? {} : { scriptText: config.scriptText }),
        // Args follow the same metadata path as scriptText and are written only once at creation;
        // resume reads and replays them from here and never accepts new caller-supplied args.
        ...(config.args === undefined ? {} : { args: config.args }),
        ...(config.name === undefined ? {} : { name: config.name }),
        ...(config.scriptHash === undefined ? {} : { scriptHash: config.scriptHash }),
        ...(config.parentSessionId === undefined
          ? {}
          : { parentSessionId: config.parentSessionId }),
        ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
        ...(config.toolCallId === undefined ? {} : { toolCallId: config.toolCallId }),
        // Lineage is also written only once at creation: amendment supersedes with a new run and never touches the predecessor row.
        ...(config.resumedFrom === undefined ? {} : { resumedFrom: config.resumedFrom }),
      });
    } else {
      // Resume precondition: source must be byte-identical to the source used to create the run. A
      // hash mismatch means the caller reused the runId with another script; site IDs are journal
      // keys, so continuing would pair new-script sites with old-script results. Reject **this
      // resume** synchronously instead of accepting it and then calling failRun, which would mark a
      // record failed even though it remains resumable with the correct source.
      if (
        existing.scriptHash !== undefined &&
        config.scriptHash !== undefined &&
        existing.scriptHash !== config.scriptHash
      ) {
        throw new WorkflowError(
          "ScriptHashMismatch",
          `Cannot resume run ${this.runId}: its script changed (recorded hash ${existing.scriptHash}, ` +
            `got ${config.scriptHash}). Resume needs the byte-identical script; to run a revised ` +
            `script, start a new run with resume_from instead.`,
          { mismatch: { expected: existing.scriptHash, got: config.scriptHash } },
        );
      }
      // Resume restores settlement order from this run's own events (this gate is part of replay
      // correctness, not an observation surface: site ordinals follow call arrival order, which can
      // be reproduced only from original settlement order). Read node rows once; report-count and
      // artifact recovery below share them.
      const nodes = this.journal.listNodes(this.runId);
      this.replaySettleOrder = recoverSettleOrder(this.journal, this.runId, nodes);
      // Restore report count from `kind:"report"` journal rows; restore usage from the run record (continuous across lifetimes).
      this.reportCount = nodes.filter((n) => n.kind === "report").length;
      // Restore artifact state alongside reportCount: ID ownership (kind, preset spec) and the
      // number of successful versions are derived from journal rows. After crash recovery, version
      // 3 remains version 3 rather than restarting at 1.
      for (const node of nodes) {
        if (node.kind !== "artifact" || node.status !== "completed") continue;
        rememberArtifactRow(this.state, node.artifactId, node.result);
      }
      this.spentTokens = existing.spentTokens;
      // Crash recovery for an amended run: rebuild the entire import table, and restore whether the
      // gate was closed exactly from events (the closure state is not persisted as a row).
      if (this.importedCache !== undefined) {
        const recovered = recoverImportClosure(this.journal, this.runId);
        this.liveAskInstances = recovered.live;
        this.queuedBeforeImportClose = recovered.queuedBeforeClose;
        this.importClosed = recovered.closed;
      }
      this.journal.updateRunStatus(this.runId, "running");
    }
    this.record({ type: "run-started", runId: this.runId, caps: this.caps });
    // Record the anchor only during the run's creation lifetime, after run-started: the projection
    // treats run-started as entry creation, and the anchor event only advances its cursor (reducer default branch).
    if (existing === undefined && config.launch !== undefined) {
      this.record(runLaunchedEvent(config.launch, config));
    }
    // Emit inherited (amend) or restored (resume) usage here: the projection treats `run-started` as
    // a usage reset (`workflow-runs-started.ts` clears the prior lifetime's settlement residue).
    // Without this event, the card shows 0 until the first live turn lands, falsely claiming this
    // run spent nothing. If there are no live asks in this lifetime, it remains 0 until cold replay
    // restores the row's value.
    // Do not emit zero: reset already establishes zero, and another event would be noise for every fresh run.
    if (this.spentTokens > 0) this.record({ type: "usage-updated", spentTokens: this.spentTokens });
  }

  /** Run settlement promise: resolves on completion, failure, or cancellation. */
  get settled(): Promise<RunSettlement> {
    return this.settledDeferred.promise;
  }

  /** Current run status. */
  status(): RunStatus {
    return this.journal.getRun(this.runId)?.status ?? "running";
  }

  // ——————————————————————————————— Boundary A ———————————————————————————————

  /**
   * Create an actor. The **effective name** is `spec.name` after `normalizePersona` (persona.name
   * takes precedence over the name argument). Every nonempty name must be unique within this run;
   * duplicates fail the entire run clearly (DuplicateActorName).
   *
   * Why fail the run instead of renaming or warning: a named actor is an identity key for
   * amend-resume cache imports, and any run may be amended later. Duplicate names in a predecessor
   * would make import matching ambiguous. The rule therefore applies to every run, not only amended
   * ones. Anonymous actors (omitted or empty name) are not checked and any number are valid; they
   * simply do not qualify for caching.
   *
   * **Replay safety**: the duplicate-check table is in memory and belongs to the engine instance.
   * Resuming byte-identical source in a **new** engine replays the same createActor calls from the
   * start, so each name is registered exactly once and does not conflict with its prior lifetime.
   * This is also why the table must not be journaled: a persisted table would collide with itself on resume.
   *
   * **Import-cache attachment also happens here** (amend-resume): look up `importedCache.actors` by
   * effective name and attach the candidate to scheduler actor state only if normalized personas
   * match. Compare at **runtime**, not by statically comparing both scripts at submission: names and
   * personas are runtime values (`agent()` arguments can be dynamic expressions), and static
   * comparison would create a second source of truth, which this package works to avoid. See
   * `matchImportedActor` in imported-cache.ts.
   */
  createActor(siteId: string, name?: string, persona?: string | PersonaSpec): ActorId {
    this.assertRunning("createActor");
    const ordinal = this.nextOrdinal(siteId);
    const ref = { siteId, ordinal };
    const id = refToString(ref);
    const spec = normalizePersona(name, persona);
    const effectiveName = spec.name;
    if (effectiveName !== undefined && effectiveName !== "") {
      const claimed = this.actorNames.get(effectiveName);
      if (claimed !== undefined) {
        // Same synchronous surface as assertRunning: createActor has no promise to reject, so it must throw.
        const err = new WorkflowError(
          "DuplicateActorName",
          `Subagent name "${effectiveName}" is used twice in this run (${claimed} and ${id}). ` +
            `A named subagent is the identity an amended re-run matches its cache by, so names must ` +
            `be unique; give this one its own name or drop the name to make it anonymous.`,
        );
        this.failRun(err);
        throw err;
      }
      this.actorNames.set(effectiveName, id);
    }
    this.scheduler.registerActor(ref, id, name, spec, matchImportedActor(this.importedCache, spec));
    // putActor replaces the whole record, while sessionId / resolvedModel are **driver-owned** fields
    // (the former is written by ensureSession, the latter by the host runtime factory). Carry existing
    // values through unchanged, or replaying the same (siteId, ordinal) would erase them.
    const existing = this.journal.getActor(this.runId, siteId, ordinal);
    this.journal.putActor({
      runId: this.runId,
      siteId,
      ordinal,
      name,
      persona: spec,
      sessionId: existing?.sessionId,
      resolvedModel: existing?.resolvedModel,
    });
    this.record({ type: "actor-created", actor: ref, name, persona: spec });
    return id;
  }

  ask(siteId: string, actorId: ActorId, instructions: string): Promise<unknown> {
    if (this.runSettled) return Promise.reject(this.runError());
    if (!this.scheduler.hasActor(actorId)) {
      // Unknown actor means the script/lowering contract was violated; fail the entire run clearly.
      const err = new WorkflowError("UnknownActor", `Unknown subagent handle: ${actorId}.`);
      this.failRun(err);
      return Promise.reject(err);
    }
    const spec = this.askSpecs.get(siteId);
    if (spec === undefined) {
      // Site table and schema synthesis come from one compilation, so a miss can only mean a wiring
      // error (artifacts from two compilations were combined). Falling back to `?? { typed: false }`
      // would silently downgrade a typed ask to untyped: no submit_result registration, use the
      // final-turn text as the result, and remove schema validation entirely. A type system that
      // reduces to "every result is valid" is worse than none, so fail the whole run clearly.
      const err = new WorkflowError(
        "MissingAskSpec",
        `Ask site ${siteId} has no spec: askSpecs is incomplete (compile output mismatch).`,
      );
      this.failRun(err);
      return Promise.reject(err);
    }
    return this.scheduler.admitAsk(siteId, actorId, instructions, spec);
  }

  /** World node (world-read / world-run); implementation in readWorld in engine-world.ts. */
  worldRead(siteId: string, op: WorldReadOp, args: unknown[]): Promise<unknown> {
    return readWorld(this.state, siteId, op, args);
  }

  log(message: string): void {
    if (this.runSettled) return;
    this.record({ type: "log", message });
  }

  /**
   * Control flow passed a `phase("…")` marker (`enterPhase` in Boundary A). Like `log`, this is
   * synchronous with no return value, a no-op after settlement, and **does not write a journal row**:
   * a marker is not a site, so there is no `dwf_node` row to write.
   *
   * Ordinals count by name in a separate table ({@link phaseOrdinals}): phase names and site IDs do
   * not consume each other's ordinals (site-ID stability).
   * **Emit on every evaluation**: the second loop of `for { phase("B"); ask }` is the second entry
   * into B. Suppressing an event when the phase name is unchanged would lose rounds in a single-phase
   * loop. Resume replays the prefix and emits it again; intentionally do not deduplicate (that would
   * require the engine to read its event table). The reducer monotonically applies
   * `rounds = max(rounds, ordinal)`.
   */
  enterPhase(name: string): void {
    if (this.runSettled) return;
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    const ordinal = (this.phaseOrdinals.get(trimmed) ?? 0) + 1;
    this.phaseOrdinals.set(trimmed, ordinal);
    // Instances minted from now on are born in this phase.
    this.currentPhase = trimmed;
    this.record({ type: "phase-entered", name: trimmed, ordinal });
  }

  /** Publish an intermediate result (`report` in Boundary A); implementation in publishReport in engine-report.ts. */
  report(siteId: string, item: unknown, artifactId?: string): void {
    publishReport(this.state, siteId, item, artifactId);
  }

  /**
   * Publish a **content artifact** (`artifact.file` / `artifact.markdown`); implementation in
   * publishContentArtifact in engine-artifacts.ts.
   */
  publishArtifact(siteId: string, op: ArtifactContentOp, args: unknown[]): Promise<ArtifactRef> {
    return publishContentArtifact(this.state, siteId, op, args);
  }

  /**
   * Declare a **preset artifact** (`artifact.chart` / `table` / `metrics` / `board`); implementation
   * in declarePresetArtifact in engine-artifacts.ts.
   */
  declareArtifact(siteId: string, op: ArtifactPresetOp, args: unknown[]): void {
    declarePresetArtifact(this.state, siteId, op, args);
  }

  // —————————————————————— Externally driven run lifecycle ——————————————————————

  /** Sandbox script returned the top-level artifact successfully; settle as completed (see settleCompleted in engine-settlement.ts). */
  complete(artifact: unknown): void {
    settleCompleted(this.state, artifact);
  }

  /**
   * External stop: abort in-flight asks (reject deferreds with Cancelled and emit
   * node-settled(cancelled)), then settle the run as `stopped(reason)`. Completed journal entries
   * remain resumable. Four reasons follow the same path: `user` / `model` (initiator from the cancel
   * entry point), `interrupted` (sandbox failure in the harness), and `provider` (deterministic
   * model-side error reported by the driver through `stopRun`). `error` is present only for the latter
   * two. First-wins: ignore calls after settlement. Implementation: settleStopped in engine-settlement.ts.
   */
  stop(reason: RunStopReason, error?: WorkflowError, supersededBy?: string): void {
    settleStopped(this.state, reason, error, supersededBy);
  }

  /**
   * External failure: counterpart to complete. The harness uses it to classify child-process
   * `{complete, ok:false, error}` (script threw), process crashes, wall-clock timeouts, NDJSON parse
   * failures, and similar cases as run failures, not cancellations; otherwise journal failure and
   * the caller's result would diverge.
   * Uses internal failRun: first-wins against complete/cancel/internal failure, driver cancels
   * in-flight asks, journal run status becomes failed with failure_json, a run-failure event is
   * emitted, and settlement resolves as failed.
   */
  fail(error: WorkflowError): void {
    this.failRun(error);
  }

  /**
   * Change **this run's own** concurrency ceiling in place.
   * An amendment containing only `max_concurrency` applies to the active run: same runId, no
   * successor minted, no superseding, and no in-flight asks lost. This is the only distinction from
   * AmendWorkflow and the sole reason for this method.
   *
   * Returns **whether this call changed anything**. Both no-op cases return false without writing
   * the database or emitting an event: the run settled between the host liveness check and this call
   * (the caller can fall back to a real amendment), or the new value equals the current one.
   *
   * When changed, three actions happen in one synchronous step and stay consistent: replace the
   * entire caps object (read live by the scheduler), write `dwf_run.caps_max_concurrency` (resume
   * reuses row caps and would otherwise restore the old ceiling), and record `run-caps-changed`.
   * **Raising** the ceiling also calls `pumpAll()`: dispatch reads the ceiling live, but no other
   * event would trigger a rescan, so queued asks would otherwise wait for the next settlement.
   * Lowering it does not recall active asks; they finish normally, and the ceiling only controls
   * whether another ask can be admitted.
   *
   * The caller clamps to `[1, ceiling]`; the ceiling is a host fact (machine CPU count), which the
   * engine neither sees nor should see. This layer only normalizes for persistence, following the
   * same rule as constructor `inheritedTokens`: the value is written to `caps_max_concurrency`
   * (`integer not null`), and NaN would poison both the column and dispatch checks.
   */
  setMaxConcurrency(maxConcurrency: number): boolean {
    if (this.runSettled) return false;
    if (!Number.isFinite(maxConcurrency)) return false;
    const previous = this.caps;
    const next = Math.max(1, Math.floor(maxConcurrency));
    if (next === previous.maxConcurrency) return false;
    const caps: Caps = { maxConcurrency: next };
    this.caps = caps;
    this.journal.updateRunCaps(this.runId, caps);
    this.record({ type: "run-caps-changed", runId: this.runId, caps, previous });
    if (next > previous.maxConcurrency) this.scheduler.pumpAll();
    return true;
  }

  // ——————————————————————————— Boundary B (report upward) ———————————————————————————

  askSubmitAttempted(instance: InstanceRef, payload: unknown): void {
    this.scheduler.submitAttempted(instance, payload);
  }

  askTurnEnded(instance: InstanceRef, finalText: string): void {
    this.scheduler.turnEnded(instance, finalText);
  }

  /**
   * In-ask progress observation: **pass through unchanged**, like askStats → usage-updated. It does
   * not affect scheduling, inputHash, or replay comparison. As with usage, a late observation after
   * settlement is dropped (there is no accounting to update here) so a completed run gets no tail.
   */
  askProgress(instance: InstanceRef, progress: AskProgress): void {
    if (this.runSettled) return;
    this.record({ type: "node-progress", instance, ...progress });
  }

  askStats(instance: InstanceRef, stats: AskStats): void {
    this.scheduler.noteStats(instance, stats);
    this.spentTokens += stats.tokens;
    // Usage cannot be persisted only once as createRun(0): without writing cumulative values back,
    // resume would restore zero usage. Persist immediately after accumulation and before the event,
    // so event payload and column value are produced in the same synchronous step and always agree.
    this.journal.updateRunUsage(this.runId, this.spentTokens);
    // Do not emit events for straggler stats after settlement (actor usage is known only after turn
    // parsing, and the final ask's stats often arrive after complete/cancel). Such an event would
    // follow run-settled, which downstream projection does not expect (run-settled must be the last
    // event). After settlement, update accounting only (usage row and node backfill from noteStats
    // are journal-row updates, not events). Keep the accounting so usage remains continuous across
    // resumable lifetimes.
    if (this.runSettled) return;
    this.record({ type: "usage-updated", spentTokens: this.spentTokens });
  }

  askFailed(instance: InstanceRef, error: WorkflowError): void {
    this.scheduler.failed(instance, error);
  }

  /**
   * Deterministic model-side error: do not settle the node; stop the entire run as
   * `stopped(provider)`. Calls after run settlement are ignored by stop's first-wins rule.
   */
  stopRun(error: WorkflowError): void {
    this.stop("provider", enrichProviderStopPhase(error, this.instancePhases));
  }

  /** Run-level stall observation: record only; ignore calls after run settlement. */
  runStalled(info: RunStallInfo): void {
    if (this.runSettled) return;
    this.record({ type: "run-stalled", ...info });
  }

  // Three pure observations for adaptive concurrency: the engine only records them and makes no
  // decisions based on them. Ignore calls after the run or node has settled; they are late
  // observations, and journaling them would give a completed run a tail.
  askWaiting(instance: InstanceRef, info: AskWaitInfo): void {
    if (this.runSettled || !this.scheduler.isLive(instance)) return;
    this.record({ type: "node-waiting", instance, ...info });
  }

  askExecuting(instance: InstanceRef): void {
    if (this.runSettled || !this.scheduler.isLive(instance)) return;
    this.record({ type: "node-executing", instance });
  }

  /**
   * The only driver observation used for an engine decision: a subagent in an active ask is about
   * to mutate the workspace ⇒ close the import cache. Ignore late observations after run or node
   * settlement, as above.
   */
  askMutating(instance: InstanceRef): void {
    if (this.runSettled || !this.scheduler.isLive(instance)) return;
    closeImportCache(this.state, instance, "mutating-tool", this.scheduler.liveActorName(instance));
  }

  concurrencyChanged(change: ConcurrencyChange): void {
    if (this.runSettled) return;
    this.record({ type: "concurrency-changed", ...change });
  }

  // ——————————————————————————————— Internal ———————————————————————————————

  /** Run-level failure (first-wins); implementation in settleFailed in engine-settlement.ts. */
  private failRun(error: WorkflowError): void {
    settleFailed(this.state, error);
  }

  /**
   * **Only** minting point for site ordinals (createActor / first line of admitAsk / worldRead /
   * report / artifact all pass through here synchronously), and therefore the only record point for
   * an instance's birth phase. This line always runs in the same tick as the script call, while an
   * event may not: ask's `node-queued` can be delayed until after the next marker by the hold rule.
   */
  private nextOrdinal(siteId: string): number {
    const next = (this.ordinals.get(siteId) ?? 0) + 1;
    this.ordinals.set(siteId, next);
    if (this.currentPhase !== undefined)
      this.instancePhases.set(refToString({ siteId, ordinal: next }), this.currentPhase);
    return next;
  }

  private assertRunning(op: string): void {
    if (this.runSettled)
      throw (
        this.runFailure ??
        new WorkflowError("Cancelled", `Run already settled; ${op} is no longer accepted.`)
      );
  }

  private runError(): WorkflowError {
    return this.runFailure ?? new WorkflowError("Cancelled", "Run already settled.");
  }

  /**
   * Each event is persisted to the journal (dwf_event) and fanned out through driver.emit (live Boundary C).
   *
   * Single funnel for every event; birth phase is added here ({@link stampBirthPhase}). Both routes
   * must receive **the same object**: bootstrap's `createJournalSequenceCapture` verifies sequence
   * numbers by reference equality.
   */
  private record(event: RunEvent): void {
    const stamped = stampBirthPhase(event, this.instancePhases);
    this.journal.appendEvent(this.runId, stamped);
    this.driver.emit(stamped);
  }
}

/** Normalize persona: a string is treated as the system prompt; display name is assigned to persona.name. */ function normalizePersona(
  name: string | undefined,
  persona: string | PersonaSpec | undefined,
): PersonaSpec {
  const base: PersonaSpec =
    typeof persona === "string" ? { system: persona } : persona ? { ...persona } : {};
  if (base.name === undefined && name !== undefined) base.name = name;
  return base;
}
