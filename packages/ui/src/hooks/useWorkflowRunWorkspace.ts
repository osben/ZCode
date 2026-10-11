import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WorkflowRunWorkspaceNode } from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";
import { useV4Conversation } from "@/v4/V4ConversationContext.js";

/**
 * Script transcript list for a workflow run.
 *
 * ```
 * Live projection run.lastEventSequence increases ──┐ (refresh signal: every node event increments it)
 *                                    ├─▶ workflowRunWorkspace({sessionId, runId}) ─▶ nodes[]
 * Open tab / switch run ────────────────────────────┘
 * ```
 *
 * The list **does not include content**, so refetching is cheap; content is fetched on demand in
 * `useWorkflowRunNodeResult`. After the signal increases, wait 250 ms before refetching: a single
 * `world.run` produces queued, dispatched, and settled events, and refetching for each would read
 * the same list three times.
 */

const REFRESH_DEBOUNCE_MS = 250;

interface WorkflowRunWorkspaceState {
  nodes: readonly WorkflowRunWorkspaceNode[];
  /** Successfully read at least once (both the placeholder and final state wait for this). */
  loaded: boolean;
  loading: boolean;
  /** The gateway truncated the list (more than maxNodes). */
  truncated: boolean;
  /** The session does not support workspace queries (older CLI). */
  unavailable: boolean;
  error: string | null;
}

/** Same capability absence check as the artifact hook: only the message remains reliable across JSON-RPC. */
function isWorkflowRunWorkspaceCapabilityMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("capabilityUnsupported") || message.includes("WorkspaceNodes");
}

export function useWorkflowRunWorkspace(options: {
  sessionId: string;
  runId: string;
  /** Refresh signal: this run's `lastEventSequence` in the live projection; absent when the run is not projected (query once). */
  refreshSignal?: number;
  enabled?: boolean;
}): WorkflowRunWorkspaceState {
  const { workflowRunWorkspace } = useV4Conversation();
  const [nodes, setNodes] = useState<readonly WorkflowRunWorkspaceNode[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Request generation: discard responses that arrive late after switching runs or sessions.
  const requestVersionRef = useRef(0);

  const { runId, sessionId } = options;
  const enabled = options.enabled !== false && sessionId.length > 0 && runId.length > 0;

  const fetchNodes = useCallback(async () => {
    const requestVersion = ++requestVersionRef.current;
    setLoading(true);
    try {
      const result = await workflowRunWorkspace({ sessionId, runId });
      if (requestVersion !== requestVersionRef.current) return;
      setNodes(result.nodes);
      setTruncated(result.truncated === true);
      setUnavailable(false);
      setError(null);
      setLoaded(true);
      setLoading(false);
    } catch (caught) {
      if (requestVersion !== requestVersionRef.current) return;
      setLoading(false);
      if (isWorkflowRunWorkspaceCapabilityMissing(caught)) {
        setUnavailable(true);
        setLoaded(true);
        return;
      }
      const message = caught instanceof Error ? caught.message : String(caught);
      logger.warn("[workflow-workspace] 读取工作区清单失败", { error: message, runId, sessionId });
      setError(message);
    }
  }, [runId, sessionId, workflowRunWorkspace]);

  // On run/session switch, discard the old list before querying again.
  useEffect(() => {
    requestVersionRef.current += 1;
    setNodes([]);
    setLoaded(false);
    setTruncated(false);
    setUnavailable(false);
    setError(null);
    if (!enabled) {
      setLoading(false);
      return;
    }
    void fetchNodes();
  }, [enabled, fetchNodes]);

  // When the signal increases, refetch after coalescing. The effect above handles the initial mount;
  // skip undefined here.
  const signal = options.refreshSignal;
  const lastSignalRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!enabled || signal === undefined) return;
    if (lastSignalRef.current === undefined) {
      lastSignalRef.current = signal;
      return;
    }
    if (signal <= lastSignalRef.current) return;
    lastSignalRef.current = signal;
    const timer = window.setTimeout(() => {
      void fetchNodes();
    }, REFRESH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [enabled, fetchNodes, signal]);

  return useMemo(
    () => ({ nodes, loaded, loading, truncated, unavailable, error }),
    [error, loaded, loading, nodes, truncated, unavailable],
  );
}
