import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WORKFLOW_ARTIFACT_LIMITS } from "@zcode/shared/zcode-protocol-v4";
import type { ArtifactItem } from "@/app-shell/workflow-artifacts/presets/index.js";
import { logger } from "@/logger.js";
import { useV4Conversation } from "@/v4/V4ConversationContext.js";

/**
 * Fetch data for preset dashboards.
 *
 * Invariant: **a dashboard is a projection of the journal**. Read journal rows where kind = report and artifact_id matches,
 * then the pure function applyArtifactItems folds them into charts / tables / tiles / boards. Every surface
 * (side-pane mini card, full-size tab, cold recovery) gets the same view from the same rows.
 *
 * ```
 * artifacts[id].itemCount rises in the projection
 *        │  (refresh signal; may overcount by one—see note 3a)
 *        ▼
 *  workflowRunArtifactData({ afterSequence: sequence of the last received row })
 *        │
 *        ▼  while hasMore, fetch the next page until drained
 *   append items[] ──▶ applyArtifactItems ──▶ one more point in the line chart
 * ```
 */

/** Maximum pages in one drain. REPORT_CAPS is 256 rows/run and page size is 200, so normally at most two pages; this bound protects the renderer thread if an implementation never returns hasMore: false. */
const MAX_PAGES_PER_DRAIN = 16;

/** Maximum extra fetch rounds before finishing if itemCount rises during a fetch (see pendingRef). Each is an incremental read from the current local end; normally one round drains it. */
const MAX_FOLLOW_UP_ROUNDS = 8;

interface WorkflowRunArtifactDataState {
  items: readonly ArtifactItem[];
  loading: boolean;
  /** Session does not support artifact queries (older CLI): dashboard cannot render; distinguish this from “no data yet.” */
  unavailable: boolean;
  error: string | null;
}

/** Same missing-capability check as useWorkflowRunArtifacts: across JSON-RPC, only message is reliable. */
function isWorkflowRunArtifactDataCapabilityMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("capabilityUnsupported") || message.includes("ArtifactItems");
}

function emptyState(): WorkflowRunArtifactDataState {
  return { items: [], loading: false, unavailable: false, error: null };
}

