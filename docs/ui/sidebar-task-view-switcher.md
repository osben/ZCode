# Sidebar Task View Switcher

## Current Behavior (2026-10-13)

The sidebar filter is "By project / By group / Recently updated", each with an icon; the old two-level
switcher is not restored. Group and project are independent; the contract is in
[grouped view](task-grouped-view.md). A valid new client `view` is kept; otherwise the old `organizeBy` is
migrated: `grouped` -> `grouped`, `chronological` -> `timeline`, `project` -> `projects`. With no valid
history the default is by project. A later explicit switch wins. Switching never changes tasks, project
order or execution directory.

## Older Two-Level Switcher (No Longer Used)

The task area view entry used to be two-level: a first-level slider `Group` / `Project`, and under `Project`
a filter menu `By project` / `Timeline` plus `Created` / `Updated`. The slider (a compact pill tabs shell
with a sliding `bg-background` indicator, `Group` left and `Project` right, placed beside `Expand/Collapse
all`) and the `View` / `Sort by` menu are superseded by the three-way filter above. The data-state mapping
below is still how the views map to preferences:

- `Group` -> `taskOrganizeBy = "grouped"`
- `Project` + `By project` -> `taskOrganizeBy = "project"`
- `Project` + `Timeline` -> `taskOrganizeBy = "chronological"`
- `Created` -> `taskSortBy = "created"`; `Updated` -> `taskSortBy = "updated"`

`Group` does not respond to `Created` / `Updated` sorting. Non-project conversations add no first-level
tab; in `Project + By project` they are an independent second-level section.

## Ordering of Project and Timeline Views

`Project + By project` and `Project + Timeline` sort in two layers, not by applying `taskSortBy` to the
whole table:

1. Tasks that are `prewarming/running`, or have `hasBackgroundWork` (a dynamic workflow run / background
   bash / detached subagent attached; background work joins the running layer, 2026-09-09), always sort at
   the top of the current ordinary task list.
2. Inside the running layer, order by `createdAt` descending, using only the stable `taskId` for equal
   creation time.
3. Only the non-running layer applies the `Created` / `Updated` preference.

So a concurrently running original task and its fork child do not swap as `lastActivityAt` alternates with
streaming events; the fork child, created later, stays stably above the original while running. Two
sessions each running one background workflow run behave the same: run progress events keep advancing
`lastActivityAt`, but both rows are fixed in the running layer by `createdAt`.

A session with a workflow run attached shows, in all three views (Project / Group / Timeline), an extra row
under the title: "Workflow icon + mini track light + current phase name" (2026-09-14), fed by the sidecar
`workflowActivity`. This row only draws: it takes no part in ordering and does not change the priority of
the leading 16px slot; row height goes 32 -> 52 (at most two rows). The spinner icon still recognizes only
`prewarming/running`; background work does not light it. Pinned remains an independent structural area and
Grouped still obeys the user's persisted explicit `sort_order`; the running layer does not scatter either
across areas.

The `Projects` / `Tasks` sections use the independent renderer-local preference
`zcode-sidebar-purpose-section-preferences`, persisting `projectsExpanded`, `conversationsExpanded` and
`sectionOrder`; on first use, old preferences, bad data or unavailable storage, both default to expanded in
`Projects -> Tasks` order.

## Layout and Interaction

```text
[ view filter ] [expand]   [new group] [archive] [filter]
Pinned
  • task
```

- The pinned area in `Group` / `Project` / `Timeline` / `Archived` modes is rendered below the switch and
  action buttons and above the ordinary task list; the list container adds no extra top/bottom margin, to
  avoid a large gap.
- The `Group` body still receives only non-pinned, non-archived tasks; a pinned task moves to the global
  pinned area of the same page and appears once. After the top-right shared task menu pins the current
  task, it must still be findable on the `Group` page and not vanish because the grouped body filtered the
  pinned membership.
- A pinned task keeps its group membership and user order; unpinning returns it to its original group or
  top-level position. An empty, non-loading pinned area stays hidden with no empty title.
- The `Expand all` / `Collapse all` button sits right beside the view switch, as a neighbor action; secondary
  actions (`New group`, archive, filter) stay on the right of the toolbar.
- When switching views, `Expand all` / `Collapse all` optimistically keeps position, icon and disabled state
  per the previous frame's display model, and is removed only after the new view confirms empty, to avoid
  the action area flickering by losing a button or turning gray briefly.
