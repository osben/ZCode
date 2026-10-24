# Mobile Remote Control Task Home Page Redesign

> **Status: implemented.** Code entry points: `packages/ui/src/WebRemoteControlMobileShell.tsx`,
> `WebRemoteControlMobileTaskHome.tsx` and `hooks/useWebRemoteControlTaskOpen.ts`.
>
> The remote control path uses external relay `data.payload` app payloads. The task home page and workspace
> switching interactions below remain valid; old relay tokens, HTTP bootstrap and `bridgeToken/wsUrl`
> assumptions are deprecated.

See [Web Remote Control Overview](./web-remote-control-architecture.md) for product and architecture. This
document records the interaction contract between the mobile home page and the chat page; timelines, themes
and wide-screen lists are navigated from the overview.

Full history: `git show b8876e8b:docs/web-remote-control/mobile-task-home-design.md`

## Background

Mobile Web remote control used to reuse the desktop `WorkspaceSidebar` and chat area: on small screens
`WorkspaceShellLayout` stacked a cropped desktop sidebar over the desktop chat area. That is quick to build but
does not fit the mobile information architecture. The mobile client is now two explicit pages: a home page
(workspaces and task lists of the current device) and a chat page (after selecting a task, still reusing
desktop chat components). Task clicking, cross-workspace switching and mobile view state reporting still reuse
the desktop remote control path.

## Goals

1. The home page shows workspace cards that expand to the workspace's tasks.
2. Clicking a task enters the chat page, reusing the existing header and the V4 session chat surface.
3. Task click logic reuses the Web remote control logic: same-workspace task -> select it and report mobile
   view state; cross-workspace task -> request a new workspace bridge, then enter the task.
4. The QR code initial state no longer enters the chat page automatically.
5. If the QR entry carries an initial task, the home page expands the owning workspace card and marks the task row selected.
6. Desktop and mobile selection states stay separate; mobile operations do not switch the desktop's current tab/task.
7. Identity isolation: `workspaceKey = workspaceIdentity?.trim() || workspacePath`.

## Non-goals (first version)

Creating workspaces on mobile; creating new SSH / WSL / Docker remote sessions on mobile; managing workspaces
outside desktop windows; several mobile devices controlling one desktop window; redoing chat components, the
ZCode runtime or the main relay protocol path; the desktop automatically switching to the task selected on mobile.

## Workspace-level "New Task" entry (2026-05-02)

Each workspace card on the task home page has a "New Task" button on its right:

1. Same workspace: call `startDraft(workspacePath, workspaceIdentity)` to enter draft mode; report
   `updateMobileViewState(workspaceKey)` (without taskId) so the old task is not still highlighted; enter the chat page.
2. Cross-workspace: `switchWorkspace(workspaceKey, { mobileNavigationIntent: "chat" })` without `taskId`; the
   target Root starts with `initialTaskId=undefined` and enters that workspace's draft mode.
3. The Web remote control `switcher` gains an optional `startDraft(workspaceKey, { mobileNavigationIntent })`
   capability; implementations without it fall back to `switchWorkspace + updateMobileViewState`.

## Solution

Use a mobile-specific shell instead of continuing to modify `WorkspaceSidebar`:

```text
WebRemoteControlMobileShell
  ├── home: WebRemoteControlMobileTaskHome
  │     └── workspace card list
  │           └── task rows
  └── chat: existing chat header + V4 session chat surface
```

Desktop and wide-screen Web remote control keep the existing `WorkspaceShellLayout` desktop layout. The
two-page mobile shell activates only when `webRemoteControlWorkspaceSwitcher` and the small-screen breakpoint
are both met. Benefits: the home page UI is designed for mobile without the sidebar's history; the chat page
reuses existing chat capabilities; task clicking, workspace bridge and mobile view state are extracted into a
shared hook; later home page evolution (search, status filter, device login state) does not pollute the desktop sidebar.

## Page model

### Home page

Browses the workspaces and tasks currently open in the desktop window.

1. Top brand and device status: `ZCode Remote Control` plus connection status (no device-name protocol field in the first version).
2. Closable notice area: the current session's projects, tasks and sessions can be viewed on this device; after the QR code expires, return to the desktop to reconnect.
3. Workspace task area: title (workspaces and tasks on the current device), subtitle (total workspace/task count), actions collapse all and refresh.
4. Workspace card: name, path, weak label (local / remote in the first version), last update time (the maximum
   `updatedAt` of its tasks; not shown when it has no tasks), task count, expand/collapse button.
