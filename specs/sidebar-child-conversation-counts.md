# Sidebar child conversations (side chats + subagents)

Status: implemented. The sidebar lists **side chats only** (§9, user decision 2026-10-24); subagents stay reachable from the parent conversation and the status panel.

## Problem

Side conversations and subagents are real sessions attached to their parent by `parent_id` (column + `session_parent_idx` index, `apps/zcode-cli/packages/adapters/src/storage/session-store/migrations.ts:19,40`) with dedicated task types — `selection_side_chat` for side chats, `subagent_child` for subagents (`apps/zcode-cli/packages/contracts/src/interfaces/session-store.port.ts:34`). But the sessions-index host hooks filter rows to `interactive | fork | workflow_parent` before the wire (`isTaskListSessionType`, `task-list-session-membership.ts`; applied in `zcode-protocol/v4-bridge.ts:1965,2018` and `server-operations.ts:1724`), so children never reach the UI and there is no way back to an older side chat. This spec surfaces them as compact icon counts on the parent row plus a one-level clickable child list — without un-filtering children onto the task list, without weakening the task-list membership contract, without any DB change. The marker is the only added row chrome and doubles as the expander.

## Contract

### 1. Facts are owned by the CLI host (all sessions-index facts are)

Two read-only methods on the session-store port (`apps/zcode-cli/packages/contracts/src/interfaces/session-store.port.ts`), implemented in the adapters repository (`storage/session-store/repositories/sessions.ts` — `listSessions` already speaks hierarchy via `roots` → `parent_id is null`):

```ts
/** Grouped child counts by parent id; tombstoned (time_deleted) children excluded, like listSessions. */
countChildSessions(input: { parentIds: readonly string[] }): Promise<Map<string, { sideChats: number }>>;
/** Latest live (not tombstoned) child sessions per parent, newest first, capped per parent. */
listChildSessions(input: {
  parentIds: readonly string[];
  limitPerParent: number;
}): Promise<Map<string, ChildSessionInfo[]>>;
```

`ChildSessionInfo = { sessionId, title, taskType, lastActivityAt }` with `taskType` scoped to `selection_side_chat` (§9.1). Both queries run over the existing `session_parent_idx` — no schema change, no migration. `workflow_child` / `nested_workflow_child` are excluded (workflow runs already surface via `workflowActivity`; do not double-count). Forks and other parent-carrying primary sessions are not children for this purpose. The list is capped newest-first in SQL (`row_number() over (partition by parent_id …)`), at `SESSION_SUMMARY_CHILD_SESSIONS_MAX` (8, owned by the wire package so producer and schema cannot drift); counts stay TRUE totals so the row icons never lie when the list is truncated. Parents with no children are omitted from both results.

### 2. Wire: flat true counters + one bounded child array on the session summary

```ts
// packages/shared/src/zcode-protocol-v4/sessions-index.ts (sessionSummarySchema)
sideChatCount: z.number().int().nonnegative().optional(),
// Deprecated (§9): kept accepting because an older or remote fork CLI still sends them, and
// narrowing the nested enum would reject the whole summary. The new host never sends them.
subagentCount: z.number().int().nonnegative().optional(),
runningSubagentCount: z.number().int().nonnegative().optional(),
// Latest side chats, newest first, capped (§1).
childSessions: z.array(childSessionSchema).optional(),
```

`childSessionSchema` = plain object `{ sessionId, title, taskType: enum(selection_side_chat | subagent_child), lastActivityAt, running: boolean, backgroundWorkId?: string }` — the subagent-only parts are deprecated (§9.2). Flat optional fields plus one bounded array keep the projection upsert equality cheap (`areTaskMetaJsonFieldsEqual` already compares JSON fields); the summary schema is a plain `z.object()`, so old CLIs/UIs ignore unknown fields — the same compatibility pattern as `executionWorktreeMissing`. The children-membership doc comment in `task-list-session-membership.ts` stays true: children get no workspace bucket of their own; counters and the list ride the parent's summary.

### 3. Host computation and heat control

