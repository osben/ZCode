# Plugin Import Entry Temporarily Hidden

## Background

The plugin import capability has a basic implementation of the frontend dialog and onboarding step, but it
still needs Agent-side support before it can be opened stably.

## Current Behavior

- Settings - plugin management: the "Import plugins from external Agent" button is temporarily hidden.
- Onboarding - data migration wizard: the plugin import step is temporarily hidden.
- The Skills, MCP servers and Commands import steps stay visible; the migration summary no longer counts the
  plugin import selection.

## Restore Condition

Once the Agent side supports plugin import, the plugin management entry and the plugin import step of the data
migration wizard can be restored and counted again in the migration task summary.
