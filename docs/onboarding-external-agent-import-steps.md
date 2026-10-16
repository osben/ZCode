# Onboarding Migration Wizard: External Agent Import Steps

## Background

Settings already supports importing Skills, MCP servers, plugins, and commands from external Agents. Plugin import still requires Agent-side support, so its entry point is temporarily hidden. The first-run data migration wizard should initially cover the available Skills, MCP server, and command imports.

## Goals

- Add three available external-import steps before the formal migration step in the onboarding migration wizard:
  - Skills
  - MCP servers
  - Commands
- Temporarily hide the plugin-import step until the required Agent-side support is available.
- Temporarily hide the proxy-settings step; do not migrate Agent proxy configuration in the onboarding data migration wizard.
- Reuse the Settings import dialog interactions in each step: scanning, scope switching, refresh, expanding sources, selecting items individually, select/deselect all, import target, and import method.
- Reuse the Settings MCP import logic for the MCP-server step; merge configuration only and do not show symlink/copy modes.
- Import selected items from all three available import steps together when entering the final migration step.

## Behavior

- Scan each of the three available import steps on demand when the user enters that step, rather than reading all external directories on the first screen.
- Users may select no external items and continue.
- Enable “Start migration” when at least one session or one external import item is selected.
- Continue reusing the settings-sync result counts and show the number of successful, skipped, and failed imports together on the completion page.

## Compatibility

- Desktop and Web share UI state; the settings-sync service determines what can actually be scanned.
- The Project target continues to depend on the current `workspacePath`; disable the Project target when there is no workspace.
- Do not add Gemini-related sources.
