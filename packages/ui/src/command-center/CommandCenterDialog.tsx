/* eslint-disable max-lines -- Aggregates command, task, and file search results; it can be split by result section later. */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { unpackWorkspaceFileEntries } from "@zcode/shared/workspaceFileEntriesCodec";
import { fetchWorkspaceFileEntriesPacked } from "@/workspace-file-search/fetchWorkspaceFileEntries.js";
import { Command as CommandPrimitive } from "cmdk";
import {
  ArrowLeftIcon,
  CheckIcon,
  ChevronDownIcon,
  FileIcon,
  FolderIcon,
  GitBranchPlusIcon,
  ListIcon,
  MessageSquareIcon,
  MessagesSquareIcon,
  RocketIcon,
  SearchIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import type {
  GitLocalBranchListResult,
  GitWorkspaceRepositoryInfo,
  WorkspaceFileEntry,
  ZCodeTaskChangeSummary,
  ZCodeTaskMeta,
} from "@zcode/shared";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { toast } from "@/components/ui/toast.js";
import { useGlobalTaskList } from "@/hooks/useGlobalTaskList.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useServices } from "@/hooks/useServices.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { matchesGitBranchSearch } from "@/git-branch-switcher/display.js";
import { FileDisplayIcon, resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";
import { toWorkspaceRelativePath } from "@/lib/taskChangeSummary.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { getPathLeaf } from "@/lib/path.js";
import { logger } from "@/logger.js";
import { HighlightedMatchText } from "@/quickpick/HighlightedMatchText.js";
import {
  QUICK_PICK_SECTION_ORDER,
  type QuickPickCommand,
  type QuickPickValueList,
  type QuickPickValueListOption,
} from "@/quickpick/quickPickCommands.js";
import { QUICK_PICK_ICON_BY_KIND } from "@/quickpick/quickPickCommandIcons.js";
import {
  quickPickCommandClassName,
  quickPickDialogClassName,
  quickPickItemClassName,
  quickPickListClassName,
  quickPickMetadataClassName,
  quickPickShortcutPillClassName,
} from "@/quickpick/quickPickStyles.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import type { ChatSearchResultHighlightRequest } from "@/v4/legacyChatViewTypes.js";
import {
  clearCommandCenterSearchHistory,
  pushCommandCenterSearchHistory,
  readCommandCenterSearchHistory,
  type CommandCenterSearchHistoryEntry,
  type CommandCenterSearchScope,
} from "@/command-center/commandCenterSearchHistory.js";
import {
  createCommandCenterPageStack,
  getActiveCommandCenterPage,
  popCommandCenterPage,
  pushCommandCenterPage,
  resetCommandCenterPageStack,
  type CommandCenterPageStack,
} from "@/command-center/commandCenterPageStack.js";
import {
  buildWorktreeTaskProjects,
  computeWorktreeTargetPath,
  deriveWorktreeFormValues,
  getWorkspaceIdentityKey,
  NEW_TASK_PROJECT_PAGE_ID,
  NEW_TASK_SETUP_PAGE_ID,
  NEW_TASK_WORKTREE_COMMAND_ID,
  resolveWorktreeLocation,
  type WorktreeTaskDestination,
  type WorktreeTaskProject,
} from "@/command-center/worktreeTaskFlow.js";
import { executeWorktreeCreation } from "@/command-center/worktreeCreation.js";

const EMPTY_QUICK_PICK_COMMANDS: QuickPickCommand[] = [];
const EMPTY_COMMAND_CENTER_WORKSPACE_TABS: WorkspaceTabState[] = [];
// Stable fallback so the worktreeProjects useMemo is not invalidated on every render when
// the settings snapshot has no recentProjects yet.
const EMPTY_RECENT_PROJECTS: readonly string[] = [];
const COMMAND_CENTER_SECTION_LIMIT = 3;
const COMMAND_CENTER_CONTEXT_SECTION_LIMIT = 3;
const COMMAND_CENTER_FILE_RESULT_LIMIT = 80;
const COMMAND_CENTER_TASK_RESULT_LIMIT = 80;
const commandCenterDialogClassName = cn(
  quickPickDialogClassName,
  // On Linux desktop, the shared DialogContent offsets centered dialogs for the custom title bar.
  // The Command Center is a top search overlay, so redeclare top in the Linux variant;
  // otherwise the platform offset overrides top-16/sm:top-20 and moves the overlay to the middle of the window.
  "top-16 max-h-[calc(100dvh-4.5rem)] -translate-y-0 sm:top-20 sm:max-h-[calc(100dvh-6rem)]",
  "platform-linux-desktop:top-16 sm:platform-linux-desktop:top-20",
);
const commandCenterListClassName = cn(
  quickPickListClassName,
  "max-h-[min(440px,calc(100dvh-15rem))]",
);

type CommandCenterSectionId = "commands" | "conversations" | "files";
type TaskSearchResultItem = ZCodeTaskMeta & {
  searchSnippet?: string;
  searchSnippets?: string[];
};
type TaskChangedFileSummary = ZCodeTaskChangeSummary["files"][number];
type TaskSearchResultRow = {
  key: string;
  task: TaskSearchResultItem;
  searchSnippet?: string;
  snippetIndex?: number;
};

function getWorkspaceFileDirectory(entry: WorkspaceFileEntry): string {
  const slashIndex = entry.relativePath.lastIndexOf("/");
  return slashIndex === -1 ? "" : entry.relativePath.slice(0, slashIndex);
}

function buildWorkspaceFileSearchText(entry: WorkspaceFileEntry): string {
  return `${entry.name} ${entry.relativePath}`.toLocaleLowerCase();
}

function filterWorkspaceFileEntries(
  entries: readonly WorkspaceFileEntry[],
  query: string,
): WorkspaceFileEntry[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) {
    return [];
  }

  const parts = normalizedQuery.split(/\s+/).filter(Boolean);
  return entries
    .filter((entry) => entry.type === "file")
    .filter((entry) => {
      const searchText = buildWorkspaceFileSearchText(entry);
      return parts.every((part) => searchText.includes(part));
    })
    .slice(0, COMMAND_CENTER_FILE_RESULT_LIMIT);
}

function normalizeSnippetForDedupe(snippet: string): string {
  return snippet
    .replace(/^\.\.\./, "")
    .replace(/\.\.\.$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

function getUniqueTaskSearchSnippets(task: TaskSearchResultItem): string[] {
  const snippets = task.searchSnippets?.length
    ? task.searchSnippets
    : task.searchSnippet
      ? [task.searchSnippet]
      : [];
  const seen = new Set<string>();
  const uniqueSnippets: string[] = [];
  for (const snippet of snippets) {
    const normalized = normalizeSnippetForDedupe(snippet);
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    uniqueSnippets.push(snippet);
  }

  return uniqueSnippets;
}

function getTaskTitle(task: ZCodeTaskMeta, untitledLabel: string): string {
  return task.title.trim() || untitledLabel;
}

function compareRecentChangedFiles(left: TaskChangedFileSummary, right: TaskChangedFileSummary) {
  if (right.lastTurnIndex !== left.lastTurnIndex) {
    return right.lastTurnIndex - left.lastTurnIndex;
  }
  if (right.writeCount !== left.writeCount) {
    return right.writeCount - left.writeCount;
  }
  return left.path.localeCompare(right.path);
}

function resolveQueryScope(rawQuery: string): {
  query: string;
  scope: CommandCenterSearchScope;
  explicitScope: boolean;
} {
  const trimmed = rawQuery.trimStart();
  const prefix = trimmed[0];
  if (prefix === ">") {
    return { query: trimmed.slice(1).trimStart(), scope: "commands", explicitScope: true };
  }
  if (prefix === "#") {
    return { query: trimmed.slice(1).trimStart(), scope: "conversations", explicitScope: true };
  }
  if (prefix === "@") {
    return { query: trimmed.slice(1).trimStart(), scope: "files", explicitScope: true };
  }

  return { query: rawQuery.trim(), scope: "all", explicitScope: false };
}

// Accepts any keyword-carrying row so command entries and value-list options share the same matcher.
function matchesCommand(command: { keywords: string[] }, title: string, query: string): boolean {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) {
    return true;
  }

  const searchText = `${title} ${command.keywords.join(" ")}`.toLocaleLowerCase();
  return normalizedQuery
    .split(/\s+/)
    .filter(Boolean)
    .every((part) => searchText.includes(part));
}

function buildTaskResultRows(params: {
  tasks: readonly TaskSearchResultItem[];
  query: string;
}): TaskSearchResultRow[] {
  const rows: TaskSearchResultRow[] = [];
  const taskByKey = new Map<string, TaskSearchResultItem>();

  for (const task of params.tasks) {
    const taskKey = `${task.workspaceIdentity?.trim() || task.workspacePath}:${task.taskId}`;
    const existingTask = taskByKey.get(taskKey);
    if (!existingTask) {
      taskByKey.set(taskKey, task);
      continue;
    }

    taskByKey.set(taskKey, {
      ...existingTask,
      searchSnippets: [
        ...getUniqueTaskSearchSnippets(existingTask),
        ...getUniqueTaskSearchSnippets(task),
      ],
    });
  }

  for (const task of taskByKey.values()) {
    const taskKey = `${task.workspaceIdentity?.trim() || task.workspacePath}:${task.taskId}`;
    const snippets = params.query ? getUniqueTaskSearchSnippets(task) : [];
    if (snippets.length === 0) {
      rows.push({ key: taskKey, task });
      continue;
    }

    snippets.forEach((snippet, snippetIndex) => {
      rows.push({
        key: `${taskKey}:${snippetIndex}`,
        task,
        searchSnippet: snippet,
        snippetIndex,
      });
    });
  }

  return rows;
}

export function CommandCenterScopeButton({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        // Scope tabs are interactive scope-switching buttons. Per the semantic roles in DESIGN.md, they are
        // common buttons and should use text-ui-base, not text-ui-xs (10px, reserved for badges/counters), which is too small. Match the search input above (text-ui-base).
        "inline-flex h-6 shrink-0 items-center gap-1 rounded-full border px-2 text-ui-base font-medium leading-none transition-colors",
        active
          ? "border-border bg-selected text-foreground"
          : "border-transparent text-foreground-subtle hover:bg-surface-hover hover:text-foreground",
      )}
    >
      {children}
      <span>{label}</span>
    </button>
  );
}

