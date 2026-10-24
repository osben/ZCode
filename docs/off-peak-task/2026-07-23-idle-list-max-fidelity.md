# Idle list max fidelity

## Design reference

- Figma file: `IGDrByFuL2wY5fLUWku4sb`, node `4866:1735`
- State name: `Automations - Task list Idle-time task / max`

## Required behavior

1. When the task list contains cards, the Keep-awake notice renders after the tabs and before the
   task-card grid.
2. A failed idle-time task with a retained queue position renders both the red `Failure` status and
   the dimmed queue-position badge (the task footer resolver must not drop the queue position in
   the failed branch).
3. The Automations page title uses the frame typography: `30px` font size, `34px` line height,
   medium weight, `0.114px` letter spacing (not the compact UI typography token used by smaller
   settings headings).

## Compatibility boundary

These rules apply to the shared Automations UI on desktop and mobile Web. The responsive card
layout is unchanged; only element order, status composition and heading typography are affected.

## Verification

- Presentation unit tests cover the failed-task secondary queue badge.
- Source fidelity tests cover the page heading typography.
- The populated-list regression test covers the Keep-awake notice appearing before the task grid.
