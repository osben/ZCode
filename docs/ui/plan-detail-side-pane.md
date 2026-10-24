# Plan Card and Side Pane Detail

## Goal

An `ExitPlanMode` plan may complete at once or grow in a streaming way through the tool input. The main
timeline shows a summary in a compact plan card; clicking the card or the top-right expand button opens the
full plan in the Side Pane. The main timeline no longer expands in place and keeps no bottom "expand plan"
button.

The plan detail is only a read-only view of the same parent session projection: it creates no session, Agent
runtime, owner, lease or command queue. Desktop Electron and desktop Web read the existing
`desktop-continuous` projection; mobile Web only reads the existing `web-remote-replayable` snapshot/gap
recovery result, with no new remote-control chain.

## Confirmed Product Semantics

1. The top-left always shows "计划" (Plan), not the tool's original name or "套餐".
2. The top-right shows only Copy; no expand, like or dislike.
3. At the bottom of the body preview, `bottom-6` floats a default-primary-style capsule button
   `h-10 pl-6 !pr-4.5` "查看完整计划 →" (View full plan), replacing the old header expand button.
4. Clicking a non-interactive card area or the bottom "查看完整计划" button behaves the same: open the detail
   in the Side Pane.
5. Each `(workspaceKey, parentSessionId, toolCallId)` maps to one stable tab; the same plan reuses it,
   different plans may coexist.
6. A plan opened from a selection side chat still uses the child session as source `parentSessionId`, but
   the tab's visible scope binds to the root task through an independent `rootSessionId`, hidden and
   restored with the root task when switching main tasks.
7. The tab title is the localized "计划".
8. The Side Pane shows the full plan; the main timeline shows only a clipped preview; there is no in-place
   expanded state.
9. The plan card stays strictly at the position of the `ExitPlanMode` tool row and is not promoted to the
   assistant turn tail. When it lies before the final body it folds with the same "已工作" history; after
   expanding it must keep the CLI `rowId` total order.
10. A streaming `ExitPlanMode` shows from the first parsable `plan` field; the card shows no line count or
    streaming counter animation, and the detail updates with the same projection.
11. After the terminal state arrives, the last non-empty body is kept; when snapshot fields are missing the
    existing full-field loading entry is still used.
12. The "Copy" of the assistant turn-tail action bar aggregates by turn: first copy all assistant body
    segments, then append the full Markdown of all `ExitPlanMode` of the same turn; it does not read the
    clipped card DOM nor include other tool results. The card's own copy button still copies only that plan.
13. The top-right summary gains an independent "计划" section listing only `ExitPlanMode` in the current
    valid conversation branch that has entered `success`, `error` or `cancelled` terminal state and has a
    body; streaming, running and awaiting-approval states do not enter the directory.
14. The plan directory is sorted by `rowId` newest first. Clicking a directory item equals clicking the
    timeline card, reusing the same `(workspaceKey, parentSessionId, toolCallId)` Side Pane tab.
15. Mobile keeps the existing Side Pane drawer; the core entry does not disappear on narrow screens.
16. The mobile-remote-specific `V4ChatPane` must receive `onOpenPlanDetail` just like the desktop
    `V4WorkspaceChatArea`; clicking the card or "查看完整计划" only updates renderer Side Pane state, sends no
    task command and does not change the `web-remote-replayable` recovery chain.

## State and Timing

```text
provider tool_input_start / delta / end
                  |
                  v
 shared partial JSON preview (recognize the plan field)
                  |
                  v
 parent conversation projection
          |                    |
          |                    +--> Side Pane plan-detail tab
          |                         key = workspaceKey
          |                               + parentSessionId
          |                               + toolCallId
          v
 main timeline plan card
   - at the original tool row position
   - Plan
   - Copy / Expand
   - clipped preview

ExitPlanMode terminal / row.removed / snapshot
                  |
                  v
 renderer plan-directory revision
                  |
                  v
 v4/conversation/plans (CLI full valid projection)
                  |
                  v
 status panel "Plan" directory (newest first)

card click / expand click
   ---> activate or create a stable tab
   ---> expand Side Pane
   ---> tab keeps subscribing to the parent projection

turn-tail assistant copy
   ---> assistant text segments (original order)
   ---> ExitPlanMode markdown (same turn, original order)
   ---> join with blank lines and write to clipboard

switch parent task
   ---> hide / restore the matching plan tabs by rootSessionId ?? parentSessionId
   ---> no new runtime, no change to owner / queue / deliveryKind
```

## State Ownership

