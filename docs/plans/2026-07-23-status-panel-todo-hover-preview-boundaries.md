# Status Panel Todo Hover Preview Boundaries

## Feature Summary

| Field                | Value                                                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Change               | Hidden Todo groups open as a left-side HoverCard preview instead of expanding inside the panel on click          |
| User-visible surface | The "completed n / pending n" entries of the V4 Status Panel                                                     |
| Existing reference   | Goal iteration Todo hover preview: `028be830cd` to `ff372381e1`                                                  |
| State owner          | Renderer-local HoverCard open state; the Todo snapshot remains owned by the plan model                           |
| Out of scope         | Todo ordering, the three-item focus window, protocol, session/store persistence                                  |

Decisions: details never enter the Status Panel document flow; visuals and interaction reuse the Goal item
hover card (delay, direction, spacing, size and scroll contract).

## Boundary Decisions

| Boundary         | Decision                                                                                                                                                                                      | Includes                              | Excludes                                                     |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------ |
| Desktop pointer  | Hover / focus opens; leaving trigger and card closes                                                                                                                                          | Pointer can travel from entry to card | Inserting details into the panel                             |
| No-hover input   | Click on the entry opens the same HoverCard                                                                                                                                                   | Mobile Web, touch, keyboard focus     | A new mobile-only UI                                         |
| Placement        | `left + start + 4px`; Radix collision handling when space is short                                                                                                                            | Same position as the Goal card        | Fixed screen coordinates                                     |
| Content          | Shows the position buckets before/after the window in original order, each item at most two lines; "completed/pending" wording only when the bucket's statuses are uniform, otherwise "before/after" | Internal card scroll                  | Model truncation, reordering, or misreporting status by position |
| Snapshot changes | After an id / content / status change the old card closes and groups are recomputed                                                                                                           | Renderer key remount                  | Persisting open state                                        |

## State And Event Flow

```text
plan snapshot
    |
    +--> getStatusPanelTodoFocusWindow()
            |
            +--> focusItems ----------> Status Panel fixed three items
            |
            +--> completed/waiting ---> HoverCard trigger
                                            |
                           hover/focus/click
                                            v
                                      left-side preview card
                                      (scrolls independently)

snapshot signature changes
    --> PlanStatusItems remount
    --> HoverCard open state reset
```

## Accepted Cases

| Case ID | Setup                                                          | Action                       | Assertions                                                                                         | Evidence             |
| ------- | -------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------- | -------------------- |
| THP01   | Hidden items only before the window                            | hover / focus the upper entry | Full completed group appears on the left; panel height and the three-item window are unchanged    | component + CDP      |
| THP02   | Hidden items only after the window                             | hover / focus the lower entry | Full pending group appears on the left; content scrolls                                            | component + CDP      |
| THP03   | Hidden items before and after, and a bucket has mixed statuses | hover both entries in turn   | At most one matching preview at a time, groups never chained; mixed buckets use neutral position wording | component + CDP |
| THP04   | No hover input                                                 | click the entry, then outside | Click opens the same preview, no in-panel expansion; blur closes it                               | component + mobile follow-up |
| THP05   | Preview open                                                   | Todo snapshot updates        | Old preview closes; entries and content recomputed from the new snapshot                           | component key + CDP  |

## Pruning

- `desktop-continuous` and `web-remote-replayable` share only the renderer projection; protocol state
  combinations are not expanded.
- Theme / locale are covered by HoverCard, semantic colors and existing i18n copy; no full permutation.
- Workspace identity, provider and runtime state do not affect a pure renderer-derived preview.
