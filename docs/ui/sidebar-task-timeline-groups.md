# Sidebar Task Timeline Groups

The sidebar timeline view groups by time on the current sort field: `updatedAt` when sorted by update time,
`createdAt` when sorted by creation time.

Group order runs from specific to coarse: 1. Today, 2. Yesterday, 3. 2 days ago / 3 days ago, 4. This week, 5. Last week, 6. This month, 7. Last month, 8. Earlier.

The week group's natural-week start follows the current UI language: Sunday for English, Monday for
Chinese. The grouping logic lives only in the UI layer; the service still provides only task timestamps, so
display text and locale rules do not sink into the task data layer.
