import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, Search } from "lucide-react";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command.js";
import { useGlobalTaskList } from "@/hooks/useGlobalTaskList.js";
import {
  buildLocalTaskSearchScopes,
  buildTaskSearchProjectNames,
  getTaskSearchTaskKey,
  type TaskSearchScope,
} from "@/project-sidebar/taskSearchScope.js";
import { useOptionalProjectDirectory } from "@/project-sidebar/ProjectDirectoryProvider.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { formatCommandShortcutLabel, matchesPrimaryShortcut } from "@/lib/keyboardShortcuts.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";
import { HighlightedMatchText } from "@/quickpick/HighlightedMatchText.js";
import {
  quickPickCommandClassName,
  quickPickDialogClassName,
  quickPickInputClassName,
  quickPickItemClassName,
  quickPickListClassName,
  quickPickMetadataClassName,
  quickPickShortcutPillClassName,
} from "@/quickpick/quickPickStyles.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";

const TASK_SEARCH_RESULT_LIMIT = 9;
const TASK_SEARCH_GROUP_COLLAPSED_SNIPPET_LIMIT = 3;
// Each query is a host RPC that scans the whole tasks index, so only the query that has stopped
// changing for this long is sent to useGlobalTaskList. The input itself always updates instantly.
const TASK_SEARCH_QUERY_SETTLE_MS = 200;

type TaskSearchResultItem = ZCodeTaskMeta & {
  searchSnippet?: string;
  searchSnippets?: string[];
};
type TaskSearchResultRow = {
  key: string;
  task: TaskSearchResultItem;
  searchSnippet?: string;
  snippetIndex?: number;
  kind: "task" | "snippet" | "expand";
  hiddenSnippetCount?: number;
  showTaskHeader: boolean;
};

