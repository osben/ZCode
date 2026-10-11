// ============================================================
// Pure reducer for workflowRuns: one dwf progress event → new workflowRuns state
// ============================================================
// Kept alongside workflow-runs.ts (the state schema) because they are two halves of the same vocabulary: the schema says “what the state looks like,”
// and this file says “how an event advances it.” Reduction must have a single implementation: if it lived in bootstrap's v4 product-projection
// while TUI also needed the same state, extracting it preserves the **single-clock** principle (workflow-runs.ts): projection and TUI mirror may not each reduce their own copy.
//
// This module is pure: no Date.now, randomness, or I/O. The **impure parts** of projection (identity gate,
// recordDynamicWorkflowRunProgress wiring, cold-hydration classification, and state.updated emission) remain in bootstrap.
//
// Dependency direction: contracts → shared. Therefore the input event type is **defined structurally** here instead of importing contracts'
// DynamicWorkflowRunProgressPayload; bootstrap assigns the bounded contracts payload to
// WorkflowRunProgressEnvelope, and that assignment is the compile-time guard that keeps both shapes aligned.
//
// Three **structural** facts from engine Boundary C are useful before reading the code; otherwise the following cases may look like fallbacks:
//   1. Node phases are the events the engine actually emits: queued/dispatched/executing/waiting/repairing/nudged/settled.
//      `executing` / `waiting` are driver observations: the model request was sent / it is waiting for a process-level slot or backoff.
//      They alternate after dispatched.
//   2. A completed resume hit **emits node-settled directly**, without node-queued (asks use releaseCachedAsk / tryImportedSettle
//      in scheduler.ts; world-read uses replay and imported hits in engine-world.ts).
//      The replayed ask includes its birth facts (kind / actor / actorSeq / instructionsHead); world-read and older journal entries do not.
//      Therefore node.kind and actor ref may be absent; they are not missing data.
//   3. Run-level usage (docs/dynamic-workflow/authoring.md): `usage-updated` carries total spent tokens directly;
//      `nodesUsed` counts the first phase transition in `node-dispatched` (replaying the same instance does not count it again).
//      There is no limit to derive it from, nor a need to.

import {
  WORKFLOW_RUNS_LIMITS,
  type WorkflowRunNode,
  type WorkflowRunPendingQuestion,
  type WorkflowRunReport,
  type WorkflowRunState,
  type WorkflowRunsState,
} from "./workflow-runs.js";

import { serializeWorkflowArtifact } from "./workflow-artifact.js";
import { actorsWithTranscriptSession } from "./workflow-runs-actor-session.js";
import { withDerivedWorkflowActorStatuses } from "./workflow-runs-actor-status.js";
import {
  countTaggedReport,
  upsertBoundedByArtifactId,
  workflowArtifactSummary,
} from "./workflow-runs-artifacts.js";
import {
  countUnlistedInstance,
  discountUnlistedInstance,
  evictForEntryBudget,
} from "./workflow-runs-caps.js";
import {
  absorbRefusedActor,
  absorbRefusedSettledNode,
  admitsNewEntry,
  seatWorkflowNode,
  withRoomForActor,
  type WorkflowRunEntryLimits,
} from "./workflow-runs-eviction.js";
import {
  reduceConcurrencyChanged,
  reduceRunCapsChanged,
  withoutCooldown,
} from "./workflow-runs-concurrency.js";
import {
  boundedActorName,
  boundedPhaseName,
  nonEmptyString,
  workflowActorEntry,
  workflowInstanceRef,
} from "./workflow-runs-entries.js";
import { canonicalWorkflowRun, workflowRunUnchanged } from "./workflow-runs-delta.js";
import { readRunIdField, readWorkflowRunStopReason } from "./workflow-runs-lineage.js";
import { carryNodeProgress, reduceNodeProgress } from "./workflow-runs-node-progress.js";
import { reduceHoleFilled, reduceHoleReached, withoutWaitingHoles } from "./workflow-runs-holes.js";
import { reducePhaseEntered, reduceRunLaunched } from "./workflow-runs-phases.js";
import { reduceRunStarted } from "./workflow-runs-started.js";
import { upsertBoundedByInstance, upsertBoundedByQid } from "./workflow-runs-tables.js";

