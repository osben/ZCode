// ============================================================
// Dynamic Workflow Run Service: run introspection read surface (ListWorkflowRuns / GetWorkflowRun)
// ============================================================
// dynamic-workflow-run-service.ts reached oxlint's max-lines limit (400 lines), so its two optional
// port members, `listRuns` and `getRunDetail`, and their pendingQuestions slice moved here. The
// public exports still come from dynamic-workflow-run-service.ts. The service object includes these
// members only when the journal supports introspection queries; the service still decides whether
// to omit the entire implementation (see the `introspection` field comment there).

import type {
  DynamicWorkflowRunDetail,
  DynamicWorkflowRunHole,
  DynamicWorkflowRunLifecycleStatus,
  DynamicWorkflowRunListItem,
  DynamicWorkflowRunListQuery,
  DynamicWorkflowRunListResult,
  DynamicWorkflowRunPendingQuestion,
  DynamicWorkflowRunPort,
} from "@zcode/contracts";
import { NON_REPORT_NODE_KINDS, type JournalStorePort } from "@zcode/dynamic-workflow";
import { reduceWorkflowRunsState, type WorkflowRunsState } from "@zcode/shared/zcode-protocol-v4";
import type { DynamicWorkflowIntrospectableJournal } from "./dynamic-workflow-run-journal.js";
import {
  readRunModelBindings,
  readRunScriptPath,
  readRunSubagentModel,
} from "./dynamic-workflow-run-launch-anchor.js";
import {
  artifactsOf,
  journalRunSummary,
  registryRunSummary,
  runConcurrencyField,
  runScriptPathField,
  runModelBindingsField,
  runSubagentModelField,
  terminalErrorField,
  terminalResultField,
  toLogTailEntry,
  TERMINAL_RUN_STATUSES,
  type RunRegistryEntry,
} from "./dynamic-workflow-run-observation.js";
import {
  COLD_REPLAY_EVENT_READ,
  replayRunProgressFromEvents,
} from "./dynamic-workflow-run-replay.js";
import { runHolesOf } from "./dynamic-workflow-run-holes.js";
import { buildWorkflowRunRoster } from "./dynamic-workflow-run-roster.js";
import type { WorkflowEscalationRegistry } from "./workflow-escalation-registry.js";

/**
 * Default number of trailing `log()` entries returned by `getRunDetail`. The tail samples narrative
 * progress rather than providing the full log; use the paginated full event log in
 * {@link DynamicWorkflowRunPort.listEvents}.
 */
const DEFAULT_LOG_TAIL_LIMIT = 20;

/** Internal service state read by the introspection surface: registry and parked table are references to the **same instances**, not copies. */
interface DynamicWorkflowRunIntrospectionContext {
  /** Journal narrowed by capability detection (same object as `journal`, only a wider type). */
  introspection: DynamicWorkflowIntrospectableJournal;
  journal: JournalStorePort;
  parentSessionId: string;
  /** Service's in-memory registry (in-flight + bounded terminal states). */
  runs: ReadonlyMap<string, RunRegistryEntry>;
  /** Parked table for upgrade questions, the sole projection source for the pendingQuestions slice. */
  escalations: WorkflowEscalationRegistry;
  /**
   * This process's default concurrency (the service's implementation). The detail view uses it to
   * decide whether a run's limit is worth reporting ({@link runConcurrencyField}). This is a
   * function rather than a number because the introspection members are created once when the
   * service is constructed, while the default is a fact read on each query.
   */
  defaultConcurrency: () => number;
}