function getTaskTitle(task: ZCodeTaskMeta, untitledLabel: string): string {
  return task.title.trim() || untitledLabel;
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

export function TaskSearchDialog({
  workspaceTabs,
  onSelectTask,
  onSelectSearchResult,
  openRequestId = 0,
}: {
  workspaceTabs: WorkspaceTabState[];
  onSelectTask: (
    targetWorkspacePath: string,
    taskId: string,
    targetWorkspaceIdentity?: string,
  ) => void;
  onSelectSearchResult?: (
    task: TaskSearchResultItem,
    context: { query: string; searchSnippet?: string; snippetIndex?: number },
  ) => void;
  openRequestId?: number;
}) {
  const { intl } = useZCodeIntl();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [expandedTaskKeys, setExpandedTaskKeys] = useState<Set<string>>(() => new Set());
  const shortcutLabel = formatCommandShortcutLabel("G");
  const trimmedQuery = query.trim();
  const [settledQuery, setSettledQuery] = useState("");
  const projectTree = useOptionalProjectDirectory()?.tree;
  // Search covers every local project of the sidebar, not only the open tabs (specs/task-search-debounce.md, Search scope).
  const localSearchScopeKey = useMemo(
    () =>
      JSON.stringify(
        buildLocalTaskSearchScopes({
          tree: open ? projectTree : null,
          openTabs: open ? workspaceTabs : [],
        }),
      ),
    [open, projectTree, workspaceTabs],
  );
  // Keyed by content: a new tree object with the same scope does not change the query key.
  const searchWorkspaceTabs = useMemo<TaskSearchScope[]>(
    () => JSON.parse(localSearchScopeKey) as TaskSearchScope[],
    [localSearchScopeKey],
  );
  const projectNameByTaskKey = useMemo(
    () => buildTaskSearchProjectNames(projectTree),
    [projectTree],
  );
  const taskList = useGlobalTaskList({
    kind: "active",
    // Fix rationale: the search dialog component stays mounted in the App, but does not need
    // recent/search results while closed. Passing an empty workspace reuses useGlobalTaskList's
    // empty-state path, avoiding an extra listTaskList subscription plus workspace event
    // subscriptions while idle, reducing renderer/RPC pressure during startup.
    workspaceTabs: searchWorkspaceTabs,
    sortBy: "updated",
    searchQuery: settledQuery,
    expanded: false,
    collapsedLimit: TASK_SEARCH_RESULT_LIMIT,
  });
  const workspaceLabelByKey = useMemo(
    () =>
      new Map(
        workspaceTabs.map((tab) => [tab.workspaceIdentity?.trim() || tab.workspacePath, tab.label]),
      ),
    [workspaceTabs],
  );
  // Mode follows the typed query, not the settled one: the list is still the previous result during the
  // settle window, and deriving the mode from settledQuery would flip the empty-state wording and snippets to recents.
  const hasQuery = trimmedQuery.length > 0;
  const getTaskResultKey = useCallback(
    (task: Pick<TaskSearchResultItem, "workspaceIdentity" | "workspacePath" | "taskId">) =>
      `${task.workspaceIdentity?.trim() || task.workspacePath}:${task.taskId}`,
    [],
  );
  const visibleResults = useMemo<TaskSearchResultRow[]>(() => {
    const rows: TaskSearchResultRow[] = [];
    const taskByKey = new Map<string, TaskSearchResultItem>();
    for (const task of taskList.items) {
      const taskKey = getTaskResultKey(task);
      const existingTask = taskByKey.get(taskKey);
      if (!existingTask) {
        taskByKey.set(taskKey, task);
        continue;
      }

      // Bugfix: search results can bring in the same task from the query cache and the
      // cross-workspace aggregation path. Merge by session key first, then dedupe by snippet
      // text, so the list shows no duplicate titles or summaries.
      taskByKey.set(taskKey, {
        ...existingTask,
        searchSnippets: [
          ...getUniqueTaskSearchSnippets(existingTask),
          ...getUniqueTaskSearchSnippets(task),
        ],
      });
    }

    for (const task of taskByKey.values()) {
      const taskKey = getTaskResultKey(task);
      const snippets = hasQuery ? getUniqueTaskSearchSnippets(task) : [];
      if (snippets.length === 0) {
        rows.push({
          key: taskKey,
          task,
          kind: "task",
          showTaskHeader: true,
        });
      } else {
        const isExpanded = expandedTaskKeys.has(taskKey);
        const visibleSnippets = isExpanded
          ? snippets
          : snippets.slice(0, TASK_SEARCH_GROUP_COLLAPSED_SNIPPET_LIMIT);
        visibleSnippets.forEach((snippet, snippetIndex) => {
          rows.push({
            key: `${taskKey}:${snippetIndex}`,
            task,
            searchSnippet: snippet,
            snippetIndex,
            kind: "snippet",
            showTaskHeader: snippetIndex === 0,
          });
        });
        if (!isExpanded && snippets.length > TASK_SEARCH_GROUP_COLLAPSED_SNIPPET_LIMIT) {
          rows.push({
            key: `${taskKey}:expand`,
            task,
            kind: "expand",
            hiddenSnippetCount: snippets.length - TASK_SEARCH_GROUP_COLLAPSED_SNIPPET_LIMIT,
            showTaskHeader: false,
          });
        }
      }

      if (!expandedTaskKeys.has(taskKey) && rows.length >= TASK_SEARCH_RESULT_LIMIT) {
        break;
      }
    }

    return expandedTaskKeys.size > 0 ? rows : rows.slice(0, TASK_SEARCH_RESULT_LIMIT);
  }, [expandedTaskKeys, getTaskResultKey, hasQuery, taskList.items]);
  const emptyLabel = taskList.loading
    ? intl.formatMessage({ id: "taskSearch.loading" })
    : intl.formatMessage({ id: hasQuery ? "taskSearch.noResults" : "taskSearch.noRecent" });

  const selectTask = useCallback(
    (row: TaskSearchResultRow) => {
      if (row.kind === "expand") {
        setExpandedTaskKeys((current) => new Set(current).add(getTaskResultKey(row.task)));
        return;
      }

      onSelectSearchResult?.(row.task, {
        query: settledQuery,
        searchSnippet: row.searchSnippet?.trim() || row.task.searchSnippet?.trim() || undefined,
        snippetIndex: row.snippetIndex,
      });
      onSelectTask(row.task.workspacePath, row.task.taskId, row.task.workspaceIdentity);
      setOpen(false);
      setQuery("");
    },
    [getTaskResultKey, onSelectSearchResult, onSelectTask, settledQuery],
  );
  const selectTaskHeader = useCallback(
    (task: TaskSearchResultItem) => {
      onSelectTask(task.workspacePath, task.taskId, task.workspaceIdentity);
      setOpen(false);
      setQuery("");
    },
    [onSelectTask],
  );

  useEffect(() => {
    if (!trimmedQuery) {
      // Clearing the input empties the list at once; the previous settled query must not linger.
      setSettledQuery("");
      return;
    }

    const timer = setTimeout(() => setSettledQuery(trimmedQuery), TASK_SEARCH_QUERY_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [trimmedQuery]);

  useEffect(() => {
    if (!open || !settledQuery) {
      return;
    }

    // Bugfix: after body-text search shipped, stale empty search results may already be marked
    // fresh in the task query cache. Refresh once when a query is typed so the service layer's
    // new body index and on-demand backfill take effect.
    void taskList.refresh();
  }, [open, taskList.refresh, settledQuery]);

  useEffect(() => {
    setExpandedTaskKeys(new Set());
  }, [settledQuery]);

  useEffect(() => {
    if (!open || !settledQuery) {
      return;
    }

    const snippetCount = visibleResults.filter((result) => result.searchSnippet?.trim()).length;
    logger.info(
      `[TaskSearchDialog] 搜索结果 query=${JSON.stringify(settledQuery)} items=${visibleResults.length} snippets=${snippetCount} firstSnippet=${JSON.stringify(visibleResults[0]?.searchSnippet?.slice(0, 80) ?? "")}`,
    );
  }, [open, settledQuery, visibleResults]);

  useEffect(() => {
    if (openRequestId <= 0) {
      return;
    }

    setOpen(true);
  }, [openRequestId]);

  useEffect(() => {
    if (!open) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      const index = visibleResults.findIndex((_, itemIndex) =>
        matchesPrimaryShortcut(event, String(itemIndex + 1)),
      );
      if (index < 0) {
        return;
      }

      event.preventDefault();
      const result = visibleResults[index];
      if (result) {
        selectTask(result);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, selectTask, visibleResults]);

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        onClick={() => setOpen(true)}
        data-icon="inline-start"
        size="lg"
        className="w-full justify-start gap-2 text-foreground hover:bg-surface-hover hover:text-foreground"
      >
        <Search className="size-4" />
        <span className="min-w-0 flex-1 truncate text-left">
          {intl.formatMessage({ id: "taskSearch.button" })}
        </span>
        <span className="ml-auto shrink-0 text-ui-xs font-normal text-foreground-subtlest">
          {shortcutLabel}
        </span>
      </Button>

      <CommandDialog
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (!nextOpen) {
            setQuery("");
            setExpandedTaskKeys(new Set());
          }
        }}
        title={intl.formatMessage({ id: "taskSearch.title" })}
        description={intl.formatMessage({ id: "taskSearch.description" })}
        className={quickPickDialogClassName}
      >
        <Command shouldFilter={false} className={quickPickCommandClassName}>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={intl.formatMessage({ id: "taskSearch.placeholder" })}
            className={quickPickInputClassName}
          />
          <CommandList className={quickPickListClassName}>
            <CommandGroup heading={intl.formatMessage({ id: "taskSearch.recent" })}>
              {visibleResults.length === 0 ? (
                <CommandEmpty className="px-4 py-5 text-foreground-subtle">
                  {emptyLabel}
                </CommandEmpty>
              ) : null}
              {visibleResults.map((result, index) => {
                const task = result.task;
                const title = getTaskTitle(task, intl.formatMessage({ id: "taskList.untitled" }));
                const workspaceLabel =
                  projectNameByTaskKey.get(getTaskSearchTaskKey(task)) ??
                  workspaceLabelByKey.get(task.workspaceIdentity?.trim() || task.workspacePath) ??
                  task.workspacePath;
                const searchSnippet = hasQuery ? result.searchSnippet?.trim() : undefined;
                const isExpandRow = result.kind === "expand";
                const showTaskHeader = result.showTaskHeader;

                return (
                  <Fragment key={result.key}>
                    {showTaskHeader && searchSnippet ? (
                      <button
                        type="button"
                        className="mt-1 flex min-w-0 w-full cursor-default items-center gap-2 rounded-md px-2.5 pb-0.5 pt-1 text-left outline-hidden first:mt-0 hover:bg-menu-hover focus-visible:bg-menu-hover"
                        onClick={() => selectTaskHeader(task)}
                      >
                        <span className="min-w-0 flex-1 truncate text-ui-base leading-5 font-normal text-foreground">
                          <HighlightedMatchText text={title} query={query} />
                        </span>
                        <CommandShortcut className={quickPickMetadataClassName}>
                          {workspaceLabel}
                        </CommandShortcut>
                        <span className="max-w-12 shrink-0 truncate font-sans text-ui-xs leading-none tracking-normal text-foreground-subtlest">
                          {formatTaskRelativeTime(task.updatedAt, intl)}
                        </span>
                      </button>
                    ) : null}
                    <CommandItem
                      value={`${title} ${workspaceLabel} ${searchSnippet ?? ""}`}
                      className={
                        isExpandRow
                          ? "min-h-7 items-center px-2.5 text-ui-base"
                          : quickPickItemClassName
                      }
                      onSelect={() => selectTask(result)}
                    >
                      {isExpandRow ? (
                        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-ui-base font-normal text-foreground-subtle">
                          <ChevronDown className="size-3.5 shrink-0" />
                          <span className="truncate">
                            {intl.formatMessage(
                              { id: "taskSearch.expandMoreSnippets" },
                              { count: String(result.hiddenSnippetCount ?? 0) },
                            )}
                          </span>
                        </span>
                      ) : (
                        <>
                          <span className={"flex min-w-0 flex-1 flex-col justify-center py-0.5"}>
                            {searchSnippet ? (
                              <span className="min-w-0 truncate text-ui-base font-normal leading-4 text-foreground-subtle">
                                <HighlightedMatchText text={searchSnippet} query={query} />
                              </span>
                            ) : (
                              <span className="truncate text-ui-base leading-5 font-normal text-foreground">
                                <HighlightedMatchText text={title} query={query} />
                              </span>
                            )}
                          </span>
                          {!searchSnippet ? (
                            <>
                              <CommandShortcut className={quickPickMetadataClassName}>
                                {workspaceLabel}
                              </CommandShortcut>
                              <span className="max-w-12 shrink-0 truncate font-sans text-ui-xs tracking-normal text-foreground-subtlest">
                                {formatTaskRelativeTime(task.updatedAt, intl)}
                              </span>
                            </>
                          ) : null}
                          <span className={quickPickShortcutPillClassName}>
                            {formatCommandShortcutLabel(String(index + 1))}
                          </span>
                        </>
                      )}
                    </CommandItem>
                  </Fragment>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  );
}
