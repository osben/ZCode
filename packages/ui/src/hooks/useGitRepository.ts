/* eslint-disable max-lines */
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ZCodePersistedFileChange,
  ZCodePersistedFileSnapshot,
  ZCodeTaskChangeSummary,
  GitBranchComparison,
  GitChangeSectionId,
  GitChangeSourceId,
  GitDiffResult,
  GitFileChange,
  GitIdentity,
  GitRepositorySummary,
} from "@zcode/shared";
import { buildTurnChangeSummary, toWorkspaceRelativePath } from "@/lib/taskChangeSummary.js";
import { logger } from "@/logger.js";
import { shouldEnableWorkspaceRpc } from "@/lib/workspaceRpcAvailability.js";
import { useServices } from "@/hooks/useServices.js";
import { useResolvedRemoteWorkspaceSessionId } from "@/hooks/useResolvedRemoteWorkspaceSessionId.js";

type GitRepositorySourceId = Extract<GitChangeSourceId, "unstaged" | "staged" | "branch">;

interface RepositoryDatasets {
  unstaged: GitPaneDataset;
  staged: GitPaneDataset;
  branch: GitPaneDataset;
}

const EMPTY_BRANCH_COMPARISON: GitBranchComparison = {
  baseRef: null,
  headRef: null,
  comparisonLabel: null,
  changes: [],
};

interface GitLiveDataRefreshInput {
  workspacePath: string;
  workspaceKey: string;
  includeExtendedData: boolean;
  refreshToken: string | number | boolean | null;
  workspaceRpcEnabled: boolean;
  // BUG-GWT-013: resolved snapshot and current pending request for this exact target.
  // Optional for legacy refresh-decision callers.
  summaryResolved?: boolean;
  refreshPending?: boolean;
  retryTick?: number;
}

export interface GitPaneFileChange extends GitFileChange {
  diff: GitDiffResult | null;
}

export interface GitPaneSection {
  id: GitChangeSectionId;
  changes: GitPaneFileChange[];
}

export interface GitPaneDataset {
  id: GitChangeSourceId;
  readonly: boolean;
  sections: GitPaneSection[];
  comparisonLabel?: string | null;
  turnIndex?: number | null;
}

export interface GitPaneSourceOption {
  id: GitChangeSourceId;
  count: number;
  readonly: boolean;
  disabled: boolean;
  comparisonLabel?: string | null;
}

export interface GitPaneRepositoryState {
  workspaceKey: string;
  workspacePath: string;
  summary: GitRepositorySummary;
  identity: GitIdentity;
  placeholder: {
    enabled: boolean;
  };
  loading: boolean;
  error: string | null;
  revision: number;
  sourceOptions: GitPaneSourceOption[];
  datasets: Record<GitChangeSourceId, GitPaneDataset>;
}

const SECTION_ORDER_BY_SOURCE: Record<GitRepositorySourceId, readonly GitChangeSectionId[]> = {
  unstaged: ["unstaged", "untracked", "conflicted"],
  staged: ["staged"],
  branch: ["branch"],
};

const EMPTY_IDENTITY: GitIdentity = {
  userName: null,
  userEmail: null,
  nameSource: null,
  emailSource: null,
  scopeLabel: null,
};

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name || String(error);
  }

  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }

  return String(error);
}

function sumSectionCount(sections: readonly GitPaneSection[]): number {
  return sections.reduce((count, section) => count + section.changes.length, 0);
}

function inferGitKind(added: number, removed: number): GitFileChange["kind"] {
  if (added > 0 && removed === 0) {
    return "added";
  }

  if (removed > 0 && added === 0) {
    return "deleted";
  }

  return "modified";
}

function createEmptySummary(workspacePath: string): GitRepositorySummary {
  return {
    workspacePath,
    repoRoot: workspacePath,
    workspaceInRepoPath: ".",
    autoRefreshWatchPaths: [],
    branchName: null,
    trackingBranchName: null,
    headRefType: "branch",
    ahead: 0,
    behind: 0,
    isDirty: false,
    isGitAvailable: false,
    isRepository: false,
  };
}

