# Settings Header Action Buttons

## Background

Subpages in Settings for skills, commands, MCP servers, and similar areas place frequent actions to the right of the descriptive text. To reduce visual shifts between Settings pages, these header toolbar controls must use a consistent compact icon-button style.

## Interaction Rules

- Icon-only actions for adding, importing, opening a directory, syncing, refreshing, and managing items in the upper-right of a list use `Button variant="ghost" size="icon-md"` (28px).
- Show only a semantic icon inside the button; display its label with `ControlHintTooltip`.
- Keep the same label as the button's `aria-label` so accessibility and localization semantics are preserved.
- Use `size-3.5` icons, matching the create, import, and refresh buttons on the Skills page.
- Use consistent `gap-2` (8px) spacing between adjacent actions in the same list header.

## Current Coverage

- Skills: create a skill, import skills, refresh the skills list.
- Memory: refresh the project memory list.
- Commands: create a command, open the user commands directory, refresh the commands list.
- Model settings: refresh the model-provider list.
- MCP servers: create an MCP server.
- Plugins, hooks, and subagents: icon-only actions in the upper-right of the corresponding list.
