# Settings Empty State

Use a transparent background and dashed border for empty states in Settings so empty content does not have the same visual hierarchy as real resource cards.

## Visual Rules

- Empty-state containers consistently use `border-dashed border-border`; do not set `bg-card`, `bg-surface`, or `bg-background`.
- Keep empty states in resource lists compact, using `rounded-xl px-4 py-3` and secondary body text.
- Empty states that guide users to create something may retain a title, description, and action button, with more vertical spacing.
- Empty states for data charts may remain centered, but must follow the same dashed-border and transparent-background rules.
- Do not add decorative icons to empty states; use icons only for real resource entries or actions with clear meaning.
- Loading, error, capability-restriction, and no-workspace-selected states are distinct states and must not use the empty-state styling.

## Scope

Currently applies to empty states for plugins, skills, subagents, automations, MCP, commands, hooks, and usage statistics in Settings.
