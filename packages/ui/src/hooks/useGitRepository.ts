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

  if (previous.refreshToken !== next.refreshToken) {
    return true;
  }

  // Key behavior: closing the Git pane must not trigger real Git work just because branch/identity data is missing.
  // Fetch extra data only on the closed → open transition; task/last-turn switches only reorganize local data.
  return !previous.includeExtendedData && next.includeExtendedData;
}

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
  const lastLiveRefreshInputRef = useRef<GitLiveDataRefreshInput | null>(null);
  const lastFileChangeEntry = null;
  const lastSummaryEntry = null;

  useEffect(() => {
    const nextRefreshInput: GitLiveDataRefreshInput = {
      workspacePath,
      workspaceKey,
      includeExtendedData,
      refreshToken,
      workspaceRpcEnabled,
    };

    if (!enabled) {
      requestVersionRef.current += 1;
      lastLiveRefreshInputRef.current = nextRefreshInput;
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
      // A disconnected remote workspace may show an empty Git-pane shell, but do not
      // query remote Git before session recovery; that would amplify a disconnected proxy error into log noise on every first mount.
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

    setRepositoryState((current) =>
      current.workspaceKey === workspaceKey
        ? {
            ...current,
            loading: true,
            error: null,
          }
        : createInitialState(workspacePath, { workspaceKey }),
    );

    // Agent file writes trigger automatic Git refresh. Do not split this into summary/unstaged/staged
    // RPCs because each server call reruns git status, creating a three-call burst for every update in the logs.
    // Use refresh once so a single status snapshot provides the header and the Git pane’s base data.
    const refreshPromise = gitService.refresh({
      workspacePath,
      includeIdentity: includeExtendedData,
      includeBranchComparison: includeExtendedData,
    });

    // Key behavior: while the header is always visible, it needs only summary and staged/unstaged counts;
    // fetch branch comparison and identity only after the Git pane is expanded, avoiding full Git-pane prefetch on the first frame.
    void refreshPromise
      .then(({ summary, identity, unstagedChanges, stagedChanges, branchComparison }) => {
        if (disposed || requestVersionRef.current !== requestVersion) {
          return;
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
          summary,
          identity: identity ?? EMPTY_IDENTITY,
          placeholder: {
            enabled: false,
          },
          loading: false,
          error: null,
          revision: requestVersion,
          sourceOptions: buildSourceOptions(datasets),
          datasets,
        });
      })
      .catch((error: unknown) => {
        if (disposed || requestVersionRef.current !== requestVersion) {
          return;
        }

        const message = getErrorMessage(error);
        logger.warn("[useGitRepository] 读取 Git 仓库状态失败", {
          workspacePath,
          error: message,
        });
        setRepositoryState((current) => ({
          ...createInitialState(workspacePath, {
            workspaceKey,
            loading: false,
            error: message,
            revision: current.revision,
          }),
        }));
      });

    return () => {
      disposed = true;
    };
  }, [
    gitService,
    includeExtendedData,
    refreshToken,
    workspaceIdentity,
    workspaceKey,
    workspacePath,
    workspaceRpcEnabled,
    enabled,
  ]);

  return useMemo(() => {
    // useEffect clears old state only after the workspace-switch commit. During render, project an empty state by
    // workspaceKey first so Git paths from the previous machine are not registered with the new remote fileWatcherService.
    const currentRepositoryState =
      repositoryState.workspaceKey === workspaceKey
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
