# Onboarding Migration Wizard: External Agent Import Steps

## Goals

- Before the formal migration step, the onboarding migration wizard offers three available
  external-import steps: Skills, MCP servers, Commands. Plugin import still needs Agent-side
  support, so its step stays hidden.
- Hide the proxy-settings step; Agent proxy configuration is not migrated by the onboarding wizard.
- Reuse the Settings import dialog interactions per step: scanning, scope switching, refresh,
  expanding sources, per-item selection, select/deselect all, import target, import method.
- The MCP-server step reuses the Settings MCP import logic; configuration merge only, no
  symlink/copy modes.
- Selected items from all three steps import together when the user enters the final migration
  step.

## Behavior

- Each step scans on demand when the user enters it, not all external directories on the first
  screen.
- Users may select no external items and continue.
- "Start migration" enables when at least one session or one external import item is selected.
- Keep the settings-sync result counts; the completion page shows successful, skipped and failed
  import counts together.

## Compatibility

- Desktop and web share UI state; the settings-sync service decides what can actually be scanned.
- The Project target depends on the current `workspacePath`; disable it when there is no workspace.
- No Gemini-related sources.