function createEmptyDataset(id: GitChangeSourceId, readonly: boolean): GitPaneDataset {
  return {
    id,
    readonly,
    sections: [],
    comparisonLabel: null,
    turnIndex: null,
  };
}

function createEmptyDatasets(): Record<GitChangeSourceId, GitPaneDataset> {
  return {
    unstaged: createEmptyDataset("unstaged", false),
    staged: createEmptyDataset("staged", false),
    branch: createEmptyDataset("branch", true),
    "last-turn": createEmptyDataset("last-turn", true),
  };
}

function buildSourceOptions(
  datasets: Record<GitChangeSourceId, GitPaneDataset>,
): GitPaneSourceOption[] {
  return [
    {
      id: "unstaged",
      count: sumSectionCount(datasets.unstaged.sections),
      readonly: false,
      disabled: false,
    },
    {
      id: "staged",
      count: sumSectionCount(datasets.staged.sections),
      readonly: false,
      disabled: false,
    },
    {
      id: "branch",
      count: sumSectionCount(datasets.branch.sections),
      readonly: true,
      disabled: false,
      comparisonLabel: datasets.branch.comparisonLabel,
    },
    {
      id: "last-turn",
      count: sumSectionCount(datasets["last-turn"].sections),
      readonly: true,
      disabled: false,
    },
  ];
}

function createInitialState(
  workspacePath: string,
  options?: {
    workspaceKey?: string;
    loading?: boolean;
    error?: string | null;
    revision?: number;
  },
): GitPaneRepositoryState {
  const datasets = createEmptyDatasets();
  return {
    workspaceKey: options?.workspaceKey ?? workspacePath,
    workspacePath,
    summary: createEmptySummary(workspacePath),
    identity: EMPTY_IDENTITY,
    placeholder: {
      enabled: false,
    },
    loading: options?.loading ?? true,
    error: options?.error ?? null,
    revision: options?.revision ?? 0,
    sourceOptions: buildSourceOptions(datasets),
    datasets,
  };
}

export function matchesGitRepositoryTarget(
  state: Pick<GitPaneRepositoryState, "workspaceKey" | "workspacePath">,
  target: Pick<GitLiveDataRefreshInput, "workspaceKey" | "workspacePath">,
): boolean {
  return state.workspaceKey === target.workspaceKey && state.workspacePath === target.workspacePath;
}

function toPaneFileChange(
  change: GitFileChange,
  diff: GitDiffResult | null = null,
): GitPaneFileChange {
  return {
    ...change,
    diff,
  };
}

function buildSectionsForSource(
  sourceId: GitRepositorySourceId,
  changes: GitFileChange[],
): GitPaneSection[] {
  const grouped = new Map<GitChangeSectionId, GitPaneFileChange[]>();
  for (const change of changes) {
    const sectionChanges = grouped.get(change.section) ?? [];
    sectionChanges.push(toPaneFileChange(change));
    grouped.set(change.section, sectionChanges);
  }

  return SECTION_ORDER_BY_SOURCE[sourceId]
    .map((sectionId) => {
      const sectionChanges = grouped.get(sectionId);
      if (!sectionChanges || sectionChanges.length === 0) {
        return null;
      }

      sectionChanges.sort((left, right) =>
        left.workspaceRelativePath.localeCompare(right.workspaceRelativePath),
      );

      return {
        id: sectionId,
        changes: sectionChanges,
      };
    })
    .filter((section): section is GitPaneSection => Boolean(section));
}

function buildRepositoryDatasets(options: {
  unstagedChanges: GitFileChange[];
  stagedChanges: GitFileChange[];
  branchComparison: GitBranchComparison;
}): RepositoryDatasets {
  return {
    unstaged: {
      id: "unstaged",
      readonly: false,
      sections: buildSectionsForSource("unstaged", options.unstagedChanges),
    },
    staged: {
      id: "staged",
      readonly: false,
      sections: buildSectionsForSource("staged", options.stagedChanges),
    },
    branch: {
      id: "branch",
      readonly: true,
      sections: buildSectionsForSource("branch", options.branchComparison.changes),
      comparisonLabel: options.branchComparison.comparisonLabel,
    },
  };
}

