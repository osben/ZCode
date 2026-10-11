// ============================================================
// Dynamic Workflow Run Service: journal capability detection and store narrowing.
// ============================================================
// dynamic-workflow-run-service.ts reached oxlint's 400-line max-lines limit, so structural narrowing for the journal /
// task link store and four groups of capability checks were moved here. The public surface is still exported from dynamic-workflow-run-service.ts.
//
// Every check follows the same rule: a store is a port with replaceable implementations, so detect capabilities instead of using instanceof.
// An absent capability means a **visible degradation** (the read surface is unavailable / returns empty / is not constructed); never silently fall back to an in-memory implementation.

import type { DwfRunIntrospectionQueries, DwfRunSessionListItem } from "@zcode/adapters/storage";
import type { CreateSessionTaskLinkInput, Logger, SessionStorePort } from "@zcode/contracts";
import type { JournalStorePort, RunRecord, StoredEvent } from "@zcode/dynamic-workflow";

/** Persistence surface for task links (SqliteSessionStore in production; tests provide a spy). */
export interface DynamicWorkflowTaskLinkStore {
  createSessionTaskLink(input: CreateSessionTaskLinkInput): Promise<unknown>;
}

/**
 * Structurally narrow the task-link persistence surface, following {@link resolveDynamicWorkflowJournalStore}:
 * the store is a replaceable port, so detect capabilities rather than using instanceof. If absent, skip creating the link—
 * the actor session is still persisted, but the session tree lacks one ownership edge (a degradation that does not affect run correctness).
 */
export function isDynamicWorkflowTaskLinkStore(
  store: SessionStorePort | undefined,
): store is SessionStorePort & DynamicWorkflowTaskLinkStore {
  return (
    typeof (store as { createSessionTaskLink?: unknown } | undefined)?.createSessionTaskLink ===
    "function"
  );
}

/**
 * Narrow the dwf journal out of the session store. Use a structural check rather than instanceof: the store is a replaceable port
 * (precedent: isScriptWorkflowStore in script-workflow-utils.ts).
 */
export function resolveDynamicWorkflowJournalStore(
  sessionStore: SessionStorePort | undefined,
  logger?: Logger,
): JournalStorePort | undefined {
  const candidate = sessionStore as
    | (SessionStorePort & { workflowJournalStore?: () => JournalStorePort })
    | undefined;
  if (typeof candidate?.workflowJournalStore !== "function") {
    // Visible degradation: do not construct the port → CreateWorkflow returns a placeholder diagnostic. Never fall back to an in-memory journal—
    // that would make the run appear to work, then silently lose everything when the process exits.
    logger?.info?.("Dynamic workflow run service disabled: session store has no dwf journal", {
      event: "dynamic_workflow.run_service.unavailable",
      module: "bootstrap.app",
      reason: "session_store_missing_workflow_journal_store",
    });
    return undefined;
  }
  return candidate.workflowJournalStore();
}

/**
 * Host-side journal surface: engine port + narrow queries for orphan reconciliation and enumeration.
 *
 * Deliberately **do not widen** the engine's {@link JournalStorePort}: the engine reads/writes its row by runId and never finds runs by parent session.
 * These two queries belong to the host; adding them to the domain port would require every journal implementation to support work the engine does not do
 * (the in-memory implementation does not provide them). As with {@link isDynamicWorkflowTaskLinkStore}, detect capabilities rather than using instanceof because stores are replaceable ports.
 */
interface DynamicWorkflowJournalStore extends JournalStorePort {
  listNonTerminalRuns(parentSessionId: string): RunRecord[];
  /**
   * Runs owned by a parent session, most recently updated first, up to limit entries (enumeration surface for service listRunsForSession).
   *
   * Return {@link DwfRunSessionListItem}, not `RunRecord`: `RunRecord` deliberately omits timestamps (the engine does not
   * need them), while enumeration must report `updatedAt`. The narrow projection does not read `result_json` (unbounded artifact, not shown in lists),
   * but **preserves failure** because the `resumable` predicate depends on failure.code.
   */
  listRunsByParentSession(parentSessionId: string, limit: number): DwfRunSessionListItem[];
}

