import { useMemo } from "react";
import type { GitDiffResult } from "@zcode/shared";
import { ChevronDownIcon, CopyIcon, FolderOpenIcon, ListTreeIcon } from "lucide-react";
import { DiffViewer } from "@/components/ui/diff-viewer.js";
import { cn } from "@/components/lib/utils.js";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.js";
import { getDiffFallbackMessageId, getGitPaneDiffPreviewPlan } from "@/GitPane/helpers.js";
import { FileDisplayInline } from "@/lib/fileDisplay.js";
import type { GitPaneFileChange } from "@/hooks/useGitRepository.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { CodePreviewSettings } from "@/store/index.js";
import type { ResolvedTheme } from "@/useTheme.js";
import { LightweightDiffPreview } from "@/components/ui/lightweight-diff-preview.js";

export function GitPaneChangeCard({
  change,
  contextMenuLabels,
  diffState,
  isDiffLoading,
  isExpanded,
  canRevealInFileManager,
  codePreviewSettings,
  resolvedTheme,
  onCopyAbsolutePath,
  onCopyRelativePath,
  onOpenChange,
  onRevealInFileManager,
  onRevealInFileTree,
}: {
  change: GitPaneFileChange;
  contextMenuLabels: {
    copyAbsolutePath: string;
    copyRelativePath: string;
    revealInFileManager: string;
    revealInFileTree: string;
  };
  diffState: GitDiffResult | null;
  isDiffLoading: boolean;
  isExpanded: boolean;
  canRevealInFileManager: boolean;
  codePreviewSettings: CodePreviewSettings;
  resolvedTheme: ResolvedTheme;
  onCopyAbsolutePath: (change: GitPaneFileChange) => void;
  onCopyRelativePath: (change: GitPaneFileChange) => void;
  onOpenChange: (change: GitPaneFileChange, nextOpen: boolean) => void;
  onRevealInFileManager: (change: GitPaneFileChange) => void;
  onRevealInFileTree?: (change: GitPaneFileChange) => void;
}) {
  const { intl } = useZCodeIntl();
  const diffPreviewPlan = useMemo(() => getGitPaneDiffPreviewPlan(diffState), [diffState]);
  const multiFileDiffFiles = useMemo(() => {
    if (diffState?.availability !== "patch" || diffState.afterContent === null) {
      return null;
    }

    // DiffViewer is memoized; if oldFile/newFile are created inline in JSX,
    // any parent refresh invalidates the shallow comparison and rerenders the large diff view.
    return {
      oldFile: {
        name: change.workspaceRelativePath,
        contents: diffState.beforeContent ?? "",
        cacheKey: `old:${diffState.path}:${diffState.beforeContent?.length ?? 0}:${diffState.beforeContent?.slice(0, 100) ?? ""}:${diffState.beforeContent?.slice(-100) ?? ""}`,
      },
      newFile: {
        name: change.workspaceRelativePath,
        contents: diffState.afterContent,
        cacheKey: `new:${diffState.path}:${diffState.afterContent.length}:${diffState.afterContent.slice(0, 100)}:${diffState.afterContent.slice(-100)}`,
      },
    };
  }, [
    change.workspaceRelativePath,
    diffState?.afterContent,
    diffState?.availability,
    diffState?.beforeContent,
    diffState?.path,
  ]);

  return (
    <div className="w-full min-w-0">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            aria-expanded={isExpanded}
            className={cn(
              "sticky top-0 z-10 flex h-8 w-full items-center gap-3 bg-background px-3 text-left transition-colors hover:bg-surface-hover supports-[backdrop-filter]:backdrop-blur-sm",
              isExpanded && "bg-surface-hover",
            )}
            onClick={() => onOpenChange(change, !isExpanded)}
          >
            {/* Opening Review mounts dozens of visible/overscan rows at once. Using Radix Collapsible on every row
                adds provider/presence and measurement work; the CDP CPU profile showed the main thread spending most of its time after the click in
                React commit. Use a regular button and render content only for expanded rows to preserve interaction while reducing open cost. */}
            <div className="min-w-0 flex-1 overflow-hidden">
              <div className="flex min-w-0 items-center gap-2 overflow-hidden">
                <FileDisplayInline
                  path={change.workspaceRelativePath}
                  options={{
                    showFilePath: true,
                    className: "inline-flex min-w-0 max-w-full items-center gap-2",
                    fileNameClassName: "truncate text-ui-base text-foreground",
                    filePathClassName: "truncate text-ui-base text-foreground-subtlest",
                  }}
                />
              </div>
            </div>
            <div className="flex shrink-0 items-center justify-end gap-3 pl-3">
              <div className="shrink-0 whitespace-nowrap text-ui-base">
                <span className="text-diff-added">+{change.added}</span>
                <span className="ml-2 text-diff-removed">-{change.removed}</span>
              </div>
              <ChevronDownIcon
                className={cn(
                  "size-4 shrink-0 text-foreground-subtle transition-transform",
                  isExpanded && "rotate-180",
                )}
              />
            </div>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-56">
          <ContextMenuItem
            disabled={!canRevealInFileManager}
            onSelect={() => onRevealInFileManager(change)}
          >
            <FolderOpenIcon className="size-4" />
            {contextMenuLabels.revealInFileManager}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => onCopyAbsolutePath(change)}>
            <CopyIcon className="size-4" />
            {contextMenuLabels.copyAbsolutePath}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => onCopyRelativePath(change)}>
            <CopyIcon className="size-4" />
            {contextMenuLabels.copyRelativePath}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            disabled={!onRevealInFileTree}
            onSelect={() => onRevealInFileTree?.(change)}
          >
            <ListTreeIcon className="size-4" />
            {contextMenuLabels.revealInFileTree}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {isExpanded ? (
        <div className="w-full min-w-0 overflow-x-auto overflow-y-hidden bg-background">
          {isDiffLoading ? (
            <div className="flex items-center justify-center py-4 text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "common.loading" })}
            </div>
          ) : diffState?.availability === "patch" && diffPreviewPlan.kind === "plain-text" ? (
            <div className="w-full min-w-0">
              <GitPanePlainTextDiffPreview
                lines={diffPreviewPlan.lines}
                codePreviewSettings={codePreviewSettings}
              />
            </div>
          ) : diffState?.availability === "patch" &&
            diffPreviewPlan.kind === "patch" &&
            diffState.patch ? (
            <div className="w-full min-w-0">
              {/* Expanding a large file only needs to show the changed hunks first. Continuing through before/after MultiFileDiff
                synchronously compares the whole file and slows click feedback. Use patch input here so the worker can continue highlighting asynchronously. */}
              <DiffViewer
                patch={diffState.patch}
                diffClassName="block"
                fontSizePx={codePreviewSettings.fontSizePx}
                lightTheme={codePreviewSettings.lightTheme}
                darkTheme={codePreviewSettings.darkTheme}
                themeType={resolvedTheme}
              />
            </div>
          ) : diffState?.availability === "patch" &&
            diffState.afterContent !== null &&
            multiFileDiffFiles ? (
            <div className="w-full min-w-0">
              {/* The right panel is narrow on mobile remote control, so expanded file diffs cannot rely on the parent hiding overflow.
                Allow horizontal scrolling on the outer container so long diff lines are not clipped on narrow screens. */}
              <DiffViewer
                oldFile={multiFileDiffFiles.oldFile}
                newFile={multiFileDiffFiles.newFile}
                diffClassName="block"
                fontSizePx={codePreviewSettings.fontSizePx}
                lightTheme={codePreviewSettings.lightTheme}
                darkTheme={codePreviewSettings.darkTheme}
                themeType={resolvedTheme}
              />
            </div>
          ) : (
            <div className="px-4 py-3 text-ui-base text-foreground-subtle">
              {intl.formatMessage({
                id: getDiffFallbackMessageId(diffState?.availability ?? "unavailable"),
              })}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function GitPanePlainTextDiffPreview({
  lines,
  codePreviewSettings,
}: {
  lines: readonly string[];
  codePreviewSettings: CodePreviewSettings;
}) {
  // Rendering a very large patch or deep hunk as a rich diff can block the main thread with synchronous parsing and DOM construction.
  // The lightweight hunk preview reuses shared diff line-number/gutter styles to stay visually consistent with the DiffViewer on the right.
  return (
    <LightweightDiffPreview
      codePreviewSettings={codePreviewSettings}
      data-git-plain-text-diff-preview
      lines={lines}
    />
  );
}