export function useWorkflowRunArtifactData(options: {
  sessionId: string;
  runId: string;
  artifactId: string;
  /**
   * Refresh signal = this id’s itemCount in the projection. A rise triggers incremental fetching; it may **overcount by one**
   * (intentional tradeoff documented in 3a), so treat it only as “there may be more,” never as the number of rows—the actual count is
   * items.length.
   */
  itemCount?: number;
  enabled?: boolean;
}): WorkflowRunArtifactDataState {
  const { workflowRunArtifactData } = useV4Conversation();
  const [state, setState] = useState<WorkflowRunArtifactDataState>(emptyState);
  const requestVersionRef = useRef(0);
  const inFlightRef = useRef(false);
  /** A new refresh signal arrived during a fetch; fetch again before finishing or the final point will never appear. */
  const pendingRef = useRef(false);
  /**
   * sequence of the last received item—the cursor for incremental reads.
   *
   * Deliberately use a ref instead of reading the end of state.items: after setState, state updates only on the next render, while the extra fetch runs
   * in the **same async function**. Reading state would use the previous end and append the same sequence twice.
   */
  const cursorRef = useRef<number | undefined>(undefined);
  /**
   * itemCount used for the previous continuation. undefined means no baseline has been established this round (mount / artifact switch);
   * that frame is handled by the full refetch, and the incremental effect records the baseline and exits—otherwise every dashboard mount would send
   * a guaranteed-empty incremental query.
   */
  const lastDrainedCountRef = useRef<number | undefined>(undefined);

  const { artifactId, runId, sessionId } = options;
  const enabled =
    options.enabled !== false && sessionId.length > 0 && runId.length > 0 && artifactId.length > 0;

  /**
   * Drain pages from the cursor until empty. replace is a full refetch (artifact/run switch), append is incremental.
   *
   * Single-flight gate (inFlightRef): itemCount commonly rises during a fetch (scripts report every iteration),
   * and re-entry would append the same sequence twice. Do not discard a blocked invocation; record it in pendingRef,
   * then let the in-flight request fetch again before finishing. Otherwise a run’s **last report** may never render
   * (no later itemCount change will trigger another fetch).
   */
  const drain = useCallback(
    async (mode: "replace" | "append") => {
      if (!enabled) return;
      if (inFlightRef.current) {
        pendingRef.current = true;
        return;
      }
      inFlightRef.current = true;
      const requestVersion = ++requestVersionRef.current;
      setState((current) => ({ ...current, loading: true, error: null }));
      try {
        let round = 0;
        let currentMode = mode;
        for (;;) {
          pendingRef.current = false;
          const collected: ArtifactItem[] = [];
          let cursor = currentMode === "append" ? cursorRef.current : undefined;
          for (let page = 0; page < MAX_PAGES_PER_DRAIN; page += 1) {
            const result = await workflowRunArtifactData({
              sessionId,
              runId,
              artifactId,
              ...(cursor === undefined ? {} : { afterSequence: cursor }),
              limit: WORKFLOW_ARTIFACT_LIMITS.defaultItemsPerPage,
            });
            if (requestVersion !== requestVersionRef.current) return;
            collected.push(...result.items);
            const lastSequence = result.items.at(-1)?.sequence;
            if (lastSequence !== undefined) cursor = lastSequence;
            if (!result.hasMore || result.items.length === 0) break;
          }
          if (requestVersion !== requestVersionRef.current) return;
          cursorRef.current = cursor;
          const settledMode = currentMode;
          setState((current) => ({
            items: settledMode === "replace" ? collected : [...current.items, ...collected],
            loading: false,
            unavailable: false,
            error: null,
          }));
          round += 1;
          if (!pendingRef.current || round >= MAX_FOLLOW_UP_ROUNDS) break;
          currentMode = "append";
        }
      } catch (caught) {
        if (requestVersion !== requestVersionRef.current) return;
        if (isWorkflowRunArtifactDataCapabilityMissing(caught)) {
          setState((current) => ({
            items: mode === "replace" ? [] : current.items,
            loading: false,
            unavailable: true,
            error: null,
          }));
          return;
        }
        const message = caught instanceof Error ? caught.message : String(caught);
        logger.warn("[workflow-artifacts] 读取看板条目失败", {
          artifactId,
          error: message,
          runId,
          sessionId,
        });
        setState((current) => ({ ...current, loading: false, error: message }));
      } finally {
        inFlightRef.current = false;
        pendingRef.current = false;
      }
    },
    [artifactId, enabled, runId, sessionId, workflowRunArtifactData],
  );

  // Artifact/run switch or closed → open: clear first, then refetch everything. Never leave points from another dashboard on this canvas.
  useEffect(() => {
    requestVersionRef.current += 1;
    cursorRef.current = undefined;
    lastDrainedCountRef.current = undefined;
    setState(emptyState());
    if (!enabled) return;
    void drain("replace");
  }, [drain, enabled]);

  // Incremental: a rise in itemCount resumes fetching from the cursor.
  //
  // The gate intentionally does **not** say “skip fetching when there are no local items yet”: a dashboard declared at the top of a script and
  // populated by reports in later iterations is empty locally at mount; using emptiness to block would mean it never renders its first point.
  // The duplicate trigger on mount is swallowed by the single-flight gate (the refetch effect runs first and already holds the gate).
  const itemCount = options.itemCount ?? 0;
  useEffect(() => {
    if (!enabled) return;
    // First frame of this round: full refetch is in progress, so only record the baseline here. Effect declaration order ensures the refetch runs first.
    if (lastDrainedCountRef.current === undefined) {
      lastDrainedCountRef.current = itemCount;
      return;
    }
    if (itemCount === lastDrainedCountRef.current) return;
    lastDrainedCountRef.current = itemCount;
    void drain("append");
  }, [drain, enabled, itemCount]);

  return useMemo(() => state, [state]);
}
