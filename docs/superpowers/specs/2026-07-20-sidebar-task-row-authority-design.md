# Sidebar Task Row Existence Authority Design

## Feature summary

| Field | Value |
| --- | --- |
| Change | All persistent sidebar task lists take their row set from `tasks-index.sqlite`; `sessions-index` only enriches live session fields |
| User-visible surfaces | Project/workspace, Timeline, Pinned, Archived, Grouped, search results |
| Existing docs | `docs/v4-refactor/14-sessions-index.md`, `docs/superpowers/specs/2026-07-13-v4-sidebar-task-state-authority-design.md`, `docs/ui/task-grouped-view.md` |
| Existing code owners | `taskListMembershipSets.ts`, `buildTaskListResultFromSessions.ts`, `useGlobalTaskList.ts`, `useWorkspaceTaskLists.ts`, `useGroupedTaskView.ts` |
| Out of scope | transcript/row authority, conversation command, CLI session store schema, relay/main business state, cross-client delivery protocol |

This corrects the 3.4.0 list data-source migration: runtime logs showed history tasks missing from Grouped after upgrading to 3.4.0 (before any auto-archive ran) and restored on rollback to 3.3.6. The pre-upgrade SQLite backup still had the tasks and group memberships, so a persistent task row must never disappear just because the current `sessions-index` snapshot lacks its summary. Not a UI cap; all list kinds share the same logic.

Case IDs start at `TSL23`; `TSL22` is reserved by the parallel Grouped remote-data single-flight work.

## Boundary decisions

| Boundary | Decision | Includes | Excludes / prunes |
| --- | --- | --- | --- |
| Persistent row existence | `tasks-index` list results are the positive authority | active, pinned, archived, group member, ordering | never infer deletion from a missing sessions snapshot |
| Negative visibility | `deleted` tombstone has top priority | all list kinds, live/restart/replay | no physical deletion of CLI transcript |
| Live activity | `sessions-index` field-level overlay | phase, lastActivityAt, background, pending interaction, live title | never overwrites membership/sort/unread |
| Temporary new task | renderer-owned optimistic/live overlay | between create/send acceptance and the task row landing | session-only cold summaries never bypass the task index |
| New-task convergence | `task_created` invalidates the task-row snapshot | active tasks created in this window, other windows, and mobile shared-host | never waits for a sessions-index content frame to implicitly bring the row in |
| Search | tasks-index queries decide the result set | searchable_text/snippets; hits may overlay known activity | sessions title-only filter is not full-text search |
| Multi-client | identical row-existence semantics | local, SSH/WSL/Docker, desktop continuous, web remote replayable | snapshot/gap delivery stays per client |
| Index-read normalization | the SQLite row's `task_id`, `workspace_path`, and primary key `workspace_key` decide entity identity; a legal remote key outranks identity projection columns | remote history rows with missing or stale identity in the identity column or `meta_json` | projection fields never rewrite the isolation key; no cross-remote join by path |

## Domain scope and high-risk cross-products

Persistence/index/snapshot (which index wins when the two disagree), UI rendering/state (five list kinds share query cache, pagination, optimistic overlay), and workspace identity/remote (joins must use `workspaceIdentity?.trim() || workspacePath`) are all in scope; mobile remote/replayable is representative (same row semantics, unchanged recovery boundary).

High-risk product:

```text
task row present/absent
  × session summary present/absent/stale
  × active/pinned/archived/deleted/grouped
  × local/remote workspace identity
  -> row existence + field owner + sort/order
```

No full permutations with provider, Goal, queue, compact, theme, or locale — they do not change task membership.

## Concept map and state owners

```text
CLI session store/runtime
  -> sessions-index summary ----------------------┐
       phase / activity / attention / live title  │
                                                  v
Host tasks-index.sqlite --------------------> TaskListRowState -> Sidebar
  task rows / pin / archive / delete / group      ^
  unread / cron / manual title / explicit order   │
                                                  │
Renderer optimistic task overlay -----------------┘
  only uncommitted create/send placement

create/send accepted -> optimistic row -> tasks-index commit -> task_created
                                                       |
                                                       v
                                      invalidate task-row snapshot -> Project row
```

| State/fact | Authority | Mirrors/caches |
| --- | --- | --- |
| Persistent task rows and workspace isolation | tasks-index | task query cache |
| pinned/archived/deleted/group/unread | tasks-index | membership snapshot/overlay |
| phase/lastActivity/attention | sessions-index | query entity sidecar |
| transcript/session config | CLI conversation projection/store | active pane projection |
| Not-yet-persisted new task | renderer optimistic overlay, then tasks-index | local store |

## Dimensions and candidate combinations

