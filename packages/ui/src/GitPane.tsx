/* eslint-disable max-lines -- GitPane currently centralizes source switching, lazy diff loading, expanded state, and file-change search integration; any future split should follow Git panel boundaries. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { GitChangeSourceId, GitDiffResult } from "@zcode/shared";
import { TID_GIT_PANE } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { FileTextIcon, FolderTreeIcon, ListIcon, RefreshCw } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { type GitPaneFileChange, type GitPaneRepositoryState } from "@/hooks/useGitRepository.js";
import { useServices } from "@/hooks/useServices.js";
import { useFileContextActions } from "@/hooks/useFileContextActions.js";
import { useWorkspaceOpenInEditorTarget } from "@/hooks/useWorkspaceOpenInEditorTarget.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { joinFilePath, isAbsoluteFilePath } from "@/lib/path.js";
import {
  getDiffCacheKey,
  getErrorMessage,
  getGitPaneDiffFindContent,
  getSourceMessageId,
} from "@/GitPane/helpers.js";
import { GitPaneChangeCard } from "@/GitPaneChangeCard.js";
import {
  buildGitPaneRows,
  getGitPaneRowIndexByPath,
  type GitPaneRow,
} from "@/GitPane/directoryRowModel.js";
import { GitPaneDirectoryHeader } from "@/GitPane/GitPaneDirectoryHeader.js";
import { getFileChangeFindState } from "@/GitPane/fileChangeFindSearch.js";
import {
  readGitPaneFileListLayout,
  writeGitPaneFileListLayout,
  type GitPaneFileListLayout,
} from "@/lib/gitPaneFileListLayoutPreference.js";
import { logger } from "@/logger.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { resolveTheme } from "@/useTheme.js";
import { getWorkspaceFileRelativePath } from "@/workspace-file-tree/model.js";

interface GitDiffLoadState {
  loading: boolean;
  diff: GitDiffResult | null;
}

const GIT_PANE_CHANGE_ROW_ESTIMATE_PX = 32;
const GIT_PANE_DIRECTORY_ROW_ESTIMATE_PX = 28;
const GIT_PANE_CHANGE_ROW_OVERSCAN = 14;

export function GitPane({
  workspacePath,
  gitState,
  isDesktop,
  selectedSourceId,
  fileChangeFindActiveIndex,
  fileChangeFindNavigationRequestId,
  fileChangeFindQuery,
  onFileChangeFindMatchCountChange,
  onSelectSource,
  onClose: _onClose,
  onRefresh,
  onRevealFileInTree,
  workspaceIdentity,
  workspaceRemoteSessionId,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  gitState: GitPaneRepositoryState;
  isDesktop?: boolean;
  selectedSourceId: GitChangeSourceId;
  fileChangeFindActiveIndex: number;
  fileChangeFindNavigationRequestId: number;
  fileChangeFindQuery: string;
  onFileChangeFindMatchCountChange: (count: number) => void;
  onSelectSource: (sourceId: GitChangeSourceId) => void;
  onClose: () => void;
  onRefresh: () => void;
  onRevealFileInTree?: (path: string) => void;
}) {
  const { gitService } = useServices();
  const { intl } = useZCodeIntl();
  const theme = useZCodeStore((state) => state.theme);
  const codePreviewSettings = useZCodeStore((state) => state.codePreviewSettings);
  const workspaceOpenTarget = useWorkspaceOpenInEditorTarget({
    workspacePath,
    workspaceIdentity,
    workspaceRemoteSessionId,
  });
  const fileActions = useFileContextActions({
    canOpenLocalFileManager: Boolean(isDesktop),
    isRemoteWorkspace:
      Boolean(workspaceRemoteSessionId || workspaceIdentity?.trim()) ||
      workspaceOpenTarget.isRemoteWorkspace,
    remoteTarget: workspaceOpenTarget.remoteTarget,
    workspaceIdentity,
  });
  const resolvedTheme = resolveTheme(theme);
  const [expandedPath, setExpandedPath] = useState<string | null>(null);
  const [fileListLayout, setFileListLayout] = useState<GitPaneFileListLayout>(() =>
    readGitPaneFileListLayout(),
  );
  const [diffStateByKey, setDiffStateByKey] = useState<Record<string, GitDiffLoadState>>({});
  const diffGenerationRef = useRef(0);
  const pendingDiffKeysRef = useRef(new Set<string>());
  const changeListScrollRef = useRef<HTMLDivElement | null>(null);

  const defaultSourceOption = gitState.sourceOptions[0]!;
  const currentSourceOption =
    gitState.sourceOptions.find((option) => option.id === selectedSourceId) ?? defaultSourceOption;
  const currentDataset = gitState.datasets[currentSourceOption.id] ?? gitState.datasets.unstaged;
  const currentChanges = useMemo(
    () => currentDataset.sections.flatMap((section) => section.changes),
    [currentDataset],
  );
  const paneRows = useMemo<GitPaneRow[]>(
    () =>
      fileListLayout === "directory"
        ? buildGitPaneRows(currentChanges)
        : currentChanges.map((change) => ({ kind: "file", change })),
    [currentChanges, fileListLayout],
  );
  const rowIndexByPath = useMemo(() => getGitPaneRowIndexByPath(paneRows), [paneRows]);
  const handleSetFileListLayout = useCallback((layout: GitPaneFileListLayout) => {
    setFileListLayout(layout);
    writeGitPaneFileListLayout(layout);
  }, []);
  const normalizedFileChangeFindQuery = fileChangeFindQuery.trim();

  const emptyStateCopy = useMemo(() => {
    if (currentSourceOption.id === "last-turn") {
      return {
        title: intl.formatMessage({ id: "git.empty.lastTurnTitle" }),
        description: intl.formatMessage({
          id: "git.empty.lastTurnDescription",
        }),
      };
    }

    if (gitState.loading) {
      return {
        title: intl.formatMessage({ id: "common.loading" }),
        description: intl.formatMessage({ id: "git.loading.description" }),
      };
    }

    if (gitState.error) {
      return {
        title: intl.formatMessage({ id: "git.error.title" }),
        description: intl.formatMessage(
          { id: "git.error.description" },
          { message: gitState.error },
        ),
      };
    }

    if (!gitState.summary.isGitAvailable) {
      return {
        title: intl.formatMessage({ id: "git.empty.gitUnavailableTitle" }),
        description: intl.formatMessage({
          id: "git.empty.gitUnavailableDescription",
        }),
      };
    }

    if (!gitState.summary.isRepository) {
      return {
        title: intl.formatMessage({ id: "git.empty.notRepositoryTitle" }),
        description: intl.formatMessage({
          id: "git.empty.notRepositoryDescription",
        }),
      };
    }

    return {
      title: intl.formatMessage({ id: "git.empty.title" }),
      description: intl.formatMessage({ id: "git.empty.description" }),
    };
  }, [
    currentSourceOption.id,
    gitState.error,
    gitState.loading,
    gitState.summary.isGitAvailable,
    gitState.summary.isRepository,
    intl,
  ]);

  useEffect(() => {
    diffGenerationRef.current += 1;
    pendingDiffKeysRef.current.clear();
    setDiffStateByKey({});
  }, [gitState.revision, workspacePath]);

  useEffect(() => {
    if (!expandedPath) {
      return;
    }

    if (!currentChanges.some((change) => change.path === expandedPath)) {
      setExpandedPath(null);
    }
  }, [currentChanges, expandedPath]);

  const loadDiffForChange = useCallback(
    (change: GitPaneFileChange, sourceId: GitChangeSourceId) => {
      if (sourceId === "last-turn" || change.diff) {
        return;
      }

      const cacheKey = getDiffCacheKey(sourceId, change.path);
      if (pendingDiffKeysRef.current.has(cacheKey) || diffStateByKey[cacheKey]?.diff) {
        return;
      }

      pendingDiffKeysRef.current.add(cacheKey);
      setDiffStateByKey((current) => ({
        ...current,
        [cacheKey]: {
          loading: true,
          diff: current[cacheKey]?.diff ?? null,
        },
      }));

      const generation = diffGenerationRef.current;
      void gitService
        .getDiff({
          workspacePath,
          path: change.path,
          sourceId,
        })
        .then((diff) => {
          if (diffGenerationRef.current !== generation) {
            return;
          }

          // For large-file diff stalls, first determine whether the delay is in fetching or rendering.
          // Record the size of each diff fetched on expansion so logs can quickly show whether the fallback condition was reached.
          // File-change search preloads diffs in batches; per-file size logs of this kind are useful only for development troubleshooting.
          // Use debug logging to keep search activity from flooding production desktop logs while retaining clues for diagnosing large-diff stalls.
          logger.debug("[GitPane] diff 已加载", {
            workspacePath,
            sourceId,
            path: change.path,
            availability: diff.availability,
            beforeChars: diff.beforeContent?.length ?? 0,
            afterChars: diff.afterContent?.length ?? 0,
          });

          setDiffStateByKey((current) => ({
            ...current,
            [cacheKey]: {
              loading: false,
              diff,
            },
          }));
        })
        .catch((error: unknown) => {
          if (diffGenerationRef.current !== generation) {
            return;
          }

          const message = getErrorMessage(error);
          logger.warn("[GitPane] 读取文件 diff 失败", {
            workspacePath,
            sourceId,
            path: change.path,
            error: message,
          });
          setDiffStateByKey((current) => ({
            ...current,
            [cacheKey]: {
              loading: false,
              diff: {
                path: change.path,
                availability: "unavailable",
                patch: null,
                beforeContent: null,
                afterContent: null,
                summary: message,
              },
            },
          }));
        })
        .finally(() => {
          pendingDiffKeysRef.current.delete(cacheKey);
        });
    },
    [diffStateByKey, gitService, workspacePath],
  );

  useEffect(() => {
    if (!expandedPath) {
      return;
    }

    const expandedChange = currentChanges.find((change) => change.path === expandedPath);
    if (!expandedChange) {
      return;
    }

    loadDiffForChange(expandedChange, currentDataset.id);
  }, [currentChanges, currentDataset.id, expandedPath, loadDiffForChange]);

  const fileChangeFindTargets = useMemo(
    () =>
      currentChanges.map((change) => {
        const diffState =
          change.diff ??
          diffStateByKey[getDiffCacheKey(currentDataset.id, change.path)]?.diff ??
          null;
        return {
          path: change.path,
          content: getGitPaneDiffFindContent(diffState),
        };
      }),
    [currentChanges, currentDataset.id, diffStateByKey],
  );
  const fileChangeFindState = useMemo(
    () =>
      getFileChangeFindState(fileChangeFindTargets, fileChangeFindQuery, fileChangeFindActiveIndex),
    [fileChangeFindActiveIndex, fileChangeFindQuery, fileChangeFindTargets],
  );
  const activeFileChangeFindMatch = fileChangeFindState.activeMatch;
  const changeRowVirtualizer = useVirtualizer({
    count: paneRows.length,
    getItemKey: (index) => {
      const row = paneRows[index];
      if (!row) {
        return `${currentDataset.id}:${index}`;
      }
      return row.kind === "file"
        ? `${currentDataset.id}:file:${row.change.path}`
        : `${currentDataset.id}:dir:${row.runIndex}:${row.directory}`;
    },
    getScrollElement: () => changeListScrollRef.current,
    estimateSize: (index) =>
      paneRows[index]?.kind === "directory"
        ? GIT_PANE_DIRECTORY_ROW_ESTIMATE_PX
        : GIT_PANE_CHANGE_ROW_ESTIMATE_PX,
    overscan: GIT_PANE_CHANGE_ROW_OVERSCAN,
  });
  const virtualChangeRows = changeRowVirtualizer.getVirtualItems();

  useEffect(() => {
    onFileChangeFindMatchCountChange(fileChangeFindState.total);
  }, [fileChangeFindState.total, onFileChangeFindMatchCountChange]);

  useEffect(() => {
    // Opening the Review pane synchronously mounted hundreds of untracked files, causing 600ms+ click long tasks in CDP traces.
    // Mount only visible rows; remeasure when expanding a diff changes its height
    // so later virtual rows do not keep using the collapsed height.
    changeRowVirtualizer.measure();
  }, [changeRowVirtualizer, currentDataset.id, expandedPath]);

  useEffect(() => {
    if (!normalizedFileChangeFindQuery) {
      return;
    }

    // File-change search must find content inside collapsed files.
    // Diffs are lazy-loaded when expanded by default, so load the diffs for the current source before searching and compute global matches from the same patch data.
    for (const change of currentChanges) {
      loadDiffForChange(change, currentDataset.id);
    }
  }, [currentChanges, currentDataset.id, loadDiffForChange, normalizedFileChangeFindQuery]);

  useEffect(() => {
    if (!activeFileChangeFindMatch) {
      return;
    }

    const activeChange = currentChanges.find(
      (change) => change.path === activeFileChangeFindMatch.path,
    );
    if (!activeChange) {
      return;
    }

    if (expandedPath !== activeFileChangeFindMatch.path) {
      // The current match may be inside a collapsed file.
      // Expand the target file first, then let the text-highlighting hook scroll to the matching line after the real DOM renders.
      setExpandedPath(activeFileChangeFindMatch.path);
    }
    loadDiffForChange(activeChange, currentDataset.id);
  }, [
    activeFileChangeFindMatch,
    currentChanges,
    currentDataset.id,
    expandedPath,
    fileChangeFindNavigationRequestId,
    loadDiffForChange,
  ]);

  useEffect(() => {
    if (!activeFileChangeFindMatch) {
      return;
    }

    const activeMatchIndex = rowIndexByPath.get(activeFileChangeFindMatch.path);
    if (activeMatchIndex === undefined) {
      return;
    }

    changeRowVirtualizer.scrollToIndex(activeMatchIndex, { align: "center" });
  }, [
    activeFileChangeFindMatch,
    changeRowVirtualizer,
    rowIndexByPath,
    fileChangeFindNavigationRequestId,
  ]);

  const handleSelectSource = (nextSourceId: string) => {
    logger.info(`[GitPane] 切换来源 workspace=${workspacePath} source=${nextSourceId}`);
    onSelectSource(nextSourceId as GitChangeSourceId);
    setExpandedPath(null);
  };

  const handleExpandChange = (change: GitPaneFileChange, nextOpen: boolean) => {
    logger.info(
      `[GitPane] 切换文件展开 workspace=${workspacePath} source=${currentSourceOption.id} path=${change.path} expanded=${nextOpen}`,
    );
    setExpandedPath(nextOpen ? change.path : null);
    if (nextOpen) {
      loadDiffForChange(change, currentDataset.id);
    }
  };

  const resolveChangePath = useCallback(
    (change: GitPaneFileChange) =>
      isAbsoluteFilePath(change.path) ? change.path : joinFilePath(workspacePath, change.path),
    [workspacePath],
  );

  const handleCopyAbsolutePath = useCallback(
    (change: GitPaneFileChange) => {
      void fileActions.copyAbsolutePath({ path: resolveChangePath(change) });
    },
    [fileActions, resolveChangePath],
  );
  const handleCopyRelativePath = useCallback(
    (change: GitPaneFileChange) => {
      void fileActions.copyRelativePath({
        path: resolveChangePath(change),
        relativePath: getWorkspaceFileRelativePath(workspacePath, resolveChangePath(change)),
      });
    },
    [fileActions, resolveChangePath, workspacePath],
  );

  const handleRevealChangeInFileManager = useCallback(
    (change: GitPaneFileChange) => {
      void fileActions.revealInFileManager({
        path: resolveChangePath(change),
        deleted: change.kind === "deleted",
        kind: "file",
      });
    },
    [fileActions, resolveChangePath],
  );

  const handleRevealChangeInFileTree = useCallback(
    (change: GitPaneFileChange) => {
      onRevealFileInTree?.(resolveChangePath(change));
    },
    [onRevealFileInTree, resolveChangePath],
  );

  const contextMenuLabels = useMemo(
    () => ({
      copyAbsolutePath: intl.formatMessage({ id: "fileActions.copyAbsolutePath" }),
      copyRelativePath: intl.formatMessage({ id: "fileActions.copyRelativePath" }),
      revealInFileManager: intl.formatMessage({ id: "git.changeContext.revealInFileManager" }),
      revealInFileTree: intl.formatMessage({ id: "git.changeContext.revealInFileTree" }),
    }),
    [intl],
  );

  return (
    <section data-testid={TID_GIT_PANE} className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex items-center justify-between gap-3 p-3">
        <Select value={currentSourceOption.id} onValueChange={handleSelectSource}>
          <SelectTrigger className="max-w-full" size="lg">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="start">
            {gitState.sourceOptions.map((option) => (
              <SelectItem key={option.id} value={option.id} disabled={option.disabled}>
                {intl.formatMessage({ id: getSourceMessageId(option.id) })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="flex items-center gap-2">
          {currentChanges.length > 0 ? (
            <div
              className="flex items-center gap-0.5 rounded-md border border-border p-0.5"
              role="group"
              aria-label={intl.formatMessage({ id: "git.fileListLayout.toggleLabel" })}
            >
              <Button
                type="button"
                variant={fileListLayout === "directory" ? "secondary" : "ghost"}
                size="icon-sm"
                aria-pressed={fileListLayout === "directory"}
                aria-label={intl.formatMessage({ id: "git.fileListLayout.directory" })}
                title={intl.formatMessage({ id: "git.fileListLayout.directory" })}
                disabled={gitState.loading}
                onClick={() => handleSetFileListLayout("directory")}
              >
                <FolderTreeIcon />
              </Button>
              <Button
                type="button"
                variant={fileListLayout === "flat" ? "secondary" : "ghost"}
                size="icon-sm"
                aria-pressed={fileListLayout === "flat"}
                aria-label={intl.formatMessage({ id: "git.fileListLayout.flat" })}
                title={intl.formatMessage({ id: "git.fileListLayout.flat" })}
                disabled={gitState.loading}
                onClick={() => handleSetFileListLayout("flat")}
              >
                <ListIcon />
              </Button>
            </div>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="lg"
            disabled={gitState.loading}
            onClick={onRefresh}
          >
            <RefreshCw className={cn("size-3.5", gitState.loading && "animate-spin")} />
            {intl.formatMessage({ id: "git.action.refresh" })}
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {currentChanges.length > 0 ? (
          <div ref={changeListScrollRef} className="h-full min-h-0 w-full overflow-auto">
            <div
              className="relative w-full min-w-0"
              style={{ height: `${changeRowVirtualizer.getTotalSize()}px` }}
            >
              {virtualChangeRows.map((virtualRow) => {
                const row = paneRows[virtualRow.index];
                if (!row) {
                  return null;
                }

                if (row.kind === "directory") {
                  return (
                    <div
                      key={virtualRow.key}
                      ref={changeRowVirtualizer.measureElement}
                      className="absolute left-0 w-full min-w-0"
                      data-git-pane-directory-virtual-row
                      data-index={virtualRow.index}
                      style={{ top: `${virtualRow.start}px` }}
                    >
                      <GitPaneDirectoryHeader row={row} />
                    </div>
                  );
                }

                const change = row.change;
                const isExpanded = expandedPath === change.path;
                const diffCacheKey = getDiffCacheKey(currentDataset.id, change.path);
                const cachedDiffState = diffStateByKey[diffCacheKey];
                const diffState = change.diff ?? cachedDiffState?.diff ?? null;
                const isDiffLoading =
                  isExpanded && !change.diff && (!cachedDiffState || cachedDiffState.loading);

                return (
                  <div
                    key={virtualRow.key}
                    ref={changeRowVirtualizer.measureElement}
                    className="absolute left-0 w-full min-w-0"
                    data-git-pane-change-virtual-row
                    data-index={virtualRow.index}
                    // transform positioning breaks the inline sticky filename, so the heading no longer stays pinned after expanding a large diff.
                    // Use a top offset to preserve virtual scrolling while keeping sticky positioning relative to the scroll container.
                    style={{ top: `${virtualRow.start}px` }}
                  >
                    <GitPaneChangeCard
                      change={change}
                      hideDirectoryPart={fileListLayout === "directory"}
                      contextMenuLabels={contextMenuLabels}
                      diffState={diffState}
                      isDiffLoading={isDiffLoading}
                      isExpanded={isExpanded}
                      canRevealInFileManager={fileActions.canRevealInFileManager({
                        path: resolveChangePath(change),
                        deleted: change.kind === "deleted",
                      })}
                      codePreviewSettings={codePreviewSettings}
                      resolvedTheme={resolvedTheme}
                      onCopyAbsolutePath={handleCopyAbsolutePath}
                      onCopyRelativePath={handleCopyRelativePath}
                      onOpenChange={handleExpandChange}
                      onRevealInFileManager={handleRevealChangeInFileManager}
                      onRevealInFileTree={
                        onRevealFileInTree ? handleRevealChangeInFileTree : undefined
                      }
                    />
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <FileTextIcon className="size-8 text-foreground-subtlest" />
            <p className="mt-3 text-ui-base font-medium text-foreground">{emptyStateCopy.title}</p>
            <p className="mt-1 text-ui-base text-foreground-subtle">{emptyStateCopy.description}</p>
          </div>
        )}
      </div>
    </section>
  );
}
