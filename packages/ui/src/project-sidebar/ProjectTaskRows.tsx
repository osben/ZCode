import { Fragment, memo, useCallback, useContext, useMemo, useState } from "react";
import type { ProjectTask, ProjectSidebarProps } from "@/project-sidebar/contract.js";
import { TaskGroupTaskMenu } from "@/project-sidebar/TaskGroupTaskMenu.js";
import { TaskList } from "@/TaskList.js";
import type { ChildSessionSelectHandler } from "@/components/TaskChildSessionRows.js";
import { Button } from "@/components/ui/button.js";
import { useProjectTaskActions } from "@/project-sidebar/useProjectTaskActions.js";
import { ProjectTaskListContext } from "@/project-sidebar/ProjectTaskListContext.js";
import { compareProjectTaskRows } from "@/project-sidebar/view.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { timelineDateHeadings } from "@/project-sidebar/timelineDates.js";

const EMPTY: ProjectTask[] = [];
export const ProjectTaskRow = memo(function Row({
  task,
  onSelect,
  refresh,
  variant,
  showFiles,
}: {
  task: ProjectTask;
  onSelect: ProjectSidebarProps["onSelectTask"];
  refresh(): Promise<void>;
  variant: "default" | "timeline";
  showFiles: boolean;
}) {
  const presentation = useContext(ProjectTaskListContext);
  const { remoteSessionId, rename, pin, archive, unread } = useProjectTaskActions(task, refresh);
  const workspaceKey = task.workspaceIdentity?.trim() || task.workspacePath;
  const activeId = useZCodeSessionStore(
    (state) => state.workspaces[workspaceKey]?.activeTaskId ?? null,
  );
  const rows = useMemo(() => [task], [task]);
  const select = useCallback(
    () =>
      onSelect(task.workspacePath, task.taskId, task.workspaceIdentity, undefined, task.unreadAt),
    [onSelect, task],
  );
  // Side chats live in the parent's workspace; forward their capability (restricted commands).
  const selectChild = useCallback<ChildSessionSelectHandler>(
    (sessionId, options) =>
      onSelect(
        task.workspacePath,
        sessionId,
        task.workspaceIdentity,
        remoteSessionId ?? undefined,
        undefined,
        { ...options, parentTaskId: task.taskId },
      ),
    [onSelect, task, remoteSessionId],
  );

  const openFiles = useCallback(
    () => presentation.onOpenTaskFiles?.(task, remoteSessionId ?? undefined),
    [presentation.onOpenTaskFiles, task, remoteSessionId],
  );
  // Reason: inline JSX creates a new reference every render, defeating TaskList's memo comparison.
  const organizationActions = useMemo(() => <TaskGroupTaskMenu task={task} />, [task]);
  // Reason: session rows reusing project details would pop layers repeatedly while browsing tasks; remote identity details live only on the project entry.
  return (
    // Each row renders its own TaskList; the outer padding keeps selected/hover backgrounds from sticking together.
    <div className="py-px">
      <TaskList
        organizationActions={organizationActions}
        workspacePath={task.workspacePath}
        workspaceIdentity={task.workspaceIdentity}
        remoteSessionId={remoteSessionId ?? undefined}
        // pinnedTasks only drives badge styling; TaskList's actual render set is always tasks.
        tasks={rows}
        pinnedTasks={task.pinned ? rows : EMPTY}
        activeTaskId={activeId}
        isWorkspaceActive={presentation.activeWorkspaceKey === workspaceKey}
        mobileActiveTaskKey={presentation.mobileActiveTaskKey}
        onOpenFileTree={
          presentation.onOpenTaskFiles &&
          showFiles &&
          (!task.workspaceIdentity?.trim() || remoteSessionId)
            ? openFiles
            : undefined
        }
        showCreateButton={false}
        showFooter={false}
        showEmptyState={false}
        // Reason: the old wiring only passed sorting and missed the timeline variant, losing directory info and the idle gray dot.
        taskRowVariant={variant}
        hoverEnabled={!presentation.isWebRemoteControl}
        sortBy="updated"
        onSelectTask={select}
        // Phone rows stay unchanged (spec §7: mobile child rows are out of scope).
        onSelectChildSession={presentation.isWebRemoteControl ? undefined : selectChild}
        onRenameTask={rename}
        onSetTaskPinned={pin}
        onArchiveTask={archive}
        isArchived={task.archived}
        onSetTaskUnread={unread}
      />
    </div>
  );
});

