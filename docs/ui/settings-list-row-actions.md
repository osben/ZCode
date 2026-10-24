# Settings List Row Action Buttons

## Interaction Spec

- Icon-only actions at the right of each settings list item use `Button variant="ghost" size="icon-md"`
  (28px).
- Same-group icon buttons such as edit and delete use `gap-1` (4px).
- Independent controls such as Switch and authorization use `gap-2` (8px) from the icon button group.
- With only one action no extra placeholder gap is created; the Memory row's trailing navigation arrow is
  not an action button and does not take the button size.

## Current Coverage

- Edit and delete of command, hook, subagent and MCP list items.
- The more menu of plugin store list items.