5. Task row: title, provider CLI, update time, status pill, unread/running/error indicators; the selected task uses the selected style.

Pinned section (2026-05-28): the top of the home page has a global pinned section. The desktop renderer's task
snapshot sync reads the sqlite lists `kind: "pinned"` and `kind: "timeline"`; the home page splits out the
pinned section by `pinned === true` and passes the rest to the normal workspace/timeline lists. Pinned tasks no
longer repeat in normal workspace cards or timeline lists, but active-task validation and selection state must
match both the pinned section and the normal grouping.

The home page owns its own scroll area and does not depend on the desktop sidebar's scroll container.

### Chat page

Reuses the existing workspace main content: a mobile-simplified chat header at the top; a home-page entry; the
body keeps the Root-injected V4 chat content (carried by `packages/ui/src/v4/SessionPane.tsx`); terminal,
browser and side pane display rules follow the existing remote control strategy (not extended proactively).

### Chat page interaction overlay boundaries

The chat page reuses desktop session components with the same overlay hierarchy and interaction modes; mobile
only tightens overlay sizes. Under `web-remote-replayable` with a coarse-pointer mobile viewport:

1. After opening, interactable content lies fully inside the visible viewport; left and right are not clipped by the page root.
2. Model selection keeps the desktop provider first-level menu and model second-level menu; the mobile model
   submenu uses a narrower width cap and shrinks to the viewport edge via Radix's available width in the
   current direction (drop the shared menu's minimum-width lower bound when shrinking); long model names
   truncate inside menu items, and the two levels never collapse into a single-column long list.
3. Branch selection and the Todo collapsed preview in the right status panel prefer to open vertically,
   flipped by Radix between top/bottom; not pinned to the left of the status panel.
4. A single overlay is at most `calc(100vw - 2rem)` wide; long model names, branch names and mixed-language
   text truncate or scroll inside the overlay, without page-level horizontal scrolling.

```text
Current (mobile)
provider root menu -> desktop-width model submenu -> viewport clip
status panel row    -> forced left popover             -> viewport clip

Post-fix (mobile)
provider root menu -> narrow model submenu (keeps second-level interaction)
                   -> min(desired width, Radix available width) -> viewport edge
status panel row    -> bottom/top popover                       -> viewport collision handling

Desktop / wide-screen Web
provider root menu -> desktop-width model submenu (unchanged)
status panel row    -> left popover (unchanged)
```

This is renderer presentation only; it does not change mobile shell navigation, task/session projection,
`CommandInbox`, owner/lease, relay, or `desktop-continuous` / `web-remote-replayable` delivery semantics.

## QR code initial state

The desktop main returns the workspace/task at QR initiation through `initialViewState`.

1. Bootstrap still selects `mobileViewState -> initialViewState -> first workspace`.
2. The web opens the corresponding workspace bridge so the current Root/App has an available workspace service.
3. The mobile shell's initial page is fixed to `home`.
4. The home page expands the workspace card by `activeWorkspaceKey` and marks the task row selected by `activeTaskId`.
5. It does not enter the chat page automatically.

`initialTaskId` here only expresses "home page selection state"; it cannot trigger `onNavigateToChat` or reuse
the task click opening flow. So after scanning, the user first sees an overview of all workspaces/tasks and
knows under which workspace the QR task lives.

## Task click flow

Task opening logic is extracted from the existing `WebRemoteControlTaskIndex` into a shared hook:

```text
useWebRemoteControlTaskOpen
  input:
    switcher
    activeWorkspacePath
    activeWorkspaceIdentity
    activeTaskId
    onSelectTask
    onNavigateToChat
    onSwitchingChange

  output:
    openTask(task)
    switchingTaskKey
    error
```

Entering the chat page after a cross-workspace switch needs a one-time navigation intent that cannot be deduced from `initialTaskId`:

```ts
type WebRemoteControlMobileNavigationIntent = "chat";

interface WebRemoteControlWorkspaceSwitchOptions {
  taskId?: string;
  mobileNavigationIntent?: WebRemoteControlMobileNavigationIntent;
  markTaskReadExpectedUnreadAt?: number;
}

interface WebRemoteControlMobileShellProps {
  initialNavigationIntent?: WebRemoteControlMobileNavigationIntent;
}
```

Rules:

1. The second parameter of `WebRemoteControlWorkspaceSwitcherApi.switchWorkspace()` is extended to
   `WebRemoteControlWorkspaceSwitchOptions`; old calls without `mobileNavigationIntent` behave as before.
2. The web entry stores `mobileNavigationIntent` in memory as a pending intent before calling `openWorkspaceBridge()`.
3. When rendering Root/MobileShell for the new bridge, the pending intent is passed as `initialNavigationIntent`; MobileShell consumes and clears it after first mount.
4. The pending intent is not written to the URL or `mobileViewState` and not passed to desktop main; it only solves the page landing after a cross-Root remount.
5. The QR initial `initialTaskId` sets no pending intent, so it only expands the card and selects the row.

Same-workspace task:

1. Compute `taskWorkspaceKey` and check it equals the current `activeWorkspaceKey`.
2. If the home snapshot task has `unreadAt`, explicitly call `setTaskUnread(..., false)` through the current
   bridge's `switcher.markTaskRead(task)`; this must not depend on whether the mobile Root's task query cache is hydrated.
3. Call `onSelectTask(task.workspacePath, task.taskId, task.workspaceIdentity)`, then
   `switcher.updateMobileViewState(taskWorkspaceKey, task.taskId)`, then switch the shell to `chat`.

Cross-workspace task:

1. Set the switching state.
2. Call `switcher.switchWorkspace(taskWorkspaceKey, { taskId: task.taskId, mobileNavigationIntent: "chat", markTaskReadExpectedUnreadAt: task.unreadAt })`.
3. After the Web end connects to the target workspace's shared-host bridge, use the target bridge's
   `workspacePath/workspaceIdentity` and the home snapshot's `unreadAt` to call
   `setTaskUnread(..., false, expectedUnreadAt)`; failure only logs and does not block opening the task.
4. After the new bridge renders, the Root receives `initialTaskId` and selects the task.
5. MobileShell consumes the one-time navigation intent carried by this click flow and enters `chat`.
6. On failure, `logger.error` and stay on the home page showing the error.

The QR initial task only affects home selection state and does not call this flow.

### Unread clear boundary after mobile opens a task

The blue dot on the mobile home page comes from the desktop renderer's pushed
`WebRemoteControlTaskTarget.unreadAt` snapshot; the mobile Root's task query cache is a separate, asynchronously
hydrated data surface. On a task click, whether the query cache hits `unreadAt` is not a precondition for
clearing unread (otherwise an already-active task, a cold cache or a cross-Root remount would skip persistence).

```text
mobile home snapshot task.unreadAt
  │
  ├─ same workspace -> current bridge markTaskRead(expectedUnreadAt)
  │                     -> tasks-index compare-and-clear
  │
  └─ cross workspace -> switch option markTaskReadExpectedUnreadAt
                         -> target bridge connected
                         -> target service compare-and-clears tasks-index unreadAt

desktop task selection -> existing query-cache optimistic clear (unchanged)
```

1. Only a home page click with an explicit `unreadAt` in the snapshot triggers a write; read tasks produce no mutation.
2. Same workspace uses the current bridge service; cross-workspace waits for the target bridge before using the target service; main/relay never hold or modify task business state.
3. The target parameter passes `workspaceIdentity`; path execution semantics keep using `workspacePath`.
4. A failed mark-as-read must not block navigation; after returning to the home page the authoritative tasks-index snapshot decides whether the blue dot returns.
5. Desktop `desktop-continuous` `useWorkspaceTaskNavigation`, query-cache overlay, sorting and `lastActivityAt` stay unchanged; this action exists only in the mobile Web remote control switcher.
6. Mobile read-only confirms the notification of this home snapshot: the repository compares the current
   `unreadAt` with `expectedUnreadAt` inside one atomic write boundary; clear when equal, otherwise return the
   current meta and emit no change event, so a late old click cannot override a later background-completion or error unread.

## Component split

1. `packages/ui/src/WebRemoteControlMobileShell.tsx`: the two-page shell; manages `home/chat` state and return
   to home; consumes the one-time `mobileNavigationIntent`; holds the switching overlay.
2. `packages/ui/src/WebRemoteControlMobileTaskHome.tsx`: renders the home page; loads workspace/task snapshots;
   manages card expansion; initializes expansion and selection from the active workspace/task.
3. `packages/ui/src/hooks/useWebRemoteControlTaskOpen.ts`: task opening logic extracted from
   `WebRemoteControlTaskIndex`; reusable by the mobile home and the old task index.
4. `packages/ui/src/lib/webRemoteControlTaskIndex.ts`: keeps and extends grouping, sorting and default expansion key calculation.
5. `packages/ui/src/app-shell/WorkspaceShellLayout.tsx`: renders `WebRemoteControlMobileShell` under the mobile
   remote control breakpoint; removes the mobile dependency on the top sidebar height drag; desktop remote
   control layout unchanged.

## Data model

`WebRemoteControlTaskTarget` already carries the fields the home page needs: `taskId`, `title`,
`workspacePath`, `workspaceIdentity`, `remoteSessionId`, `workspaceLabel`, `workspaceKind`, `createdAt`,
`updatedAt`, `provider`, `unreadAt`, `pinned`.

Derived display fields: the first version adds no `deviceLabel` protocol field (it shows connection status; a
real device name would extend `WebRemoteControlWindowBootstrapResult` / `WebRemoteControlWorkspaceListResult`
with an optional `deviceLabel` and keep connection status text as fallback); the workspace card's last update
time adds no `workspaceUpdatedAt` field and is derived as the maximum task `updatedAt` after grouping.

Optional display fields for the status pill:

```ts
displayStatus?: "idle" | "running" | "completed" | "error";
// 2026-09-09 note: Whether the session has background work (dynamic workflow run / background bash / detached subagent).
// Only participates in list running-layer sorting, does not affect displayStatus; source is hasBackgroundWork from the sessions-index sidecar.
hasBackgroundWork?: boolean;
// 2026-09-14 note: Workflow run summary (<= 4 runs: running first, then most recently ended), source is workflowActivity from the sidecar.
// Mobile rows draw a Workflow icon + mini track light + current phase name (24px, 13px text) under the title; only drawn, not participating in sorting or status pills.
workflowActivity?: SessionWorkflowActivity;
```

`displayStatus` sources are layered by authority; multiple caches are not peer facts:

1. When the task row carries the sessions-index activity sidecar, the real-time `phase` is the sole authority:
   `prewarming` / `running` -> `running`; `completedSuccess` / `completedInterrupted` -> `completed`; `error` ->
   `error`; `draft` produces no persistent task row (if compatible data brings `draft`, do not treat it as a terminal state, continue to the next fallback).
2. Without sessions-index activity, read the renderer's task runtime cache: live statuses (`creating` /
   `queued` / `streaming` / `waiting_permission` / `waiting_user_input` ...) -> `running`; `failed` -> `error`; `completed` -> `completed`.
