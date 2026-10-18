# Session deletion: honest copy, child counts, permanent erase

Status: implemented (2026-10-18), except the E2E scenarios, which are not written or run (desktop E2E cannot run in this environment).

## Problem

"Delete" in this app never removes data. Facts verified in the current source:

- Non-archived row: `deleteTask` writes a tombstone (`tasks.deleted = 1`) in `tasks-index.sqlite`. Archived row: `deleteArchivedTask` writes the same tombstone (`taskIndexRepo.ts:1893`; `specs/manage-sessions-table.md` §7 wrongly calls it "permanent index removal").
- The CLI session store (`~/.zcode/cli/db/db.sqlite`) keeps every row, message and file. The only `delete from session` in the CLI is `deleteEmptySession` (empty drafts). The `deleteSession` command only closes the runtime.
- The tombstone is intentional and must stay: it is what prevents deleted chats from reappearing after a restart (`docs/task-list-membership-cache-sync.md`).
- Children (`selection_side_chat`, `subagent_child`, workflow children) are attached by `session.parent_id` (plain column, no foreign key) and have no task-index row. They disappear from the UI with their parent, but stay in the database. No purge, retention job or Storage-manager category (`sessionStore` is `cleanability: none`) can remove them.
- Archive writes only `tasks.archived` in the task index. A search of `zcode-cli` (`bootstrap`, `core`, `adapters`), `services` and `desktop` finds no writer of the CLI `time_archived`; it is only read (`session-mapper.ts`, `server-operations.ts`, `resume.ts`). Archived parents therefore keep "active" children.
- The only in-process `eventStore.deleteSession` calls (`server-operations.ts`, `session-residency.ts`) release the in-memory `InMemorySessionEventStore`, the only `EventStore` implementation exported by `adapters/src/storage/index.ts`. They are not a persistent delete; message content lives in the SQLite `message` / `part` / `session_entry` tables.
- Dropping a `session` row is not enough to clear a tree. Foreign keys on `session(id)` differ per table (`migrations.ts`):
  - `message`, `part`, `session_entry`, `session_input`, `session_task_link.child_session_id` and similar: `on delete cascade`.
  - `workflow_run.parent_session_id` and `session_task_link.parent_session_id`: `on delete set null`, so the rows survive as orphans. (`workflow_activity.child_session_id` is also set null, but activities are deleted with their run.)
  - `dwf_run.parent_session_id`, the other `dwf_*` columns and `input_history.session_id` (the typed prompts of a session): plain text, no foreign key (by design for `dwf_*`, `migrations.ts:814`), so they are never touched by a `session` delete.
  - `session.parent_id`: plain text, no foreign key.
- Foreign keys are enforced at runtime: `pragma foreign_keys = on` is set on the same `DatabaseSync` handle (`SqliteSessionStore.db`) that all repositories use, inside the migration runner (`migration-runner.ts:137`). This is a precondition of §4, so a test asserts it on the store handle.
- The only delete dialog that explains anything is Session Manager ("Session files stay on disk"). The sidebar archived section, web-remote index and "Delete all archived" say nothing about children or retained data.
- Child counts on rows are not reliable enough for copy. `sideChatCount` / `subagentCount` ride the live sessions-index overlay, are not persisted in the task index, and `mapSessionSummaryToTaskMeta.ts` omits a zero count, so "absent" cannot be told from "zero". The archived section, web-remote index and `archivedTaskDeletion.ts` (the "Delete all archived" batch, ids only) do not read them at all. Rows also exclude archived and nested descendants.

Net effect: users believe a chat was erased, its content (including side chats and subagent transcripts) stays on disk, and there is no way to get rid of it.

## Terms

- **Hide** — today's "Delete": tombstone in the task index, content retained. Reversible only by developers; not offered as undo in UI.
- **Erase** — new: permanent removal of the session, its descendant children and their files, then removal of the index row. Irreversible.
- **Descendants** — sessions reachable from a root through `parent_id` where the child `task_type` is one of `selection_side_chat`, `subagent_child`, `workflow_child`, `nested_workflow_child`. **Forks (`fork`) and other primary sessions are never descendants**, even though they also carry `parent_id`.

## Contract

