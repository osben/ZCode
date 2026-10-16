# General Mode and Coding Mode (M1)

## Goals and Scope

General mode reduces technical details for non-programming tasks; Coding mode retains the full development entry points. This phase changes only presentation and entry points. It does not change models, system prompts, tool permissions, Agent execution capabilities, or historical data. M2 deliverables/presentation and response style, and the M3 file manager, are out of scope.

Opening file content from a filename is out of scope: currently, a filename with a patch opens the single-file Diff; otherwise, it opens the file. It is not the workspace “Review” tab. Do not misinterpret hiding the “Create review” entry point as disabling all Diff functionality.

## Product Behavior

In Settings and the avatar menu, list the mode options in this order: “Coding mode → General mode.” Default to Coding mode when there is no saved preference, and retain existing users' choices.

| Scenario | General mode | Coding mode |
| --- | --- | --- |
| Command execution and execution groups | Keep summaries and running/failure status; hide commands, output, expansion, and raw-error hover prompts | Display and expand details according to the existing rules |
| File edits and change groups | Keep file summaries and file entry points; hide expansion, inline Diff, and added/deleted line counts | Keep change details |
| Conversation status and turn changes | Hide the Git environment section and turn-change summary | Keep Git and change information |
| Thinking | Keep raw thinking, including code blocks, with existing collapse/expand behavior | Keep the raw displayed text |
| Code in final responses | Always wrap lines, hide the wrap toggle, and retain Copy | Respect and retain the user's existing line-wrap preference |
| Automatic context compaction | Use the wording “Optimize conversation” | Keep the existing context-compaction wording |
| Top-level external open options | File manager only | Installed editors, terminals, and file manager |
| Creating reviews and terminals | Hide related entry points from launch cards, add menus, command palette, and recently closed items; hide the bottom terminal create button | Keep the existing entry points |
| Already-open panels | Review and terminal tabs and the bottom terminal remain visible, switchable, usable, and closable; keep the current active tab | Same as General mode |

Mode-based filtering of external open options applies only to the top-level “Open” button and follows existing SSH/WSL/Docker availability constraints. Mode changes must not override saved external-app preferences. Context menus for file links in replies and for the file tree in the sidebar retain all available external apps; do not filter by General/Coding mode.

Other tools such as Read/Search/Browser/MCP are not simplified uniformly. Keep wording for manual compaction unchanged. Switching modes does not delete or rewrite raw tool results, thinking text, or code line-wrap settings.

## State Ownership and Migration

```text
Settings / avatar menu
    -> ZCodeStore.setInterfaceMode
        -> localStorage: zcode-interface-mode
        -> state:interfaceMode broadcast -> setter in other windows (suppress echo)
        -> presentation / new entry points in shared UI

useAppPanels / taskSidePaneMemory -> open tabs, selected item, collapsed state (not rewritten by mode)
Terminal / TerminalSession      -> terminal session, PTY (not closed by mode)
CLI/runtime -> raw events and task state (mode does not participate)
```

- Values are `general` / `coding`. When unset or unknown, default to `coding`; migrate old `concise` to `general`, and normalize old `professional` to `coding`.
- Desktop and Web share the UI. Desktop preferences use the existing broadcast sync; Web may use the existing no-op broadcast. Do not add a new server-side preference or task configuration.
- Workspace identity remains `workspaceIdentity?.trim() || workspacePath`. Mode switching does not change remote connections, ownership, or task scope.
- Keep existing boundaries for Desktop continuous and mobile Web replayable paths; do not add recovery messages or runtime state.
- The independent Dev instance's Settings service follows explicit `ZCODE_DESKTOP_HOME_DIR`; when unset, retain the HOME / USERPROFILE / homedir fallback so appearance-related actions do not write to another instance.

## Coverage Before Release

See [General/Coding Mode Verification](../testing/general-coding-mode-verification.md) for acceptance cases and coverage status. Declare only verification that has actually been run; pending E2E does not mean the case has entered the CI or Docker suite.