/** Build the `listRuns` and `getRunDetail` members for the service to spread into its returned port object. */
export function createRunIntrospectionMethods(
  ctx: DynamicWorkflowRunIntrospectionContext,
): Required<Pick<DynamicWorkflowRunPort, "listRuns" | "getRunDetail">> {
  const { introspection, journal, parentSessionId, runs, escalations, defaultConcurrency } = ctx;
  return {
    /**
     * List runs by project: journal rows ∪ this session's registry. **Read-only**:
     * `possiblyInterrupted` is a read-side annotation and must never rewrite the journal (cleaning
     * up an in-flight run owned by a sibling session would mark a live run dead; orphan cleanup
     * belongs exclusively to construction of the owning session, see invariant 4 in the header).
     */
    async listRuns(query: DynamicWorkflowRunListQuery): Promise<DynamicWorkflowRunListResult> {
      const limit = Math.max(0, query.limit);
      // Fetch one extra row **only to detect truncation**; it does not go in the result page. Never
      // use `length === limit` as the test: an exact-limit result would be a false positive, sending
      // the model to fetch a nonexistent history page. The v4 gateway event pagination (`hasMore`)
      // uses the same convention.
      const rows = introspection.listRuns({
        cwd: query.cwd,
        limit: limit + 1,
        ...(query.statuses === undefined ? {} : { statuses: query.statuses }),
      });
      const journalItems = rows.map((row) => ({
        ...journalRunSummary(row, runs.get(row.runId), parentSessionId),
        spentTokens: row.spentTokens,
      }));

      // Registry complement: during the few microtasks after submit returns and before the engine
      // calls createRun, the journal has no trace of the run. Without this branch, a newly started
      // run would disappear from its own project list.
      const listed = new Set(rows.map((row) => row.runId));
      const gapItems: DynamicWorkflowRunListItem[] = [];
      for (const [runId, entry] of runs) {
        if (listed.has(runId) || entry.cwd !== query.cwd) continue;
        // If a row exists but was not selected by this query, limit/statuses excluded it; the
        // complement must not pull it back in, which would silently invalidate an explicit filter.
        if (journal.getRun(runId) !== undefined) continue;
        const summary = registryRunSummary(runId, entry);
        if (query.statuses !== undefined && !query.statuses.includes(summary.status)) continue;
        // Usage: the row is not persisted yet, but a revision run's starting point was fixed at
        // submit time (see RunRegistryEntry.inheritedTokens). A fresh run has no starting point -> 0,
        // consistent with previous behavior.
        gapItems.push({ ...summary, spentTokens: entry.inheritedTokens ?? 0 });
      }

      // A run in this gap is necessarily the most recently submitted (only a few microtasks precede
      // its journal row), so sort it by submit time ahead of journal rows ordered by time_updated
      // descending. The limit applies to the whole page.
      gapItems.sort((left, right) => right.createdAt - left.createdAt);
      const merged = [...gapItems, ...journalItems];
      const truncated = merged.length > limit;
      return {
        runs: truncated ? merged.slice(0, limit) : merged,
        // Present only when true; `false` would be a noisy field on every page.
        ...(truncated ? { truncated: true } : {}),
      };
    },

    /** Single-run detail: dwf_run row + node counts + actors + log tail + in-memory terminal artifacts. */
    async getRunDetail(runId: string): Promise<DynamicWorkflowRunDetail | undefined> {
      const row = introspection.getRunRow(runId);
      const entry = runs.get(runId);
      if (row === undefined) {
        // Neither source has it -> genuinely unknown (normalized to run_not_found by the tool
        // layer). Registry only -> the gap described above: the run exists, so reporting not_found
        // would be false.
        if (entry === undefined) return undefined;
        const gapSummary = registryRunSummary(runId, entry);
        // Gap form of the situation snapshot: no events or node rows exist yet, so the phase table
        // is absent, roster is empty, and health counts are zero. Only `pendingQuestionsKnown` has
        // content: this session owns the entry and can read the parked table (and this is exactly
        // when a question is **most likely** parked; see the pendingQuestions comment below).
        const gapRoster = buildWorkflowRunRoster({
          run: undefined,
          events: [],
          nodes: [],
          actors: [],
          status: gapSummary.status,
          pendingQuestions: escalations.pendingFor(runId),
          now: Date.now(),
        });
        return {
          ...gapSummary,
          // Gap copy of the concurrency limit (see RunRegistryEntry.maxConcurrency): the row is
          // not persisted, but the value was fixed at submit, so the detail view need not pretend
          // it does not know during these few microtasks.
          ...runConcurrencyField(entry.maxConcurrency, defaultConcurrency()),
          // Gap copy of the subagent model, for the same reason (see RunRegistryEntry.subagentModel).
          ...runSubagentModelField(entry.subagentModel),
          // Gap copy of the script-named models, for the same reason.
          ...runModelBindingsField(entry.modelBindings),
          // Gap copy of the script file, for the same reason (see RunRegistryEntry.scriptPath).
          ...runScriptPathField(entry.scriptPath),
          // Counts have no authoritative source yet, so honestly report 0. The starting usage is
          // known (a revision inherits its predecessor's cumulative value; see
          // RunRegistryEntry.inheritedTokens), and reporting 0 would claim this lineage spent nothing.
          usage: {
            spentTokens: entry.inheritedTokens ?? 0,
            nodesObserved: 0,
            nodesRunning: 0,
            nodesCompleted: 0,
            nodesFailed: 0,
          },
          actors: [],
          logTail: [],
          ...gapRoster,
          ...terminalResultField(gapSummary.status, entry),
          ...terminalErrorField(gapSummary.status, entry),
          // This gap branch is exactly when the run is in flight but its journal row is not yet
          // persisted, also when a question is **most likely** parked. Without this branch, the
          // blocked actor in a newly started run would be invisible to the model.
          ...pendingQuestionsField(escalations, runId),
          // Holes follow the same rationale as pending questions: the entry is in hand during the
          // gap, so the engine's parked table can be read; omit the entire field when empty.
          ...holesField(runHolesOf(runId, entry, journal)),
          // Artifacts: the dwf_run row is not persisted in this gap branch, but **node rows may
          // already exist**—the engine can put an artifact row immediately after createRun. Read
          // them here rather than assuming the list is empty: a run queried just after declaring a
          // board should not appear to have produced nothing. If empty, artifactsOf omits the field.
          ...artifactsOf(runId, journal),
        };
      }

      const summary = journalRunSummary(row, entry, parentSessionId);
      const counts = introspection.countNodesByStatus(runId);
      // Read events **once**: reduce the same sequence through the cold-replay path into the same
      // state used by the run panel, then pass it with node/actor rows to the situation snapshot.
      // Reading twice would pay twice for the same data, and this query is the most expensive part
      // for long runs.
      // Read report items only up to the projection's bound (same read as cold replay; see dynamic-workflow-run-replay.ts).
      const stored = journal.listEvents(runId, COLD_REPLAY_EVENT_READ);
      // Read actor rows once, without persona (the full system prompt is an inherently unbounded field with no reader here).
      const actorRows = journal.listActors(runId, { withPersona: false });
      const pendingQuestions = pendingQuestionsOf(escalations, runId, summary.status, entry);
      return {
        ...summary,
        // Persisted limit (`dwf_run.caps_max_concurrency`), present only when it differs from the
        // default concurrency. Deliberately omit it from journalRunSummary, the shared list-row
        // projection: a rarely set field should not widen every row.
        ...runConcurrencyField(row.caps.maxConcurrency, defaultConcurrency()),
        // Subagent model for this run, present only when set. It has no dwf_run column (the user
        // ruled out a migration); the `run-launched` event is authoritative. As with the snapshot,
        // use the registry entry when present (all three creation paths set it), and scan event
        // headers only for cold rows. Like the concurrency limit, deliberately omit it from
        // journalRunSummary so a rarely set field does not widen every list row.
        ...runSubagentModelField(
          entry === undefined ? readRunSubagentModel(journal, runId) : entry.subagentModel,
        ),
        // Script file for this run, present only when recorded. Same rules as the subagent model:
        // the `run-launched` event is authoritative (dwf_run has no such column); use the registry
        // entry when present and scan event headers only for cold rows. Deliberately omit it from
        // journalRunSummary too; a field used only by AmendWorkflow should not widen list rows.
        ...runModelBindingsField(
          entry === undefined ? readRunModelBindings(journal, runId) : entry.modelBindings,
        ),
        ...runScriptPathField(
          entry === undefined ? readRunScriptPath(journal, runId) : entry.scriptPath,
        ),
        usage: {
          // Read dwf_run.spent_tokens directly: the sole authority for run-level token usage.
          spentTokens: row.spentTokens,
          // Sum of persisted node rows, **not** "total steps": dynamic workflows have no static
          // total, and queued nodes exist only in event phases, not in the journal.
          nodesObserved: counts.running + counts.completed + counts.failed,
          nodesRunning: counts.running,
          nodesCompleted: counts.completed,
          nodesFailed: counts.failed,
        },
        actors: actorRows.map((actor) => ({
          siteId: actor.siteId,
          ordinal: actor.ordinal,
          // Deliberately omit persona: the full system prompt is inherently unbounded at the port.
          ...(actor.name === undefined ? {} : { name: actor.name }),
        })),
        logTail: introspection
          .listRecentLogEvents(runId, DEFAULT_LOG_TAIL_LIMIT)
          .map(toLogTailEntry),
        ...buildWorkflowRunRoster({
          run: reduceRunState(row, stored, defaultConcurrency()),
          events: stored,
          // The roster reads only kind / status / stats / coordinates: no results, no report rows.
          nodes: journal.listNodes(runId, { kinds: NON_REPORT_NODE_KINDS, withResult: false }),
          actors: actorRows,
          status: summary.status,
          ...(pendingQuestions === undefined ? {} : { pendingQuestions }),
          now: Date.now(),
        }),
        ...terminalResultField(summary.status, entry, row),
        ...terminalErrorField(summary.status, entry, row),
        ...(pendingQuestions === undefined || pendingQuestions.length === 0
          ? {}
          : { pendingQuestions }),
        // Holes (see "The run snapshot" in docs/execution-engine.md): same source and projection as
        // the snapshot—this is the model's only discovery surface after a hole notification is lost.
        // A cold row's fact table is rebuilt from the script stored in the row (only when a hole has actually arrived).
        ...holesField(runHolesOf(runId, entry, journal, row.scriptText)),
        // Artifact snapshot is attached for every state, including failed/cancelled: a run that
        // stopped at step 12 may still have delivered a board produced earlier. Share the **same**
        // artifactsOf implementation with `listArtifacts` and terminal snapshots so all three
        // return the same list (separate implementations would eventually diverge on questions such
        // as whether a failed row counts as a version). If empty, omit the entire field.
        ...artifactsOf(runId, journal),
      };
    },
  };
}