function createLastTurnChange(
  workspacePath: string,
  snapshotByPath: Map<string, ZCodePersistedFileSnapshot>,
  file: ZCodeTaskChangeSummary["files"][number],
): GitPaneFileChange {
  const relativePath = toWorkspaceRelativePath(workspacePath, file.path);
  const snapshot = snapshotByPath.get(file.path);

  return {
    path: file.path,
    repoRelativePath: relativePath,
    workspaceRelativePath: relativePath,
    kind: inferGitKind(file.added, file.removed),
    section: "last-turn",
    added: file.added,
    removed: file.removed,
    isStaged: false,
    isUntracked: false,
    isConflicted: false,
    diff: {
      path: file.path,
      availability: snapshot ? "patch" : "unavailable",
      patch: null,
      beforeContent: snapshot?.beforeContent ?? null,
      afterContent: snapshot?.afterContent ?? null,
      summary: null,
    },
  };
}

function buildLastTurnDataset(options: {
  workspacePath: string;
  turnIndex: number | null;
  fileChange: ZCodePersistedFileChange | null;
  summary: ZCodeTaskChangeSummary | null;
}): GitPaneDataset {
  const snapshotByPath = new Map<string, ZCodePersistedFileSnapshot>(
    options.fileChange?.snapshots.map((snapshot) => [snapshot.path, snapshot]) ?? [],
  );

  return {
    id: "last-turn",
    readonly: true,
    turnIndex: options.turnIndex,
    // Key behavior: continue preferring the per-turn file snapshot already persisted by the ZCode Agent,
    // so the agent’s read-only review path remains stable after the Git pane starts using real repository data.
    sections: options.summary
      ? [
          {
            id: "last-turn",
            changes: options.summary.files.map((file) =>
              createLastTurnChange(options.workspacePath, snapshotByPath, file),
            ),
          },
        ]
      : [],
  };
}

export function shouldRefreshLiveGitData(
  previous: GitLiveDataRefreshInput | null,
  next: GitLiveDataRefreshInput,
): boolean {
  if (!next.workspaceRpcEnabled) {
    return false;
  }

  if (!previous || !previous.workspaceRpcEnabled) {
    return true;
  }

  if (previous.workspacePath !== next.workspacePath) {
    return true;
  }

  if (previous.workspaceKey !== next.workspaceKey) {
    return true;
  }

  if (previous.retryTick !== next.retryTick) {
    return true;
  }

  if (previous.refreshToken !== next.refreshToken) {
    return true;
  }

  // BUG-GWT-013: recover an unresolved target only after its current request settles.
  // Strict checks preserve callers that omit these optional recovery inputs.
  if (next.summaryResolved === false && next.refreshPending === false) {
    return true;
  }

  // Only opening the pane requests extras; closing it and last-turn switches need no Git IO.
  return !previous.includeExtendedData && next.includeExtendedData;
}

const MAX_INITIAL_REFRESH_RETRIES = 2;