/**
 * Node event → phase. Instead of `eventType.slice("node-".length)` (the event name happens to match the phase), use an explicit table
 * so readers can see all node events and their phases at a glance, and future events do not depend on lucky string slicing.
 */
const NODE_EVENT_PHASE: Readonly<Record<string, WorkflowRunNode["phase"]>> = {
  "node-queued": "queued",
  "node-dispatched": "dispatched",
  "node-executing": "executing",
  "node-waiting": "waiting",
  "node-repairing": "repairing",
  "node-nudged": "nudged",
  "node-settled": "settled",
};

/**
 * **Structured** input for one workflow run progress event. Fields match contracts'
 * `DynamicWorkflowRunProgressPayload`, but are all optional here: this module does not validate schemas,
 * and handles partial input by reducing whatever it can (the whole event is invalid if runId / eventType is absent).
 *
 * `actorSessionId` is a derived field that the run service adds **outside** the payload
 * (see toProgressPayload in dynamic-workflow-run-launch.ts): a deterministically generated actor
 * session ID. It is not an engine-observable fact, but without it downstream consumers would have to recreate the contract.
 */
export interface WorkflowRunProgressEnvelope {
  runId?: string;
  toolCallId?: string;
  sequence?: number;
  eventType?: string;
  payload?: Record<string, unknown>;
  actorSessionId?: string;
}

/**
 * Reduce one progress event into the `workflowRuns` state key.
 *
 * Returns `null` to indicate **no semantic change**: an invalid event (missing runId / eventType), or a replay whose
 * content is byte-for-byte identical. The caller then skips `state.updated` / UI refresh, so revision increases only when
 * something actually changes (idempotent replay does not advance it).
 *
 * Missing `previous` is equivalent to empty state `{ revision: 0, runs: [] }`. `limits` is an injection point for tests only;
 * its default is {@link WORKFLOW_RUNS_LIMITS} (production has no second set of limits).
 */
export function reduceWorkflowRunsState(
  previous: WorkflowRunsState | undefined,
  envelope: WorkflowRunProgressEnvelope,
  limits: WorkflowRunEntryLimits = WORKFLOW_RUNS_LIMITS,
): WorkflowRunsState | null {
  const runId = envelope.runId;
  if (!runId || typeof envelope.eventType !== "string") return null;
  const sequence = typeof envelope.sequence === "number" ? envelope.sequence : 0;
  const payload = isPlainRecord(envelope.payload) ? envelope.payload : {};

  const prior: WorkflowRunsState = previous ?? { revision: 0, runs: [] };
  const existing = prior.runs.find((run) => run.runId === runId);
  const base: WorkflowRunState = existing ?? {
    runId,
    ...(envelope.toolCallId ? { toolCallId: envelope.toolCallId } : {}),
    status: "pending",
    usage: { spentTokens: 0, nodesUsed: 0 },
    actors: [],
    nodes: [],
    lastEventSequence: sequence,
  };

  // Canonical key order (workflow-runs-delta.ts): reduction advances via `{...run, newKey: v}`, so newly appearing optional keys are appended in
  // **arrival order**, but key-level delta consumers do not have that history. Reorder both sides by schema order so
  // `JSON.stringify(apply(prior, diff(prior, next))) === JSON.stringify(next)` holds byte-for-byte.
  const next = canonicalWorkflowRun(
    applyWorkflowRunEvent(base, envelope.eventType, payload, {
      ...(envelope.actorSessionId === undefined ? {} : { actorSessionId: envelope.actorSessionId }),
      ...(envelope.toolCallId === undefined ? {} : { toolCallId: envelope.toolCallId }),
      // Monotonic: late/replayed events cannot move the high-water mark backward.
      sequence: Math.max(base.lastEventSequence, sequence),
      // Counters for rejected instances are **additive** and have no identity for deduplication, so count only events that advance the high-water mark
      // (see workflow-runs-caps.ts). The high-water mark is the value **before this event**.
      advancesWaterMark: sequence > base.lastEventSequence,
      limits,
    }),
  );

  // Idempotent: no delta for a semantic no-op (replaying the same event does not advance revision). Use **structural** comparison rather than
  // JSON.stringify on the whole run — that would serialize the entire table for every event (the O(N) bytes this change removes),
  // and would treat identical content with different key order as a change. Share the same predicate as diff's “did this key change?” check.
  if (existing !== undefined && workflowRunUnchanged(existing, next)) return null;

  const runs = existing
    ? prior.runs.map((run) => (run.runId === runId ? next : run))
    : [...prior.runs, next];
  // Keep the most recent ~8, evicting the oldest. Complete facts for terminal runs remain in the journal (the details page can query the event log).
  // These two **cross-run** limits are real constants, not injected through `limits`: that parameter only shrinks each run's table,
  // while run count and entry budget are unrelated to the injected rules.
  const bounded =
    runs.length > WORKFLOW_RUNS_LIMITS.maxRuns
      ? runs.slice(runs.length - WORKFLOW_RUNS_LIMITS.maxRuns)
      : runs;
  // Apply the entry budget after the run-count cap: eight runs at their limits come too close to the snapshot limit (workflow-runs-caps.ts).
  return { revision: prior.revision + 1, runs: evictForEntryBudget(bounded, runId) };
}

