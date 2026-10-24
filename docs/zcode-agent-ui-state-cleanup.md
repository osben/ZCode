# ZCode Agent UI state cleanup

## Goal

The UI layer keeps only view state and necessary short-lived optimistic state; real session/runtime
state is owned by the ZCode Agent and the ZCode Protocol V4 projection. New changes must not extend
the old protocol naming.

## Current state

- The old `workspaceInitByProvider` is a single `workspaceInit`. `setWorkspaceInitState` / `setWorkspaceInitAttempts` take no provider parameter and write workspace-level init state; `getWorkspaceProviderInitState` is replaced by `getWorkspaceInitState`, so the UI no longer expresses multi-agent init state.
- The default workspace state uses a stable singleton reference so selectors on a never-written workspace bucket do not produce a different snapshot on each read.
- `taskStatus` / `taskError` are removed from the workspace root state. A draft keeps a short-lived `draftRuntime`; the displayed state of an existing task is derived from the active task runtime through `getWorkspaceDisplayedTaskState`.
- `availableModes` / `currentModeId` are removed from the workspace root state. The UI derives mode state from `configOptions` through `getWorkspaceModeState`; `setAvailableModes` / `setCurrentModeId` remain only as a compatibility layer patching `configOptions` for legacy entries such as `mode_update`.

## Follow-ups

- Keep aligning `configOptions` with `ZCodeSessionSettingsState`; the UI adds no independent mirrored model, mode or thinking-level fields.
- Move `queuedPromptsByTaskId` and the replayable mirror state to the ZCode session runtime / host command queue.