/**
 * pendingQuestions slice for `getRunDetail`.
 *
 * Uses the **same projection source** as the `getTask` snapshot (the in-memory upgrade parked table),
 * deliberately not journal replay. The journal has raised/resolved events, but "who is still owed
 * an answer" is a live process fact; an unmatched raised event replayed after process death would
 * lie because its parked deferred is gone.
 *
 * Omit the entire field when empty (same as snapshots): an empty array reads as "asked and answered";
 * only absence means "no one is waiting."
 */
function pendingQuestionsField(
  escalations: WorkflowEscalationRegistry,
  runId: string,
): Pick<DynamicWorkflowRunDetail, "pendingQuestions"> {
  const pendingQuestions = escalations.pendingFor(runId);
  return pendingQuestions.length === 0 ? {} : { pendingQuestions };
}

/** Omit the entire field when empty (same rule as pendingQuestions). */
function holesField(
  holes: readonly DynamicWorkflowRunHole[],
): Pick<DynamicWorkflowRunDetail, "holes"> {
  return holes.length === 0 ? {} : { holes };
}

/**
 * Whether this read **can** answer "is any question awaiting a response," and the answer itself
 * (`health.pendingQuestionsKnown`).
 *
 * `undefined` means unknown, not "none." The parked table is **in this process's memory** (see the
 * rationale in {@link pendingQuestionsField}), so this read can answer truthfully only in two
 * cases: the run is in this session's registry, or the run is terminal (by definition, no one is
 * still listening). For other cases (a sibling session's in-flight run or remains of a dead
 * process), an empty table looks identical to "unknown," but these imply different next steps for
 * the model: one can keep waiting; the other must ask another way.
 */