function applyWorkflowRunEvent(
  base: WorkflowRunState,
  eventType: string,
  payload: Record<string, unknown>,
  derived: {
    actorSessionId?: string;
    toolCallId?: string;
    sequence: number;
    advancesWaterMark: boolean;
    limits: WorkflowRunEntryLimits;
  },
): WorkflowRunState {
  const run: WorkflowRunState = {
    ...base,
    ...(derived.toolCallId && !base.toolCallId ? { toolCallId: derived.toolCallId } : {}),
    lastEventSequence: derived.sequence,
  };

  switch (eventType) {
    /**
     * run-started: return to running, reset usage, remove terminal remnants from the previous incarnation, and record this run's own concurrency limit.
     * Rules are in workflow-runs-started.ts (resume's re-arming semantics warrant a full file header).
     */
    case "run-started":
      return reduceRunStarted(run, payload);
    case "actor-created": {
      const ref = workflowInstanceRef(payload.actor);
      if (!ref) return run;
      // Birth phase (added 2026-09-09): `actor-created` is the actor's birth event, and its timestamp arrives only here;
      // no later event can carry or change it.
      const phaseName = boundedPhaseName(nonEmptyString(payload.phaseName));
      const { actorSessionId } = derived;
      const actor = workflowActorEntry(ref, payload.name, phaseName, actorSessionId, payload.model);
      // Make room for this active newcomer when the table is full (workflow-runs-eviction.ts); otherwise keep rejecting new entries.
      // Replayed events neither evict nor take a slot (the latter is restricted only on **overflowed** runs; see admitsNewEntry).
      const seated = derived.advancesWaterMark ? withRoomForActor(run, ref, derived.limits) : run;
      const upserted = upsertBoundedByInstance(seated.actors, actor, derived.limits.maxActors, {
        admitNew: admitsNewEntry(run, derived.advancesWaterMark),
      });
      // Rejected subagents must still be countable: there is no run-level actor counter, so their only trace is their birth-phase bucket.
      const absorbed =
        upserted.truncated && derived.advancesWaterMark
          ? absorbRefusedActor(seated, phaseName, derived.limits)
          : seated;
      return withDerivedWorkflowActorStatuses({
        ...absorbed,
        actors: upserted.list,
        ...(upserted.truncated || seated.truncated ? { truncated: true } : {}),
      });
    }
    case "node-queued":
    case "node-dispatched":
    case "node-executing":
    case "node-waiting":
    case "node-repairing":
    case "node-nudged":
    case "node-settled": {
      const ref = workflowInstanceRef(payload.instance);
      if (!ref) return run;
      const phase = NODE_EVENT_PHASE[eventType]!;
      // There are two birth events (exactly matching workflow-runs-caps.ts): `node-queued`, and a direct
      // `node-settled { cached: true }` on a replay hit. An **overflowed** run accepts new keys only from live birth events
      // (see admitsNewEntry): replayed events and intermediate phases of an unlisted instance must not put it back in the table,
      // since it was already counted in nodesUnlisted and listing it again would both list and count it.
      const born =
        eventType === "node-queued" || (eventType === "node-settled" && payload.cached === true);
      const actorRef = workflowInstanceRef(payload.actor);
      // `node-dispatched` with birth facts (the activation step in docs/dynamic-workflow/presentation.md, "Reduction"): at dispatch,
      // the engine resends the same facts carried by this instance's `node-queued` and its subagent's `actor-created` events,
      // allowing an instance omitted from the table to return with its actor **when it is dispatched**.
      // Without an actor ref, this is a bare dispatch from an old journal or world-read; keep the existing handling.
      const dispatchActor =
        eventType === "node-dispatched" && actorRef !== null
          ? workflowActorEntry(
              actorRef,
              payload.actorName,
              boundedPhaseName(nonEmptyString(payload.actorPhaseName)),
              derived.actorSessionId,
              payload.actorModel,
            )
          : null;
      // Sole entry point for eviction, B2 rejection, and activation (workflow-runs-eviction.ts).
      const seating = seatWorkflowNode(
        run,
        {
          eventType,
          ref,
          actorRef,
          actor: dispatchActor,
          born,
          advancesWaterMark: derived.advancesWaterMark,
        },
        derived.limits,
      );
      const seated = seating.run;
      const previousNode = seated.nodes.find(
        (node) => node.siteId === ref.siteId && node.ordinal === ref.ordinal,
      );
      const kind =
        payload.kind === "ask" || payload.kind === "world-read" ? payload.kind : previousNode?.kind;
      // Birth phase name: the engine stamps only birth events — `node-queued`, and on replay hits,
      // direct `node-settled { cached: true }` (that node has no queued event, so this is its birth event). Other
      // `node-*` events omit it; carry it forward, following the same pattern as kind / actorSiteId above.
      const phaseName =
        boundedPhaseName(nonEmptyString(payload.phaseName)) ?? previousNode?.phaseName;
      const node: WorkflowRunNode = {
        siteId: ref.siteId,
        ordinal: ref.ordinal,
        ...(kind === undefined ? {} : { kind }),
        phase,
        ...(payload.outcome === "ok" ||
        payload.outcome === "failed" ||
        payload.outcome === "cancelled"
          ? { outcome: payload.outcome }
          : {}),
        ...(payload.cached === true ? { cached: true } : {}),
        ...(actorRef
          ? { actorSiteId: actorRef.siteId, actorOrdinal: actorRef.ordinal }
          : previousNode?.actorSiteId !== undefined
            ? { actorSiteId: previousNode.actorSiteId, actorOrdinal: previousNode.actorOrdinal }
            : {}),
        ...(phaseName === undefined ? {} : { phaseName }),
        // Task summary and progress readings: node-queued takes them from the payload, other events carry them forward, and birth events clear previous-incarnation counters.
        // Rules are in workflow-runs-node-progress.ts (which also explains why they must be carried explicitly).
        ...carryNodeProgress(eventType, payload, previousNode),
      };
      const upsertedNodes = upsertBoundedByInstance(seated.nodes, node, derived.limits.maxNodes, {
        admitNew: seating.admitNew,
      });
      // Count one step at an instance's **first** dispatch. When the same node-dispatched event is replayed, previousNode is already
      // in a phase after dispatched, so do not count it again; reduction must be idempotent (the top level detects "no change" structurally).
      // An instance rejected at the limit is still counted because steps are run-level facts, not bounded by display limits.
      // Since it has no previousNode, phase-based deduplication does not work; replaying dispatched would keep increasing the count
      // (caught by a property test). Therefore, on a run that **has overflowed**, count by the same watermark rule as nodesUnlisted;
      // below the limit every instance has its own row, so phase deduplication suffices without changing a byte.
      const firstDispatch =
        eventType === "node-dispatched" &&
        admitsNewEntry(run, derived.advancesWaterMark) &&
        (previousNode === undefined || previousNode.phase === "queued");
      // When an instance returns to the table, subtract it from `nodesUnlisted` first; counting it while also listing it would add an extra step.
      const restored = seating.activated ? discountUnlistedInstance(seated.usage) : seated.usage;
      // Two counters for rejected instances (workflow-runs-caps.ts): `upsertedNodes.truncated` means exactly
      // “this instance could not enter the table” — the run-level truncated flag is computed separately below, and they must not be confused.
      const usage = countUnlistedInstance(
        firstDispatch ? { ...restored, nodesUsed: restored.nodesUsed + 1 } : restored,
        {
          rejected: upsertedNodes.truncated,
          advancesWaterMark: derived.advancesWaterMark,
          eventType,
          cached: payload.cached === true,
        },
      );
      // Rejected instance **settled at birth**: its run-level count was recorded above; record it in its birth-phase bucket here, and remove its actor,
      // which cannot enter the table without its node, according to the orphan rule (workflow-runs-eviction.ts).
      const absorbed =
        upsertedNodes.truncated && derived.advancesWaterMark && born && phase === "settled"
          ? absorbRefusedSettledNode(seated, node, derived.limits)
          : seated;
      return withDerivedWorkflowActorStatuses({
        ...absorbed,
        // Which session owns the transcript (workflow-runs-actor-session.ts): cache-hit settlement and dispatch each report it.
        actors: actorsWithTranscriptSession(
          absorbed.actors,
          eventType,
          payload,
          actorRef,
          derived.actorSessionId,
        ),
        ...(usage === seated.usage ? {} : { usage }),
        nodes: upsertedNodes.list,
        ...(upsertedNodes.truncated || seated.truncated ? { truncated: true } : {}),
      });
    }
    /**
     * node-progress: one turn of an ask has finished parsing (the driver sends one per parsed turn).
     *
     * **Not a lifecycle event**: it does not set phase, count a step, or change actor state; it only writes three readings to the node.
     * Therefore it is intentionally outside the cases above and the NODE_EVENT_PHASE table. Rules are in
     * workflow-runs-node-progress.ts.
     */
    case "node-progress": {
      const ref = workflowInstanceRef(payload.instance);
      if (!ref) return run;
      return reduceNodeProgress(run, ref, payload);
    }
    /**
     * report: one incremental output emitted by script `report(item)` (source for the details page Results section).
     *
     * It **intentionally does not touch `nodes[]`**: report has no node-queued/node-settled lifecycle, and counting it would inflate the step count
     * of a workflow that reports frequently (compact cards and task lists read `settled/observed` from nodes),
     * while adding an instance with no ordering meaning to the state overlay. It also does not touch actor state — it is not evidence that an actor is active.
     */
    case "report": {
      const ref = workflowInstanceRef(payload.instance);
      if (!ref) return run;
      // Second argument to `report(item, artifactId)`: which preconfigured board receives this entry. Missing means an ordinary report; skip the counting branch below.
      const artifactId = nonEmptyString(payload.artifactId);
      const report: WorkflowRunReport = {
        siteId: ref.siteId,
        ordinal: ref.ordinal,
        preview: workflowReportPreview(payload.item),
        ...(artifactId === undefined ? {} : { artifactId }),
      };
      const existingReports = run.reports ?? [];
      // The counting deduplication key is **the same** as the reports table: (siteId, ordinal). Check it **before** upsert,
      // or every entry will “already exist” afterward. See countTaggedReport below for why this check becomes inaccurate after hitting the limit,
      // and why that direction of inaccuracy is safe.
      const firstSighting = !existingReports.some(
        (item) => item.siteId === ref.siteId && item.ordinal === ref.ordinal,
      );
      // Upsert by (siteId, ordinal): every report call runs again during script replay (the engine silently skips the already-recorded instance by the same key),
      // so the same instance must stay one row, not two. Limit semantics match actors/nodes: reject new entries, update existing ones as usual, and keep overflow facts in the journal.
      const upserted = upsertBoundedByInstance(
        existingReports,
        report,
        WORKFLOW_RUNS_LIMITS.maxReports,
      );
      // Tagged entries **still go into reports**: each channel has its own limit; the tag adds a destination rather than redirecting the entry.
      const counted =
        artifactId !== undefined && firstSighting
          ? countTaggedReport(run.artifacts, artifactId)
          : run.artifacts;
      return {
        ...run,
        reports: upserted.list,
        ...(counted === undefined ? {} : { artifacts: counted }),
        ...(upserted.truncated || run.truncated ? { truncated: true } : {}),
      };
    }

    /**
     * artifact-published: the script published a version of a **user-facing** artifact through `artifact.*`, or
     * declared a preconfigured board. Both successful content publication and preconfigured-member declarations use this event;
     * cache hits do not emit it again (same as report).
     *
     * ⚠ Terminology: artifact here is output for **users**. The “script top-level return value” behind `resultPreview` is also called an artifact internally by the engine, but is for the **model** — they are unrelated. See workflow-artifacts.ts.
     *
     * Like report, it **does not touch `nodes[]` or actor state**: artifact sites are not in any graph and have no node lifecycle
     * events (they do not even emit node-settled, specifically to avoid adding an untracked node to the sidebar).
     * It does not count as a step either — delivering an artifact is not “one more step.”
     *
     * The deduplication key is the **artifact ID**, not a site instance: publishing the same ID again is a **new version**, which must replace the same card
     * rather than create another. This differs from the nodes/actors/reports tables, which deduplicate by (siteId, ordinal): two versions of one artifact ID may come from different site instances, and instance-based deduplication would create two cards.
     */
    case "artifact-published": {
      const summary = workflowArtifactSummary(payload.artifact);
      if (summary === undefined) return run;
      const upserted = upsertBoundedByArtifactId(
        run.artifacts ?? [],
        summary,
        WORKFLOW_RUNS_LIMITS.maxArtifacts,
      );
      return {
        ...run,
        artifacts: upserted.list,
        ...(upserted.truncated || run.truncated ? { truncated: true } : {}),
      };
    }

    /**
     * artifact-failed: a content artifact publication was rejected (file missing / outside allowed bounds / over limit / store absent).
     *
     * **Intentionally changes no state.** A failed publication claims no ID, kind, or version
     * (only completed records claim these, otherwise the live path could claim something the resume path cannot, creating two ledgers).
     * So there is nothing to upsert here: a “failed” card for an artifact that never existed would show users a nonexistent delivery, while the script may have caught the error, had a subagent fix it, and successfully republished it.
     *
     * The **event log** reads this event (the details-page audit view pages through the journal, not this reducer). Keep the case explicit instead of
     * falling through to default so “no state change” is a **visible decision**, not an omitted branch.
     */
    case "artifact-failed":
      return run;
    case "usage-updated": {
      // Event carries the total spent directly (the engine wrote dwf_run.spent_tokens immediately before emitting); if absent, retain the known value.
      if (typeof payload.spentTokens !== "number") return run;
      return { ...run, usage: { ...run.usage, spentTokens: payload.spentTokens } };
    }
    /**
     * escalation: an actor escalated a blocking question to the primary agent and is waiting for an answer in its ask.
     *
     * Like report, it **does not touch `nodes[]` or actor state**: escalation has no node lifecycle and does not count as a step
     * (waiting is not work, following the same rule as report). It must not mark the asking actor idle either —
     * that actor's ask remains dispatched, with status still derived from node phase; change nothing here.
     *
     * Deduplicate by `qid`, not site instance: escalation has no site identity. Upsert (not push) makes replay idempotent —
     * replaying the same raised event produces a byte-for-byte identical table, so the top-level JSON comparison returns null.
     */
    case "escalation-raised": {
      const qid = nonEmptyString(payload.qid);
      const question = nonEmptyString(payload.question);
      // qid is the identity and question is the entire reason for this record to exist; if either is missing, it cannot be shown, so only advance the high-water mark.
      if (qid === undefined || question === undefined) return run;
      // An unreadable actor ref does **not** discard the whole record: qid is the identity, actor is only an attribute. Hiding the
      // question because of an incomplete ref would defeat the only fallback value of “blocked questions must be visible” (rendering has its own fallback label).
      const actorRef = workflowInstanceRef(payload.actor);
      const actorName = boundedActorName(nonEmptyString(payload.actorName));
      const context = nonEmptyString(payload.context);
      // The event must carry the question time: this module has no clock (purity contract in the header). It is required on new events, but events replayed
      // from old journals may not have it — omit the entire field when absent so rendering can hide the wait duration.
      const askedAt =
        typeof payload.askedAt === "number" && Number.isFinite(payload.askedAt)
          ? payload.askedAt
          : undefined;
      const pending: WorkflowRunPendingQuestion = {
        qid,
        ...(actorRef ? { actorSiteId: actorRef.siteId, actorOrdinal: actorRef.ordinal } : {}),
        ...(actorName === undefined ? {} : { actorName }),
        question: boundedQuestionText(question),
        ...(context === undefined ? {} : { context: boundedQuestionText(context) }),
        ...(askedAt === undefined ? {} : { askedAt }),
      };
      const upserted = upsertBoundedByQid(
        run.pendingQuestions ?? [],
        pending,
        WORKFLOW_RUNS_LIMITS.maxPendingQuestions,
      );
      return {
        ...run,
        pendingQuestions: upserted.list,
        ...(upserted.truncated || run.truncated ? { truncated: true } : {}),
      };
    }

    /**
     * The primary agent answered: that actor's turn continues in place, and the question is no longer pending.
     *
     * The answer itself is **not projected**: it remains the `escalate` tool result in the actor turn transcript (replayed byte-for-byte on cache hits); here we only remove
     * the question from the pending table. The event-log row still contains the original answer for auditing, separate from the live fact of “who still needs an answer.”
     */
    case "escalation-resolved": {
      const qid = nonEmptyString(payload.qid);
      if (qid === undefined) return run;
      return withoutPendingQuestions(run, (pending) => pending.qid !== qid);
    }

    /**
     * concurrency-changed: the process-level coordinator adjusted the cap for this run's provider key. Does not touch `nodes[]` or actor state:
     * cap is a gate, not a node property. Rules are in workflow-runs-concurrency.ts.
     */
    case "concurrency-changed":
      return reduceConcurrencyChanged(run, payload);

    /**
     * run-caps-changed: this run's concurrency limit changed **while it was running** (a revision changing only `max_concurrency`
     * takes effect in place without stopping or restarting the run; docs/dynamic-workflow/concurrency.md). Its payload and rule match
     * `run-started`, so the reducer lives alongside it in workflow-runs-concurrency.ts.
     * It also leaves `nodes[]` and actor state untouched: a limit is a gate, not a node fact.
     */
    case "run-caps-changed":
      return reduceRunCapsChanged(run, payload);

    /** phase-entered / run-launched: phase reduction is in workflow-runs-phases.ts (which only carries the declared phase table). */
    case "phase-entered":
      return reducePhaseEntered(run, payload);
    case "run-launched":
      return reduceRunLaunched(run, payload);

    /**
     * hole-reached / hole-filled: a hole waiting and being filled (docs/dynamic-workflow/presentation.md, "Holes on the timeline").
     * Do not touch nodes / actors; a hole has no node row. The rules live in workflow-runs-holes.ts.
     */
    case "hole-reached":
      return reduceHoleReached(run, payload);
    case "hole-filled":
      return reduceHoleFilled(run, payload);

    case "run-settled": {
      const status = payload.status;
      const error = isPlainRecord(payload.error) ? payload.error : undefined;
      const message = typeof error?.message === "string" ? error.message : undefined;
      // Clear pending questions on terminal state: the source of truth is pending deferreds inside the process, and by definition a terminal run has no listener
      // (cancel has made cancelAsk reject them; if the process died, the whole registry disappeared and a `resolved` event will never arrive).
      // Keeping them would leave an unanswerable question in the sidebar — worse than hiding it, because it reads as “someone is still waiting.”
      // Clear on **all** terminal states, including completed: pending questions on a completed run are only remnants with no future response.
      // Cooldown means “until new dispatches are unblocked”; a terminal run dispatches nothing, so keeping it would show a countdown with no subject.
      // Keep cap / ceiling: they are historical facts about the concurrency under which this run executed.
      // A waiting hole is like a pending question: its source of truth is an in-process deferred, and no one is waiting to fill it after the run is terminal; keep filled holes.
      const cleared = withoutWaitingHoles(
        withoutCooldown(withoutPendingQuestions(run, () => false)),
      );
      // The boundary between waiting / completed in the actor's three-state status depends on whether the run is terminal, so derive it again:
      // an actor that was created but never asked changes from waiting to completed when the run ends.
      // Three terminal state values; carry `stopReason` only when stopped,
      // and the successor pointer only when superseded (the card uses it to link “replaced by run X”).
      const carriedStopReason =
        status === "stopped" ? readWorkflowRunStopReason(payload.stopReason) : undefined;
      const supersededBy =
        carriedStopReason === "superseded" ? readRunIdField(payload.supersededBy) : undefined;
      // Older journals used cancelled / failed as `run-settled` status values. Previously, unknown values in this closed set were ignored, so cold replay left
      // an already stopped run as running: the card stayed lit and Cancel remained clickable though the backend had nothing to cancel. Once a settlement event arrives, the run must never remain active:
      // map unknown values to terminal errored (not resumable; do not show Resume), retain the text, and explain which value was absent.
      // CLI cold replay now creates settlement by row (dynamic-workflow-run-replay.ts); this is the second gate on the wire.
      const terminal = status === "completed" || status === "errored" || status === "stopped";
      const settledMessage = terminal
        ? message
        : (message ?? `run settled with an unrecognized status: ${String(status)}`);
      return withDerivedWorkflowActorStatuses({
        ...cleared,
        status: terminal ? status : "errored",
        ...(carriedStopReason === undefined ? {} : { stopReason: carriedStopReason }),
        ...(supersededBy === undefined ? {} : { supersededBy }),
        ...(settledMessage === undefined
          ? {}
          : { error: settledMessage.slice(0, WORKFLOW_RUNS_LIMITS.maxErrorLength) }),
        // CLI decides resumability in the payload (using the same predicate as the resume gate); carry it through here, and include it only when true.
        ...(payload.resumable === true ? { resumable: true as const } : {}),
      });
    }
    // log / compaction are not steps and have no site ID, so only advance the high-water mark (they enter the event log, not the graph).
    default:
      return run;
  }
}