### 1. Archive stays index-only (decision, no behavior change)

Archive is reversible and children render on the parent row, so they are archived implicitly. Archive does not cascade, does not write CLI `time_archived`, and has no dialog. Hide and Erase of a parent whose `runningSubagentCount > 0` warn that running children will be stopped (Hide) or block the Erase until they stop (§4).

### 2. Hide: honest copy with child counts (part A)

Every confirm surface for deleting a session — Session Manager dialog, sidebar archived section, web-remote task index, "Delete all archived" — states what happens:

- Body: sessions are hidden from the list and their files stay on disk until erased.
- When the selected sessions have children, a second line adds the counts: "Includes {sideChats} side chats and {subagents} subagents." The numbers come from the read-only `countSessionTree` query (§5), not from row meta, because row counts cannot distinguish "unknown" from "zero" and exclude archived and nested descendants (see Problem). The dialog shows the line only after the query resolves; nothing is shown while it loads (no flicker for plain sessions), and when it fails, is unsupported or the workspace is remote it shows the generic sentence "May also include side chats and subagents attached to these sessions." A zero count is omitted; a resolved all-zero result shows no line.
- "Delete all archived" resolves the archived ids first, then runs the same query once for the batch.
- Bulk dialogs query only the rows that will actually be deleted (pinned rows excluded unless opted in, as today).

New i18n keys under `sessionManager.delete.*` / `confirmDialog.archivedTaskDelete*` in `en-US`, `zh-CN`, `uk-UA` (uk-UA three-form plurals). The stale text in `specs/manage-sessions-table.md` §7 is corrected in the same change.

### 3. Erase: opt-in permanent removal (part B)

Erase only ever acts on sessions that are already hidden. It is a second step after Hide, never a separate delete path:

1. **Session Manager delete dialog** — a checkbox below the pinned checkbox: "Erase files permanently. This can't be undone." Unchecked by default, never remembered. When checked, the dialog shows the exact tree numbers from `countSessionTree`: "Erases {total} sessions: {sideChats} side chats, {subagents} subagents, {workflowSessions} workflow sessions." The checkbox is disabled while a session in the tree is running (the dialog says how many to stop). The confirm button becomes "Erase {count}" and keeps destructive styling. Confirm runs the existing Hide path first (`deleteTask` / `deleteArchivedTasks`, through the window controller, so projections and caches update through the existing `task_deleted` flow), then erases the same ids. If the erase step fails, the sessions are still hidden and the result toast names the failed count.
2. **Hidden-sessions maintenance row (Settings → Sessions)** — a footer row under the Session Manager table showing how many hidden sessions still have content in the CLI store ("{count} hidden sessions are still stored on disk") with an "Erase hidden sessions" action behind a confirm dialog. It renders nothing while the count is unknown, zero, or unsupported. This is the only way to erase sessions that were hidden before this feature (they have no UI row). Count only, no byte size. It lives in Settings → Sessions, not in the Resource Manager Storage tab: Storage is served by the main process, which holds no task state and has no relay to the Host, so a Storage-tab action would need a new IPC channel, a preload bridge and a main→Host relay. The count and the action cover local workspaces only and use the same Hide-first, tombstone-kept erase path.

Hide remains the default everywhere. The sidebar, archived section and web remote only get §2 copy; the irreversible action lives in one place per concern so it cannot be hit from a hover button.

### 4. Erase semantics

Owner split (unchanged ownership): CLI session store owns content; `tasks-index.sqlite` owns list visibility. The tombstone is never removed by Erase: `saveSession` in the CLI (`sessions.ts`, `insert into session … on conflict(id) do update`) is an upsert, so any resident runtime that writes after the erase can recreate the `session` row. Keeping the tombstone is what keeps such a row hidden. The cost is one small index row per erased session.