function pendingQuestionsOf(
  escalations: WorkflowEscalationRegistry,
  runId: string,
  status: DynamicWorkflowRunLifecycleStatus,
  entry: RunRegistryEntry | undefined,
): readonly DynamicWorkflowRunPendingQuestion[] | undefined {
  const known = entry !== undefined || TERMINAL_RUN_STATUSES.has(status);
  return known ? escalations.pendingFor(runId) : undefined;
}

/**
 * Reduce journal events into the same state used by the run panel. `node-queued` task summaries and
 * `node-progress` readings exist only in events, and the reducer already contains the rules for
 * extracting them. Reuse it instead of writing another parser in this read path (two parsers would
 * eventually diverge on questions such as whether requeueing resets the turn count).
 *
 * The caller reads and passes in events. `replayRunProgressFromEvents` is the cold-replay path itself,
 * so the state reduced here matches what the UI sees after restart byte-for-byte.
 */
function reduceRunState(
  row: Parameters<typeof replayRunProgressFromEvents>[0],
  stored: Parameters<typeof replayRunProgressFromEvents>[1],
  defaultConcurrency: number,
): WorkflowRunsState["runs"][number] | undefined {
  let state: WorkflowRunsState | undefined;
  for (const payload of replayRunProgressFromEvents(row, stored, defaultConcurrency)) {
    state = reduceWorkflowRunsState(state, payload) ?? state;
  }
  return state?.runs.find((run) => run.runId === row.runId);
}
