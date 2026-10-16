# Mobile Remote Control Task Home Page Redesign

> **Status: Implemented.** The current code entry points are `packages/ui/src/WebRemoteControlMobileShell.tsx`,
> `WebRemoteControlMobileTaskHome.tsx` and `hooks/useWebRemoteControlTaskOpen.ts`; the "recommended/implementation order"
> below preserves design history and does not represent pending implementation status.
>
> The current remote control path uses external relay `data.payload` app payloads. Interactions involving the task home page and workspace switching described in this document remain valid; old relay tokens, HTTP bootstrap, and `bridgeToken/wsUrl` assumptions are deprecated and no longer serve as implementation references.

See [Web Remote Control Overview](./web-remote-control-architecture.md) for product and architecture overview. This document records the interaction contract between the mobile home page and the chat page; timelines, themes, and wide-screen lists are navigated uniformly from the overview.

## Background (Before Redesign)

Before the redesign, the mobile Web remote control reused the desktop `WorkspaceSidebar` and chat area:

1. On small screens, the mobile page was converted to a top-bottom structure by `WorkspaceShellLayout`.
2. The upper half is still a cropped version of the desktop sidebar, including workspace, task entries, and some desktop sidebar capabilities.
3. The lower half reuses the desktop chat area.

This structure quickly reuses existing logic, but is not suitable for the new mobile information architecture. The new goal is to make the mobile client two明确 pages:

1. Home page: workspaces and task lists on the current device.
2. Chat page: the chat interface after selecting a task, continuing to reuse desktop chat components.

The core change is: the mobile client no longer reuses the desktop task list UI, but task clicking, cross-workspace switching, mobile view state reporting, and other business logic continue to reuse the existing desktop remote control path.

## Goals

1. The mobile remote control home page displays workspace cards, which can be expanded to show tasks under that workspace.
2. After clicking a task, enter the chat page, which continues to reuse the existing header and V4 session chat surface.
3. Task click logic reuses the existing Web remote control logic:
   - Same workspace task: directly select the task and report mobile view state.
   - Cross-workspace task: request a new workspace bridge, then enter the corresponding task.
4. The QR code initial state no longer automatically enters the chat page.
5. If the QR code entry carries an initial task, the home page automatically expands the workspace card belonging to that task and displays the corresponding task row as selected.
6. Maintain desktop and mobile selection state separation; mobile operations do not reverse-switch the desktop's current tab/task.
7. Comply with the identity isolation rule `workspaceKey = workspaceIdentity?.trim() || workspacePath`.

## Non-Goals

The first version does not:

1. Create workspaces on the mobile client.
2. Create new SSH / WSL / Docker remote sessions on the mobile client.
3. Manage workspaces outside desktop windows on the mobile client.
4. Multiple mobile devices simultaneously controlling the same desktop window.
5. Redo chat components, ZCode runtime, or the main relay protocol path.
6. Have the desktop automatically switch to the task selected on the mobile client.

## 2026-05-02 Supplement: Workspace-Level New Task Entry

To complete the mobile operational closed loop, add a "New Task" button on the right side of each workspace card on the task home page, with the following behavior:

1. Same workspace:
   - Call `startDraft(workspacePath, workspaceIdentity)` to enter draft mode.
   - Report `updateMobileViewState(workspaceKey)` (without taskId), avoiding continued highlighting of the old task.
   - Enter the chat page.
2. Cross-workspace:
   - Use `switchWorkspace(workspaceKey, { mobileNavigationIntent: "chat" })`, without passing `taskId`.
   - The target Root starts with `initialTaskId=undefined`, entering the draft mode of that workspace.
3. The Web remote control `switcher` adds the optional `startDraft(workspaceKey, { mobileNavigationIntent })` capability,
   facilitating unified mobile client calls; implementations that do not support this capability can still fall back to `switchWorkspace + updateMobileViewState`.

This supplement maintains the existing identity isolation rule: `workspaceKey = workspaceIdentity?.trim() || workspacePath`.

## Recommended Solution

Use a mobile-specific shell, rather than continuing to modify `WorkspaceSidebar`.

It is recommended to add a layer of mobile remote control UI:

```text
WebRemoteControlMobileShell
  ├── home: WebRemoteControlMobileTaskHome
  │     └── workspace card list
  │           └── task rows
  └── chat: existing chat header + V4 session chat surface
```

