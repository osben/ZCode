# Sidebar Purpose Section Order

## Current Interaction Revision (2026-09-15)

This section replaces the "dedicated handle" convention of the older design below. The current ProjectSidebar
shares PurposeSections and WorkspacePurposeSection:

- "Projects" and "Tasks" (项目 / 任务) drag directly from the title text or the blank title area; the
  six-dot button on the right is removed. A click still only collapses the current section; the right-hand
  create button is independent and activates neither drag nor collapse.
- It reuses the project sorting's PointerSensor (activates after 6px movement) and KeyboardSensor; after the
  title is focused, Space starts, arrow keys move, Space commits and Escape cancels. Touching the title can
  drag, and the content area keeps scrolling.
- A single target insertion line is derived from the same useSortable active / over / index: moving up it is
  before the target, moving down after it, and the whole expanded section moves together. The line uses the
  project sorting's 2px icon-blue with an 8px hollow circle; it takes no layout, intercepts no pointer, and is
  cleared on release/cancel.
- Section displacement is constrained to the vertical axis; the sidebar list explicitly forbids horizontal
  scrolling and keeps vertical scrolling. Dragging out of the sidebar's right edge cannot widen the scroll
  container nor produce a horizontal scrollbar.
- The only committed order is still the renderer-local sectionOrder; with no valid swap no preference is
  written. Collapse values and task/project content do not change with sorting; no new persistence or timer.

```text
title Pointer / Touch / Keyboard -> dnd-kit active / over (vertical axis) -> target-edge blue line
                                                           ├─ commit -> original sectionOrder preference
                                                           └─ cancel -> clear transient state
title click -> original collapse preference; right action -> original create callback
```

The shared UI serves desktop/Web; it constrains only sidebar display and does not change Host/CLI,
workspaceIdentity, desktop continuous or mobile replayable. A 390px desktop check represents the narrow
layout, not real mobile shared-host verification.

Acceptance: CWP02 updates its title trigger assertion; a pending interaction regression covers up/down
sorting, expand/collapse, click/create isolation, keyboard cancel/commit, reload persistence, and the blue
line and no horizontal overflow when dragging to the right in dark/light themes and narrow screens. No model
request.

### Verification Outcome

- Dev app CDP: before the fix, dragging right widened the sidebar from 409px to 1060px; after the fix the
  same gesture gives 0 horizontal displacement and content width equals the visible width (264px), the blue
  line appears and Escape clears it.
- Electron pending run `desktop-e2e-20260915121039329-p28373-70b1989f9323c47a`: 4/4 passed, 1200px dark and
  390px light screenshots checked; covering title pointer/keyboard sorting, cancel/commit, reload, collapse and
  action isolation, dark/light themes and no horizontal overflow.
- Existing CWP02 formal run `desktop-e2e-20260915121257994-p30885-947e07257bcefaa2`: 1/1 passed. Two fixture
  checks passed; the new case stays pending.
- 18 related unit tests, root typecheck, desktop typecheck:e2e, lint (existing warnings only, 0 errors),
  format and the HEAD incremental architecture check passed. The default all-branch architecture check still
  has the pre-existing `resolveConversationWorkspaceTarget.ts` unmanaged-new-file.
- Real mobile shared-host, touch hardware and Windows/Linux GUI were not run; the change only alters shared
  sidebar interaction and layout, not communication or task data.

## Feature Summary

| Field | Value |
| --- | --- |
| Change | The second-level "Projects / Tasks" sections in `Project + By project` support drag reordering with the user order persisted; the order is shared across devices while each device collapses/expands independently |
| User-visible surfaces | Desktop and shared Web workspace sidebar; the shared task-purpose label is synced to "任务 / Tasks" |
| Existing docs | `docs/ui/sidebar-task-view-switcher.md`, `docs/superpowers/specs/2026-07-10-non-project-conversation-workspace-design.md` |
| State owner | Renderer-local `zcode-sidebar-purpose-section-preferences` |
| Out of scope | Mobile `/remote` drag layout, cross-window live sync, Host/Agent/protocol state, other "对话" copy |

The internal `workspacePurpose=conversation` semantics are unchanged; the shared task-purpose section/workspace
label and the desktop sidebar empty-state and create-entry copy change from "对话 / Conversations" to "任务 /
Tasks". Mobile `/remote` may reuse the new label but gets no drag entry.

## Clarified Decisions