3. Without an explicit runtime state, read the tasks-index persistent terminal state: `completed` -> `completed`; `error` -> `error`.
4. A standalone persistent `status=running` only means the old process may not have ended normally and does not
   prove the host is still running; fall back to `idle`.

The priority covers all conflict directions:

- sessions-index `prewarming` / `running` over old `completed` / `failed` / `error` -> `running`.
- `completedSuccess` / `completedInterrupted` over live / `failed` / `running` -> `completed`.
- `error` over live / `completed` / `running` -> `error`.
- Missing or compatible `draft`, any old state -> keep the current runtime -> persistent terminal fallback.

So new sessions-index frames can advance an old `completed/error` cache to `running` and settle an old live
cache to `completed/error`; the mobile home page does not merge these sources itself.

Aggregation boundaries:

1. `displayStatus` is computed by the desktop renderer when building `WebRemoteControlTaskTarget` snapshots;
   `buildWebRemoteControlTaskTargets()` reads task-row sessions-index activity first, then falls back to
   Zustand task runtime state and `ZCodeTaskMeta.status` in the order above.
2. The mobile home page only consumes `WebRemoteControlTaskTarget.displayStatus` and never reads ZCode runtime, Repo, Service or persistence implementations.
3. The sync chain stays renderer `syncWebRemoteControlTasks()` -> desktop main -> relay -> mobile bootstrap/listWorkspaces; no new mobile-side status query entry.
4. Changes to sessions-index activity or compatible task runtime state must rebuild and sync the task snapshot so the pills do not lag until the next list refresh.
5. The field is for mobile home display only and does not change the true state source of the ZCode runtime; when old data is missing the mobile frontend falls back to `idle`.