- `New group` stays a pure icon button in `Group` view, exposing its label through tooltip and `aria-label`.
- With `Group` selected, the right side keeps `Expand/Collapse all`, `New group`, archive and other common
  actions; the project sub-view and sort filter menu are hidden and the task toolbar shows no search
  button.
- On narrow widths the toolbar may wrap: the switch takes the available width first, and action buttons
  that wrap to the next row must stay visible, so long translated text does not squeeze icon buttons.

`Project + By project` task area:

```text
Pinned
Projects          [drag]     [chevron] [+]
  workspace rows
Tasks             [drag]     [chevron] [new task]
  conversation rows
```

- `Pinned` shows only with data or while loading; a conversation/project pinned task appears once.
- The `Projects` and `Tasks` titles always show and expand/collapse independently; clicking the title or
  the remaining title row outside the right action and drag handle toggles the section (down arrow =
  expanded, right arrow = collapsed).
- A dedicated drag handle supports mouse, touch and keyboard. The user can swap the two sections; an empty
  or collapsed section can still be moved, expanded state and content follow the section, and
  `sectionOrder` persists immediately after a swap.
- Arrow and right action are hidden in the default pointer state and show on section hover, keyboard
  `focus-within`, open menu, or a device without hover; the action is a sibling of the trigger and its click
  only runs the action without changing the expanded state.
- The `+` menu on `Projects` reuses `Open folder` and `Remote connection`; `MessageCirclePlus` on `Tasks`
  always creates a draft in the conversation backing workspace.
- Tasks in `Tasks` use the same single-line row as ordinary workspace tasks: no backing workspace directory
  name (e.g. `default`) and no gray dot for ordinary idle; real status indicators (unread, error, running)
  are kept.
- Collapsing a section only hides content; it does not clear workspace row expansion, task cache or DnD
  order. With no real project, no conversation backing tab, or temporarily empty workspace tabs during
  restore, both titles and their empty states still render.
- Task queries use all workspace targets; only workspace rows, DnD, expand/collapse and the project empty
  state are filtered to `workspacePurpose=project`.
- `Group` keeps showing non-project tasks: top-level ungrouped by default, joinable to ordinary groups; no
  `default` workspace group is auto-generated for the backing path.
- The `Group` top pinned area and grouped body use the same workspace scope but keep independent membership:
  the former shows only pinned, the latter excludes pinned; no duplicate rows.
- `Expand all` / `Collapse all` follow the current view: in Group mode it controls groups; in Project mode
  it controls the `Projects` section and all project task groups, not `Tasks`; Timeline shows nothing when
  there is nothing to bulk-expand.

## Web Remote Constraint

The Web remote sidebar still uses only the `Project` first-level mode and shows no `Group` item, because
the remote task list comes from `listWorkspaces()` / the replayable task index, and there is no remote
recovery semantics for user-defined groups yet. Mobile remote keeps the vertical scroll and height drag of
the top navigation area; `clientMode`, `deliveryKind`, task stream, snapshot and replayable recovery
boundaries are unchanged.

Section order is a renderer-local preference: the current window updates immediately, other open windows
need no live sync, and a remount reads the same persisted value. Full boundary and cases:
`docs/ui/sidebar-purpose-section-order.md`.

## Compatibility

- Keep using `readSidebarTaskPreferences()` / `persistSidebarTaskPreferences()`.
- Desktop, Web, macOS, Windows, Linux, and Zai Light / Zai Dark stay supported.
- Copy goes through existing i18n keys; new copy needs both `en-US` and `zh-CN`.

## Mobile Remote Task List Gestures (2026-10-14)

Mobile `/remote` reuses the project sidebar component; the entry's `isWebRemoteControl` decides interaction
capability, never window width.

- Project titles register no sort drag (including keyboard sorting) and allow vertical touch scrolling;
  click still expands or collapses. Projects in the pinned area follow the same rule.
- All session views (project, pinned, group, timeline) do not respond to hover, and touch-caused focus does
  not toggle the action area or hide meta info. One tap opens a session.
- Mobile keeps the existing always-visible actions and keyboard open; desktop keeps project sorting and
  session hover/focus actions.
- No change to task identity, sort persistence, shared Host or the replayable chain.

```text
mobile entry -> shared sidebar display config -> projects no sort / sessions fixed display -> tap -> existing open chain
desktop entry -> default interaction config -> project sort / session hover + focus -> click -> existing open chain
```
