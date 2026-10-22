# Global task search: settle the query before querying

## Problem

`TaskSearchDialog` passed the trimmed input straight into `useGlobalTaskList` on every keystroke. Each distinct query is a host RPC that runs `LOWER(searchable_text) LIKE ?` over the whole tasks index (up to 200 KB of body text per row), twice (COUNT and SELECT). With thousands of tasks, every keystroke stalled the host. `useDeferredValue` alone does not help here: it defers rendering but the query still reaches the hook for each intermediate value.

## Owner

- `packages/ui/src/TaskSearchDialog.tsx` owns the settled query (`settledQuery`). It is the only component that decides which query reaches `useGlobalTaskList`.
- `useGlobalTaskList` (`packages/ui/src/hooks/useGlobalTaskList.ts`) owns request ordering. It keeps a `requestSerialRef` so only the latest request writes results, and it keys `hasCurrentResult` by query. It is not changed by this spec.
- The input value and the match highlight stay on the live query and are not part of this contract.

## Product rules

1. The input field updates on every keystroke. Nothing about typing is delayed.
2. A query reaches the task list only after it has stopped changing for `TASK_SEARCH_QUERY_SETTLE_MS` (200 ms). Intermediate keystrokes never reach the RPC.
3. Clearing the input empties the result list at once. The previous settled query must not linger.
4. Results for a stale query must not overwrite results for a newer one. This is guaranteed by `useGlobalTaskList`'s request serial, and must not regress.
5. The index refresh that runs when a query is typed (`taskList.refresh`) runs once per settled query, not once per keystroke.
6. Expanded snippet groups reset when the settled query changes.
7. The list mode (search or recents wording, and whether snippets show) follows the typed query, not the settled one. Only the task-list RPC waits for the settle delay, so the list does not flip to recents while a query is settling.

## Acceptance scenarios

1. Typing `r`, `re`, `rev`, `revi`, `revie`, `review` in quick succession (each step under 200 ms apart) shows each value in the input immediately. The task list is never called with any intermediate value. After 200 ms of quiet it is called with `review` exactly once, and the refresh runs once.
2. Clearing the input after a settled query calls the task list with the empty query without waiting for the settle delay.
3. A query that is still changing when the dialog is closed does not leave a pending settle that updates a closed dialog. Closing the dialog clears the input, which clears the settled query.
4. Typing `review` from an empty input shows the search empty-state wording (`taskSearch.noResults`) at once, before the 200 ms settle, and the task list is still called with the empty query until the settle completes.