| State | Authoritative source | Lifecycle |
| --- | --- | --- |
| Plan body and streaming state | `ToolCallRow` of the parent conversation projection | Follows the parent session |
| Plan directory | Terminal-state `ExitPlanMode` query of the CLI's current valid projection | Follows the parent branch; refreshed after edit/retry pruning |
| plan detail tab and active item | renderer workspace Side Pane memory | Current window; not persisted |
| Tab stable identity | `workspaceIdentity?.trim() \|\| workspacePath` + parent session + tool call | Current window |
| Latest non-empty plan body | Local display fallback of the plan detail component | While the tab is mounted |
| Tab visible scope | `rootSessionId ?? parentSessionId`; selection side chat uses the root task ID | Current window |

## Interaction and Accessibility

- The card uses semantic tokens `bg-card`, `border-card-border`, `text-foreground*` and the strong module
  radius `rounded-xl`, compatible with all themes. No divider between card header and body; compact spacing
  keeps the hierarchy.
- The card header uses the `NotepadText` icon; icon and "计划" title both use `text-foreground-subtle`,
  composed by a `flex items-center gap-2` container. Header height `h-10`; content is top-aligned with
  `items-start pt-4 px-4`.
- The whole card is keyboard-focusable; Enter / Space opens the detail. Card key handling ignores Enter /
  Space coming from inner interactive elements, so the bottom button and the whole card do not open the same
  tab twice.
- Copy, View full plan, links and buttons in the body stop propagation and do not open the tab again; the
  bottom text button uses its visible copy as the accessible name and does not reuse the whole card's
  `aria-label`. Icon buttons use compact `icon-xs` / `icon-sm` sizes with localized `aria-label`.
- Copy success changes only the button's accessible name and icon, with no persistent toast.
- The main timeline preview's body node carries `max-h-64`, overflow clipping and a bottom mask together; the
  first `30%` is fully visible and the last `70%` fades, so the gradient is computed against visible height.
  An empty plan shows no plan card; the Side Pane still shows the full body.

## Cases and Pruning

| Case | Scenario | Expected | Decision |
| --- | --- | --- | --- |
| S06 | Complete `ExitPlanMode` plan | Card compactly shows "计划" and Copy, no line count; card/bottom "查看完整计划" capsule opens the same detail tab; no feedback buttons | accepted |
| S07 | `plan` parameter streams in | Card shows from the first parsable fragment, no streaming counter animation; an already open detail grows in sync and matches at terminal state | accepted |
| S08 | Several historical plans under one parent task | Each `toolCallId` is its own tab; repeated clicks on a plan reuse; hide/restore on task switch without crossing workspace | accepted |
| S09 | Electron, desktop Web, mobile Web, dark/light, zh/en | Shared card and Side Pane semantics; mobile reuses the existing replayable projection and drawer, no new runtime | accepted |
| S10 | Ordinary assistant reply and `ExitPlanMode` persisted, then restart | canonical `assistant_response` still restores by UI/transcript visibility semantics; the plan tool row keeps the full `plan` and shows as read-only interrupted history | accepted |
| S11 | A turn has assistant body and `ExitPlanMode` | Turn-tail copy is all assistant body plus appended full plan Markdown; unaffected by card clipping, no other tool results mixed in | accepted |
| S12 | Assistant, tool or reasoning output follows the plan | The plan card stays at the original `ExitPlanMode` row; the "已工作" expanded order equals the CLI row total order, not pinned to the turn bottom | accepted |
| S13 | Several finished plans in the current valid branch | The top-right "计划" lists all plans newest first; title from the Markdown H1/first non-empty line; click opens the matching Side Pane | accepted |
| S14 | Plan streaming/awaiting approval, then terminal; or edit/retry pruning | Non-terminal not in the summary; appears after terminal; removed from the directory after `row.removed`; a late query does not restore an old plan | accepted |
| S15 | Cold restore, desktop continuous, mobile remote replayable | Reuse the same CLI full-projection query and shared-host attachment; return the same valid set, no new runtime, owner, queue or replay branch | accepted |
| S16 | `/btw` or `/side` child session enables plan mode and opens the full plan | Side Pane shows the child session's full plan; the tab is visible under the root task and hides/restores on root-task switch; no new session or runtime | accepted |

Pruning: do not Cartesian-multiply `model x permission mode x goal x fork x queue` with the plan detail,
since detail and directory only read the existing projection and send no session command.
`success/error/cancelled` share the same terminal filter implementation, so component-test enumeration
suffices; remote snapshot/gap recovery correctness stays with existing replayable cases, and S15 only proves
that query routing and workspace identity are not crossed.