### Home page snapshot push dedup boundary

Desktop main only dedups transport of the renderer-built `WebRemoteControlWorkspaceListResult` and neither owns
nor re-interprets task business state. The dedup signature must cover fields the home page must adopt at once
but that change only at lifecycle nodes or user operations:

1. Tasks: `title`, `unreadAt`, `displayStatus`, `pinned`, `archived`, `remoteSessionId`.
2. Workspace connection state: `kind`, `connectionState`, `remoteSessionId`, `lastConnectionError`.
3. Stable identity fields of tasks/workspaces keep participating, so additions, deletions and cross-workspace membership changes are visible.

Fields normalize to mobile display semantics: missing `displayStatus` = `idle`, missing `connectionState` =
`connected`, missing optional strings = empty string, missing boolean memberships = `false`. Any change of
these effective values must send a new `workspace-list-updated`.

`updatedAt` comes from sessions-index `lastActivityAt` and changes often during streaming text and tool events.
It is not in the immediate push signature; real-time refresh of relative times and time sorting needs a
separate throttle/merge design, and each streaming event must not push the whole task home snapshot.

```text
Low-frequency display/connection field changes --> main snapshot signature changes --> workspace-list-updated --> mobile immediate adoption
High-frequency updatedAt changes ---------------> not a full-table immediate push (throttle/merge boundary kept for later)
```