```
Session Manager (confirm, Erase checked)
   │ 1. Hide: deleteTask / deleteArchivedTasks  ──▶ tombstone + task_deleted   (existing path)
   ▼
zcodeTaskService.eraseTasks(rows)
   │ 2. resolve tree: countSessionTree; refuse if any session in tree is running (this process)
   ▼
Host: close resident runtimes in the tree (closeSession), then request
   ▼
CLI protocol method session/eraseTree({ sessionIds })
   │ 3. recursive walk by parent_id over child task types (root always included)
   │ 4. one transaction, in this order:
   │      a. delete workflow_run rows whose parent_session_id is in the tree
   │      b. delete dwf_run rows whose parent_session_id is in the tree (dwf_* children cascade)
   │      c. delete input_history rows of the tree's sessions (typed prompts, no foreign key)
   │      d. delete the tree's session rows (FK cascade removes message/part/entry/input/task links/usage)
   │ 5. remove session-scoped directories (§6); result lists erased ids and a failure count
   ▼
result ──▶ UI toast (erased / failed counts). No index write: the tombstone stays.
```

Rules:

- **Hide first, erase second.** If any step after Hide fails, the session is still hidden and nothing resurrects. A retry is safe because every step is idempotent.
- **Workflow tables are deleted explicitly, before the sessions.** `workflow_run` references sessions with `on delete set null` and `dwf_run` has no foreign key at all, so a plain `session` delete would leave both behind with their journals.
- **In-memory state.** The Host closes resident runtimes through `closeSession`, which also releases their `InMemorySessionEventStore` entries (the existing `eventStore.deleteSession` calls). Erase adds no second in-memory cleanup path.
- **Idempotent.** A session id that no longer exists counts as erased. Erasing an id twice is a no-op.
- **Running guard is process-local.** Erase refuses while a session in the tree has a live turn in the CLI process that serves the request. The session database has no lease or owner table, so another window's CLI process is not checked: if it is running a turn in an erased tree, its later writes fail on the foreign key. v1 accepts this limit and does not add a cross-window lease.
- **Hide warns, it does not stop.** Hide of a parent with running children only warns in the dialog; it never stops them.
- **Forks survive.** A fork of an erased session keeps its own content; its `parent_id` becomes a dangling reference (no foreign key exists), same as after a hide. The fork-boundary row must not crash on a missing parent (verify in implementation, add a test).
- **No second state.** No `erasing` flag is persisted. The tree is recomputed at confirm time; the dialog numbers are not trusted by the executor.
- **Remote workspaces** (`workspaceIdentity` set) are not erasable in v1: the action is hidden with a reason. Mobile web remote never offers Erase: `SettingsPage` passes `allowErase={!isWebRemoteControl}` to the Sessions section, which hides both the checkbox and the maintenance row (method presence cannot be used, because RPC proxies answer any property).
- **No process per workspace.** Session ids are global, so counting hidden content goes through one client: an already-running runtime if any exists (`runtimePolicy: "existing-only"`), otherwise a single started one in the first workspace that can host it. Erasing hidden content uses each workspace's own live runtime first (its running guard sees its own sessions) and sends the remaining ids through one shared started client.
- **Unsupported peers.** An older CLI without the methods answers method-not-found; Services maps that to "unsupported", the dialog falls back to the generic §2 sentence, and Erase is hidden.

### 5. Interfaces

CLI session store port (`session-store.port.ts`), optional like `deleteEmptySession`:

```ts
/** Descendants of the roots through child task types only; includes archived children; excludes forks. Unknown ids count 0. */
countSessionTree?(input: { rootIds: readonly SessionId[] }): Promise<SessionTreeCounts>;
deleteSessionTree?(input: { rootIds: readonly SessionId[] }): Promise<{ erasedIds: SessionId[] }>;
interface SessionTreeCounts { total: number; sideChats: number; subagents: number; workflowSessions: number; workflowRuns: number; running: number }
```

`countSessionTree` is read-only and used by the Hide copy (§2), the Erase preview (§3) and the maintenance count. `running` is filled by the protocol handler from the live registry, not by the store.

Protocol (`packages/shared/src/zcode-protocol/index.ts`, strict schemas, runtime validation): `session/treeCounts` and `session/eraseTree`, dispatched in `server.ts`, handled in `server-operations.ts`, listed in `shared/test/zcodeProtocol.test.ts`.

Services (`IZCodeTaskService`), all optional so existing implementers (bots fixtures, remote collections, e2e harness) keep compiling: `countTaskTrees(params)`, `eraseTasks(params)`, `countDeletedTaskContent(params)`. Remote collections do not implement them; the UI shows Erase only when the method exists and the workspace is local. UI reaches them through `packages/ui/src/hooks/`, never through `window.zcode`.