export function ProjectTaskRows({
  tasks,
  onSelect,
  refresh,
  kind = "project",
  showEmptyState = true,
}: {
  showEmptyState?: boolean;
  kind?: "project" | "pinned" | "timeline" | "unread";
  tasks: ProjectTask[];
  onSelect: ProjectSidebarProps["onSelectTask"];
  refresh(): Promise<void>;
}) {
  const { intl, locale } = useZCodeIntl();
  const chronological = kind === "timeline" || kind === "unread";
  const pageSize = chronological ? 20 : 5;
  const [limit, setLimit] = useState(pageSize);
  const [showAll, setShowAll] = useState(false);
  const ordered = useMemo(
    () => [...tasks].sort((a, b) => compareProjectTaskRows(a, b, kind)),
    [tasks, kind],
  );
  const visible =
    kind === "pinned" ? (showAll ? ordered : ordered.slice(0, 20)) : ordered.slice(0, limit);
  const hasMore = kind === "pinned" ? ordered.length > 20 : ordered.length > limit;
  const headings = chronological
    ? timelineDateHeadings(
        visible.map((task) => task.updatedAt),
        Date.now(),
        locale,
      )
    : [];
  // Reason: with TaskList reused per row, an empty array no longer mounts the old empty state; the list owner shows it once.
  if (!tasks.length)
    return kind === "pinned" || !showEmptyState ? null : (
      <div
        className="px-8.5 py-2 text-ui-base text-foreground-subtlest"
        data-testid="project-no-tasks"
      >
        {intl.formatMessage({
          id: kind === "unread" ? "taskList.noUnreadTasks" : "taskList.noTasks",
        })}
      </div>
    );
  return (
    <div
      className={kind === "pinned" || chronological ? "px-2" : undefined}
      data-testid={
        kind === "pinned"
          ? "project-pinned-tasks"
          : chronological
            ? `project-${kind}-tasks`
            : undefined
      }
    >
      {kind === "pinned" ? (
        // Reason: the refactor missed the pinned section's original outer padding and demoted its heading to the auxiliary font size.
        <h3 className="px-2.5 py-1 text-ui-base font-medium text-foreground-subtlest">
          {intl.formatMessage({ id: "taskList.pinnedSection" })}
        </h3>
      ) : null}
      {visible.map((task, index) => (
        // Date headings share the row's full task key; updates across date segments must not remount a task row being acted on.
        <Fragment
          key={JSON.stringify([
            task.hostId,
            task.workspaceIdentity?.trim() || task.workspacePath,
            task.taskId,
          ])}
        >
          {headings[index] ? (
            <h3
              data-timeline-date-heading={headings[index].key}
              className="px-2.5 pt-2 pb-1 text-ui-base font-medium text-foreground-subtle"
            >
              {intl.formatMessage({ id: headings[index].id }, headings[index].values)}
            </h3>
          ) : null}
          <ProjectTaskRow
            task={task}
            onSelect={onSelect}
            refresh={refresh}
            variant={chronological ? "timeline" : "default"}
            showFiles={kind === "pinned"}
          />
        </Fragment>
      ))}
      {hasMore ? (
        <Button
          data-task-list-show-more="true"
          variant="ghost"
          size="sm"
          // Reason: the pagination entry misused the auxiliary font size and secondary color, inconsistent with task titles and empty states; brighten only on interaction.
          className="ml-8.5 h-auto p-0 text-ui-base text-foreground-subtlest hover:bg-transparent focus-visible:text-foreground"
          onClick={() =>
            kind === "pinned" ? setShowAll((value) => !value) : setLimit((n) => n + pageSize)
          }
        >
          {intl.formatMessage({
            id: kind === "pinned" && showAll ? "taskList.showLess" : "taskList.showMore",
          })}
        </Button>
      ) : null}
    </div>
  );
}