- Cold path (`loadStoredSessionSummaries`, `zcode-protocol/v4-bridge.ts`, async): one `countChildSessions` + one `listChildSessions` batch for all listed session ids of the workspace seed; seed those facts into the same resolver cache before loaded-session overlays run. Parents found with children seed the live resolver's tracking set.
- Live path (`getSessionIndexMeta` host hook, synchronous, per session): served by `createChildSessionFactsResolver` (`zcode-protocol-v4/child-session-facts.ts`, unit-tested directly) — a per-parent TTL cache (1 second) refreshed asynchronously that serves stale values until a refresh lands. Only parents known to have children are refreshed, so plain workspaces issue no store queries; a failed refresh backs off a full TTL so a broken store cannot turn every fan-out into a retry-and-warn loop.
- Resolution is side chats only (§9.1): `sideChatCount` and `childSessions` with `running: false`; no busy counting, no detached-child or background-work lookups, no subagent-driven invalidation. Side-chat parent discovery from live session records stays (it keeps those parents refreshing).
- Event order on child activity: the host records the child → invalidate that parent's cached facts → publish the current parent summary without changing its activity timestamp → refresh store facts asynchronously (TTL-limited; an invalidation inside the TTL schedules one trailing refresh at the first eligible instant) → publish the parent summary again with refreshed values. The index publisher conflates unchanged summaries. Child events never change the parent's `lastActivityAt`, and `ModelStreaming` never enters this path (streaming does not change child membership).
- Facts follow one complete production projection: session summary → Window Controller overlay → strict task metadata → task-index/session join → grouped sidebar row. Optional fields omitted by the current session summary clear stale child metadata at each join. A child event for a parent not loaded in a conversation runtime updates that parent's existing cold sessions-index summary in place, preserving its activity timestamp and starting no parent runtime.

### 4. UI: icon segment on the row + one-level child list under it