The desktop and wide-screen Web remote control continue to use the existing desktop layout of `WorkspaceShellLayout`. Only when `webRemoteControlWorkspaceSwitcher` and the small-screen breakpoint are met does the two-page mobile shell activate.

Benefits:

1. The home page UI can be designed entirely for the mobile experience, without being limited by the desktop sidebar's historical structure.
2. The chat page still reuses existing chat capabilities, reducing risk.
3. Task clicking, workspace bridge, and mobile view state do not re-invent the wheel; they are just extracted as a shared hook.
4. If the mobile home page continues to evolve later, e.g., search, status filtering, device login state, it will not pollute the desktop sidebar.

## Page Model

### Home Page

The home page is used to browse the workspaces and tasks currently opened in the desktop window.

Information structure:

1. Top brand and device status:
   - `ZCode Remote Control`
   - The first version displays connection status, without adding a device name protocol field
2. Closable notice area:
   - Explains that the current session's projects, tasks, and sessions can be viewed on this device
   - After the QR code expires, return to the desktop to reconnect
3. Workspace task area:
   - Title: Workspaces and tasks on the current device
   - Subtitle: total workspace/task count
   - Actions: collapse all, refresh
4. Workspace card:
   - Workspace name
   - Workspace path
   - Weak labels: local / SSH remote / Docker / WSL, the first version can use local / remote
   - Last update time, derived from the maximum `updatedAt` of tasks under that workspace; not displayed when there are no tasks
   - Task count
   - Expand/collapse button
5. Task row:
   - Task title
   - Provider CLI
   - Update time
   - Status pill
   - Unread, running, error, and other status indicators
   - The currently selected task uses the selected style

2026-05-28 supplement: Add a global pinned section at the top of the mobile home page. The desktop renderer synchronizes task snapshots simultaneously reading
`kind: "pinned"` and `kind: "timeline"` sqlite lists; after the mobile home page receives unified task targets,
it first splits out the pinned section by `pinned === true`, then passes the unpinned tasks to the normal workspace/timeline lists. Pinned tasks
no longer appear repeatedly in normal workspace cards or timeline lists, but the active task validation and selection state must match both
the pinned section and the normal grouping simultaneously.

The home page owns its own scroll area and cannot depend on the desktop sidebar's scroll container.

### Chat Page

The chat page reuses the existing workspace main content:

1. Keep a mobile-simplified chat header at the top.
2. Add a home page entry.
3. The main body continues to use the Root-injected V4 chat content (ultimately carried by `packages/ui/src/v4/SessionPane.tsx` for sessions).
4. Mobile display rules for terminal, browser, and side pane follow the existing remote control strategy; the first version does not proactively extend.

### Chat Page Interaction Overlay Boundaries

The mobile remote control chat page reuses desktop session components and maintains consistent overlay hierarchy and interaction modes with the desktop; the mobile client only tightens
overlay sizes to avoid introducing another model selection behavior for narrow viewports.
Under `web-remote-replayable` with a coarse-pointer mobile viewport, interaction overlays must satisfy:

1. The interactable content after opening is fully located within the current visible viewport; the left and right must not be clipped by the page root node.
2. Model selection continues to use the provider first-level menu and model second-level menu consistent with the desktop; the mobile client's model second-level menu
   uses a narrower width as the upper bound, and automatically shrinks to the viewport edge via Radix's available width in the current direction; when shrinking, cancel the
   minimum width lower bound of shared menus; long model names are truncated within menu items, without changing first-level and second-level content to a single-column long list.
3. Branch selection and Todo collapsed preview within the right status panel prefer to open vertically, flipped by Radix between top/bottom; do not pin them to the left of the status panel.
4. A single overlay width must not exceed `calc(100vw - 2rem)`; long model names, branch names, and Chinese/English text are handled by internal truncation or scrolling within the overlay, without causing horizontal scrolling at the page level.

Current and post-fix presentation boundaries:

```text
Current (mobile)
provider root menu -> desktop-width model submenu -> viewport clip
status panel row    -> forced left popover             -> viewport clip

Post-fix (mobile)
provider root menu -> narrow model submenu (maintaining second-level interaction)
                   -> min(desired width, Radix available width) -> viewport edge
status panel row    -> bottom/top popover                       -> viewport collision handling

Desktop / wide-screen Web
provider root menu -> desktop-width model submenu (maintaining current state)
status panel row    -> left popover (maintaining current state)
```

