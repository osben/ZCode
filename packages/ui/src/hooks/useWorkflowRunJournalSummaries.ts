import { useEffect, useRef, useState } from "react";
import type { V4ConversationWorkflowRunSummary } from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";
import { useV4Conversation } from "@/v4/V4ConversationContext.js";

/**
 * Discovery query for dwf runs.
 *
 * It no longer provides a fallback for card joins: after restart, the CLI cold-materializes the
 * projection by replaying the journal. Its remaining consumers are the run catalog and the task
 * list's "Completed workflows · N" count. The catalog lists the latest 64 runs, while the projection
 * keeps only 8. The initial query on cold start can still fail before the subscription is established,
 * so the retry semantics below remain in place.
 *
 * This logic was originally inline in `SessionPane`: it issued one request and silently returned
 * `null` on failure. The discovery-query effect was declared before the lease/subscription effect,
 * and the CLI dispatches requests serially. On restart, opening a historical session therefore always
 * queried before the subscription was established; the host record was not registered yet, causing
 * `sessionNotFound` and hiding the entire fallback. The card then remained in a compiled-with-no-runs
 * state (opening it showed only the script and static graph, with no details page entry point).
 * The CLI now prepares cold sessions first; this hook provides the second half by retrying that query.
 */

/**
 * Distinguish a missing capability (an older CLI has no such query, the dwf journal is unavailable,
 * or the run service was not constructed) from ordinary failures. The former is a stable fact, so
 * retries would only send another doomed RPC every time the pane changes. The latter (a cold session
 * or a connection hiccup) can be resolved by asking again.
 *
 * Use the same approach as `isWorkflowRunEventsCapabilityMissing`: after an error crosses JSON-RPC,
 * only its message is reliable. Match both patterns: use reasonCode if it was forwarded; otherwise,
 * match the capability name embedded in the constructor. Deliberately **do not** classify
 * `sessionNotFound` as a missing capability; that is exactly the kind of error worth retrying.
 */
export function isWorkflowRunsCapabilityMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("capabilityUnsupported") || message.includes("listDynamicWorkflowRuns");
}

/**
 * Journal run summaries for a session. `null` means none were found (or the query has not completed);
 * the overall fallback remains absent and the card stays in its compiled-with-no-runs state, without
 * pretending there is an entry point.
 *
 * `live` is an existing signal that the host record is registered (the subscription ACK has arrived).
 * The false→true transition on cold start is the only time worth retrying, so there is no polling or
 * backoff here: a failure after `live` is a real failure.
 *
 * `refreshKey` is the only way to **explicitly** fetch again after settlement (the freshness source
 * for the run catalog and task-list count). Callers provide a monotonic count of settled runs, so a
 * session gets one extra paginated read when a run finishes. Deliberately do not use the projection's
 * `revision`; it increments on every node event and would turn one read into a stream.
 */
export function useWorkflowRunJournalSummaries(options: {
  sessionId: string | null;
  live: boolean;
  /**
   * Caller-provided gate declaring that this query is relevant to the pane; defaults to true.
   *
   * The journal is keyed by the **parent session**, but SessionPane for nested read-only transcripts
   * (dwf actors / subagents) used to issue this query with the child session id indiscriminately.
   * Returning no results was the smaller issue; the bigger one was that the CLI cold-session preparation
   * could materialize a second (ghost) runtime for a **running** detached session, writing the same
   * event log twice and freezing the live view at "worked for xx seconds". The CLI now gates this by
   * hasLiveConversation; this is the UI half: panes that should not ask do not issue the query.
   */
  enabled?: boolean;
  /** Omit this key by default; the CLI decides the count (default 16 / maximum 64). */
  limit?: number;
  refreshKey?: number | string;
}): readonly V4ConversationWorkflowRunSummary[] | null {
  const { workflowRuns } = useV4Conversation();
  const { enabled = true, limit, live, refreshKey, sessionId } = options;
  const [summaries, setSummaries] = useState<readonly V4ConversationWorkflowRunSummary[] | null>(
    null,
  );
  /**
   * The **most recently** settled session and its answer (successful summaries, or `null` when the capability is absent).
   *
   * Store the "session + answer", not just a boolean meaning "queried": a pane's `effectiveSessionId`
   * can change (draft promotion, fork, task switch). If only the session id were stored, switching
   * back to a previously queried session would both skip the query and remain empty because its state
   * was cleared on the previous switch. Querying one journal page after switching away and back is
   * cheap; a permanently empty entry point is not.
   *
   * Store `refreshKey` too: an increase means "this answer is stale" and triggers another query.
   * **Missing capability is unaffected by it** (see below), so track that case separately instead
   * of comparing it here.
   */
  const settledRef = useRef<{
    sessionId: string;
    refreshKey: number | string | undefined;
    summaries: readonly V4ConversationWorkflowRunSummary[] | null;
  } | null>(null);
  /**
   * Missing capability is a terminal fact **per session**: an older CLI or unavailable journal will
   * not change when a run completes. Track it separately from the answer above so an increased
   * `refreshKey` cannot bypass this state. Otherwise every completed run would send another doomed RPC,
   * the very churn this classification was introduced to prevent.
   */
  const capabilityMissingSessionRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || !sessionId) {
      setSummaries(null);
      return;
    }
    if (capabilityMissingSessionRef.current === sessionId) {
      setSummaries(null);
      return;
    }
    const settled = settledRef.current;
    if (settled?.sessionId === sessionId && settled.refreshKey === refreshKey) {
      // An answer already exists; a `live` transition does not need another RPC (live runs come from
      // the projection, and the journal only fills in history).
      setSummaries(settled.summaries);
      return;
    }
    // On session switch, joining the previous session's runs to this session's card would be incorrect.
    // (`refreshKey` increases use the same path: clear → refetch, and do not show the old answer while waiting.)
    setSummaries(null);
    let alive = true;
    workflowRuns({ sessionId, ...(limit === undefined ? {} : { limit }) }).then(
      (result) => {
        if (!alive) return;
        settledRef.current = { sessionId, refreshKey, summaries: result.runs };
        setSummaries(result.runs);
      },
      (error: unknown) => {
        if (!alive) return;
        if (isWorkflowRunsCapabilityMissing(error)) {
          capabilityMissingSessionRef.current = sessionId;
        } else {
          // Cold sessions are the most common case here; the `live` transition retries automatically.
          // Keep a log entry to help investigate other failures.
          logger.warn("[workflow-run] 读取 run 摘要失败（journal 回退暂缺）", {
            error: error instanceof Error ? error.message : String(error),
            live,
            sessionId,
          });
        }
        setSummaries(null);
      },
    );
    return () => {
      alive = false;
    };
  }, [enabled, limit, live, refreshKey, sessionId, workflowRuns]);

  return summaries;
}