- No toggle, no menu item, no setting anywhere: the row gets ONLY the icon marker.
- Rendering in every desktop sidebar view (§7): the grouped row `packages/ui/src/project-sidebar/grouped/task-row.tsx` (both render chains) and the shared `TaskListItem` row get a compact icon-segment marker (`ChildSessionCountsMarker`, styled exactly like the neighboring clock/moon/`WorktreeTaskMarker` meta icons — `size-3.5`, the row's muted meta color, no highlight, tooltip via `title`) appended to the right-side metadata group. In the interactive chain it sits OUTSIDE the hover-suppressed metadata span (between it and the hover-action cluster), because the marker doubles as the expander and must stay clickable while hover swaps metadata for actions; the drag-overlay chain renders it display-only. Side chats = message-circle glyph + tabular `sideChatCount`. The segment renders only when its count is non-zero (no zero chips); zero children → nothing rendered, no layout reservation — plain sessions keep today's layout byte-for-byte.
- Child list: clicking the marker expands/collapses a one-level list of child rows directly under the parent row (the marker is the expander — `aria-expanded`, no extra chevron; the click stops row propagation so it does not select the task). Children render inside the parent row's column below the title line — the same mechanism as workflow run lines — so the virtualized row model is untouched and the row simply grows (rows are already variable-height). Visual language reuses existing precedents only: the nesting rail of grouped content (`TASK_GROUP_CONTENT_CLASS` `ml-4 border-l pl-2`) and the below-title scale of workflow run lines — child row: message-circle glyph (`size-3`), title `text-ui-sm text-foreground-subtle` truncating, trailing `text-ui-xs text-foreground-subtlest` relative time. Beyond the cap: a trailing `text-ui-xs text-foreground-subtlest` `+N more` row (navigates to the parent conversation).
- Expansion state is per-parent, per-device, collapsed by default, in `localStorage` (`lib/childSessionExpansionPreference.ts`, the `workspaceExpansionPreference` pattern) — deliberately NOT `setting.json` (fork-unsafe — upstream writes strip unknown keys) and NOT broadcast-synced (UI-local preference).
- Navigation on child click (side chats): the child session opens as the active conversation through the row's regular `onSelectTask` path with `options: { selectionSideChat: true }` (§7) — writable, with restricted commands.
- Plumbing: `packages/ui/src/v4/mapSessionSummaryToTaskMeta.ts` carries `sideChatCount` and the bounded array into `ZCodeTaskMeta` (`packages/shared/src/zcode-task-types-core.ts`, flat optionals); row metadata equality in `useWorkspaceActiveTaskState.ts` and the projection upsert equality (`sessions-index-projection.ts`) include them so a counters- or list-only change emits a delta.
- i18n: the visible row text is icon + number only; sentence forms live in the marker tooltip, child-row accessible names, and aria-labels. Keys (`taskList.childSideChatsCount`, `taskList.childSideChatRowLabel`, `taskList.childMoreLabel`) in `en-US`, `zh-CN`, `uk-UA` with correct plural categories (uk-UA needs the three-form Slavic plural).

### 5. Compatibility

Old UI + new CLI → unknown summary fields ignored. New UI + old CLI → fields absent or subagent-only entries filtered (§9.3) → side chats only. Remote workspaces: counts and the list are computed in the CLI host that owns the session store (correct machine end-to-end); expansion state is per-device renderer state.

### 6. Subagents spawned inside a side chat (right-pane navigation)

Side chats are real sessions, so an `Agent`/`Task` call inside a side chat spawns a real `subagent_child` whose `parent_id` is the side chat session. Clicking that subagent's summary row (or the status panel entry) must open it as a right-pane `subagent-session` tab — the same behavior the main task already has:

- The tab's own identity keeps the true lineage: `parentSessionId` = the side chat session id that spawned it.
- The tab's visibility root is the main task, not the side chat: `rootSessionId` = the side chat tab's `parentSessionId` (the main task). Switching the main task hides/restores the tab; opening it inside the side chat never scopes the tab to the side chat session.
- The side chat pane forwards the existing `onOpenSubagentSession`, `onOpenSubagentDirectory`, `onOpenBackgroundBash` and `onSyncSubagentSessionTabs` handlers unchanged and passes `rootSessionId` to `SessionPane`, so the host, not the card, owns the root injection. The side chat's tab-sync collector prunes only its own tabs (`parentSessionId` = side chat); the main task's direct child tabs are untouched.
- The sidebar child list stays one level deep: it lists the side chat as a child of the main task and does NOT nest the side chat's subagents. Navigation to a nested subagent is the right pane's job. No new runtime, session, owner, queue, or delivery path is created.
- Pane bindings: read-only intent belongs to the selected subagent pane binding — another pane in the same workspace stays writable. Pane binding persistence retains its child capability (`subagent_child` read-only or `selection_side_chat` writable with restricted commands), including draft-owned split layouts and renderer reload recovery. Restored children are validated by explicit session ID and task type through the existing `session/list` explicit-ID query (reads persisted identity and task type without starting a runtime); the bounded top-level sessions-index list is not proof that a child session is missing, and a missing or non-subagent target still closes the restored pane.

### 7. Every sidebar view renders the marker and child list

The same facts render the same marker and child list in every desktop sidebar view (grouped, projects, timeline, pinned).

- One component path: `ChildSessionCountsMarker` and the child list (`components/TaskChildSessionRows.tsx`, moved from `project-sidebar/grouped/`) plus one expansion hook (`useChildSessionsExpansion`, backed by `childSessionExpansionPreference`). Both rows use them; neither keeps its own copy of the expansion state.
- `TaskListItem` renders the marker only when its owner passes `onSelectChildSession(sessionId, options)`. `ProjectTaskRow` passes it (binding the parent's `workspacePath` / `workspaceIdentity`); other `TaskListItem` users (web remote mobile rows, session manager) do not, so their rows are unchanged — mobile stays out of scope.
- Marker placement mirrors the grouped row: right of the hover-suppressed metadata span, before the hover-action cluster, hidden while a pending interaction badge owns the status slot. The child list renders below the title line, after the workflow run lines; the leading slot aligns to the first line whenever either below-title lane is present.
- Navigation contract: `ProjectSidebarProps.onSelectTask` declares the optional sixth `options: { readOnly?, selectionSideChat? }` argument the shell handler (`WorkspaceShellLayout.handleSelectTaskInChat`) already accepts. A side-chat child opens writable with restricted commands; the overflow row opens the parent without options. Child rows also pass `parentTaskId` — children are absent from the top-level tree, so navigation resolves the owning parent for remote workspace attachment, the remote session id and stale-navigation checks, while the child id stays the conversation target. Opening a remote child therefore works when the parent's workspace tab is closed.
- Row memo equality (`areTaskListItemTaskFieldsEqual`) includes `sideChatCount` and `childSessions`, so a counter- or list-only summary update re-renders the row.
- Navigation path: every wrapper between the row and `WorkspaceShellLayout.handleSelectTaskInChat` forwards the sixth `options` argument (`useProjectTaskNavigation`, the grouped `TaskGroupedView` adapter). Dropping it loses the child-specific semantics (observed as a writable composer on a subagent).
- Data path: the ported `project-sidebar` builds rows from the project tree (task index) and overlays live facts from the controller rows. The controller registry exposes `readTaskOverlays()` — per online row, `activity` and/or `childFacts` (`pickTaskChildSessionFacts(row.meta)`, defined fields only) — and `applyProjectTaskOverlays` spreads `childFacts` onto the matching tree row. Rows without facts keep their identity; the task index never stores child facts. The no-registry fallback (`useWorkspaceSessionsIndexItems`) carries the same facts from mapped session summaries.
- Known limitation: child facts exist only for workspaces whose Host sessions-index is seeded (§3 cold path). A workspace whose Host has not loaded its sessions-index yet shows no marker until one of its tasks is opened. Eager seeding for every listed workspace is a separate decision (Host cost).
- Phones: the web remote switcher resolves tasks from the top-level tree and cannot open a child, so both the `TaskListItem` owner and the grouped row hide the marker when `isWebRemoteControl`.

Acceptance: in the grouped view, projects view (default), timeline view and pinned section, a parent with a side-chat child shows the message-circle marker; clicking it expands the child row; clicking the child opens it (§4); expansion state is shared across views for the same parent id.

### 8. Live children, right-pane open, stop (superseded by §9)

Superseded. This section added running subagents inline on a collapsed parent, a subagent opening in the right-pane `subagent-session` tab from the sidebar (the `pendingSubagentOpen` / `subagentTarget` path), and a Stop control for running background subagents (`cancelBackgroundWork` per `backgroundWorkId`). §9 removed all of it from the sidebar; only the deprecated wire fields survive (§9.2). Subagents are reached from the parent conversation (Agent rows open the right-pane tab) and stopped from the status panel.

### 9. Side chats only (2026-10-24, supersedes §8 and the subagent parts of §1–§7)

The sidebar shows side chats only. Subagents are no longer listed, counted or controlled from the sidebar; they stay reachable from the parent conversation (Agent rows open the right-pane `subagent-session` tab) and stoppable from the status panel.

**9.1 Producer (CLI host).** `countChildSessions` / `listChildSessions` scope their SQL to `selection_side_chat` (live, not tombstoned). `countChildSessions` returns `{ sideChats }` per parent; `ChildSessionInfo.taskType` is `selection_side_chat`. The cap (`SESSION_SUMMARY_CHILD_SESSIONS_MAX`) and the true total therefore apply to side chats alone, so a parent with many subagents can never push its side chats out of the list. `child-session-facts` resolves `sideChatCount` and `childSessions` (each `running: false`) only: no busy counting, no detached-child or background-work lookups, no subagent-driven invalidation. Side-chat parent discovery from live session records stays (it keeps those parents refreshing).

**9.2 Wire compatibility.** The summary and task-meta schemas keep `subagentCount`, `runningSubagentCount`, `childSessions[].running`, `childSessions[].backgroundWorkId` and the `subagent_child` enum value, marked deprecated: an older or remote fork CLI still sends them, and narrowing the nested enum would reject the whole summary. The new host never sends the subagent counters or `backgroundWorkId`.

**9.3 Consumer.** One filter at the renderer mapping (`mapSessionSummaryToTaskMeta` and the controller overlay `pickTaskChildSessionFacts`) drops `subagent_child` entries and the subagent counters, so an old CLI degrades to side chats only. The marker renders only the message-circle segment (`sideChatCount`); the child list shows side chats, collapsed by default (no running-inline rows); the overflow row counts `sideChatCount − shown`. Removed: the bot segment and its running form, the §8 live rows, the §8.2 sidebar→right-pane subagent open, the §8.3 sidebar Stop, and their i18n keys.

**9.4 Side-chat context menu.** A child row owns its own context menu; right-click never reaches the parent row's menu (grouped `ContextMenuTrigger` and flat `<li onContextMenu>`). Items: **Open** (same as click: main pane, writable with restricted commands) and **Copy session ID** (the side chat's id, through the existing copy helper and `appHeader.copySessionId` label). The menu content mounts only while open. The parent's hover card may still show over child rows (accepted).

**9.5 Separate hover.** The side-chat list renders as a sibling of the parent row's hover/press/context-menu/hover-card/drag target, not inside it (supersedes the §4/§7 "inside the parent row's column" placement): grouped view — after the row's `ContextMenu` inside the same measured virtual item, with the row's left padding; projects/timeline/pinned — a separate `<li>` after the row, offset to the title column (row padding + leading slot + gap). Hovering the parent fills only the parent row; hovering a side chat fills only that side chat, and the parent shows no hover actions. The gap `<li>` stops `contextmenu` so the list-level task menu cannot open for a stale task. Workflow run lines stay inside the row.

Acceptance (§9):

1. A parent with 3 side chats and 10 subagents shows the message-circle marker `3` and no bot segment; expanding lists the 3 side chats and no subagent rows; no `+N more`.
2. A parent with only subagents shows no marker and no child list.
3. Old CLI sending subagent rows and counters → the same rendering as 1–2 (consumer filter).
4. Right-click on a side-chat row opens the side-chat menu, not the parent's; **Open** opens the side chat; **Copy session ID** copies the side chat id.
5. Running subagents produce no spinner, row or Stop in the sidebar.
6. Hovering a side-chat row highlights only that row (no parent fill, no parent hover actions); hovering the parent highlights only the parent row, not its side-chat list.

## Acceptance scenarios

1. Session with 2 side-chat children → row shows the message-circle segment `2`; no other layout change.
2. `/side` chat created from a selection → parent's `sideChatCount` becomes 1 and the chat appears in the expanded list within the TTL + next fan-out.
3. Marker click → child list expands beneath the row; click again → collapses; expansion state survives reload (localStorage, per parent).
4. Plain session without children → summaries may carry absent fields, row renders byte-identical to today; no zero segments render.
5. A fork (taskType `fork`, has a parent) is NOT counted; tombstoned children are NOT counted; workflow children remain invisible (no double display next to the workflow mini-track). The fork `time_archived` column is not a filter (upstream has no CLI archive; `specs/upstream-sync-cli-divergences.md`).
6. CLI restart with cold children → counts and list restored from the store.
7. Old UI + new CLI and new UI + old CLI → no parse errors; side chats render, subagent entries degrade to side chats only (§9.3).
8. A summary whose only change is a counter or a child-list entry emits a projection delta (not conflated away).
9. Click a side-chat row → that session opens as the active conversation, writable with restricted commands; more children than the cap → `+N more` trailing row; icon counts still show the true totals.
10. An in-TTL invalidation retains stale facts and refreshes at TTL expiry; streaming chunks do not publish parent-summary refreshes; an idle parent with a child event gets refreshed facts while its `lastActivityAt` remains unchanged.
11. Cold summary facts survive the live overlay and pass through the controller projection, strict metadata validation, and task-index/session join; absent facts clear stale values.
12. A subagent spawned inside a `/side` chat opens as a right-pane `subagent-session` tab: the request carries `parentSessionId` = the side chat session and `rootSessionId` = the main task, the tab is visible under the main task and hidden under the side chat, and the side chat's sync only prunes its own tabs. A restored child pane survives top-level-index omission when the `session/list` query confirms its subagent type; a separate pane in the same workspace remains writable.

## Validation

- `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed` (bootstrap typechecks against core dist — rebuild core first when types change).
- Unit: `countChildSessions` / `listChildSessions` grouped queries on a temp store (adapters tests); bridge TTL cache behavior, stale-serve, failure backoff (bootstrap tests, `child-session-facts.test.ts`); projection equality + `deriveSessionSummary` field propagation (`sessions-index-projection.test.ts`); `mapSessionSummaryToTaskMeta` mapping; marker rendering for zero/segment cases, child-list expand/collapse and overflow, separate hover and context menu, navigation wiring (packages/ui/test); i18n parity via the node:test catalog test.
- The sidebar isolation E2E places the parent row in grouped mode and locates it by the grouped-row key before checking the expanded child row.

## Out of scope

- Multi-level nesting, drag-and-drop, pin-subtree (Copilot-style tree).
- Closing or opening side chats from the sidebar row.
- Per-type toggles or any host-side/fork-settings storage (no toggle at all).
- Counting `workflow_child` / `nested_workflow_child` (owned by `workflowActivity`).
- Realtime counter push on child completion.
- Mobile/web task-index row rendering of the counters or list (shared summaries carry them; phones hide the marker, §7).