This boundary belongs only to renderer presentation; it does not change mobile shell navigation, task/session projection,
`CommandInbox`, owner/lease, relay, or `desktop-continuous` / `web-remote-replayable` delivery semantics.

## QR Code Initial State

In the current chain, the desktop main returns the workspace/task at the time of QR code initiation through `initialViewState`.

New behavior:

1. Bootstrap still selects `mobileViewState -> initialViewState -> first workspace`.
2. The web still opens the corresponding workspace bridge, ensuring the current Root/App has an available workspace service.
3. The mobile shell initial page is fixed as `home`.
4. The home page expands the corresponding workspace card based on `activeWorkspaceKey`.
5. The home page marks the corresponding task row as selected based on `activeTaskId`.
6. Does not automatically enter the chat page.

`initialTaskId` at this stage only expresses "home page selection state" and cannot trigger `onNavigateToChat`, nor can it reuse the task click opening flow.

This way, after scanning the QR code, the user first sees an overview of all workspaces/tasks on the current device, while also knowing clearly under which workspace the task corresponding to the desktop QR code resides.

## Task Click Flow

Task opening logic is extracted from the existing `WebRemoteControlTaskIndex` to form a shared hook:

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

Entering the chat page after a cross-workspace requires a one-time navigation intent that cannot be deduced from `initialTaskId`:

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

1. The second parameter of `WebRemoteControlWorkspaceSwitcherApi.switchWorkspace()` is extended to `WebRemoteControlWorkspaceSwitchOptions`; when old calls do not pass `mobileNavigationIntent`, the behavior is unchanged.
2. The web entry point temporarily stores `mobileNavigationIntent` as a pending intent in memory before calling `openWorkspaceBridge()`.
3. When rendering Root/MobileShell for the new bridge, pass the pending intent as `initialNavigationIntent`; the MobileShell consumes and clears it after the first mount.
4. The pending intent is not written to the URL, not written to `mobileViewState`, and not passed to the desktop main; it only solves the page landing after the current browser page's cross-Root remount.
5. The QR code initial `initialTaskId` does not set a pending intent, therefore only expands the home page card and selects the task row.

Same workspace task:

1. Calculate `taskWorkspaceKey`.
2. Determine whether it equals the current `activeWorkspaceKey`.
3. If the task in the home page snapshot has `unreadAt`, explicitly call `setTaskUnread(..., false)` through the current Web remote control bridge's
   `switcher.markTaskRead(task)`; this action must not depend on whether the mobile Root
   internal task query cache has already been hydrated.
4. Call `onSelectTask(task.workspacePath, task.taskId, task.workspaceIdentity)`.
5. Call `switcher.updateMobileViewState(taskWorkspaceKey, task.taskId)`.
6. Switch the mobile shell to the `chat` page.

Cross-workspace task:

1. Set the switching state.
2. Call `switcher.switchWorkspace(taskWorkspaceKey, { taskId: task.taskId,
mobileNavigationIntent: "chat", markTaskReadExpectedUnreadAt: task.unreadAt })`.
3. After the Web end connects to the target workspace's shared-host bridge, use the target bridge's
   `workspacePath/workspaceIdentity` and the `unreadAt` from the home page snapshot to call
   `setTaskUnread(..., false, expectedUnreadAt)`; failure only logs, do not block the task from opening.
4. After the new bridge rendering completes, the Root receives `initialTaskId` and selects the task.
5. The MobileShell consumes the one-time navigation intent carried by this user click flow, entering the `chat` page.
6. On failure, log `logger.error` and stay on the home page displaying the error.

Note: The QR code initial task only affects the home page selection state and does not call this click flow.

### Unread Clear Boundaries After Mobile Opens a Task

The blue dot on the mobile task home page comes from the desktop renderer's pushed `WebRemoteControlTaskTarget.unreadAt` snapshot; the mobile
Root's task query cache is another data surface hydrated asynchronously by the current bridge. When clicking a task, do not use whether the query cache
hits `unreadAt` as the precondition for clearing unread anymore, otherwise the same task that is already active, cold cache, or cross-Root
remount will skip persistence.

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

Constraints:

1. Only the home page click and when the snapshot explicitly has `unreadAt` trigger writes; read tasks do not produce meaningless mutations.
2. Same workspace uses the current bridge service; cross-workspace must wait for the target bridge to be established before using the target service;
   do not allow main/relay to hold or modify task business state.
3. The target parameter must pass through `workspaceIdentity`; the path execution semantics continue to use `workspacePath`.
4. Failed marking as read must not block navigation. After returning to the home page, the authoritative tasks-index snapshot determines whether the blue dot is restored.
5. The desktop `desktop-continuous` `useWorkspaceTaskNavigation`, query-cache overlay, sorting, and
   `lastActivityAt` logic remains unchanged; this action only exists in the mobile Web remote control switcher.
6. Mobile read-only confirms the notification corresponding to this home page snapshot: the repository must compare the current
   `unreadAt` with `expectedUnreadAt` within the same atomic write boundary. Clear when equal; when not equal, return the current meta and emit no change event; prevent late
   old clicks from overriding subsequently generated background completion or error unread.

## Component Splitting

It is recommended to add or adjust the following UI files:

1. `packages/ui/src/WebRemoteControlMobileShell.tsx`
   - Mobile remote control two-page shell.
   - Manages `home/chat` page state.
   - Manages return to home.
   - Consumes the one-time `mobileNavigationIntent` from cross-workspace clicks.
   - Holds the switching overlay.
2. `packages/ui/src/WebRemoteControlMobileTaskHome.tsx`
   - Renders the home page.
   - Loads workspace/task snapshots.
   - Manages workspace card expansion state.
   - Initializes expansion and selection based on the active workspace/task.
3. `packages/ui/src/hooks/useWebRemoteControlTaskOpen.ts`
   - Extracts the task opening logic from the existing `WebRemoteControlTaskIndex`.
   - Reusable by the mobile home page and the old task index.
4. `packages/ui/src/lib/webRemoteControlTaskIndex.ts`
   - Preserves and extends grouping, sorting, and default expansion key calculation.
5. `packages/ui/src/app-shell/WorkspaceShellLayout.tsx`
   - Renders `WebRemoteControlMobileShell` under the mobile remote control breakpoint.
   - Removes the mobile remote control's dependency on the top sidebar height drag.
   - The desktop remote control layout remains as-is.

## Data Model Supplements

The current `WebRemoteControlTaskTarget` already contains the basic fields needed for the home page:

1. `taskId`
2. `title`
3. `workspacePath`
4. `workspaceIdentity`
5. `remoteSessionId`
6. `workspaceLabel`
7. `workspaceKind`
8. `createdAt`
9. `updatedAt`
10. `provider`
11. `unreadAt`
12. `pinned`

Home page derived display fields:

1. The top device area in the first version does not add a `deviceLabel` protocol field; it only displays the current remote control connection status. If a real device name is displayed later, explicitly extend `WebRemoteControlWindowBootstrapResult` / `WebRemoteControlWorkspaceListResult` with an optional `deviceLabel`, and provide connection status text as a fallback.
2. The workspace card's last update time does not add a `workspaceUpdatedAt` protocol field; the mobile home page derives the maximum `updatedAt` of tasks in that group after grouping by workspace. Workspaces without tasks do not display the update time.

To support the status pill in the screenshots, it is recommended to add an optional display field:

```ts
displayStatus?: "idle" | "running" | "completed" | "error";
// 2026-09-09 note: Whether the session has background work (dynamic workflow run / background bash / detached subagent).
// Only participates in list running-layer sorting, does not affect displayStatus; source is hasBackgroundWork from the sessions-index sidecar.
hasBackgroundWork?: boolean;
// 2026-09-14 note: Workflow run summary (<= 4 runs: running first, then most recently ended), source is workflowActivity from the sidecar.
// Mobile rows draw a Workflow icon + mini track light + current phase name (24px, 13px text) under the title; only drawn, not participating in sorting or status pills.
workflowActivity?: SessionWorkflowActivity;
```

Field sources are layered by authority level; multiple caches must not be treated as peer facts:

1. When the task row carries sessions-index activity sidecar, the real-time `phase` is the sole authority for the current display state:
   - `prewarming` / `running` → `running`
   - `completedSuccess` / `completedInterrupted` → `completed`
   - `error` → `error`
   - `draft` does not produce a persistent task row; if compatible data unexpectedly brings `draft`, do not treat it as a terminal state; continue to the next fallback
