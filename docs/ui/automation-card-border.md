# Automation Card Border

## Goal

Content Cards in the automation main view use the same semantic border level as home Cards. This avoids card edges being hard to see in Zai Dark when `border-surface` or an inset shadow is too light.

## Visual contract

- The home off-peak template card, real automation task card, off-peak task card, scheduled and off-peak template cards, no-task empty state and no-workspace hint all use `border-card-border`.
- Card background, radius, spacing and interaction states keep their existing contract; only the border semantics converge.
- Inputs, menus, dialogs and table dividers keep their own semantic borders and are not replaced with the Card border.
- Desktop and Web share the same styles; Zai Light and Zai Dark must not use hard-coded colors.
- The top-right "创建任务" (Create task) button on the new scheduled-task and new off-peak-task detail pages uses the shared `Button` with `variant="default" size="lg"` and no extra `className`; the automation home entry keeps its independent style.
- The text and dropdown segment of "创建定时任务" (Create scheduled task) also reuse the shared `Button` default variant; the business layer keeps only the segment layout, modeled on the Changes Summary Open segmented button: `DropdownMenu` wraps the whole rounded container, the main button and the dropdown Trigger are sibling controls, no outer border or extra divider is added, and the menu opens from the right edge of the combined button with `align="end"`.
- The create entries at the top right of the automation home and in the empty state share the 28px-high `default` size; refresh uses `outline/icon` and the segmented dropdown uses `icon-md`, so refresh and create are equal height while keeping primary/secondary hierarchy.

## Regression boundary

- Do not restore `border-surface` as the border of automation content Cards.
- Do not simulate the off-peak task card border with `shadow-[inset_0_0_0_1px_var(--color-surface)]`.
- `AutomationHistoryEmptyState` uses `rounded-xl border border-dashed border-card-border`, so the "还没有运行记录" (no run records yet) empty state is consistent on the scheduled and off-peak detail pages.