/** Whether the journal has the narrow queries required for orphan reconciliation (the production SQLite implementation does; the engine's in-memory one does not). */
export function supportsNonTerminalRunQuery(
  journal: JournalStorePort,
): journal is JournalStorePort & Pick<DynamicWorkflowJournalStore, "listNonTerminalRuns"> {
  return (
    typeof (journal as Partial<DynamicWorkflowJournalStore>).listNonTerminalRuns === "function"
  );
}

/** Whether the journal has the narrow enumeration queries. Detect each independently: a missing query degrades only its read surface. */
export function supportsRunEnumeration(
  journal: JournalStorePort,
): journal is JournalStorePort & Pick<DynamicWorkflowJournalStore, "listRunsByParentSession"> {
  return (
    typeof (journal as Partial<DynamicWorkflowJournalStore>).listRunsByParentSession === "function"
  );
}

/**
 * Journal with run introspection queries (data source for `ListWorkflowRuns` / `GetWorkflowRun`).
 *
 * The **sole source** of the signatures is adapters' {@link DwfRunIntrospectionQueries} (`import type`, zero runtime
 * dependency). Deliberately do not copy them here: these four queries are not on the engine's {@link JournalStorePort} (the engine never
 * enumerates runs or aggregates counts), so they are connected only through capability detection. If signatures drift, the compiler cannot report it;
 * the two tools would silently degrade to "this session does not support this capability."
 */
export interface DynamicWorkflowIntrospectableJournal
  extends JournalStorePort, DwfRunIntrospectionQueries {}

/**
 * Whether the journal has the "active interval per lifecycle" read surface (duration for completion cards; see
 * "How long it took" in `docs/dynamic-workflow/transcript-and-notifications.md`).
 *
 * **Detect independently; do not add this to the four checks in {@link supportsRunIntrospection}:** those four jointly
 * enable two tools, while this one only supplies a single number. Without it, duration falls back to this lifecycle's wall clock—a more conservative
 * answer, not a broken tool. It must not affect `GetWorkflowRun` availability (the engine's in-memory journal does not provide it, and its runs do not outlive the process anyway).
 */
export function supportsRunLifeSpans(
  journal: JournalStorePort,
): journal is JournalStorePort & Pick<DwfRunIntrospectionQueries, "listRunLifeSpans"> {
  return typeof (journal as Partial<DwfRunIntrospectionQueries>).listRunLifeSpans === "function";
}

/**
 * Whether the journal has the "page events by count and byte limits" read surface (event log; see "Reading the journal"
 * in docs/execution-engine.md). Detect independently, for the same reason as {@link supportsRunLifeSpans}: without it the event log falls back
 * to count-only paging (the in-memory journal case: its runs do not outlive the process and never accumulate large pages).
 */
export function supportsEventPages(
  journal: JournalStorePort,
): journal is JournalStorePort & Pick<DwfRunIntrospectionQueries, "listEventPage"> {
  return typeof (journal as Partial<DwfRunIntrospectionQueries>).listEventPage === "function";
}

/**
 * Event page on a journal without the {@link supportsEventPages} read surface: count only, fetching one extra to decide `hasMore`.
 * The byte limit cannot be honored here—knowing an event's size requires reading it first—and such journals (the in-memory
 * implementation) never accumulate large pages anyway.
 */
export function pageByCountOnly(
  journal: JournalStorePort,
  runId: string,
  page: { afterSequence?: number; limit: number },
): { events: StoredEvent[]; hasMore: boolean } {
  const read = journal.listEvents(runId, {
    types: "all",
    reportItems: "all",
    ...(page.afterSequence === undefined ? {} : { afterSequence: page.afterSequence }),
    limit: page.limit + 1,
  });
  const hasMore = read.length > page.limit;
  return { events: hasMore ? read.slice(0, page.limit) : read, hasMore };
}

/**
 * Whether the journal has run introspection queries. **Check all four together:** this is one capability (the list needs listRuns and detail needs the other three);
 * a partial implementation would make one tool fail at runtime instead of degrading visibly.
 */
export function supportsRunIntrospection(
  journal: JournalStorePort,
): journal is DynamicWorkflowIntrospectableJournal {
  const candidate = journal as Partial<DwfRunIntrospectionQueries>;
  return (
    typeof candidate.countNodesByStatus === "function" &&
    typeof candidate.getRunRow === "function" &&
    typeof candidate.listRecentLogEvents === "function" &&
    typeof candidate.listRuns === "function"
  );
}