2. When there is no sessions-index activity, read the current renderer's task runtime cache:
   - `creating` / `queued` / `streaming` / `waiting_permission` / `waiting_user_input` etc. live status → `running`
   - `failed` → `error`
   - `completed` → `completed`
3. When the runtime cache also has no explicit state, read the tasks-index persistent terminal state:
   - `completed` → `completed`
   - `error` → `error`
4. A standalone persistent `status=running` only means the old process may not have ended normally; it does not prove that the current host is still running; fall back to
   `idle`.

This priority must cover all conflict directions, not just fix `running`:

| sessions-index activity                     | Old runtime / persistent cache   | Mobile display                                          |
| ------------------------------------------- | -------------------------------- | ------------------------------------------------------- |
| `prewarming` / `running`                    | `completed` / `failed` / `error` | `running`                                               |
| `completedSuccess` / `completedInterrupted` | live / `failed` / `running`      | `completed`                                             |
| `error`                                     | live / `completed` / `running`   | `error`                                                 |
| Missing or compatible `draft`               | Any                              | Maintain current runtime → persistent terminal fallback |

Therefore, new sessions-index frames can both advance old `completed/error` cache to `running` and收口 old live cache to
`completed/error`. The mobile home page does not independently merge these sources.

Aggregation boundaries:

1. `displayStatus` is calculated by the desktop renderer when constructing `WebRemoteControlTaskTarget` snapshots;
   `buildWebRemoteControlTaskTargets()` first reads the sessions-index activity carried by task rows, then falls back to Zustand task runtime state and `ZCodeTaskMeta.status` in the above order.
2. The mobile home page only consumes `WebRemoteControlTaskTarget.displayStatus` and must not directly read ZCode runtime, Repo, Service, or persistence implementations.
3. The sync chain remains the renderer `syncWebRemoteControlTasks()` -> desktop main -> relay -> mobile bootstrap/listWorkspaces; no new mobile-side status query entry points are added.
4. Changes to sessions-index activity or compatible task runtime state must trigger a rebuild and sync the task snapshot, avoiding
   `running` / `completed` / `error` pills lagging until the next task list refresh.
5. This field is only used for the mobile home page display and does not change the true state source of the ZCode runtime. When old data is missing, the mobile frontend falls back to `idle`.

### Home Page Snapshot Push Deduplication Boundaries

The Desktop main only performs transport deduplication on the renderer-constructed `WebRemoteControlWorkspaceListResult` and does not own or re-interpret task business state. The deduplication signature must cover fields that the mobile home page needs to adopt immediately but only change at lifecycle nodes or user operations:

1. Tasks: `title`, `unreadAt`, `displayStatus`, `pinned`, `archived`, `remoteSessionId`;
2. Workspace connection status: `kind`, `connectionState`, `remoteSessionId`, `lastConnectionError`;
3. Stable identity fields for tasks/workspaces continue to participate in the signature, ensuring that additions, deletions, and cross-workspace membership changes are visible.

Fields are normalized to the mobile client's display semantics: missing `displayStatus` is equivalent to `idle`, missing `connectionState` is equivalent to
`connected`, missing optional strings are equivalent to empty strings, missing boolean memberships are equivalent to `false`. Any of the above effective value changes must
send a new `workspace-list-updated`.

`updatedAt` comes from sessions-index `lastActivityAt` and changes frequently during streaming text and tool events. This round does not add it to the
immediate push signature; if real-time refresh of relative times and time sorting is needed, a throttle/merge strategy must be designed separately; each streaming event must not push
the entire task home page snapshot.

```text
Low-frequency display/connection field changes --> main snapshot signature changes --> workspace-list-updated --> mobile immediate adoption
High-frequency updatedAt changes ---------------> This round does not trigger full-table immediate push (retaining subsequent throttle/merge boundaries)
```

### Status Projection Impact Boundaries

This fix belongs to presentation / state-source precedence and does not change session commands, runtime, persistence, or recovery protocols.

```text
sessions-index phase (real-time activity) ───────────────┐
                                                         ├─> desktop renderer target projection
renderer runtime cache (fallback only when activity is missing) ┤       └─> relay payload --> mobile status pill
tasks-index terminal status (last fallback) ───────────────┘

desktop task list -- sessions-index continuous projection (maintaining existing path)
mobile /remote ----- renderer task snapshot + replayable delivery (only correcting payload fields)
```

