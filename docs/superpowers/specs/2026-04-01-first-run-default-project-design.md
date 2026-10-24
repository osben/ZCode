# Startup fallback to a non-project conversation workspace (supersedes the default project)

## Overview

On startup the app restores `lastWorkspaceSession` first. If no workspace is restorable, it ensures
`<dataBaseDir>/.zcode/workspace/default` exists and activates and prewarms it with
`workspacePurpose=conversation`. The UI stays in "no project selected" state; the user can chat
immediately.

## Decision rule

- `lastWorkspaceSession.length > 0` → restore the last session.
- `lastWorkspaceSession.length === 0` or the settings file does not exist → fall back to the
  conversation backing workspace.

## Platform scope

Desktop (Electron) is the reference implementation; Web keeps the same startup semantics.

## Service layer

`IFileService.ensureConversationWorkspace(): Promise<{ path: string; created: boolean; workspacePurpose: "conversation" }>`
is idempotent: it creates `<dataBaseDir>/.zcode/workspace/default` if missing (`created: true`),
otherwise returns the existing path (`created: false`). Repeated calls have no extra side effects.

Settings write constraint: `recentProjects` and `lastOpenTabs` may be written in sequence within one
open-workspace flow, so settings updates must be serialized — a later patch must not overwrite the
field written by the earlier one.

## Desktop startup entry

Main reads settings at startup:

1. `lastWorkspaceSession.length > 0` → no new path is assigned; the renderer restores the session.
2. `lastWorkspaceSession.length === 0` → ensure the backing path exists and pass the full
   conversation descriptor to the renderer; it also serves as the Agent warmup target.

Startup has exactly two main paths: restore a session, or enter the default conversation workspace.

## Files

| File | Role |
|------|------|
| `packages/services/src/file/fileService.ts` | backing workspace path and idempotent creation |
| `packages/shared/src/protocol.ts` | `WorkspacePurpose` and the persisted descriptor |
| `packages/desktop/src/main/startupWorkspace.ts` | resolve restore-session vs conversation fallback |
| `packages/desktop/src/main/index.ts` | startup wiring |

The full current design lives in [2026-07-10-non-project-conversation-workspace-design.md](./2026-07-10-non-project-conversation-workspace-design.md).