| Candidate | tasks-index row | sessions summary | membership | Expected effect | Status |
| --- | --- | --- | --- | --- | --- |
| TSL23-A | present | absent | active/grouped | keep the static row; no spinner/attention; explicit group order unchanged | accepted |
| TSL23-B | present | present | any non-deleted | row from task index; activity/title enriched per field owner | accepted |
| TSL23-C | present | stale | deleted | tombstone excludes; summary cannot resurrect | pruned by TSL20 |
| TSL24-A | absent | stored completed | none | cold summary never becomes a persistent row directly; the syncer creates the task row first | accepted |
| TSL24-B | absent | newly live | pending create | only the existing optimistic/live overlay may show it temporarily; reconcile after commit | accepted |
| TSL25-A | present in identity A | summary at same path, identity B | grouped/project | no join, no workspace crossing; A keeps its static row | accepted |
| TSL25-B | present | present | pinned/archived | membership decides the section; sessions fields never move sections | accepted |
| TSL25-C | SQLite row is remote identity A but `meta_json` missing/stale | summary in identity A | grouped/project | normalize on read from SQLite entity columns, then join; never degrade to path matching | accepted |
| TSL26-A | just committed | present or pending | active/project | `task_created` invalidates the task-row snapshot; the new row enters the current workspace | accepted |
| TSL26-B | absent | draft only | none | unsent drafts never fabricate persistent task rows | pruned |

## Pruning decisions

| ID | Pruned combinations | Guard/invariant | Coverage |
| --- | --- | --- | --- |
| P1 | desktop/mobile × every membership | delivery profile never changes terminal row membership | desktop unit + replayable scope/recovery tests |
| P2 | local/SSH/WSL/Docker permutations | unified `workspaceKey`; each endpoint uses its own task service | identity focused tests |
| P3 | session phase × provider/Goal/queue | phase affects only activity fields, never row existence | running/completed representatives |
| P4 | deleted × all task types/list kinds | TSL20 tombstone negative invariant | TSL20 existing tests |

## Accepted cases

| Case | Setup | Action | Assertions | Evidence | E2E status |
| --- | --- | --- | --- | --- | --- |
| TSL23 | tasks-index has 25 active/grouped tasks; sessions-index has only 5 summaries | build Project/Timeline/Grouped | all 25 rows show; 5 with activity, rest with persistent meta; group order unchanged | pure projection + hook integration | focused covered; desktop covered |
| TSL24 | task row and session summary both exist; phase/title/activity then update | apply sessions delta and membership refresh | row identity/section unchanged; live fields update; pin/unread mutations never change activity ordering | projection/store test | focused covered |
| TSL25 | same path different identity, stale index JSON identity, or missing/late session summary | cold load, remote restore, summary arrival | SQLite entity columns normalize identity first; no crossing; no disappearance on missing summary; in-place enrichment when the correct summary arrives | repo + identity + hook integration | focused covered; remote GUI planned |
| TSL26 | current workspace has an old task-row snapshot; a new conversation's first send commits its task row | receive `task_created` | membership/task-row reads refresh; Project shows the new row immediately and later refreshes never drop it | event policy + hook integration | focused covered; desktop covered |

## Matrix backfill and E2E handoff

| File | Change |
| --- | --- |
| `docs/conversation-session-case-catalog.md` | add TSL23–TSL26 |
| `docs/testing/conversation-session-e2e-coverage-matrix.md` | mark focused tests + desktop regression representatives |

- Provider fixture: no model requests; pre-seeded task SQLite plus controllable sessions-index snapshots.
- File-system fixture: at least the "25 task rows / 5 summaries" local representative; remote identity via focused mocks.
- Timing: assert before and after snapshots; no sleeps — use store frame/hydration gates.
- Review risks: never use task-index historical `status=running` as a live spinner; never let a session-only cold summary bypass deleted or persistent membership.

## SSH/WSL running-indicator regression (2026-07-23)

Task rows existed over SSH/WSL but the running spinner was missing. The fix normalizes task-index reads — it does not loosen the UI join, fake activity from persistent `status=running`, or touch protocol/delivery or the whole SQLite schema.

```text
tasks row(workspace_key = remote identity)
        |
        | rowToMeta 以 SQLite 实体列归一化
        v
task meta(identity A) + sessions summary(identity A, phase=running)
        |
        | exact workspaceKey + taskId join
        v
activity sidecar -> loading spinner
```

SQLite's `(workspace_key, task_id)` already decides query and isolation scope; `workspace_identity` and `meta_json` are entity-field projections that never rewrite the primary-key isolation. The unified resolver restores a legal remote `workspace_key` directly as identity; non-remote rows read the identity column; local rows fall back to `workspacePath`. This fixes SSH/WSL enrichment while keeping the TSL25 invariant "same path, different remote, never join".

Focused coverage: TSL25-C1 (SSH row with correct identity column but `meta_json` missing identity → `listTaskMetas` returns the column identity); TSL25-C2 (WSL row with empty identity column but a legal remote `workspace_key` → identity recovered from `workspace_key`); TSL25-C3 (same path and taskId, different SSH identities → only exact-identity matches; wrong summaries attach no activity). No new E2E that round — TSL25's remote GUI representative already exists; the gap was repo read-layer coverage.