No schema change, no migration, no new `setting.json` key. Erase is a data operation on the shared databases; the upstream build treats a tombstoned id without a session row as already hidden.

### 6. Session-scoped files

Only directories whose name is exactly an erased session id, under known roots, are removed, never by glob. Any category whose per-session path cannot be confirmed in the code is left in place, reported in the result as "files kept", and recorded below.

Removed after the database rows are erased (best effort; failures are counted in the result, never block the erase), each as `<storageRoot>/cli/<dir>/<sessionId>` where the id must match `[A-Za-z0-9._-]{1,120}` (the artifact store's own sanitizer leaves such ids unchanged) and the resolved path must be a direct child of the root:

- `artifacts` — tool result artifacts (`NodeToolArtifactStore`)
- `image-cache`, `pdf-cache`, `video-cache` — derived media attachments
- `sessions` — script-workflow files (`script-workflow-tool-port.ts`)

Not removed in v1, because the protocol server does not know their roots: `bash-startup/<sessionId>` (shell startup scripts) and persisted exec output `<execRoot>/<sessionId>/*-stdout.log`. The dialog copy therefore says the conversation data is erased and some cache files may remain. The protocol server receives the raw `storage.dir` as the `storageRoot` dependency from the entrypoint and joins `cli/<dir>/<sessionId>` exactly like the writers do (`create-app.ts`, `script-workflow-tool-port.ts`); it deliberately does not use `getCliStorageRoot()`, which differs when `storage.dir` itself ends in `cli`. When the dependency is absent every session counts as a file failure.

Side effect to know: usage tables (`model_usage`, `turn_usage`, `tool_usage`) cascade from `session`, so erased sessions also leave the app usage statistics.

## Acceptance scenarios

1. Session with 2 side chats and 3 subagents, Hide → dialog line "Includes 2 side chats and 3 subagents" once the query resolves (generic sentence before that); after confirm the row is gone and rows in `db.sqlite` are unchanged.
2. Same session, Erase checked → dialog shows exact tree numbers including archived and nested descendants; after confirm `session`, `message`, `part`, `workflow_run` and `dwf_run` rows for the whole tree are gone; the tombstone stays; a restart does not resurrect it.
3. A fork of an erased session still opens and renders its history.
4. Erase while a subagent is running → blocked with the running count; nothing deleted.
5. Erase fails or is interrupted midway → the session stays hidden (Hide ran first); retrying succeeds and is a no-op for ids already erased.
6. Archived row Hide through the archived section → dialog states files stay on disk.
7. The maintenance entry shows "Deleted sessions with content: N"; "Erase deleted sessions" erases all tombstoned trees of the local workspaces, reports partial failures by count, and the count drops to 0.
8. Remote workspace row: Erase checkbox disabled with a reason.
9. Archive a parent with children → no dialog, no CLI change, children reappear with the parent on restore.

## Tests

- CLI: tree walk includes `selection_side_chat`/`subagent_child`/`workflow_child`/`nested_workflow_child`, includes archived, excludes `fork` and `interactive` rows that share `parent_id`; `pragma foreign_keys` reads `1` on the store handle; after an erase no row remains in `message`, `part`, `session_entry`, `session_input`, `session_task_link`, `workflow_run` or `dwf_run` (and their cascaded children) that references a tree id; idempotent second call.
- Services: Hide runs before erase, tombstone is never removed, erase failure keeps the session hidden, running guard, method-not-found maps to unsupported.
- UI: dialog child line (zero, one, plural), checkbox swaps to exact numbers, confirm label, disabled states; maintenance entry.
- E2E: Session Manager Hide with children and Erase with children.

## Decisions taken

- Archive stays index-only: no dialog, no cascade (confirmed by the user, 2026-10-18).
- Hide only warns about running children; it never stops them.
- The maintenance entry lives in Settings → Sessions (chosen by the user over the Storage tab, 2026-10-18).
- No byte size for hidden sessions; a count is enough.
- v1 removes only the session directories listed in §6; `bash-startup` and persisted exec output stay on disk and the dialog copy says some cache files may remain.