/**
 * Keep pending questions that match the predicate, and **remove the entire key when none remain** (do not leave an empty array).
 *
 * “Empty ⇒ key absent” is the protocol contract for this field (see schema comment), and the sidebar uses it to hide the entire section. It is also
 * an idempotency anchor: resolving a qid that is already absent returns a byte-for-byte identical run object, so the top-level JSON comparison
 * returns null — no revision bump or UI refresh.
 */
function withoutPendingQuestions(
  run: WorkflowRunState,
  keep: (pending: WorkflowRunPendingQuestion) => boolean,
): WorkflowRunState {
  const current = run.pendingQuestions;
  if (current === undefined) return run;
  const remaining = current.filter(keep);
  if (remaining.length === current.length) return run;
  if (remaining.length > 0) return { ...run, pendingQuestions: remaining };
  const { pendingQuestions: _emptied, ...withoutKey } = run;
  return withoutKey;
}

/** Display limit for questions/follow-up details. An ellipsis makes truncation visible, matching the report-preview convention. */
function boundedQuestionText(text: string): string {
  const limit = WORKFLOW_RUNS_LIMITS.maxQuestionLength;
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/**
 * Display preview for one report entry.
 *
 * Serialization shares the **same source** as run artifact projection (`serializeWorkflowArtifact`: strings unchanged, other values as pretty
 * JSON — moved here from contracts along with the reducer and re-exported from contracts), because the same value appears in both the completion notification's `<reports>` and details-page Results section; a difference between them is a bug. Compute it in the reducer instead of the renderer: preview is a **bounded** protocol field, and copying the serialization contract into the UI would eventually diverge from notification/TaskOutput text.
 */
function workflowReportPreview(item: unknown): string {
  // Payload has already passed boundDynamicWorkflowRunEventPayload (strings 2048 / depth 6 / 32 keys), so it can exceed the limit here
  // only when an object with many keys expands into longer pretty JSON. The ellipsis makes truncation visible in the UI,
  // so no extra protocol field is needed per entry (run-level truncated means “some entries were omitted,” which is different).
  const text = serializeWorkflowArtifact(item) ?? "";
  const limit = WORKFLOW_RUNS_LIMITS.maxReportPreviewLength;
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
