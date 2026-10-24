import { useCallback, useContext, useLayoutEffect, useRef, useState } from "react";
import type { ProjectSidebarProps, ProjectTask } from "@/project-sidebar/contract.js";
import { ProjectTaskRows } from "@/project-sidebar/ProjectTaskRows.js";
import { ProjectTaskListContext } from "@/project-sidebar/ProjectTaskListContext.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";

// Mirrors ProjectTaskRows' "project" page (5 rows + "show more"); only sizes the placeholder.
const PROJECT_PAGE_SIZE = 5;
const ROW_ESTIMATE_PX = 32;
const SHOW_MORE_ESTIMATE_PX = 20;
/** Set on the sidebar scroll container (index.tsx); bounds which project rows are mounted. */
const PROJECT_ROWS_VIEWPORT_ATTRIBUTE = "data-project-rows-viewport";
// Rows mount half a viewport ahead of the visible area: enough lead to avoid an empty slot while
// scrolling, while most of a long expanded list still stays unmounted on a view switch.
const REACH_VIEWPORT_FRACTION = 0.5;

/**
 * Decides whether an expanded project mounts its task rows (specs/project-sidebar-deferred-rows.md).
 * Cause of ISSUE-064: the projects view mounted every expanded project's rows in one commit, most of
 * them below the fold. The flag only ever goes false → true, so mounted rows never unmount.
 */
export function useRowsReveal(isOpen: boolean, tasks: readonly ProjectTask[]) {
  const { activeWorkspaceKey, mobileActiveTaskKey } = useContext(ProjectTaskListContext);
  const activeTaskId = useZCodeSessionStore((state) =>
    activeWorkspaceKey ? (state.workspaces[activeWorkspaceKey]?.activeTaskId ?? null) : null,
  );
  const canDefer = typeof IntersectionObserver !== "undefined";
  // A node that mounts collapsed has nothing to defer; a later expand is a user action.
  const [revealed, setRevealed] = useState(!isOpen || !canDefer);
  const [wasOpen, setWasOpen] = useState(isOpen);
  let mustReveal = !canDefer || tasks.length === 0;
  if (wasOpen !== isOpen) {
    setWasOpen(isOpen);
    if (isOpen) mustReveal = true;
  }
  if (!revealed && !mustReveal) {
    // The active row must stay queryable (selection, scroll-to-task, mobile remote highlight).
    mustReveal = tasks.some(
      (task) =>
        (activeTaskId !== null &&
          task.taskId === activeTaskId &&
          (task.workspaceIdentity?.trim() || task.workspacePath) === activeWorkspaceKey) ||
        (mobileActiveTaskKey != null &&
          `${buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity)}:${task.taskId}` ===
            mobileActiveTaskKey),
    );
  }
  if (!revealed && mustReveal) setRevealed(true);
  const reveal = useCallback(() => setRevealed(true), []);
  return { revealed: revealed || mustReveal, reveal };
}

/** Rows slot inside an expanded project's CollapsibleContent: the rows, or their placeholder. */
export function DeferredRowsSlot({
  rows,
  tasks,
  onSelect,
  refresh,
}: {
  rows: ReturnType<typeof useRowsReveal>;
  tasks: ProjectTask[];
  onSelect: ProjectSidebarProps["onSelectTask"];
  refresh(): Promise<void>;
}) {
  return rows.revealed ? (
    <ProjectTaskRows tasks={tasks} onSelect={onSelect} refresh={refresh} />
  ) : (
    <DeferredProjectRowsPlaceholder taskCount={tasks.length} onReach={rows.reveal} />
  );
}

/** Sized stand-in for rows that are not yet reachable; reveals them before paint when in reach. */
function DeferredProjectRowsPlaceholder({
  taskCount,
  onReach,
}: {
  taskCount: number;
  onReach(): void;
}) {
  const slotRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const slot = slotRef.current;
    // Resolved from the DOM (already inserted here) rather than a ref: an ancestor's ref is not
    // attached yet when the sidebar and its projects mount in the same commit.
    const root = slot?.closest<HTMLElement>(`[${PROJECT_ROWS_VIEWPORT_ATTRIBUTE}]`);
    if (!slot || !root) {
      onReach();
      return;
    }
    // Tab from the header must reach this project's rows, so focus entering the project mounts them.
    const section = slot.closest("section");
    section?.addEventListener("focusin", onReach);
    const stop = watchReach(slot, root, onReach);
    return () => {
      section?.removeEventListener("focusin", onReach);
      stop?.();
    };
  }, [onReach]);
  const rows = Math.min(taskCount, PROJECT_PAGE_SIZE);
  return (
    <div
      ref={slotRef}
      aria-hidden="true"
      data-project-rows-placeholder="true"
      style={{
        height: `${rows * ROW_ESTIMATE_PX + (taskCount > PROJECT_PAGE_SIZE ? SHOW_MORE_ESTIMATE_PX : 0)}px`,
      }}
    />
  );
}

/** Reveals now when the slot is within reach of the scroller; otherwise observes it. */
function watchReach(
  slot: HTMLElement,
  root: HTMLElement,
  onReach: () => void,
): (() => void) | undefined {
  const bounds = root.getBoundingClientRect();
  const reach = bounds.height * REACH_VIEWPORT_FRACTION;
  const position = slot.getBoundingClientRect();
  if (position.top < bounds.bottom + reach && position.bottom > bounds.top - reach) {
    onReach();
    return undefined;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) onReach();
    },
    { root, rootMargin: `${REACH_VIEWPORT_FRACTION * 100}% 0px` },
  );
  observer.observe(slot);
  return () => observer.disconnect();
}
