# Sidebar child conversations (side chats + subagents)

Status: implemented (PR #92). Revised 2026-10-15 (v2): icon counters on the row — no toggle — plus a clickable child list under the parent row. v1 was counters + a show/hide toggle.

## Problem

Side conversations and subagents are real sessions attached to their parent by `parent_id` (column + `session_parent_idx` index, `apps/zcode-cli/packages/adapters/src/storage/session-store/migrations.ts:19,40`) with dedicated task types — `selection_side_chat` for side chats, `subagent_child` for subagents (`apps/zcode-cli/packages/contracts/src/interfaces/session-store.port.ts:34`). But the sessions-index host hooks filter rows to `interactive | fork | workflow_parent` before the wire (`isTaskListSessionType`, `task-list-session-membership.ts`; applied in `zcode-protocol/v4-bridge.ts:1965,2018` and `server-operations.ts:1724`), so children never reach the UI: after a Task-tool run or a `/side` chat the left sidebar shows nothing, and there is no way back to a finished subagent transcript or an older side chat. Precedent: deepseek renders a "N subagents running" status on the parent row; Copilot nests a full session tree. This spec takes the middle path: true counts as compact icon segments on the parent row plus a one-level clickable child list beneath it — without un-filtering children onto the task list and without any DB change.

## Contract

### 1. Facts are owned by the CLI host (all sessions-index facts are)

Two read-only methods on the session-store port (`apps/zcode-cli/packages/contracts/src/interfaces/session-store.port.ts`), implemented in the adapters repository (`storage/session-store/repositories/sessions.ts` — `listSessions` already speaks hierarchy via `roots` → `parent_id is null`, :213):

```ts
/** Grouped child counts by parent id; tombstoned (time_deleted) children excluded, like listSessions. */
countChildSessions(input: { parentIds: readonly string[] }): Promise<
  Map<string, { sideChats: number; subagents: number }>
>;
/** Latest live (not tombstoned) child sessions per parent, newest first, capped per parent. */
listChildSessions(input: {
  parentIds: readonly string[];
  limitPerParent: number;
}): Promise<Map<string, ChildSessionInfo[]>>;
```

`ChildSessionInfo = { sessionId, title, taskType: 'selection_side_chat' | 'subagent_child', lastActivityAt }`. Both queries run over the existing `session_parent_idx` — no schema change, no migration. `selection_side_chat` counts as side chats, `subagent_child` as subagents; `workflow_child` / `nested_workflow_child` are excluded (workflow runs already surface via `workflowActivity`; do not double-count). Forks and other parent-carrying primary sessions are not children for this purpose. The list is capped newest-first in SQL (`row_number() over (partition by parent_id …)`), at `SESSION_SUMMARY_CHILD_SESSIONS_MAX` (8, owned by the wire package so producer and schema cannot drift); counts stay TRUE totals so the row icons never lie when the list is truncated. Parents with no children are omitted from both results.

### 2. Wire: flat true counters + one bounded child array on the session summary

```ts
// packages/shared/src/zcode-protocol-v4/sessions-index.ts (sessionSummarySchema)
sideChatCount: z.number().int().nonnegative().optional(),
subagentCount: z.number().int().nonnegative().optional(),
// Children of the parent whose runtime is currently alive in this CLI process; 0/absent after a cold restart.
runningSubagentCount: z.number().int().nonnegative().optional(),
// Latest children, newest first, capped (§1); running flags merged from the live registry.
childSessions: z.array(childSessionSchema).optional(),
```

`childSessionSchema` = plain object `{ sessionId, title, taskType: enum(selection_side_chat | subagent_child), lastActivityAt, running: boolean }`. Flat optional fields plus one bounded array keep the projection upsert equality cheap (`areTaskMetaJsonFieldsEqual` already compares JSON fields); the summary schema is a plain `z.object()`, so old CLIs/UIs ignore all of it — same compatibility pattern as `executionWorktreeMissing`. The children-membership doc comment in `task-list-session-membership.ts` stays true: children still get no workspace bucket of their own; counters and the list ride the parent's summary.

### 3. Host computation and heat control

- Cold path (`loadStoredSessionSummaries`, `zcode-protocol/v4-bridge.ts`, async): one `countChildSessions` + one `listChildSessions` batch for all listed session ids of the workspace seed; seed those facts into the same resolver cache before loaded-session overlays run. Parents found with children seed the live resolver's tracking set.
- Live path (`getSessionIndexMeta` host hook, synchronous, per session): served by `createChildSessionFactsResolver` (`zcode-protocol-v4/child-session-facts.ts`, unit-tested directly) — a per-parent TTL cache (1 second) refreshed asynchronously that serves stale values until a refresh lands. Only parents known to have children are refreshed, so plain workspaces issue no store queries; a failed refresh backs off a full TTL so a broken store cannot turn every fan-out into a retry-and-warn loop.
- Running ownership follows runtime ownership: ordinary live child records in `context.sessions` use the residency busy predicate; detached subagent lifecycles come from the V4 gateway, which owns the child→parent map and records `TurnStarted` / terminal transitions. The gateway is authoritative for detached children because they have no bootstrap session record. Idle side-chat and subagent records still register their parent for store refresh; only busy subagents contribute to running counts.
- Event order on child activity: the gateway records detached ownership/lifecycle (or the host already has the child record) → invalidate that parent's cached store facts → publish the current parent summary without changing its activity timestamp → refresh store facts asynchronously → publish the parent summary again with the refreshed values. The index publisher conflates unchanged summaries. Refreshes remain TTL-limited, and child events never change the parent's `lastActivityAt`.
- Facts follow one complete production projection: session summary → Window Controller overlay → strict task metadata → task-index/session join → grouped sidebar row. Optional fields omitted by the current session summary clear stale child metadata at each join.

### 4. UI: icon segments on the row + one-level child list under it

- No toggle, no menu item, no setting anywhere (user decision 2026-10-15): the row gets ONLY the icon marker.
- Rendering in every desktop sidebar view (§7): the grouped row `packages/ui/src/project-sidebar/grouped/task-row.tsx` (both render chains) and the shared `TaskListItem` row used by the projects, timeline and pinned lists: a compact icon-segment marker (`ChildSessionCountsMarker`, styled exactly like the neighboring clock/moon/`WorktreeTaskMarker` meta icons — `size-3.5`, the row's muted meta color, no highlight, tooltip via `title`) appended to the right-side metadata group — in the interactive chain it sits OUTSIDE the hover-suppressed metadata span (between it and the hover-action cluster), because the marker doubles as the expander and must stay clickable while hover swaps metadata for actions; the drag-overlay chain renders it display-only. Segments: side chats = message-circle glyph + tabular `sideChatCount`; subagents = bot glyph + count. A segment renders only when its own count is non-zero (no zero chips); when `runningSubagentCount > 0`, the subagents segment switches to its running form using the row's existing loading idiom — a spinning `LoaderIcon` next to `running/total` (e.g. `1/3`), monochrome like the neighboring meta icons. All-zero → nothing rendered, no layout reservation — plain sessions keep today's layout byte-for-byte.
- Child list: clicking the marker expands/collapses a one-level list of child rows directly under the parent row (the marker is the expander — `aria-expanded`, no extra chevron; the click stops row propagation so it does not select the task). Children render inside the parent row's column below the title line — the same mechanism as workflow run lines — so the virtualized row model is untouched and the row simply grows (rows are already variable-height). Visual language reuses existing precedents only: the nesting rail of grouped content (`TASK_GROUP_CONTENT_CLASS` `ml-4 border-l pl-2`) and the below-title row scale of workflow run lines — child row: type glyph (message-circle / bot, `size-3`), title `text-ui-sm text-foreground-subtle` truncating, trailing status — spinning `LoaderIcon` while `running`, `text-ui-xs text-foreground-subtlest` relative time otherwise. Beyond the cap: a trailing `text-ui-xs text-foreground-subtlest` `+N more` row (navigates to the parent conversation, where the full subagent history lives). Expansion state is per-parent, per-device, collapsed by default, in `localStorage` (`lib/childSessionExpansionPreference.ts`, the `workspaceExpansionPreference` pattern) — deliberately NOT `setting.json` (fork-unsafe — upstream writes strip unknown keys) and NOT broadcast-synced (UI-local preference).
- Navigation on child click (v1, implemented): the child session opens as the active conversation through the row's regular `onSelectTask` path. Side chats remain writable. Subagent selection carries a read-only intent into the workbench binding, matching the Host's `guard.subagentReadOnly` rule; the composer and mutation controls stay hidden. This intent applies only to that subagent binding.
- Plumbing: `packages/ui/src/v4/mapSessionSummaryToTaskMeta.ts` carries the three counters and the bounded array into `ZCodeTaskMeta` (`packages/shared/src/zcode-task-types-core.ts`, flat optionals); row metadata equality in `useWorkspaceActiveTaskState.ts:61` compares them so a change re-renders; the projection upsert equality (`sessions-index-projection.ts`) includes them so a counters- or list-only change emits a delta.
- i18n: the visible row text is icon + number only; sentence forms live in the marker tooltip (composed from per-count phrases), child-row accessible names, and aria-labels. Keys (`taskList.childSideChatsCount`, `taskList.childSubagentsCount`, `taskList.childSubagentsRunningCount`, `taskList.childSubagentRowLabel`, `taskList.childSideChatRowLabel`, `taskList.childRunningLabel`, `taskList.childMoreLabel`) in `en-US`, `zh-CN`, `uk-UA` with correct plural categories (uk-UA needs the three-form Slavic plural).

### 5. Compatibility

Old UI + new CLI → unknown summary fields ignored. New UI + old CLI → fields absent → nothing rendered. Remote workspaces: counts and the list are computed in the CLI host that owns the session store (correct machine end-to-end); expansion state is per-device renderer state.

### 6. Subagents spawned inside a side chat (right-pane navigation)

Side chats are real sessions, so an `Agent`/`Task` call inside a side chat spawns a real `subagent_child` whose `parent_id` is the side chat session. Clicking that subagent's summary row (or the status panel entry) must open it as a right-pane `subagent-session` tab — the same behavior the main task already has. Scope follows the fix precedent for plan details from side chats (`b8d9e87d`):

- The tab's own identity keeps the true lineage: `parentSessionId` = the side chat session id that spawned it.
- The tab's visibility root is the main task, not the side chat: `rootSessionId` = the side chat tab's `parentSessionId` (the main task). Switching the main task hides/restores the tab; opening it inside the side chat never scopes the tab to the side chat session.
- The side chat pane forwards the existing `onOpenSubagentSession`, `onOpenSubagentDirectory`, `onOpenBackgroundBash` and `onSyncSubagentSessionTabs` handlers unchanged and passes `rootSessionId` to `SessionPane`, so the host, not the card, owns the root injection. The side chat's tab-sync collector prunes only its own tabs (`parentSessionId` = side chat); the main task's direct child tabs are untouched.
- The sidebar child list stays one level deep: it still lists the side chat as a child of the main task and does NOT nest the side chat's subagents under it. Navigation to a nested subagent is the right pane's job. No new runtime, session, owner, queue, or delivery path is created.

### 7. Every sidebar view renders the marker and child list (2026-10-23)

v2 mounted the marker only in the grouped row, so the default `projects` view, the `timeline` view and the pinned section (all rendered through `ProjectTaskRows` → `TaskList` → `TaskListItem`) dropped the child facts that the summary already carried. Rule: the same facts render the same marker and child list in every desktop sidebar view.

- One component path: `ChildSessionCountsMarker` and the child list (`components/TaskChildSessionRows.tsx`, moved from `project-sidebar/grouped/`) plus one expansion hook (`useChildSessionsExpansion`, backed by the existing `childSessionExpansionPreference` localStorage owner). Both rows use them; neither keeps its own copy of the expansion state.
- `TaskListItem` renders the marker only when its owner passes `onSelectChildSession(sessionId, options)`. `ProjectTaskRow` passes it (binding the parent's `workspacePath` / `workspaceIdentity`); other `TaskListItem` users (web remote mobile rows, session manager) do not, so their rows are unchanged — mobile stays out of scope.
- Marker placement mirrors the grouped row: right of the hover-suppressed metadata span, before the hover-action cluster, hidden while a pending interaction badge owns the status slot. The child list renders below the title line, after the workflow run lines; the leading slot aligns to the first line whenever either below-title lane is present.
- Navigation contract: `ProjectSidebarProps.onSelectTask` declares the optional sixth `options: { readOnly?, selectionSideChat? }` argument the shell handler (`WorkspaceShellLayout.handleSelectTaskInChat`) already accepts. A subagent child opens read-only, a side chat opens writable with restricted commands; the overflow row opens the parent without options.
- Row memo equality (`areTaskListItemTaskFieldsEqual`) includes `sideChatCount`, `subagentCount`, `runningSubagentCount` and `childSessions`, so a counter- or list-only summary update re-renders the row.

- Data path (regression from the 3.16.2 sync): the ported `project-sidebar` builds rows from the project tree (task index) and overlaid only live `activity` from the controller rows, so the Host child facts never reached ANY sidebar view, grouped included. The controller registry now exposes `readTaskOverlays()` — per online row, `activity` and/or `childFacts` (`pickTaskChildSessionFacts(row.meta)`, defined fields only) — and `applyProjectTaskOverlays` spreads `childFacts` onto the matching tree row. Rows without facts keep their identity; the task index still never stores child facts. The no-registry fallback (`useWorkspaceSessionsIndexItems`) carries the same facts from the mapped session summaries.
- Known limitation (observed on web + server, 2026-10-24): child facts exist only for workspaces whose Host sessions-index is seeded (§3 cold path). A workspace whose Host has not loaded its sessions-index yet shows no marker until one of its tasks is opened. Desktop seeding breadth was not re-verified; eager seeding for every listed workspace is a separate decision (Host cost).
- Phones: the web remote switcher resolves tasks from the top-level tree and cannot open a child, so both the `TaskListItem` owner and the grouped row hide the marker when `isWebRemoteControl`.
- Navigation path: every wrapper between the row and `WorkspaceShellLayout.handleSelectTaskInChat` forwards the sixth `options` argument (`useProjectTaskNavigation`, the grouped `TaskGroupedView` adapter). Dropping it opened a subagent with a writable composer.

Acceptance: in the projects view (default), timeline view and pinned section, a parent with a subagent child shows the bot marker; clicking it expands the child row; clicking the child opens it read-only as the active session; expansion state is shared with the grouped view for the same parent id.

### 8. Live children, right-pane open, stop (2026-10-24)

User-approved mockup (2026-10-24): running subagents stay visible without a click, a subagent opens in the right pane, and a running background subagent can be stopped from its row.

**8.1 Live children inline.** Collapsed is still the default, but a collapsed parent renders its `running` children (from `childSessions`) under the row; finished children stay behind the marker. The trailing row then reads `+N more` (N = true total − shown) and expands the list (`aria-expanded=false`) instead of opening the parent; expanded, it keeps the §4 overflow behavior. One owner: `visibleChildSessions(task, expanded)` in `components/TaskChildSessionRows.tsx`; both rows use it for rendering and leading-slot alignment.

**8.2 Subagent opens in the right pane.** A subagent child row no longer replaces the main pane. It selects the parent task and opens the existing `subagent-session` side-pane tab (`rootSessionId = parentSessionId = parent`, `childSessionId`, `title`, `subagentType = ""` — the summary does not carry it; presentation falls back to the title). Side chats keep the §4 behavior (main pane, writable). The parent row stays the selected row, so the sidebar highlight and the header name the parent.

Owners and event order (side-pane state is render-scoped in `useAppPanels`; opening before the parent is active commits the tab under the old owner/workspace):

```text
child row click
  → ProjectSidebar onOpenSubagentSession(target)            (sidebar: intent only)
  → WorkspaceShellLayout: pendingSubagentOpen = target      (single owner of the pending intent)
                          handleSelectTaskInChat(parent)    (normal parent selection)
  → render: active workspace/task == parent
  → effect: handleOpenSubagentSession(request); pending = null   (useAppPanels owns the tab)
```

- Idempotency: the tab id is `subagent-session:<workspaceKey>:<root>:<child>`; reopening activates the existing tab.
- Stale intent: any later `handleSelectTaskInChat` replaces or clears `pendingSubagentOpen`; it is consumed only when the active workspace key and task id equal the target parent. No timers.
- Pruning: the parent pane keeps tabs whose child is in its transcript's `subagents.childSessionIds` (finished included); a child whose Agent row was removed by edit/retry is pruned — accepted.
- Phones: unchanged (rows gated, §7).

**8.3 Stop a background subagent from its row.** Wire addition (backward compatible; nested objects strip unknown keys): `childSessions[].backgroundWorkId?: string`, present only while the child runs as cancellable background work of the parent. Producer: the CLI host, from the parent publisher's `backgroundWorks` (`kind: "subagent"`, `status: "running"`, `cancellable`, matched by exact `childSessionId`), merged in `child-session-facts.resolve`. Freshness: parent `BackgroundTask*` lifecycle events invalidate and republish the parent summary like child activity (§3 event order), never `ModelStreaming`.

```text
row Stop click (running && backgroundWorkId)
  → sendConversationCommandV4(parent workspace, envelope{ sessionId: parent, command: cancelBackgroundWork{ workId } })
  → CLI CommandInbox → interaction-background → stopBackgroundTask(workId)
  → child TurnComplete/BackgroundTask* → parent summary republished → running=false, Stop disappears
```

- The command is the same one the status panel sends; no new Host RPC. Transport precedent: `useTaskInteractionAutoResolutionSnooze` (workspace-scoped v4 command from a sidebar row, no pane lease).
- Foreground subagents get no Stop (no backgroundWorkId); they end with the parent turn.
- A failed command shows a toast; the row keeps its state until the summary changes (no optimistic removal).

Acceptance (§8):

1. Collapsed parent with one running and two finished subagents shows exactly the running row plus `+2 more`; clicking `+2 more` expands.
2. Clicking a subagent row selects the parent (highlighted in the sidebar) and shows the child in the right `subagent-session` tab; works when the parent was not active and across workspaces.
3. Selecting another task before the parent activates drops the pending open.
4. A running background subagent row shows Stop; clicking it sends `cancelBackgroundWork` for the parent with that `workId`; the spinner and Stop disappear after the next summary.
5. A running foreground subagent has no Stop. Old CLI (no `backgroundWorkId`) → no Stop.

## Why

The hierarchy already exists in the DB and in `context.sessions`; the only gap is that the wire drops children wholesale. Counters answer "where did my subagents / side chats go"; the clickable list answers "take me back to that one" — the actual day-to-day pain — at deepseek's cost plus one indented level, without Copilot's tree complexity (collapse state trees, DnD, depth, pin-subtree) and without weakening the explicit task-list membership contract. Dropping the v1 toggle keeps the row chrome minimal: the marker is the only added element and doubles as the expander.

## Acceptance scenarios

1. Session with 2 subagent children, one currently live → row shows the subagents segment in running form (`1/2` + spinning loader, monochrome); no other layout change.
2. `/side` chat created from a selection → parent's `sideChatCount` becomes 1 and the chat appears in the expanded list within the TTL + next fan-out.
3. Marker click → child list expands beneath the row; click again → collapses; expansion state survives reload (localStorage, per parent).
4. Plain session without children → summaries may carry absent fields, row renders byte-identical to today; a session with only side chats renders only the side-chat segment (no zero subagents segment).
5. A fork (taskType `fork`, has a parent) is NOT counted; tombstoned children are NOT counted. The fork `time_archived` column is not a filter (upstream has no CLI archive; `specs/upstream-sync-cli-divergences.md`).
6. CLI restart with cold children → counts and list restored from the store; `running` / `runningSubagentCount` are 0/absent until a child runs again.
7. Old UI + new CLI and new UI + old CLI → no parse errors, no rendering.
8. A summary whose only change is a counter or a child-list entry emits a projection delta (not conflated away).
9. Workflow children remain invisible as counts (no double display next to the workflow mini-track).
10. Click a child row → that session opens as the active conversation (v1 navigation; side-pane hosting for side chats and a mounted subagent drilldown are follow-ups).
11. More children than the cap → `+N more` trailing row; icon counts still show the true totals.
12. A detached live subagent appears as running without a `context.sessions` record; `TurnStarted` marks it running, terminal events clear running, and parent discovery does not depend on busy state.
13. An idle parent with a child event gets refreshed facts on the next bounded refresh, while its `lastActivityAt` remains unchanged.
14. Cold summary facts survive the live overlay and pass through the controller projection, strict metadata validation, and task-index/session join; absent facts clear stale values.
15. A subagent spawned inside a `/side` chat opens as a right-pane `subagent-session` tab: the request carries `parentSessionId` = the side chat session and root `rootSessionId` = the main task, the tab is visible under the main task and hidden under the side chat, and the side chat's sync only prunes its own tabs. The sidebar child list still shows one level only (unchanged non-goal).

## Validation

- `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed` (bootstrap typechecks against core dist — rebuild core first when types change).
- Unit: `countChildSessions` / `listChildSessions` grouped queries on a temp store (adapters tests); bridge TTL cache behavior (bootstrap tests); projection equality + `deriveSessionSummary` field propagation (`sessions-index-projection.test.ts`); `mapSessionSummaryToTaskMeta` mapping; task-row marker rendering for zero/segments/running, child-list expand/collapse and overflow, navigation wiring (packages/ui/test); i18n parity via the node:test catalog test.

## Out of scope

- Multi-level nesting, drag-and-drop, pin-subtree (Copilot-style tree).
- Closing or opening side chats from the sidebar row.
- Per-type toggles or any host-side/fork-settings storage (no toggle at all in v2).
- Counting `workflow_child` / `nested_workflow_child` (owned by `workflowActivity`).
- Realtime counter push on child completion.
- Mobile/web task-index row rendering of the counters or list (shared summaries carry them; row UI later if wanted). Desktop projects/timeline/pinned views are in scope since §7.

## Review follow-up (2026-10-16)

- Detached lifecycle facts must retain the authoritative persisted `taskType`. Only `subagent_child` contributes to `runningSubagentCount`; detached `workflow_child` and `nested_workflow_child` remain excluded, just like their cold-store counts.
- If an invalidation arrives inside the one-second TTL, retain the stale facts and schedule one trailing refresh for the first eligible instant. Do not require an unrelated later sidebar resolve to drain the invalidation.
- Parent-summary invalidation follows lifecycle and membership changes, not `ModelStreaming` chunks. Streaming is high frequency and does not change child membership or running state; `TurnStarted` and terminal events continue to update live running facts.
- Read-only intent belongs to the selected subagent pane binding. A workspace can contain another independently writable pane, which remains writable while the subagent pane is open.
- Pane binding persistence retains its child capability (`subagent_child` read-only or `selection_side_chat` writable with restricted commands), including draft-owned split layouts and renderer reload recovery. Restored children are validated by explicit session ID and task type rather than the filtered top-level index.
- If a child event refreshes facts for a parent that is not loaded in a conversation runtime, update that parent's existing cold sessions-index summary in place. Preserve its activity timestamp and do not start a parent runtime.
- Restored child-pane validation uses the existing `session/list` explicit-ID query, which reads persisted identity and task type without starting a runtime. The bounded top-level sessions-index list is not proof that a child session is missing. A missing or non-subagent target still closes the restored pane.
- The sidebar isolation E2E places the parent row in grouped mode and locates it by the grouped-row key before checking the expanded child row.

Event order for child invalidation remains: lifecycle owner updates child state → resolver invalidates the parent → parent summary is published → a TTL-eligible store refresh completes → refreshed parent summary is published. `ModelStreaming` does not enter this path.

Additional acceptance scenarios: a detached workflow child never affects the subagent count; an in-TTL invalidation refreshes automatically at TTL expiry; streaming chunks do not publish parent-summary refreshes; a restored child pane survives top-level-index omission when the store confirms its subagent type; a separate pane in the same workspace remains writable.