Must preserve:

1. Relay, desktop main, and shared-host attachment still only pass through, without holding task/session business state.
2. The snapshot/gap, owner, and queue semantics of desktop `desktop-continuous` and mobile `web-remote-replayable` remain unchanged.
3. The tasks-index continues to own persistent rows/membership; sessions-index activity only owns real-time phases.
4. `workspaceIdentity?.trim() || workspacePath`, `remoteSessionId`, and pinned/archived membership are unaffected by status merging.
5. The mobile client's running-first sorting continues to consume the final `displayStatus`; stale caches no longer erroneously pin terminal rows to the top or push back true running rows to normal time sorting.

Focused regression covers all phase and conflict cache combinations; no conversation E2Es are added this round because there are no new interactions,
commands, or delivery behaviors, and runtime NDJSON has proven that sessions-index consistently publishes correct phases in the error window; the defect lies in
pure renderer target projection.

To support the pinned section, `WebRemoteControlTaskTarget` adds an optional field:

```ts
pinned?: boolean;
```

Field source:

1. The Desktop renderer reads tasks in the `Root` through `useGlobalTaskList({ kind: "pinned" })` and
   `useGlobalTaskList({ kind: "timeline" })`.
2. `buildWebRemoteControlTaskTargets()` marks `pinned: true` for pinned query results; timeline query results are not marked.
3. The Mobile home page only consumes this display field for sectioning; it does not directly read task repos, sqlite, ZCode services, or runtime.
4. `workspace_task_list_changed` carries incremental events of task meta, which only indicates title, time, status, and other metadata changes, not
   pinned/archived membership changes. Frontend cache updates must preserve existing list归属, avoiding status refreshes moving pinned tasks out of the pinned section.

## State and Routing

The first version does not need to introduce real URL routing; React state can be used internally within the mobile shell:

```text
currentMobilePage: "home" | "chat"
```

Entering chat:

1. The user clicks a task.
2. Task selection succeeds.
3. Set `currentMobilePage = "chat"`.
4. If the current history state is not `{ zcodeMobilePage: "chat" }`, add a layer of chat history state.

Returning to the home page:

1. Click the header back button.
2. If the current history state is `{ zcodeMobilePage: "chat" }`, call `history.back()`, and `popstate` returns to home.
3. If there is no current chat history state, directly set `currentMobilePage = "home"` as a fallback.
4. Retain the selection state of the current active task.

Browser back key:

1. The mobile shell does not write history when initially entering `home`, preserving the original history stack of the QR code entry.
2. Only when the user clicks a task from `home` and successfully enters `chat` is a single `history.pushState({ zcodeMobilePage: "chat" }, "")` called.
3. If already at this `chat` state, do not push repeatedly, avoiding stacking history from multiple clicks on the same task.
4. When `popstate` hits `{ zcodeMobilePage: "chat" }`, set `currentMobilePage = "chat"`; when returning from chat by clicking the back button, use `history.back()` to go back to home, rather than directly changing the state.
5. When `popstate` returns to a non-`zcodeMobilePage` state, set `currentMobilePage = "home"`, and allow the browser's subsequent default back behavior.
6. After a successful cross-workspace task click and remounting the Root, still add a layer of `chat` state according to the "user clicks to enter chat" rule; this state comes from the click flow's one-time `mobileNavigationIntent`; the QR code initial `initialTaskId` does not add this layer of state.
7. Remove the `popstate` listener when the mobile shell unmounts.

Do not put workspace/task state into the URL to avoid coupling with the QR code entry and paired state.

## Style Rules

UI must comply with the root directory `DESIGN.md`:

1. Use semantic tokens, e.g., `bg-background`, `bg-card`, `border-card-border`, `text-foreground-subtle`.
2. Use `rounded-lg` for cards; do not use overly large border radii.
3. The home page is a business tool interface; keep it compact, clear, and scannable; do not make it a marketing page.
4. Support light, dark, Zai light, Zai dark.
5. Support Chinese and English text lengths; do not rely on fixed English short phrases.
6. Use existing `Button` components and lucide icons for buttons.
7. Home page scrolling, card height, and task row height must be stable; expand/collapse must not cause uncontrollable horizontal overflow.

## Logging

