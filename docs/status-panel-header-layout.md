# Status Panel Header Layout

## Purpose

The headings for the Git, Goal, Progress, and Run sections in the Status panel must use a consistent information order. Avoid mixing layouts where some status information is aligned to the right while other information follows the heading.

## Rules

- Order each section header row as: title, expand/collapse chevron, status content.
- In the collapsed state, status content for Git, Progress, and Run must appear immediately after the chevron; do not push it to the far right with `ml-auto`.
- Goal pause/resume is an immediate action for the current goal and appears before elapsed-time and token metrics.
- In the expanded Status panel, provide an absolutely positioned collapse button in the upper-right corner to switch to the mini state.
- When the upper-right collapse button is present, reserve space on the right side of section header rows so titles, chevrons, and status content do not overlap it.
- When the mini pill displays running background tasks, show only the task-type icon and the number of running tasks; do not show elapsed time or a timer. The expanded Run section and task details continue to show elapsed time.

## Compatibility

- This layout does not change the Status panel's data sources; it changes only the information order in header rows.
- The mini state continues to use the existing pill-row entry point to expand the panel.
- Continue using existing i18n keys; do not add locale resources.