Sorting is persisted renderer-locally; the drag entry was a dedicated handle (now superseded by title drag);
input is mouse/touch/keyboard; scope is Desktop/shared Web; no live cross-window sync; the whole section is
always draggable whether empty or collapsed. The copy change touches only the sidebar section-related copy,
not the conversation product/protocol semantics.

## State and Sync Boundary

```text
pointer / touch / keyboard drag handle
  -> reorder [projects, conversations]
  -> update current renderer immediately
  -> apply the same order inside every visible device group
  -> persist sectionOrder to localStorage
  -> restore on the next renderer mount

  -X-> Host / Agent / task snapshot / protocol
  -X-> mobile web-remote-replayable
  -X-> live broadcast to another open window
```

Expanded state follows "device x section" and does not change with a swap or clicks on another device; only
when no device level is shown does the top-level compatibility preference continue to be used:

```text
local           -> projects / conversations
server:<id>     -> projects / conversations
pending:<route> -> projects / conversations

click server:A / projects
  -> updates only server:A / projects
  -X-> local / projects
  -X-> server:B / projects
```

## Domain Scope and Dimensions

| Dimension | Values | Decision |
| --- | --- | --- |
| Input | mouse pointer / touch pointer / keyboard | accepted, all through the drag handle |
| Section content | non-empty / empty | accepted, both draggable |
| Section expansion | expanded / collapsed | accepted, persisted per device independently; the section moves as a whole keeping each device's expand state |
| Initial preference | missing / legacy / valid / corrupt | accepted; missing, legacy, corrupt use the default `projects -> conversations` |
| Surface | Desktop / shared Web / mobile `/remote` | first two accepted for drag; one shared order across devices; mobile accepts shared copy only, drag pruned, keeping its independent layout |
| Window | current / another open renderer / remount | current updates immediately; live sync of another window pruned; remount restore accepted |
| Runtime delivery | desktop-continuous / web-remote-replayable | ignored; sorting does not enter runtime/realtime chains |
| Theme / locale | Zai Light / Zai Dark; zh-CN / en-US | accepted; existing semantic tokens and bilingual copy |

## Candidate and Pruning Decisions

| Candidate | Setup / action | Expected result | Status |
| --- | --- | --- | --- |
| SPO01 | View the sidebar with default preferences | Projects above Tasks, both sections expanded | accepted |
| SPO02 | Drag from the Tasks handle above Projects | The whole Tasks section swaps, expand state and content unchanged, order written to the local preference | accepted |
| SPO03 | Refresh or restart the renderer | Tasks above Projects restored | accepted |
| SPO04 | Drag after collapsing or with an empty section | Still swappable; cache, workspace/task order or expand state not cleaned | accepted |
| SPO05 | Keyboard focus the handle and sort | Same result as pointer sorting, the handle has a readable `aria-label` | accepted |
| SPO06 | Observe the order in another open window | No live change required; that window reads the persisted value at next mount | pruned, renderer-local preference adds no broadcast |
| SPO07 | View or drag on mobile `/remote` | The task-purpose label shows "任务", but no drag entry, no change to replayable recovery | copy accepted; drag pruned, independent mobile layout |
| SPO08 | Change other "对话" copy across the product | Original copy kept | ignored, this change adjusts only the sidebar purpose section |
| SPO09 | Drag project/task order inside any device | All devices use the same order synchronously, no per-device sort preference added | accepted, single renderer-local owner kept |
| SPO10 | Collapse Projects or Tasks inside any device | Only that device's section collapses; other devices' expand state unchanged and persisted independently | accepted, isolated by Source group key |

## Accepted Case and Evidence

| Case | Setup | Action | Assertions | Evidence | E2E |
| --- | --- | --- | --- | --- | --- |
| CWP02 / SPO01-05 | fresh profile, conversation backing workspace only | View, collapse, drag "Tasks" above "Projects" and reload | Bilingual section semantics correct; action outside the collapse trigger; handle accessible; order and expand state persisted independently; no project workspace row | DOM order + `aria-expanded` + localStorage + remount DOM | Update the existing `conversation-session-conversation-workspace.test.ts`; no provider request |

## E2E Handoff

- Reuse the formal CWP02; do not create a duplicate case.
- This is a pure renderer interaction that produces no provider request; the case-local fixture is empty and
  declares `noProviderRequests`, with no new provider response replay.
- The pointer E2E proves real swapping and reload restore; the keyboard/touch sensor contracts are covered by
  focused component/source tests.
- It does not enter the new Docker admission flow; CWP02's current suite ownership is kept.