Logs are needed for debugging interactive issues, not guessing state.

The UI layer uniformly uses:

```ts
import { logger } from "@/logger.js";
```

Recommended log points:

1. Home page loading workspace/task snapshot failure: `error`.
2. Mobile view state update failure after clicking a same-workspace task: `error`.
3. Cross-workspace task switching begins: `info`.
4. Cross-workspace task switching failure: `error`.
5. QR code initial state cannot match workspace/task: `warn`.

High-frequency rendering and normal hovers do not log.

## Implementation and Regression Tests

Must execute:

```bash
pnpm typecheck
pnpm lint
```

Current test entry points:

1. `packages/ui/test/webRemoteControlMobileTaskHome.test.ts`
   - Workspaces grouped by desktop return order.
   - Default expansion of `activeWorkspaceKey`.
   - `activeTaskId` corresponding task displays as selected.
   - After clicking collapse all, all workspace cards are collapsed.
2. `packages/ui/test/useWebRemoteControlTaskOpen.test.ts`
   - Same workspace task calls `onSelectTask` and `updateMobileViewState`.
   - Cross-workspace task calls `switchWorkspace` with `{ taskId, mobileNavigationIntent: "chat" }`.
   - On switching failure, retain the error and clear the switching state.
3. `packages/ui/test/workspaceShellRemoteMobileLayout.test.ts`
   - Renders the mobile shell under the mobile remote control breakpoint.
   - Non-mobile breakpoints continue to render the existing shell/sidebar.
   - The QR code initial task only expands the home page card and selects the task row; does not enter chat.
   - When the user clicks a task to enter chat, only adds a layer of history state; browser back returns to home.
   - After a cross-workspace click and remounting the Root, consume the one-time `mobileNavigationIntent` to enter chat, and clear it after consumption.
4. `packages/shared/test/webRemoteControl.test.ts`
   - If adding `displayStatus`, add schema/type compatibility tests.
5. `packages/ui/test/webRemoteControlTaskIndex.test.ts`
   - `buildWebRemoteControlTaskTargets()` calculates `displayStatus` by the priority of sessions-index activity -> task runtime ->
     `ZCodeTaskMeta.status`.
   - Covers conflicts between live phases and stale runtime/persisted cache in the running, completed, and error directions.
   - When activity is missing or is a compatible `draft`, maintain the original runtime/persisted fallback; persistent `running` must still not create fake
     running.
6. `packages/desktop/test/webRemoteControlManagerExternalRelay.test.ts`
   - Only changing `title`, `unreadAt`, `displayStatus`, `pinned`, `archived`, or
     `remoteSessionId` for the same task must push `workspace-list-updated`.
   - Only changing `connectionState`, `remoteSessionId`, or `lastConnectionError` for the same workspace must push;
     identical effective field snapshots must still be deduplicated.
   - Changing high-frequency `updatedAt` alone does not belong to this round's immediate push contract.

## Historical Implementation Order

It is recommended to implement in the following order:

1. Extract `useWebRemoteControlTaskOpen`, maintaining the existing `WebRemoteControlTaskIndex` behavior unchanged.
2. Add the mobile home page component, using existing task target fields to complete workspace cards and task rows.
3. Add the mobile shell and integrate it under the small-screen remote control mode.
4. Adjust the QR code initial state: stay on the home page by default, only expand and select the corresponding task.
5. Add the `displayStatus` field and status pills.
6. Remove or bypass the mobile remote control's old sidebar top-drag collapse logic.
7. Add tests, execute `pnpm typecheck` and `pnpm lint`.
8. Update the current mobile client UI description in `docs/web-remote-control/web-remote-control-architecture.md`.

## Risk Points

1. Cross-workspace task clicks recreate the bridge; the new Root's first frame state must be well-coordinated with the mobile shell page state to avoid flashing the home page before entering chat.
2. The QR code initial state still needs to open the workspace bridge; otherwise, the chat page cannot reuse existing services; but the UI should not automatically jump to chat.
3. Remote workspaces must always use `workspaceIdentity` as the key; `workspacePath` alone is not sufficient.
4. `WorkspaceShellLayout` has a lot of existing remote control mobile layout history; carefully preserve the desktop remote control behavior when integrating the mobile shell.
5. If real URL routing is added later, avoid mixing short-term `remoteControlToken` with internal task page state.