export function useGitRepository(options: {
  workspacePath: string;
  activeTaskId: string | null;
  enabled?: boolean;
  includeExtendedData?: boolean;
  refreshToken?: string | number | boolean | null;
  remoteSessionId?: string | null;
  remoteTarget?: unknown;
  workspaceIdentity?: string | null;
}): GitPaneRepositoryState {
  const {
    workspacePath,
    enabled = true,
    includeExtendedData = false,
    refreshToken = null,
    remoteSessionId: preferredRemoteSessionId = null,
    remoteTarget,
    workspaceIdentity = null,
  } = options;
  const { gitService } = useServices();
  const remoteSessionId = useResolvedRemoteWorkspaceSessionId(
    workspacePath,
    preferredRemoteSessionId,
    workspaceIdentity,
    remoteTarget,
  );
  const workspaceRpcEnabled = shouldEnableWorkspaceRpc({
    workspaceIdentity,
    remoteSessionId,
    remoteTarget,
  });
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  // Store cleanup: the write path for the per-turn change-summary map (setPerTurnSummaries/setPerTurnFileChanges)
  // was removed with the old ChatView stream subscription, so the store no longer persists this derived state (it was always empty before removal).
  // Keep the “last-turn” dataset’s empty-state structure until the v4 projection supplies per-turn change data.
  const [repositoryState, setRepositoryState] = useState<GitPaneRepositoryState>(() =>
    createInitialState(workspacePath, { workspaceKey }),
  );
  const requestVersionRef = useRef(0);
  const pendingRequestVersionRef = useRef<number | null>(null);
  // A retry tick admits bounded recovery even when a confirmed snapshot remains resolved.
  // The counter is scoped to both identity and path so another target gets its own budget.
  const [retryTick, setRetryTick] = useState(0);
  const consecutiveFailuresRef = useRef({ workspaceKey: "", workspacePath: "", count: 0 });
  const lastLiveRefreshInputRef = useRef<GitLiveDataRefreshInput | null>(null);
  const lastFileChangeEntry = null;
  const lastSummaryEntry = null;
  // A successful snapshot resolves the target even while refreshing or when comparison fails.
  // Loading must not flip this flag: that would clean up an in-flight same-target refresh
  // and misidentify its completion as a service-instance swap needing another request.
  const summaryResolved =
    matchesGitRepositoryTarget(repositoryState, { workspacePath, workspaceKey }) &&
    repositoryState.revision > 0;

  useEffect(() => {
    const nextRefreshInput: GitLiveDataRefreshInput = {
      workspacePath,
      workspaceKey,
      includeExtendedData,
      refreshToken,
      workspaceRpcEnabled,
      summaryResolved,
      retryTick,
      refreshPending:
        pendingRequestVersionRef.current !== null &&
        pendingRequestVersionRef.current === requestVersionRef.current,
    };

    if (!enabled) {
      requestVersionRef.current += 1;
      lastLiveRefreshInputRef.current = null;
      setRepositoryState((current) =>
        createInitialState(workspacePath, {
          workspaceKey,
          loading: false,
          error: null,
          revision: current.revision,
        }),
      );
      return;
    }

    if (!workspaceRpcEnabled) {
      requestVersionRef.current += 1;
      lastLiveRefreshInputRef.current = nextRefreshInput;
      // Wait for remote session recovery before querying Git.
      setRepositoryState((current) =>
        createInitialState(workspacePath, {
          workspaceKey,
          loading: false,
          error: null,
          revision: current.revision,
        }),
      );
      return;
    }

    const shouldRefresh = shouldRefreshLiveGitData(
      lastLiveRefreshInputRef.current,
      nextRefreshInput,
    );
    lastLiveRefreshInputRef.current = nextRefreshInput;
    if (!shouldRefresh) {
      return;
    }

    let disposed = false;
    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;
    pendingRequestVersionRef.current = requestVersion;

    setRepositoryState((current) =>
      matchesGitRepositoryTarget(current, nextRefreshInput)
        ? {
            ...current,
            loading: true,
            error: null,
          }
        : createInitialState(workspacePath, { workspaceKey }),
    );

    // One refresh derives summary and changes from the same status snapshot.
    const refreshPromise = gitService.refresh({
      workspacePath,
      includeIdentity: includeExtendedData,
      includeBranchComparison: includeExtendedData,
    });

    // Identity and comparison are requested only for an open Git pane.
    void refreshPromise
      .then((result) => {
        const {
          summary,
          identity,
          unstagedChanges,
          stagedChanges,
          branchComparison,
          branchComparisonError,
        } = result;
        if (pendingRequestVersionRef.current === requestVersion) {
          pendingRequestVersionRef.current = null;
        }

        // BUG-GWT-013: service replacement must not drop a current result. Logical target
        // changes advance the version, so only the current identity/path can apply it.
        if (requestVersionRef.current !== requestVersion) {
          return;
        }
        // Stale results cannot reset another target's retry budget.
        consecutiveFailuresRef.current = { workspaceKey, workspacePath, count: 0 };

        if (disposed) {
          // Re-establish the baseline through the replacement service instance.
          lastLiveRefreshInputRef.current = null;
        }

        const repositoryDatasets = buildRepositoryDatasets({
          unstagedChanges,
          stagedChanges,
          branchComparison: branchComparison ?? EMPTY_BRANCH_COMPARISON,
        });
        const datasets: Record<GitChangeSourceId, GitPaneDataset> = {
          ...repositoryDatasets,
          "last-turn": createEmptyDataset("last-turn", true),
        };

        setRepositoryState({
          workspaceKey,
          workspacePath,
          summary,
          identity: identity ?? EMPTY_IDENTITY,
          placeholder: {
            enabled: false,
          },
          loading: false,
          error: branchComparisonError ?? null,
          revision: requestVersion,
          sourceOptions: buildSourceOptions(datasets),
          datasets,
        });
      })
      .catch((error: unknown) => {
        if (pendingRequestVersionRef.current === requestVersion) {
          pendingRequestVersionRef.current = null;
        }

        // Apply the same stale-result guard on failure. The retry tick also handles
        // targets whose confirmed snapshot remains visible after a failed refresh.
        if (requestVersionRef.current !== requestVersion) {
          return;
        }

        const message = getErrorMessage(error);
        logger.warn("[useGitRepository] 读取 Git 仓库状态失败", {
          workspacePath,
          error: message,
        });
        setRepositoryState((current) =>
          matchesGitRepositoryTarget(current, nextRefreshInput) &&
          current.summary.isGitAvailable &&
          current.summary.isRepository
            ? { ...current, loading: false, error: message }
            : createInitialState(workspacePath, {
                workspaceKey,
                loading: false,
                error: message,
              }),
        );
        // Exhausted retries leave the error visible until an external refresh trigger.
        const failures = matchesGitRepositoryTarget(
          consecutiveFailuresRef.current,
          nextRefreshInput,
        )
          ? consecutiveFailuresRef.current.count
          : 0;
        if (failures < MAX_INITIAL_REFRESH_RETRIES) {
          consecutiveFailuresRef.current = {
            workspaceKey,
            workspacePath,
            count: failures + 1,
          };
          setRetryTick((tick) => tick + 1);
        }
      });

    return () => {
      disposed = true;
    };
  }, [
    gitService,
    includeExtendedData,
    refreshToken,
    retryTick,
    summaryResolved,
    workspaceIdentity,
    workspaceKey,
    workspacePath,
    workspaceRpcEnabled,
    enabled,
  ]);

  return useMemo(() => {
    // Hide another identity/path's snapshot during render, before effect cleanup.
    const currentRepositoryState = matchesGitRepositoryTarget(repositoryState, {
      workspaceKey,
      workspacePath,
    })
      ? repositoryState
      : createInitialState(workspacePath, { workspaceKey });
    const datasets = {
      ...currentRepositoryState.datasets,
    };
    const lastTurnIndex = lastFileChangeEntry?.[0] ?? lastSummaryEntry?.[0] ?? null;
    const lastFileChange = lastFileChangeEntry?.[1] ?? null;
    const lastTurnSummary = buildTurnChangeSummary(lastFileChange) ?? lastSummaryEntry?.[1] ?? null;

    datasets["last-turn"] = buildLastTurnDataset({
      workspacePath,
      turnIndex: lastTurnIndex,
      fileChange: lastFileChange,
      summary: lastTurnSummary,
    });

    return {
      ...currentRepositoryState,
      sourceOptions: buildSourceOptions(datasets),
      datasets,
    };
  }, [lastFileChangeEntry, lastSummaryEntry, repositoryState, workspaceKey, workspacePath]);
}