### Status projection boundary

The status precedence is presentation / state-source precedence only and does not change session commands,
runtime, persistence or recovery protocols.

```text
sessions-index phase (real-time activity) ───────────────┐
                                                         ├─> desktop renderer target projection
renderer runtime cache (fallback only when activity is missing) ┤       └─> relay payload --> mobile status pill
tasks-index terminal status (last fallback) ───────────────┘

desktop task list -- sessions-index continuous projection (existing path kept)
mobile /remote ----- renderer task snapshot + replayable delivery (only payload fields corrected)
```

Must preserve:

1. Relay, desktop main and shared-host attachment only pass through and hold no task/session business state.
2. Snapshot/gap, owner and queue semantics of desktop `desktop-continuous` and mobile `web-remote-replayable` are unchanged.
3. tasks-index keeps owning persistent rows/membership; sessions-index activity owns only real-time phases.
4. `workspaceIdentity?.trim() || workspacePath`, `remoteSessionId` and pinned/archived membership are unaffected by status merging.
5. Mobile running-first sorting keeps consuming the final `displayStatus`; stale caches no longer wrongly pin terminal rows to the top or push true running rows back to time sorting.

Focused regression covers all phase and conflict-cache combinations; no conversation E2E was added because
there is no new interaction, command or delivery behavior (runtime NDJSON showed sessions-index publishes the
correct phases in the error window; the defect was in pure renderer target projection).

`WebRemoteControlTaskTarget` adds an optional field for the pinned section:

```ts
pinned?: boolean;
```

1. The Desktop renderer reads tasks in `Root` via `useGlobalTaskList({ kind: "pinned" })` and `useGlobalTaskList({ kind: "timeline" })`.
2. `buildWebRemoteControlTaskTargets()` marks `pinned: true` for pinned query results; timeline results are not marked.
3. The mobile home page consumes this field only for sectioning and never reads task repos, sqlite, ZCode services or runtime directly.
4. `workspace_task_list_changed` carries incremental task meta events (title, time, status), not pinned/archived
   membership changes; frontend cache updates must preserve existing list membership so a status refresh does not move pinned tasks out of the pinned section.

## State and routing

The first version has no real URL routing; React state inside the mobile shell is used:

```text
currentMobilePage: "home" | "chat"
```

Entering chat: the user clicks a task; selection succeeds; set `currentMobilePage = "chat"`; if the history
state is not `{ zcodeMobilePage: "chat" }`, push one chat history state.

Returning home: click the header back button; if the history state is `{ zcodeMobilePage: "chat" }`, call
`history.back()` and let `popstate` return to home; with no chat history state set `currentMobilePage = "home"`
directly as fallback; keep the active task's selection.

Browser back key:

1. The shell writes no history when first entering `home`, preserving the QR entry's original history stack.
2. Only when the user clicks a task from `home` and successfully enters `chat` is `history.pushState({ zcodeMobilePage: "chat" }, "")` called once.
3. If already at this `chat` state, do not push again (avoids stacking history from repeated clicks on the same task).
4. `popstate` hitting `{ zcodeMobilePage: "chat" }` sets `currentMobilePage = "chat"`; returning from chat via the back button uses `history.back()` rather than changing state directly.
5. `popstate` to a non-`zcodeMobilePage` state sets `currentMobilePage = "home"` and allows the browser's following default back behavior.
6. After a successful cross-workspace click and Root remount, still push one `chat` state per "user clicks to enter chat", sourced from the click flow's one-time `mobileNavigationIntent`; the QR initial `initialTaskId` adds no such state.
7. Remove the `popstate` listener when the shell unmounts.

Do not put workspace/task state in the URL, to avoid coupling with the QR entry and paired state.

## Style rules

UI follows the root `DESIGN.md`: semantic tokens (`bg-background`, `bg-card`, `border-card-border`,
`text-foreground-subtle`); `rounded-lg` cards, no oversized radii; the home page is a compact, scannable
business tool interface, not a marketing page; light, dark, Zai light and Zai dark; Chinese and English text
lengths; existing `Button` components and lucide icons; stable home scrolling, card height and task row height,
with no uncontrolled horizontal overflow on expand/collapse.

## Logging

The UI layer uses `import { logger } from "@/logger.js";`. Log points: home snapshot load failure (`error`);
mobile view state update failure after a same-workspace task click (`error`); cross-workspace switch start
(`info`); cross-workspace switch failure (`error`); QR initial state cannot match workspace/task (`warn`).
High-frequency rendering and ordinary hover do not log.

## Verification

Run `pnpm typecheck` and `pnpm lint`. Test entry points:

1. `packages/ui/test/webRemoteControlMobileTaskHome.test.ts`: workspaces grouped by desktop return order;
   default expansion of `activeWorkspaceKey`; `activeTaskId` task shows selected; collapse all collapses every card.
2. `packages/ui/test/useWebRemoteControlTaskOpen.test.ts`: same-workspace task calls `onSelectTask` and
   `updateMobileViewState`; cross-workspace calls `switchWorkspace` with `{ taskId, mobileNavigationIntent: "chat" }`;
   on switch failure the error is kept and the switching state cleared.
3. `packages/ui/test/workspaceShellRemoteMobileLayout.test.ts`: mobile shell under the mobile breakpoint,
   existing shell/sidebar otherwise; QR initial task only expands the card and selects the row without entering
   chat; a user task click adds one history state and browser back returns home; after a cross-workspace click
   and Root remount the one-time `mobileNavigationIntent` is consumed to enter chat and then cleared.
4. `packages/shared/test/webRemoteControl.test.ts`: schema/type compatibility for `displayStatus`.
5. `packages/ui/test/webRemoteControlTaskIndex.test.ts`: `buildWebRemoteControlTaskTargets()` computes
   `displayStatus` by sessions-index activity -> task runtime -> `ZCodeTaskMeta.status`; covers live-phase vs
   stale runtime/persisted conflicts in the running, completed and error directions; with missing or
   compatible `draft` activity keeps the runtime/persisted fallback and persistent `running` still creates no fake running.
6. `packages/desktop/test/webRemoteControlManagerExternalRelay.test.ts`: changing only `title`, `unreadAt`,
   `displayStatus`, `pinned`, `archived` or `remoteSessionId` of the same task must push
   `workspace-list-updated`; changing only `connectionState`, `remoteSessionId` or `lastConnectionError` of the
   same workspace must push; an identical effective snapshot is still deduplicated; a high-frequency
   `updatedAt` change alone is outside the immediate push contract.

## Risks

1. A cross-workspace task click recreates the bridge; the new Root's first-frame state must coordinate with the shell page state to avoid flashing the home page before chat.
2. The QR initial state still needs to open the workspace bridge (otherwise the chat page cannot reuse existing services), but the UI must not jump to chat automatically.
3. Remote workspaces must always use `workspaceIdentity` as key; `workspacePath` alone is not enough.
4. `WorkspaceShellLayout` has a lot of remote control mobile layout history; preserve desktop remote control behavior when integrating the mobile shell.
5. If real URL routing is added later, avoid mixing the short-lived `remoteControlToken` with internal task page state.