/**
 * Scope prefix for a search-history chip (for example, commands → ">").
 * Extracted so CommandCenterSearchHistory can reuse it.
 */
function scopeToPrefix(scope: CommandCenterSearchScope): string {
  switch (scope) {
    case "commands":
      return ">";
    case "conversations":
      return "#";
    case "files":
      return "@";
    default:
      return "";
  }
}

/**
 * Timestamp for a conversation-search result.
 * Kept as a separate component for reuse and unit tests; per DESIGN.md, relative time in a list item is
 * secondary copy and uses text-ui-sm (not text-ui-xs, which is too small).
 */
export function CommandCenterConversationTimestamp({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "max-w-12 shrink-0 truncate font-sans text-ui-sm tracking-normal text-foreground-subtlest",
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * Command-center search-history area: section heading + history chips + clear/expand buttons.
 * Extracted from CommandCenterDialog's inline JSX for reuse and unit testing.
 *
 * Font-size roles (DESIGN.md):
 * - Section heading: text-ui-sm (section label / helper text)
 * - Search term in history chip: text-ui-base (readable content, matching the list body)
 * - Scope prefix in chip: text-ui-xs (badge marker, one level smaller than the content)
 */
export function CommandCenterSearchHistory({
  entries,
  expanded,
  onToggleExpanded,
  onPickEntry,
  onClear,
  historyLabel,
  clearLabel,
  expandLabel,
  collapseLabel,
}: {
  entries: CommandCenterSearchHistoryEntry[];
  expanded: boolean;
  onToggleExpanded: () => void;
  onPickEntry: (entry: CommandCenterSearchHistoryEntry) => void;
  onClear: () => void;
  historyLabel: string;
  clearLabel: string;
  expandLabel: string;
  collapseLabel: string;
}) {
  const canExpand = entries.length > 6;
  return (
    <>
      <div className="flex items-center gap-2 px-3 pt-2 text-ui-sm font-medium text-foreground-subtle">
        <span>{historyLabel}</span>
        <button
          type="button"
          aria-label={clearLabel}
          className="ml-auto inline-grid size-6 place-items-center rounded-md text-foreground-subtlest hover:bg-surface-hover hover:text-foreground"
          onClick={onClear}
        >
          <Trash2Icon className="size-3.5" />
        </button>
      </div>
      <div
        className={cn(
          "relative flex flex-wrap gap-1.5 overflow-hidden px-3 pt-1 pb-2 pr-11",
          expanded ? "" : "max-h-[34px]",
        )}
      >
        {entries.map((entry) => {
          const prefix = scopeToPrefix(entry.scope);
          return (
            <button
              key={`${entry.scope}:${entry.query}:${entry.updatedAt}`}
              type="button"
              // text-ui-base scales with --ui-font-size (12–20px), so do not use a fixed h-5.
              // At 20px, the content area (20px - 2px border = 18px) cannot fit the font line box,
              // and the outer overflow-hidden would clip the text. Use min-h-5 + py-0.5 + leading-none
              // so height grows with the font and remains readable across the 12–20px range.
              className="inline-flex min-h-5 max-w-44 shrink-0 items-center gap-1 rounded-full border border-border px-2 py-0.5 leading-none text-ui-base text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
              onClick={() => onPickEntry(entry)}
            >
              {prefix ? <span className="font-mono text-ui-xs text-brand">{prefix}</span> : null}
              <span className="min-w-0 truncate">{entry.query}</span>
            </button>
          );
        })}
        {canExpand ? (
          <button
            type="button"
            aria-label={expanded ? collapseLabel : expandLabel}
            className="absolute top-1 right-3 inline-grid size-6 place-items-center rounded-md text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
            onClick={onToggleExpanded}
          >
            <ChevronDownIcon
              className={cn("size-3.5 transition-transform", expanded ? "rotate-180" : "")}
            />
          </button>
        ) : null}
      </div>
    </>
  );
}

export const CommandCenterDialog = memo(function CommandCenterDialogComponent({
  open,
  commands,
  workspaceAbsPath,
  workspaceIdentity,
  activeTaskId,
  activeTaskChangeSummary,
  workspaceTabs,
  onOpenChange,
  onSelectTask,
  onCreateTaskInWorkspace,
  onSearchResultHighlightRequest,
  onOpenCodeViewer,
}: {
  open: boolean;
  commands: QuickPickCommand[];
  workspaceAbsPath: string;
  workspaceIdentity?: string;
  activeTaskId?: string | null;
  activeTaskChangeSummary?: ZCodeTaskChangeSummary | null;
  workspaceTabs: WorkspaceTabState[];
  onOpenChange: (open: boolean) => void;
  onSelectTask: (
    targetWorkspacePath: string,
    taskId: string,
    targetWorkspaceIdentity?: string,
  ) => void;
  /**
   * Opens (or reuses) the workspace tab and starts a draft task in it — the App-level
   * workspace-open + startDraft contract used by the "New task in worktree" flow.
   */
  onCreateTaskInWorkspace: (targetWorkspacePath: string, targetWorkspaceIdentity?: string) => void;
  onSearchResultHighlightRequest?: (
    request: Omit<ChatSearchResultHighlightRequest, "requestId">,
  ) => void;
  onOpenCodeViewer: (source: CodeViewerSource) => void;
}) {
  const { fileService } = useServices();
  const { intl } = useZCodeIntl();
  // Worktree flow runs local Git for arbitrary local project paths; the active workspace's
  // scoped services may point at a remote Host, so always resolve the local base Host accessor.
  const baseServices = useBaseWorkspaceServices();
  const { settings } = useSettings();
  // Stage F：全局存储目录只在 desktop 平台实现；无 provider / 方法缺失时保持 null（global 模式按无效位置处理）。
  const platform = useOptionalPlatform();
  const workspaceKey = workspaceIdentity?.trim() || workspaceAbsPath;
  const [rawQuery, setRawQuery] = useState("");
  const [manualScope, setManualScope] = useState<CommandCenterSearchScope>("all");
  const [expandedSections, setExpandedSections] = useState<Set<CommandCenterSectionId>>(
    () => new Set(),
  );
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<CommandCenterSearchHistoryEntry[]>([]);
  // Copilot-style page stack: commands with a `page` push an in-palette sub-page instead of closing the dialog.
  const [pageStack, setPageStack] = useState<CommandCenterPageStack>(createCommandCenterPageStack);
  // “New task in worktree” flow state lives with the page-stack machinery (no global store):
  // back keeps the chosen project and form values (CC-01); closing the palette resets everything.
  const [worktreeProject, setWorktreeProject] = useState<WorktreeTaskProject | null>(null);
  const [worktreeDestination, setWorktreeDestination] =
    useState<WorktreeTaskDestination>("worktree");
  /** null = not chosen yet; the effective base branch falls back to the repo default. */
  const [worktreeBaseBranch, setWorktreeBaseBranch] = useState<string | null>(null);
  const [worktreeBranchName, setWorktreeBranchName] = useState("");
  const [worktreeBranchesResult, setWorktreeBranchesResult] =
    useState<GitLocalBranchListResult | null>(null);
  const [worktreeRepoInfo, setWorktreeRepoInfo] = useState<GitWorkspaceRepositoryInfo | null>(null);
  const [worktreeDataLoading, setWorktreeDataLoading] = useState(false);
  const [worktreeDataError, setWorktreeDataError] = useState<string | null>(null);
  const [worktreeStartBusy, setWorktreeStartBusy] = useState(false);
  const [worktreeIssueMessage, setWorktreeIssueMessage] = useState<string | null>(null);
  /** Existing worktree path offered when creation fails with target-path-exists (WT-04 recovery). */
  const [worktreeRecoveryPath, setWorktreeRecoveryPath] = useState<string | null>(null);
  /** Stage F：懒加载的全局存储目录（仅 global 模式取，缓存于组件 state；失败静默保持 null）。 */
  const [appWorktreesDir, setAppWorktreesDir] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  // In-flight worktree Start attempts: incremented on dialog close and on every new Start,
  // so a result resolving after the user closed the palette cannot switch workspaces or
  // write state into the already-reset flow (CodeRabbit: ignore late creation results).
  const worktreeStartAttemptRef = useRef(0);
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFileEntry[]>([]);
  const [workspaceFilesLoading, setWorkspaceFilesLoading] = useState(false);
  const [workspaceFilesError, setWorkspaceFilesError] = useState<string | null>(null);
  const [loadedWorkspaceKey, setLoadedWorkspaceKey] = useState<string | null>(null);
  // Performance fix: the closed Command Center does not need to recompute commands, tasks, and recent changes during chat streaming.
  // Keep hook order but pass empty inputs while closed so the hidden dialog does not rebuild its results on every token batch.
  const effectiveCommands = open ? commands : EMPTY_QUICK_PICK_COMMANDS;
  const effectiveWorkspaceTabs = open ? workspaceTabs : EMPTY_COMMAND_CENTER_WORKSPACE_TABS;
  const effectiveActiveTaskChangeSummary = open ? activeTaskChangeSummary : null;
  const activePage = getActiveCommandCenterPage(pageStack);
  const activePageCommand = useMemo(
    () =>
      activePage
        ? effectiveCommands.find((command) => command.id === activePage.commandId)
        : undefined,
    [activePage, effectiveCommands],
  );
  const worktreeProjectPageActive = activePage?.id === NEW_TASK_PROJECT_PAGE_ID;
  const worktreeSetupPageActive = activePage?.id === NEW_TASK_SETUP_PAGE_ID && !!worktreeProject;
  const recentProjects = settings?.recentProjects ?? EMPTY_RECENT_PROJECTS;
  const worktreeProjects = useMemo(
    () =>
      worktreeProjectPageActive
        ? buildWorktreeTaskProjects({
            tabs: effectiveWorkspaceTabs,
            recentProjects,
            activeWorkspaceKey: workspaceKey,
          })
        : [],
    [worktreeProjectPageActive, effectiveWorkspaceTabs, recentProjects, workspaceKey],
  );
  // Stage D: effective worktree defaults = global settings + the project override entry keyed by path.
  const worktreeEffectiveLocation = useMemo(
    () =>
      worktreeProject
        ? resolveWorktreeLocation(
            settings,
            settings?.worktreeProjectOverrides,
            worktreeProject.workspacePath,
            appWorktreesDir,
          )
        : null,
    [settings, worktreeProject, appWorktreesDir],
  );
  // Stage F：仅当生效模式为 global 时向平台取 app 目录（懒加载 + 组件 state 缓存）。
  const getAppWorktreesDir = platform?.getAppWorktreesDir;
  useEffect(() => {
    if (
      worktreeEffectiveLocation?.mode !== "global" ||
      typeof getAppWorktreesDir !== "function" ||
      appWorktreesDir !== null
    ) {
      return;
    }
    let cancelled = false;
    getAppWorktreesDir().then(
      (dir) => {
        if (!cancelled) {
          setAppWorktreesDir(dir.trim() || null);
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          // 静默失败：目录不可用时 global 模式按无效位置处理（Start 阻塞 + 内联错误）。
          logger.debug("[CommandCenter] getAppWorktreesDir 失败", {
            error: getErrorMessage(error),
          });
          setAppWorktreesDir(null);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [worktreeEffectiveLocation?.mode, getAppWorktreesDir, appWorktreesDir]);
  // Recomputed together because Start, validation, and the previews all read the same
  // composed values; the memo keeps per-keystroke work off renders that did not change the form.
  const {
    effectiveBaseBranch: effectiveWorktreeBaseBranch,
    trimmedBranchName: trimmedWorktreeBranchName,
    composedBranchName: composedWorktreeBranchName,
    branchNameIssue: worktreeBranchNameIssue,
    customLocationInvalid: worktreeCustomLocationInvalid,
    globalLocationUnavailable: worktreeGlobalLocationUnavailable,
    targetPathPreview: worktreeTargetPathPreview,
    targetPathPreviewDisplay: worktreeTargetPathPreviewDisplay,
  } = useMemo(
    () =>
      deriveWorktreeFormValues({
        projectPath: worktreeProject?.workspacePath ?? null,
        branchName: worktreeBranchName,
        selectedBaseBranch: worktreeBaseBranch,
        branchesResult: worktreeBranchesResult,
        effectiveLocation: worktreeEffectiveLocation,
        isWorktreeDestination: worktreeDestination === "worktree",
      }),
    [
      worktreeBaseBranch,
      worktreeBranchesResult,
      worktreeBranchName,
      worktreeDestination,
      worktreeEffectiveLocation,
      worktreeProject,
    ],
  );
  // WT-03: a non-repository or Git-less project shows a dedicated state and blocks Start.
  const worktreeRepoUnavailable =
    worktreeRepoInfo !== null &&
    (!worktreeRepoInfo.isGitAvailable || worktreeRepoInfo.kind === "not-repository");
  const resolvedQuery = useMemo(() => resolveQueryScope(rawQuery), [rawQuery]);
  const activeScope = resolvedQuery.explicitScope ? resolvedQuery.scope : manualScope;
  const searchQuery = resolvedQuery.query;
  // Query filter + open/recent split of the project page, memoized so typing does not
  // re-filter from scratch on renders unrelated to the list or the query.
  const worktreeProjectPageRows = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
    const filteredProjects = normalizedQuery
      ? worktreeProjects.filter((project) =>
          `${project.label ?? ""} ${project.workspacePath}`
            .toLocaleLowerCase()
            .includes(normalizedQuery),
        )
      : worktreeProjects;
    return {
      openProjects: filteredProjects.filter((project) => project.isOpen),
      recentProjectsRows: filteredProjects.filter((project) => !project.isOpen),
      isEmpty: filteredProjects.length === 0,
    };
  }, [worktreeProjects, searchQuery]);
  const worktreeBranchRows = useMemo(() => {
    if (!worktreeSetupPageActive || !worktreeBranchesResult) {
      return [];
    }
    return worktreeBranchesResult.branches.filter((branch) =>
      matchesGitBranchSearch(branch.name, searchQuery),
    );
  }, [searchQuery, worktreeBranchesResult, worktreeSetupPageActive]);
  const hasSearchQuery = searchQuery.trim().length > 0;
  const searchConversations =
    open && hasSearchQuery && (activeScope === "all" || activeScope === "conversations");
  const searchFiles = open && hasSearchQuery && (activeScope === "all" || activeScope === "files");
  const searchWorkspaceTabs = useMemo(
    () => (searchConversations ? effectiveWorkspaceTabs : []),
    [effectiveWorkspaceTabs, searchConversations],
  );
  const currentWorkspaceTabs = useMemo(
    () =>
      effectiveWorkspaceTabs.filter(
        (tab) => (tab.workspaceIdentity?.trim() || tab.workspacePath) === workspaceKey,
      ),
    [effectiveWorkspaceTabs, workspaceKey],
  );
  const recentTaskWorkspaceTabs = useMemo(
    () => (open && !hasSearchQuery ? currentWorkspaceTabs : []),
    [currentWorkspaceTabs, hasSearchQuery, open],
  );
  const taskList = useGlobalTaskList({
    kind: "active",
    workspaceTabs: searchWorkspaceTabs,
    sortBy: "updated",
    searchQuery,
    expanded: false,
    collapsedLimit: COMMAND_CENTER_TASK_RESULT_LIMIT,
  });
  const recentTaskList = useGlobalTaskList({
    kind: "active",
    workspaceTabs: recentTaskWorkspaceTabs,
    sortBy: "updated",
    searchQuery: "",
    expanded: false,
    collapsedLimit:
      activeScope === "conversations"
        ? COMMAND_CENTER_TASK_RESULT_LIMIT + (activeTaskId ? 1 : 0)
        : COMMAND_CENTER_CONTEXT_SECTION_LIMIT + (activeTaskId ? 1 : 0),
  });
  const workspaceLabelByKey = useMemo(
    () =>
      new Map(
        effectiveWorkspaceTabs.map((tab) => [
          tab.workspaceIdentity?.trim() || tab.workspacePath,
          tab.label,
        ]),
      ),
    [effectiveWorkspaceTabs],
  );
  const commandOptions = useMemo(
    () =>
      effectiveCommands
        .map((command) => ({
          command,
          title: intl.formatMessage({ id: command.titleId }),
        }))
        .filter(({ command, title }) => matchesCommand(command, title, searchQuery)),
    [effectiveCommands, intl, searchQuery],
  );
  const commandOptionsBySection = useMemo(
    () =>
      QUICK_PICK_SECTION_ORDER.map((sectionId) => ({
        sectionId,
        commands: commandOptions.filter(({ command }) => command.sectionId === sectionId),
      })).filter((section) => section.commands.length > 0),
    [commandOptions],
  );
  const conversationRows = useMemo(
    () => buildTaskResultRows({ tasks: taskList.items, query: searchQuery }),
    [searchQuery, taskList.items],
  );
  const fileRows = useMemo(
    () => filterWorkspaceFileEntries(workspaceFiles, searchQuery),
    [searchQuery, workspaceFiles],
  );
  const recentChangeRows = useMemo(
    () => [...(effectiveActiveTaskChangeSummary?.files ?? [])].sort(compareRecentChangedFiles),
    [effectiveActiveTaskChangeSummary],
  );
  const recentChangePreviewRows = useMemo(
    () => recentChangeRows.slice(0, COMMAND_CENTER_CONTEXT_SECTION_LIMIT),
    [recentChangeRows],
  );
  const recentTaskRows = useMemo(
    () => recentTaskList.items.filter((task) => task.taskId !== activeTaskId),
    [activeTaskId, recentTaskList.items],
  );
  const recentTaskPreviewRows = useMemo(
    () => recentTaskRows.slice(0, COMMAND_CENTER_CONTEXT_SECTION_LIMIT),
    [recentTaskRows],
  );
  useEffect(() => {
    if (open) {
      setHistoryEntries(readCommandCenterSearchHistory(workspaceKey));
      return;
    }

    setRawQuery("");
    setManualScope("all");
    setExpandedSections(new Set());
    setHistoryExpanded(false);
    setPageStack(createCommandCenterPageStack());
    // 关闭面板即退出 worktree flow：项目、表单与错误状态全部复位（无全局 store）。
    setWorktreeProject(null);
    setWorktreeDestination("worktree");
    setWorktreeBaseBranch(null);
    setWorktreeBranchName("");
    setWorktreeBranchesResult(null);
    setWorktreeRepoInfo(null);
    setWorktreeDataLoading(false);
    setWorktreeDataError(null);
    setWorktreeStartBusy(false);
    setWorktreeIssueMessage(null);
    setWorktreeRecoveryPath(null);
    // An in-flight Start result must not reopen/switch anything after dismissal.
    worktreeStartAttemptRef.current += 1;
  }, [open, workspaceKey]);

  const setupWorkspacePath = worktreeProject?.workspacePath ?? null;
  useEffect(() => {
    if (!worktreeSetupPageActive || !setupWorkspacePath) {
      return;
    }

    // 进入 setup 页时读取仓库信息与本地分支；WT-03（非仓库/Git 不可用）来自 repoInfo，
    // 分支列表喂 base-branch 选择与 branch-name 客户端预校验。
    let cancelled = false;
    setWorktreeDataLoading(true);
    setWorktreeDataError(null);
    Promise.all([
      baseServices.gitService.getWorkspaceRepositoryInfo({ workspacePath: setupWorkspacePath }),
      baseServices.gitService.getLocalBranches({ workspacePath: setupWorkspacePath }),
    ])
      .then(
        ([repoInfo, branchesResult]) => {
          if (cancelled) {
            return;
          }

          // ?? null：测试替身可能 resolve undefined；与“尚未加载”同态处理。
          setWorktreeRepoInfo(repoInfo ?? null);
          setWorktreeBranchesResult(branchesResult ?? null);
        },
        (error: unknown) => {
          if (!cancelled) {
            setWorktreeDataError(getErrorMessage(error));
          }
        },
      )
      .finally(() => {
        if (!cancelled) {
          setWorktreeDataLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [baseServices.gitService, setupWorkspacePath, worktreeSetupPageActive]);

  useEffect(() => {
    setExpandedSections(new Set());
  }, [activeScope, searchQuery]);

  useEffect(() => {
    setWorkspaceFiles([]);
    setWorkspaceFilesError(null);
    setWorkspaceFilesLoading(false);
    setLoadedWorkspaceKey(null);
  }, [workspaceKey]);

  useEffect(() => {
    if (!searchFiles || loadedWorkspaceKey === workspaceKey) {
      return;
    }

    let cancelled = false;
    setWorkspaceFilesLoading(true);
    setWorkspaceFilesError(null);
    void fetchWorkspaceFileEntriesPacked(fileService, workspaceAbsPath)
      .then((result) => {
        // Host returns a columnar packed string (avoiding structured cloning large arrays); unpack it once here.
        const entries = unpackWorkspaceFileEntries(result, workspaceAbsPath);
        if (cancelled) {
          return;
        }

        setWorkspaceFiles(entries);
        setLoadedWorkspaceKey(workspaceKey);
      })
      .catch((error) => {
        if (!cancelled) {
          setWorkspaceFilesError(String(error));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setWorkspaceFilesLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [fileService, loadedWorkspaceKey, searchFiles, workspaceAbsPath, workspaceKey]);

  const rememberSearch = useCallback(
    (scope: CommandCenterSearchScope = activeScope) => {
      if (!hasSearchQuery) {
        return;
      }

      setHistoryEntries(
        pushCommandCenterSearchHistory({
          workspaceKey,
          query: searchQuery,
          scope,
        }),
      );
    },
    [activeScope, hasSearchQuery, searchQuery, workspaceKey],
  );

  const closeDialog = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  const runCommand = useCallback(
    (command: QuickPickCommand) => {
      rememberSearch("commands");
      if (command.page) {
        // Page-stack commands open a sub-page instead of running and closing; per-page query memory is managed by the stack helpers.
        const transition = pushCommandCenterPage(
          pageStack,
          {
            id: command.page.id,
            placeholderId: command.page.placeholderId,
            commandId: command.id,
          },
          rawQuery,
        );
        setPageStack(transition.stack);
        setRawQuery(transition.query);
        searchInputRef.current?.focus();
        return;
      }

      closeDialog();
      void Promise.resolve(command.run?.()).catch((error) => {
        logger.error("[CommandCenter] 命令执行失败", {
          commandId: command.id,
          error,
        });
        toast(
          intl.formatMessage(
            { id: "quickPick.commandFailed" },
            {
              error: error instanceof Error ? error.message : String(error),
            },
          ),
        );
      });
    },
    [closeDialog, intl, pageStack, rawQuery, rememberSearch],
  );

  const popPage = useCallback(() => {
    const transition = popCommandCenterPage(pageStack, rawQuery);
    setPageStack(transition.stack);
    setRawQuery(transition.query);
    searchInputRef.current?.focus();
  }, [pageStack, rawQuery]);

  const selectPageValue = useCallback(
    (valueList: QuickPickValueList, value: string) => {
      // Applying a value-list selection returns to the palette root and keeps the dialog open.
      const transition = resetCommandCenterPageStack(pageStack, rawQuery);
      setPageStack(transition.stack);
      setRawQuery(transition.query);
      searchInputRef.current?.focus();
      try {
        valueList.onSelect(value);
      } catch (error) {
        logger.error("[CommandCenter] 页面选项执行失败", {
          value,
          error,
        });
        toast(
          intl.formatMessage(
            { id: "quickPick.commandFailed" },
            {
              error: error instanceof Error ? error.message : String(error),
            },
          ),
        );
      }
    },
    [intl, pageStack, rawQuery],
  );

  const selectWorktreeProject = useCallback(
    (project: WorktreeTaskProject) => {
      const sameProject =
        worktreeProject !== null &&
        getWorkspaceIdentityKey(worktreeProject) === getWorkspaceIdentityKey(project);
      if (!sameProject) {
        // 换项目才重置表单；同一项目返回后再进入保留已输入内容（CC-01）。
        setWorktreeDestination("worktree");
        setWorktreeBaseBranch(null);
        setWorktreeBranchName("");
        setWorktreeBranchesResult(null);
        setWorktreeRepoInfo(null);
        setWorktreeDataError(null);
      }

      setWorktreeIssueMessage(null);
      setWorktreeRecoveryPath(null);
      setWorktreeProject(project);
      const transition = pushCommandCenterPage(
        pageStack,
        {
          id: NEW_TASK_SETUP_PAGE_ID,
          placeholderId: "commandCenter.placeholder.newTaskSetup",
          commandId: NEW_TASK_WORKTREE_COMMAND_ID,
        },
        rawQuery,
      );
      setPageStack(transition.stack);
      setRawQuery(transition.query);
      searchInputRef.current?.focus();
    },
    [pageStack, rawQuery, worktreeProject],
  );

  /** Open a workspace + draft via the App contract; WT-04 keeps the created path recoverable. */
  const openTaskWorkspace = useCallback(
    (targetWorkspacePath: string, targetWorkspaceIdentity?: string) => {
      try {
        onCreateTaskInWorkspace(targetWorkspacePath, targetWorkspaceIdentity);
      } catch (error) {
        logger.error("[CommandCenter] 打开 worktree workspace 失败", {
          targetWorkspacePath,
          error: getErrorMessage(error),
        });
        toast(
          intl.formatMessage(
            { id: "commandCenter.worktree.openFailed" },
            { path: targetWorkspacePath },
          ),
          {
            durationMs: 10_000,
            actionLabel: intl.formatMessage({ id: "commandCenter.worktree.openExisting" }),
            onAction: () => onCreateTaskInWorkspace(targetWorkspacePath),
          },
        );
      }
    },
    [intl, onCreateTaskInWorkspace],
  );

  const startWorktreeTask = useCallback(async () => {
    const project = worktreeProject;
    if (!project || worktreeStartBusy) {
      return;
    }

    if (worktreeDestination === "checkout") {
      closeDialog();
      openTaskWorkspace(project.workspacePath, project.workspaceIdentity);
      return;
    }

    const branchName = composedWorktreeBranchName;
    const targetPath = computeWorktreeTargetPath(
      project.workspacePath,
      branchName,
      worktreeEffectiveLocation,
    );
    if (!branchName || !targetPath || worktreeBranchNameIssue || worktreeCustomLocationInvalid) {
      return;
    }

    setWorktreeStartBusy(true);
    setWorktreeIssueMessage(null);
    setWorktreeRecoveryPath(null);
    // A new Start invalidates any previous in-flight attempt; dialog close does the same.
    const attempt = ++worktreeStartAttemptRef.current;
    try {
      // 创建编排（请求、issue 映射、target-path-exists 恢复）与 empty-state 发送拦截共用。
      const outcome = await executeWorktreeCreation({
        gitService: baseServices.gitService,
        workspacePath: project.workspacePath,
        branchName,
        baseBranch: effectiveWorktreeBaseBranch || undefined,
        targetPath,
        formatMessage: (id, values) => intl.formatMessage({ id }, values),
      });
      if (worktreeStartAttemptRef.current !== attempt) {
        // The palette was closed (or another Start began) while the request was in flight:
        // do not reopen it, switch the workspace, or write into the reset flow state.
        return;
      }
      if (outcome.kind === "created") {
        logger.info("[CommandCenter] worktree 创建成功", {
          workspacePath: project.workspacePath,
          branchName,
          targetPath: outcome.worktreePath,
        });
        closeDialog();
        openTaskWorkspace(outcome.worktreePath);
        return;
      }
      if (outcome.kind === "existing-worktree") {
        setWorktreeIssueMessage(outcome.message);
        setWorktreeRecoveryPath(outcome.worktreePath);
        return;
      }
      if (outcome.errorDetail !== null) {
        logger.warn("[CommandCenter] 创建 worktree 请求失败", {
          workspacePath: project.workspacePath,
          branchName,
          error: outcome.errorDetail,
        });
      } else {
        logger.warn("[CommandCenter] 创建 worktree 被拒绝", {
          workspacePath: project.workspacePath,
          branchName,
          issues: outcome.issueCodes,
        });
      }
      setWorktreeIssueMessage(outcome.message);
    } finally {
      setWorktreeStartBusy(false);
    }
  }, [
    baseServices.gitService,
    closeDialog,
    composedWorktreeBranchName,
    effectiveWorktreeBaseBranch,
    intl,
    openTaskWorkspace,
    worktreeBranchNameIssue,
    worktreeCustomLocationInvalid,
    worktreeDestination,
    worktreeEffectiveLocation,
    worktreeProject,
    worktreeStartBusy,
  ]);

  const canStartWorktreeTask = useMemo(() => {
    if (!worktreeSetupPageActive || worktreeStartBusy) {
      return false;
    }
    if (worktreeDataError || worktreeRepoUnavailable) {
      return false;
    }
    if (worktreeDestination === "checkout") {
      return true;
    }
    return (
      !worktreeDataLoading &&
      worktreeBranchesResult !== null &&
      trimmedWorktreeBranchName.length > 0 &&
      worktreeBranchNameIssue === null &&
      !worktreeCustomLocationInvalid &&
      !worktreeGlobalLocationUnavailable
    );
  }, [
    trimmedWorktreeBranchName,
    worktreeBranchNameIssue,
    worktreeBranchesResult,
    worktreeCustomLocationInvalid,
    worktreeDataError,
    worktreeDataLoading,
    worktreeDestination,
    worktreeGlobalLocationUnavailable,
    worktreeRepoUnavailable,
    worktreeSetupPageActive,
    worktreeStartBusy,
  ]);

  const selectTask = useCallback(
    (row: TaskSearchResultRow) => {
      rememberSearch("conversations");
      onSearchResultHighlightRequest?.({
        taskId: row.task.taskId,
        workspacePath: row.task.workspacePath,
        workspaceIdentity: row.task.workspaceIdentity,
        query: searchQuery,
        snippet: row.searchSnippet?.trim() || row.task.searchSnippet?.trim() || undefined,
        snippetIndex: row.snippetIndex,
      });
      onSelectTask(row.task.workspacePath, row.task.taskId, row.task.workspaceIdentity);
      closeDialog();
    },
    [closeDialog, onSearchResultHighlightRequest, onSelectTask, rememberSearch, searchQuery],
  );

  const selectFile = useCallback(
    (entry: WorkspaceFileEntry) => {
      rememberSearch("files");
      onOpenCodeViewer({
        type: "file",
        title: entry.name,
        path: entry.path,
      });
      closeDialog();
    },
    [closeDialog, onOpenCodeViewer, rememberSearch],
  );

  const selectRecentChange = useCallback(
    (file: TaskChangedFileSummary) => {
      closeDialog();
      const relativePath = toWorkspaceRelativePath(workspaceAbsPath, file.path);
      onOpenCodeViewer({
        type: "file",
        title: getPathLeaf(relativePath) || relativePath,
        path: file.path,
      });
    },
    [closeDialog, onOpenCodeViewer, workspaceAbsPath],
  );

  const selectRecentTask = useCallback(
    (task: ZCodeTaskMeta) => {
      onSelectTask(task.workspacePath, task.taskId, task.workspaceIdentity);
      closeDialog();
    },
    [closeDialog, onSelectTask],
  );

  const setScope = useCallback(
    (scope: CommandCenterSearchScope) => {
      setManualScope(scope);
      if (resolvedQuery.explicitScope) {
        setRawQuery(searchQuery);
      }
    },
    [resolvedQuery.explicitScope, searchQuery],
  );

  const shouldShowCommandSection = activeScope === "all" || activeScope === "commands";
  const shouldShowConversationSection = activeScope === "all" || activeScope === "conversations";
  const shouldShowFileSection = activeScope === "all" || activeScope === "files";
  const showHistory = !activePage && !hasSearchQuery && historyEntries.length > 0;

  const renderMoreRow = (sectionId: CommandCenterSectionId, count: number) => {
    if (expandedSections.has(sectionId) || count <= COMMAND_CENTER_SECTION_LIMIT) {
      return null;
    }

    return (
      <button
        type="button"
        className="mt-0.5 flex min-h-7 w-full items-center gap-1.5 rounded-xl px-2.5 pl-8 text-left text-ui-base text-foreground-subtle hover:bg-menu-hover hover:text-foreground"
        onClick={() => setExpandedSections((current) => new Set(current).add(sectionId))}
      >
        {intl.formatMessage({ id: "commandCenter.moreResults" })}
        <ChevronDownIcon className="size-3.5" />
      </button>
    );
  };

  const renderRecentChangesSection = ({
    rows = recentChangePreviewRows,
    showEmpty = false,
  }: {
    rows?: TaskChangedFileSummary[];
    showEmpty?: boolean;
  } = {}) => {
    if (hasSearchQuery || (rows.length === 0 && !showEmpty)) {
      return null;
    }

    return (
      <CommandGroup heading={intl.formatMessage({ id: "commandCenter.section.recentChanges" })}>
        {rows.length === 0 ? (
          <CommandEmpty className="px-4 py-5 text-foreground-subtle">
            {intl.formatMessage({ id: "commandCenter.empty.recentChanges" })}
          </CommandEmpty>
        ) : null}
        {rows.map((file) => {
          const relativePath = toWorkspaceRelativePath(workspaceAbsPath, file.path);
          const descriptor = resolveFileDisplayDescriptor(file.path);
          return (
            <CommandItem
              key={file.path}
              value={`${relativePath} +${file.added} -${file.removed}`}
              className={quickPickItemClassName}
              onSelect={() => selectRecentChange(file)}
            >
              <FileDisplayIcon src={descriptor.fileIconSrc} size={14} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">{relativePath}</span>
              <CommandShortcut className={quickPickMetadataClassName}>
                <span className="text-diff-added">+{file.added}</span>{" "}
                <span className="text-diff-removed">-{file.removed}</span>
              </CommandShortcut>
            </CommandItem>
          );
        })}
      </CommandGroup>
    );
  };

  const renderRecentTasksSection = ({
    rows = recentTaskPreviewRows,
    showEmpty = false,
  }: {
    rows?: ZCodeTaskMeta[];
    showEmpty?: boolean;
  } = {}) => {
    if (hasSearchQuery || (rows.length === 0 && !showEmpty)) {
      return null;
    }

    return (
      <CommandGroup heading={intl.formatMessage({ id: "commandCenter.section.recentTasks" })}>
        {rows.length === 0 ? (
          <CommandEmpty className="px-4 py-5 text-foreground-subtle">
            {intl.formatMessage({ id: "commandCenter.empty.recentTasks" })}
          </CommandEmpty>
        ) : null}
        {rows.map((task) => {
          const title = getTaskTitle(task, intl.formatMessage({ id: "taskList.untitled" }));
          return (
            <CommandItem
              key={`${task.workspaceIdentity?.trim() || task.workspacePath}:${task.taskId}`}
              value={`${title} ${task.workspacePath}`}
              className={quickPickItemClassName}
              onSelect={() => selectRecentTask(task)}
            >
              <MessageSquareIcon className="size-3.5 text-foreground-subtle" />
              <span className="min-w-0 flex-1 truncate">{title}</span>
              <CommandShortcut className={quickPickMetadataClassName}>
                {formatTaskRelativeTime(task.updatedAt, intl)}
              </CommandShortcut>
            </CommandItem>
          );
        })}
      </CommandGroup>
    );
  };

  const renderCommandSections = () => {
    if (!shouldShowCommandSection || commandOptionsBySection.length === 0) {
      return null;
    }

    return commandOptionsBySection.map((section) => (
      <CommandGroup
        key={section.sectionId}
        heading={intl.formatMessage({
          id: `quickPick.section.${section.sectionId}`,
        })}
      >
        {section.commands.map(({ command, title }) => {
          const Icon = QUICK_PICK_ICON_BY_KIND[command.icon];
          return (
            <CommandItem
              key={command.id}
              value={`${title} ${command.keywords.join(" ")}`}
              disabled={command.disabled}
              className={quickPickItemClassName}
              onSelect={() => runCommand(command)}
            >
              <Icon className="size-3.5 text-foreground-subtle" />
              <span className="min-w-0 flex-1 truncate">
                <HighlightedMatchText text={title} query={searchQuery} />
              </span>
              {command.shortcut ? (
                <CommandShortcut className={quickPickShortcutPillClassName}>
                  {command.shortcut}
                </CommandShortcut>
              ) : null}
            </CommandItem>
          );
        })}
      </CommandGroup>
    ));
  };

  const renderConversationSection = () => {
    if (
      !hasSearchQuery ||
      !shouldShowConversationSection ||
      (!taskList.loading && conversationRows.length === 0)
    ) {
      return null;
    }

    const visibleRows =
      activeScope === "conversations" || expandedSections.has("conversations")
        ? conversationRows
        : conversationRows.slice(0, COMMAND_CENTER_SECTION_LIMIT);
    return (
      <CommandGroup heading={intl.formatMessage({ id: "commandCenter.section.conversations" })}>
        {taskList.loading && conversationRows.length === 0 ? (
          <CommandEmpty className="px-4 py-5 text-foreground-subtle">
            {intl.formatMessage({ id: "taskSearch.loading" })}
          </CommandEmpty>
        ) : null}
        {visibleRows.map((row) => {
          const task = row.task;
          const title = getTaskTitle(task, intl.formatMessage({ id: "taskList.untitled" }));
          const workspaceLabel =
            workspaceLabelByKey.get(task.workspaceIdentity?.trim() || task.workspacePath) ??
            task.workspacePath;
          const searchSnippet = row.searchSnippet?.trim();
          return (
            <CommandItem
              key={row.key}
              value={`${title} ${workspaceLabel} ${searchSnippet ?? ""}`}
              className={quickPickItemClassName}
              onSelect={() => selectTask(row)}
            >
              <MessageSquareIcon className="size-3.5 text-foreground-subtle" />
              <span className="flex min-w-0 flex-1 flex-col justify-center py-0.5">
                <span className="truncate text-ui-base leading-5 font-normal text-foreground">
                  <HighlightedMatchText text={title} query={searchQuery} />
                </span>
                {searchSnippet ? (
                  <span className="min-w-0 truncate text-ui-base leading-4 text-foreground-subtle">
                    <HighlightedMatchText text={searchSnippet} query={searchQuery} />
                  </span>
                ) : null}
              </span>
              <CommandShortcut className={quickPickMetadataClassName}>
                {workspaceLabel}
              </CommandShortcut>
              <CommandCenterConversationTimestamp>
                {formatTaskRelativeTime(task.updatedAt, intl)}
              </CommandCenterConversationTimestamp>
            </CommandItem>
          );
        })}
        {activeScope === "all" ? renderMoreRow("conversations", conversationRows.length) : null}
      </CommandGroup>
    );
  };

  const renderFileSection = () => {
    if (
      !hasSearchQuery ||
      !shouldShowFileSection ||
      (!workspaceFilesLoading && !workspaceFilesError && fileRows.length === 0)
    ) {
      return null;
    }

    const visibleRows =
      activeScope === "files" || expandedSections.has("files")
        ? fileRows
        : fileRows.slice(0, COMMAND_CENTER_SECTION_LIMIT);
    return (
      <CommandGroup heading={intl.formatMessage({ id: "commandCenter.section.files" })}>
        {workspaceFilesLoading && fileRows.length === 0 ? (
          <CommandEmpty className="px-4 py-5 text-foreground-subtle">
            {intl.formatMessage({ id: "sidePane.openFileLoading" })}
          </CommandEmpty>
        ) : workspaceFilesError ? (
          <CommandEmpty className="px-4 py-5 text-destructive">{workspaceFilesError}</CommandEmpty>
        ) : null}
        {visibleRows.map((entry) => {
          const descriptor = resolveFileDisplayDescriptor(entry.path);
          const directory = getWorkspaceFileDirectory(entry);
          return (
            <CommandItem
              key={entry.path}
              value={`${entry.name} ${entry.relativePath}`}
              className={quickPickItemClassName}
              onSelect={() => selectFile(entry)}
            >
              <FileDisplayIcon src={descriptor.fileIconSrc} size={14} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">
                <HighlightedMatchText text={entry.name} query={searchQuery} />
              </span>
              {directory ? (
                <CommandShortcut className={quickPickMetadataClassName}>
                  <HighlightedMatchText text={directory} query={searchQuery} />
                </CommandShortcut>
              ) : null}
            </CommandItem>
          );
        })}
        {activeScope === "all" ? renderMoreRow("files", fileRows.length) : null}
      </CommandGroup>
    );
  };

  const hasAnySearchResults =
    (shouldShowCommandSection && commandOptions.length > 0) ||
    (shouldShowConversationSection && conversationRows.length > 0) ||
    (shouldShowFileSection && fileRows.length > 0);
  const hasSearchStatus =
    taskList.loading ||
    workspaceFilesLoading ||
    (shouldShowFileSection && Boolean(workspaceFilesError));

  const renderWorktreeProjectRow = (project: WorktreeTaskProject) => {
    const label = project.label?.trim() || getPathLeaf(project.workspacePath);
    return (
      <CommandItem
        key={`${project.workspaceIdentity ?? ""}:${project.workspacePath}`}
        value={`${label} ${project.workspacePath}`}
        className={quickPickItemClassName}
        onSelect={() => selectWorktreeProject(project)}
      >
        <FolderIcon className="size-3.5 shrink-0 text-foreground-subtle" />
        <span className="min-w-0 flex-1 truncate">
          <HighlightedMatchText text={label} query={searchQuery} />
        </span>
        {project.isOpen && !project.isActive ? (
          <span className="shrink-0 rounded-sm bg-surface px-1 font-sans text-ui-xs leading-4 text-foreground-subtle">
            {intl.formatMessage({ id: "commandCenter.worktree.alreadyOpen" })}
          </span>
        ) : null}
        <CommandShortcut
          className={cn(quickPickMetadataClassName, "font-mono")}
          title={project.workspacePath}
        >
          <HighlightedMatchText text={project.workspacePath} query={searchQuery} />
        </CommandShortcut>
        {project.isActive ? <CheckIcon className="size-3.5 shrink-0 text-foreground" /> : null}
      </CommandItem>
    );
  };

  const renderWorktreeProjectsSection = () => {
    const { openProjects, recentProjectsRows, isEmpty } = worktreeProjectPageRows;
    return (
      <>
        <CommandGroup heading={intl.formatMessage({ id: "commandCenter.section.openWorkspaces" })}>
          {isEmpty ? (
            <CommandEmpty className="px-4 py-5 text-foreground-subtle">
              {intl.formatMessage({ id: "commandCenter.worktree.noProjects" })}
            </CommandEmpty>
          ) : null}
          {openProjects.map(renderWorktreeProjectRow)}
        </CommandGroup>
        {recentProjectsRows.length > 0 ? (
          <CommandGroup
            heading={intl.formatMessage({ id: "commandCenter.section.recentProjects" })}
          >
            {recentProjectsRows.map(renderWorktreeProjectRow)}
          </CommandGroup>
        ) : null}
      </>
    );
  };

  const renderWorktreeDestinationRow = (
    destination: WorktreeTaskDestination,
    labelId: string,
    descriptionId: string,
    icon: ReactNode,
  ) => (
    <CommandItem
      value={`destination ${destination}`}
      className={quickPickItemClassName}
      disabled={worktreeStartBusy}
      onSelect={() => setWorktreeDestination(destination)}
    >
      {icon}
      <span className="flex min-w-0 flex-1 flex-col justify-center py-0.5">
        <span className="truncate text-ui-base font-normal leading-5 text-foreground">
          {intl.formatMessage({ id: labelId })}
        </span>
        <span className="min-w-0 truncate text-ui-base leading-4 text-foreground-subtle">
          {intl.formatMessage({ id: descriptionId })}
        </span>
      </span>
      {worktreeDestination === destination ? (
        <CheckIcon className="size-3.5 shrink-0 text-foreground" />
      ) : null}
    </CommandItem>
  );

  const renderWorktreeSetupSection = () => {
    if (!worktreeProject) {
      return null;
    }

    const showWorktreeControls = worktreeDestination === "worktree";
    return (
      <div className="flex flex-col gap-3 px-3 py-3">
        <div>
          <p className="px-2.5 pb-1 text-ui-sm font-medium text-foreground-subtle">
            {intl.formatMessage({ id: "commandCenter.worktree.destination" })}
          </p>
          {renderWorktreeDestinationRow(
            "worktree",
            "commandCenter.worktree.destination.worktree",
            "commandCenter.worktree.destination.worktree.description",
            <GitBranchPlusIcon className="size-3.5 shrink-0 text-foreground-subtle" />,
          )}
          {renderWorktreeDestinationRow(
            "checkout",
            "commandCenter.worktree.destination.checkout",
            "commandCenter.worktree.destination.checkout.description",
            <FolderIcon className="size-3.5 shrink-0 text-foreground-subtle" />,
          )}
        </div>
        {showWorktreeControls ? (
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="command-center-worktree-branch-name"
              className="px-2.5 text-ui-sm font-medium text-foreground-subtle"
            >
              {intl.formatMessage({ id: "commandCenter.worktree.branchName" })}
            </label>
            <input
              id="command-center-worktree-branch-name"
              value={worktreeBranchName}
              disabled={worktreeStartBusy}
              autoComplete="off"
              spellCheck={false}
              placeholder={intl.formatMessage({
                id: "commandCenter.worktree.branchName.placeholder",
              })}
              onChange={(event) => setWorktreeBranchName(event.target.value)}
              onKeyDown={(event) => {
                // 在分支名输入框按 Enter 直接提交，而不是触发 cmdk 的高亮项。
                if (event.key === "Enter" && canStartWorktreeTask) {
                  event.preventDefault();
                  void startWorktreeTask();
                }
              }}
              className={cn(
                "h-8 w-full rounded-lg border border-input-border bg-input px-2 font-mono text-ui-base text-foreground outline-none transition-colors",
                "placeholder:font-sans placeholder:text-foreground-subtlest",
                "hover:border-input-border-hover focus:border-input-border-focused focus:bg-input-focused",
                worktreeBranchNameIssue ? "border-destructive" : undefined,
              )}
            />
            {worktreeBranchNameIssue ? (
              <p className="px-2.5 text-ui-sm text-destructive">
                {intl.formatMessage({
                  id:
                    worktreeBranchNameIssue === "branch-already-exists"
                      ? "commandCenter.worktree.branchName.exists"
                      : "commandCenter.worktree.branchName.invalid",
                })}
              </p>
            ) : null}
            {/* WTS-02：有生效 prefix 时预览最终分支名；Start 与校验都用合成后的值。 */}
            {worktreeEffectiveLocation?.prefix && trimmedWorktreeBranchName ? (
              <p className="px-2.5 text-ui-sm text-foreground-subtle">
                {intl.formatMessage(
                  { id: "commandCenter.worktree.branchName.final" },
                  { name: composedWorktreeBranchName },
                )}
              </p>
            ) : null}
          </div>
        ) : null}
        {showWorktreeControls ? (
          <div>
            <p className="px-2.5 pb-1 text-ui-sm font-medium text-foreground-subtle">
              {intl.formatMessage({ id: "commandCenter.worktree.baseBranch" })}
            </p>
            {worktreeDataError ? (
              <CommandEmpty className="px-4 py-3 text-destructive">
                {intl.formatMessage(
                  { id: "commandCenter.worktree.error.requestFailed" },
                  { error: worktreeDataError },
                )}
              </CommandEmpty>
            ) : worktreeDataLoading && !worktreeBranchesResult ? (
              <CommandEmpty className="px-4 py-3 text-foreground-subtle">
                {intl.formatMessage({ id: "commandCenter.worktree.baseBranch.loading" })}
              </CommandEmpty>
            ) : worktreeRepoUnavailable ? (
              <p className="flex items-start gap-2 px-2.5 py-2 text-ui-sm text-foreground-subtle">
                <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-warning" />
                {intl.formatMessage({
                  id: worktreeRepoInfo?.isGitAvailable
                    ? "commandCenter.worktree.error.not-a-repository"
                    : "commandCenter.worktree.error.git-unavailable",
                })}
              </p>
            ) : worktreeBranchRows.length === 0 ? (
              <CommandEmpty className="px-4 py-3 text-foreground-subtle">
                {intl.formatMessage({ id: "commandCenter.worktree.baseBranch.empty" })}
              </CommandEmpty>
            ) : (
              worktreeBranchRows.map((branch) => (
                <CommandItem
                  key={branch.name}
                  value={`base ${branch.name}`}
                  className={quickPickItemClassName}
                  disabled={worktreeStartBusy}
                  onSelect={() => setWorktreeBaseBranch(branch.name)}
                >
                  <span className="min-w-0 flex-1 truncate font-mono">
                    <HighlightedMatchText text={branch.name} query={searchQuery} />
                  </span>
                  {effectiveWorktreeBaseBranch === branch.name ? (
                    <CheckIcon className="size-3.5 shrink-0 text-foreground" />
                  ) : null}
                </CommandItem>
              ))
            )}
          </div>
        ) : null}
        {showWorktreeControls &&
        (worktreeCustomLocationInvalid || worktreeGlobalLocationUnavailable) ? (
          // WTS-01 / Stage F：位置无效（Custom 非绝对路径，或 global 目录不可用）时错误停留在
          // target path 旁，预览隐藏、Start 阻塞。
          <div className="px-2.5">
            <p className="text-ui-sm font-medium text-foreground-subtle">
              {intl.formatMessage({ id: "commandCenter.worktree.targetPath" })}
            </p>
            <p className="text-ui-sm text-destructive">
              {intl.formatMessage({
                id: worktreeCustomLocationInvalid
                  ? "commandCenter.worktree.error.custom-location-invalid"
                  : "commandCenter.worktree.error.global-location-unavailable",
              })}
            </p>
          </div>
        ) : showWorktreeControls && worktreeTargetPathPreviewDisplay ? (
          <div className="px-2.5">
            <p className="text-ui-sm font-medium text-foreground-subtle">
              {intl.formatMessage({ id: "commandCenter.worktree.targetPath" })}
            </p>
            <p
              className="truncate font-mono text-ui-sm text-foreground-subtle"
              title={worktreeTargetPathPreview ?? undefined}
            >
              {worktreeTargetPathPreviewDisplay}
            </p>
          </div>
        ) : null}
        {worktreeRepoUnavailable && worktreeDestination === "checkout" ? (
          <p className="flex items-start gap-2 px-2.5 py-1 text-ui-sm text-foreground-subtle">
            <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-warning" />
            {intl.formatMessage({
              id: worktreeRepoInfo?.isGitAvailable
                ? "commandCenter.worktree.error.not-a-repository"
                : "commandCenter.worktree.error.git-unavailable",
            })}
          </p>
        ) : null}
        {worktreeIssueMessage ? (
          <div role="alert" className="flex flex-col gap-1.5 px-2.5">
            <p className="text-ui-sm text-destructive">{worktreeIssueMessage}</p>
            {worktreeRecoveryPath ? (
              <div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={worktreeStartBusy}
                  onClick={() => {
                    // 恢复入口同样要先关闭面板再走打开契约。
                    closeDialog();
                    openTaskWorkspace(worktreeRecoveryPath);
                  }}
                >
                  {intl.formatMessage({ id: "commandCenter.worktree.openExisting" })}
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="flex items-center justify-end">
          <Button disabled={!canStartWorktreeTask} onClick={() => void startWorktreeTask()}>
            {intl.formatMessage({
              id: worktreeStartBusy
                ? "commandCenter.worktree.starting"
                : "commandCenter.worktree.start",
            })}
          </Button>
        </div>
      </div>
    );
  };

  const renderActivePageSection = () => {
    if (!activePage) {
      return null;
    }
    if (activePage.id === NEW_TASK_PROJECT_PAGE_ID) {
      return renderWorktreeProjectsSection();
    }
    if (activePage.id === NEW_TASK_SETUP_PAGE_ID) {
      return renderWorktreeSetupSection();
    }
    if (!activePageCommand?.valueList) {
      return null;
    }

    const valueList = activePageCommand.valueList;
    const options = valueList.options
      .map((option: QuickPickValueListOption) => ({
        option,
        label: intl.formatMessage({ id: option.labelId }),
      }))
      .filter(({ option, label }) => matchesCommand(option, label, searchQuery));
    return (
      <CommandGroup heading={intl.formatMessage({ id: activePageCommand.titleId })}>
        {options.length === 0 ? (
          <CommandEmpty className="px-4 py-5 text-foreground-subtle">
            {intl.formatMessage({ id: "commandCenter.noResults" })}
          </CommandEmpty>
        ) : null}
        {options.map(({ option, label }) => (
          <CommandItem
            key={option.value}
            value={`${label} ${option.keywords.join(" ")}`}
            className={quickPickItemClassName}
            onSelect={() => selectPageValue(valueList, option.value)}
          >
            {option.swatchColor !== undefined ? (
              // Swatch color is palette preview content (THEME_PALETTES accent data), not UI chrome tokening.
              <span
                aria-hidden="true"
                className="size-3.5 shrink-0 rounded-full border border-border"
                style={option.swatchColor ? { backgroundColor: option.swatchColor } : undefined}
              />
            ) : null}
            <span className="min-w-0 flex-1 truncate">
              <HighlightedMatchText text={label} query={searchQuery} />
            </span>
            {valueList.current === option.value ? (
              <CheckIcon className="size-3.5 shrink-0 text-foreground" />
            ) : null}
          </CommandItem>
        ))}
      </CommandGroup>
    );
  };

  const renderDefaultSections = () => {
    switch (activeScope) {
      case "commands":
        return renderCommandSections();
      case "conversations":
        return renderRecentTasksSection({ rows: recentTaskRows, showEmpty: true });
      case "files":
        return renderRecentChangesSection({ rows: recentChangeRows, showEmpty: true });
      default:
        return (
          <>
            {renderRecentChangesSection()}
            {renderRecentTasksSection()}
            {renderCommandSections()}
          </>
        );
    }
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={intl.formatMessage({ id: "quickPick.title" })}
      description={intl.formatMessage({ id: "quickPick.description" })}
      className={commandCenterDialogClassName}
    >
      <Command shouldFilter={false} loop className={quickPickCommandClassName}>
        <div className="border-b border-border px-2 pt-2 pb-2">
          <div className="flex h-8 items-center gap-2 rounded-full border border-input-border bg-input px-2.5 transition-colors hover:border-input-border-hover focus-within:border-input-border-focused focus-within:bg-input-focused">
            {activePage ? (
              <button
                type="button"
                aria-label={intl.formatMessage({ id: "quickPick.command.goBack" })}
                title={intl.formatMessage({ id: "quickPick.command.goBack" })}
                onClick={popPage}
                className="inline-grid size-5 shrink-0 place-items-center rounded-md text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
              >
                <ArrowLeftIcon className="size-3.5" />
              </button>
            ) : null}
            <SearchIcon className="size-4 shrink-0 text-foreground-subtlest" />
            <CommandPrimitive.Input
              ref={searchInputRef}
              value={rawQuery}
              onValueChange={setRawQuery}
              onKeyDown={(event) => {
                // Keyboard back navigation while a sub-page is active; with text in the input ArrowLeft keeps moving the caret.
                if (event.key === "ArrowLeft" && activePage && rawQuery === "") {
                  event.preventDefault();
                  popPage();
                }
              }}
              placeholder={
                activePage
                  ? intl.formatMessage({ id: activePage.placeholderId })
                  : intl.formatMessage({ id: "commandCenter.placeholder" })
              }
              className="min-w-0 flex-1 bg-transparent text-ui-base leading-5 text-foreground outline-none placeholder:text-foreground-subtlest"
            />
          </div>
          {activePage ? null : (
            <div
              role="tablist"
              aria-label={intl.formatMessage({ id: "commandCenter.scopeTabs" })}
              className="-mx-1 mt-1.5 flex gap-1 overflow-x-auto px-1 pb-0.5 scrollbar-hide"
            >
              <CommandCenterScopeButton
                active={activeScope === "all"}
                label={intl.formatMessage({ id: "commandCenter.scope.all" })}
                onClick={() => setScope("all")}
              >
                <ListIcon className="size-3" />
              </CommandCenterScopeButton>
              <CommandCenterScopeButton
                active={activeScope === "commands"}
                label={intl.formatMessage({ id: "commandCenter.scope.commands" })}
                onClick={() => setScope("commands")}
              >
                <RocketIcon className="size-3" />
              </CommandCenterScopeButton>
              <CommandCenterScopeButton
                active={activeScope === "conversations"}
                label={intl.formatMessage({ id: "commandCenter.scope.conversations" })}
                onClick={() => setScope("conversations")}
              >
                <MessagesSquareIcon className="size-3" />
              </CommandCenterScopeButton>
              <CommandCenterScopeButton
                active={activeScope === "files"}
                label={intl.formatMessage({ id: "commandCenter.scope.files" })}
                onClick={() => setScope("files")}
              >
                <FileIcon className="size-3" />
              </CommandCenterScopeButton>
            </div>
          )}
        </div>
        <CommandList className={commandCenterListClassName}>
          {activePage ? (
            renderActivePageSection()
          ) : !hasSearchQuery ? (
            renderDefaultSections()
          ) : hasAnySearchResults || hasSearchStatus ? (
            <>
              {renderCommandSections()}
              {renderConversationSection()}
              {renderFileSection()}
            </>
          ) : (
            <CommandEmpty className="px-4 py-5 text-foreground-subtle">
              {intl.formatMessage({ id: "commandCenter.noResults" })}
            </CommandEmpty>
          )}
        </CommandList>
        {showHistory ? (
          <CommandCenterSearchHistory
            entries={historyEntries}
            expanded={historyExpanded}
            onToggleExpanded={() => setHistoryExpanded((value) => !value)}
            onPickEntry={(entry) => {
              const prefix = scopeToPrefix(entry.scope);
              setManualScope(entry.scope);
              setRawQuery(prefix ? `${prefix}${entry.query}` : entry.query);
            }}
            onClear={() => {
              clearCommandCenterSearchHistory(workspaceKey);
              setHistoryEntries([]);
            }}
            historyLabel={intl.formatMessage({ id: "commandCenter.history" })}
            clearLabel={intl.formatMessage({ id: "commandCenter.clearHistory" })}
            expandLabel={intl.formatMessage({ id: "commandCenter.expandHistory" })}
            collapseLabel={intl.formatMessage({ id: "commandCenter.collapseHistory" })}
          />
        ) : null}
      </Command>
    </CommandDialog>
  );
});
