# Task index: do not load search text for non-search reads (ZCO-39 stage 1)

## Problem

`tasks.searchable_text` holds up to 200 KB of body text per task, and `~/.zcode/v2/tasks-index.sqlite` is read synchronously inside the Host (`node:sqlite` `DatabaseSync`), so every byte read blocks all RPC of that window. List reads never use the body text, but they selected it. Measured on a real index (1.7k tasks, 1.3k archived, 26 MB of search text, read-only benchmark): the first task-list snapshot (`listTasks` + `listPinnedTasks` + `listArchivedTasks`) blocked the Host for ~155 ms; without `searchable_text` it takes ~6 ms. The onboarding check `listTaskMetas({}).length > 0` loaded the entire table (~158 ms) to answer an existence question.

## Behavior

- `listTaskMetas`, `listSessionsByAutomation` and `queryTaskList` without a search term do not select `searchable_text`. `queryTaskList` with a search term keeps selecting it, because snippets are built from it.
- `rowToMeta` only reads `meta_json` and scalar columns, so returned `ZCodeTaskMeta` values are identical. Items from a non-search `queryTaskList` carry no `searchSnippet`/`searchSnippets`, exactly as before.
- `TaskIndexRepo.hasTaskMetas({ includeDeleted? })` answers "is there at least one (non-deleted) task" with `SELECT EXISTS(...)`. The onboarding `hasExistingLocalTask` uses it instead of materializing every row.
- No schema change, no migration, no change to ordering, filtering, limits, totals, `hasMore`, or write paths. Writers still read the existing `searchable_text` so an update without new body text keeps it.
- Out of scope: the grouped-view bootstrap read, the workspace-scoped `OR @key IS NULL` split, search `LIMIT` (D3) and FTS5 (D1).

## Acceptance scenarios

1. `listTaskMetas` returns the same metas, in the same order, for workspace, provider, pinned, archived and includeDeleted filters, and the SQL it prepares does not mention `searchable_text`.
2. `listSessionsByAutomation` returns the same metas and its SQL does not mention `searchable_text`.
3. `queryTaskList` without a search term returns items without snippets and its list SQL does not select `searchable_text`; with a search term it still returns the body-text snippet.
4. Updating a task without new `searchableText` after these reads still retains the stored body text (search still finds it).
5. `hasTaskMetas()` is false on an empty index, true with a live task, false when only deleted tasks exist unless `includeDeleted` is set.
6. The onboarding check reports an existing local task exactly when `listTaskMetas({})` would be non-empty.