## Desktop E2E handoff (2026-07-22)

Product semantics and pruning of TSL23–TSL26 unchanged; the desktop continuous GUI representatives were landed in `manual-review/pending` (batch human review before promote). Remote/mobile and other list-kind permutations were not expanded.

Representatives (both passed fixture check and 1/1 strict replay; artifacts under `packages/desktop/.e2e-artifacts/desktop-e2e-20260722-135334-434/` and `-135432-692/summary.md`):

- **TSL23** — real tasks-index with 25 rows, sessions-index with 1 summary; cold-start Project, click Show more repeatedly: 25 unique taskIds; the no-summary tail row exists; persistent `running` fakes no spinner. The 1/24 split covers the same summary-present/absent equivalence classes as the 25/5 focused test.
- **TSL26** — hydrated current Project with an unsent draft in a V4 pane; first send, wait for task commit: no such task before send; exactly one row by taskId after; still exactly one after assistant completion and renderer reload. Covers optimistic→persisted plus the `task_created` refresh.

```text
cold start: tasks-index 25 rows ─┐
                                 ├─ join ─> Project first 5 ─> Show more ─> all 25
            sessions-index 1 row ┘

first send: draft(no row) -> optimistic row -> tasks-index commit -> task_created
                                                            |
                                                            v
                                              invalidate + persisted one row
```

## TSL19/TSL20 restart regression handoff (2026-07-22)

Two P0 bugfix cases tied to cold-start membership, local `desktop-continuous` UI entries only; remote/mobile reuse the same task-type/tombstone invariants.

```text
fork: parent completed -> Fork -> child(task_type=fork,parent_id=parent)
                                  -> switch to draft -> App restart
                                  -> cold sessions-index -> Project child row -> click/hydrate

delete: task -> archive(confirm) -> Archived -> delete(confirm)
                 -> tasks-index deleted=1 ----┐
                 -> CLI session retained -----+-> App restart -> sessions-index has summary
                                              └-> Project/Archived both hide task
```

- **TSL19** — create a parent, fork from a completed assistant (CLI row `task_type=fork`, `parent_id=parent`); switch to an unsent draft, restart the app, open the `#` session directory before resuming the child. Assert exact `session:<childId>` is visible, proving cold sessions-index restored the child. (The Project row is now owned by tasks-index; a fork not landing a task row is a separate gap — workflow/auxiliary children are covered by focused tests.)
- **TSL20** — archive a normal task from Project, permanently delete it from Archived; assert tombstone and CLI session, restart, and wait until the raw sessions mention directory shows the session. Project and Archived never resurrect; tasks-index `deleted=1`; the CLI session is retained.

Both passed fixture check and 1/1 strict replay (`desktop-e2e-20260722-141321-231` and `-141719-802/summary.md`).

TSL19's strict replay also exposed a current gap beyond the original commit `3270dcc2c2`: cold sessions-index restores the fork, but tasks-index has no matching fork row, so Project still does not show the child. That gap is not claimed as covered; the pending case proves the originally-claimed sessions-index membership via the exact `session:<childId>` mention, and the matrix keeps the Project row **partial**.

## Live fork task-row commit (2026-07-24)

Confirmed product end state: an explicit fork is a persistent primary task — the child must appear in Project immediately when the command succeeds, without relying on app/CLI restart, reopening the child, or a later runtime event to self-heal.

The fault was not the sidebar join but the hydration boundary failing to publish the current summary:

```text
fork commit -> child record/resume -> 暂态 draft publisher
                                      |
                                      v
                         synthesized conversation hydration
                                      |
                         [旧] 只 flush conversation subscriber
                                      X
                            sessions-index 无 visible upsert
                                      X
                         task-index syncer 无法创建 child row

                         [新] hydration commit
                                      |
                                      v
                         publish current non-draft summary
                                      |
                                      v
                     task-index row + task_created -> Project
```

The fix belongs in the gateway hydration commit, not a UI session-only overlay:

- Hydration is the atomic boundary where the transient publisher becomes the full authoritative projection; it must not wait for a later event that may never come.
- sessions-index keeps carrying only lightweight summaries; tasks-index remains the sole owner of persistent rows and membership.
- `isDraftSession` filtering stays — unsent drafts are never written as tasks.
- Re-sending the same summary stays idempotent via sessions-index diff plus task-index upsert.
- Desktop `desktop-continuous` gets the live delta immediately; mobile `web-remote-replayable` reaches the same end state through its own connection-owned subscription and snapshot/gap recovery — no recovery-protocol change.

The representative combination is fixed as TSL28: local desktop, completed parent, no post-hydration event. A running parent only changes the fork precondition (the parent's active work must continue); SSH/WSL/Docker only change workspaceKey; mobile only changes delivery — none are permuted against the task-row persistent end state.
