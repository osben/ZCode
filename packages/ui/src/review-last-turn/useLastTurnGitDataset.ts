import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ConversationRow,
  TurnHeaderRow,
  V4ConversationFileChangesResult,
} from "@zcode/shared/zcode-protocol-v4";
import type { GitChangeKind } from "@zcode/shared";
import type {
  GitPaneDataset,
  GitPaneFileChange,
  GitPaneRepositoryState,
} from "@/hooks/useGitRepository.js";
import type { LastTurnGitDataset } from "./contract.js";
import { formatReadonlyDiffPatch } from "./readonlyDiffPatch.js";
import { toWorkspaceRelativePath } from "@/lib/taskChangeSummary.js";
import { logger } from "@/logger.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import { useConversationProjection } from "@/v4/useConversationProjection.js";
import { useV4Conversation } from "@/v4/V4ConversationContext.js";

type FileChangeItem = V4ConversationFileChangesResult["items"][number];

/** Latest turn whose v4 header reports file changes and can be queried by row target. */
export function selectLastFileChangeTurn(rows: readonly ConversationRow[]): TurnHeaderRow | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (row.kind === "turnHeader" && row.entityId && (row.fileChanges?.files ?? 0) > 0) {
      return row;
    }
  }
  return null;
}

function inferTurnChangeKind(item: FileChangeItem): GitChangeKind {
  if (
    item.patches.length > 0 &&
    item.patches.every((hunk) => hunk.oldLines === 0 && hunk.oldStart === 0)
  ) {
    return "added";
  }
  if (
    item.patches.length > 0 &&
    item.patches.every((hunk) => hunk.newLines === 0 && hunk.newStart === 0)
  ) {
    return "deleted";
  }
  return "modified";
}

function createLastTurnChange(workspacePath: string, item: FileChangeItem): GitPaneFileChange {
  const relativePath = toWorkspaceRelativePath(workspacePath, item.path);
  const patch = formatReadonlyDiffPatch(relativePath, item.patches);
  return {
    path: item.path,
    repoRelativePath: relativePath,
    workspaceRelativePath: relativePath,
    kind: inferTurnChangeKind(item),
    section: "last-turn",
    added: item.additions,
    removed: item.deletions,
    isStaged: false,
    isUntracked: false,
    isConflicted: false,
    diff: {
      path: item.path,
      availability: patch ? "patch" : "unavailable",
      patch: patch || null,
      beforeContent: null,
      afterContent: null,
      summary: null,
    },
  };
}

export function buildLastTurnGitDataset(options: {
  workspacePath: string;
  result: V4ConversationFileChangesResult | null;
}): GitPaneDataset {
  const items = options.result?.items ?? [];
  return {
    id: "last-turn",
    readonly: true,
    turnIndex: null,
    sections:
      items.length > 0
        ? [
            {
              id: "last-turn",
              changes: items.map((item) => createLastTurnChange(options.workspacePath, item)),
            },
          ]
        : [],
  };
}

/** Overrides only the "last-turn" dataset and option count; Git-backed sources stay untouched. */
export function withLastTurnDataset(
  state: GitPaneRepositoryState,
  lastTurn: LastTurnGitDataset | null,
): GitPaneRepositoryState {
  if (!lastTurn) return state;
  return {
    ...state,
    datasets: { ...state.datasets, "last-turn": lastTurn.dataset },
    sourceOptions: state.sourceOptions.map((option) =>
      option.id === "last-turn" ? { ...option, count: lastTurn.count } : option,
    ),
  };
}

/**
 * Review pane "Last turn" source (specs/review-last-turn-source.md). Must render inside a
 * V4 conversation provider. The v4 projection owns per-turn file changes; this hook only reads:
 *
 * ```
 * projection turnHeader.fileChanges ──▶ select latest changed turn ──▶ request key
 *   (live delta / replayable snapshot)                                   │ enabled
 *                                          v4/conversation/fileChanges ◀─┘
 *                                          └─▶ GitPaneDataset (stale keys dropped)
 * ```
 */
export function useLastTurnGitDataset(options: {
  sessionId: string | null;
  workspacePath: string;
  workspaceKey: string;
  /** Fetch details only while the "Last turn" source is selected. */
  enabled: boolean;
}): LastTurnGitDataset | null {
  const { sessionId, workspacePath, workspaceKey, enabled } = options;
  const { layer, fileChanges } = useV4Conversation();
  const [lease, setLease] = useState<SessionLease | null>(null);

  useEffect(() => {
    if (!sessionId) {
      setLease(null);
      return;
    }
    // The chat pane already holds a lease for the active session, so this shares its store.
    const nextLease = layer.acquire(sessionId);
    setLease(nextLease);
    return () => nextLease.release();
  }, [layer, sessionId]);

  const { snapshot } = useConversationProjection(lease);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const header = useMemo(
    () => (snapshot ? selectLastFileChangeTurn(snapshot.rows.window) : null),
    [snapshot],
  );
  // Refs carry the values behind requestKey into the fetch effect; the key alone decides when to fetch.
  const headerRef = useRef(header);
  headerRef.current = header;
  // A running turn refetches only when its aggregate changes, not on every projection revision.
  const requestKey =
    sessionId && snapshot && header
      ? JSON.stringify([
          workspaceKey,
          sessionId,
          snapshot.logEpoch,
          header.rowId,
          header.entityId,
          header.state,
          header.fileChanges,
        ])
      : null;
  const [loaded, setLoaded] = useState<{
    key: string;
    result: V4ConversationFileChangesResult | null;
  } | null>(null);

  const loadedKeyRef = useRef<string | null>(null);
  loadedKeyRef.current = loaded?.key ?? null;

  useEffect(() => {
    const current = snapshotRef.current;
    const header = headerRef.current;
    if (!enabled || !requestKey || !sessionId || !current || !header?.entityId) return;
    if (loadedKeyRef.current === requestKey) return;
    let disposed = false;
    void fileChanges({
      sessionId,
      target: { rowId: header.rowId, entityId: header.entityId },
      baseRevision: current.revision,
      baseLogEpoch: current.logEpoch,
    }).then(
      (result) => {
        if (!disposed) setLoaded({ key: requestKey, result });
      },
      (error: unknown) => {
        if (disposed) return;
        logger.warn("[useLastTurnGitDataset] failed to read last-turn file changes", {
          error: error instanceof Error ? error.message : String(error),
          rowId: header.rowId,
        });
        setLoaded({ key: requestKey, result: null });
      },
    );
    return () => {
      disposed = true;
    };
  }, [enabled, fileChanges, requestKey, sessionId]);

  // Keyed on requestKey, not the header object: a running turn replaces its header on every
  // activeMs/token update, which must not re-render GitPane when nothing it shows changed.
  return useMemo(() => {
    const currentHeader = headerRef.current;
    if (!currentHeader || !requestKey) return null;
    const result = loaded?.key === requestKey ? loaded.result : null;
    const dataset = buildLastTurnGitDataset({ workspacePath, result });
    return {
      dataset,
      count: result ? sumChanges(dataset) : (currentHeader.fileChanges?.files ?? 0),
    };
  }, [loaded, requestKey, workspacePath]);
}

function sumChanges(dataset: GitPaneDataset): number {
  return dataset.sections.reduce((sum, section) => sum + section.changes.length, 0);
}
