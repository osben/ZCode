# Local workspace path and cold-resume identity boundary

## Status

- Type: bug-fix spec
- Scope: desktop local workspaces, CLI session persistence, V4 conversation cold resume
- Unchanged: remote workspace identity; desktop `desktop-continuous` and mobile `web-remote-replayable` delivery semantics

## Problem

Local workspaces may omit `workspaceIdentity`; the identity key follows the existing rule:

```text
workspaceKey = workspaceIdentity?.trim() || workspacePath
```

The `workspacePath` from the directory picker may keep a trailing `/`. That value feeds workspace-identity state such as the provider registry, tabs, and the task index. When the CLI creates the runtime, it also derives the execution directory via `path.resolve` (no trailing `/`) and writes it back to the session's `path` / `directory`. After a CLI restart, V4 cold resume rebuilds the workspace reference solely from the session path, so one local directory ends up with two exact keys:

```text
current attachment / provider registry   /home/user/project/
session cold-resume path                 /home/user/project
```

This is not a provider-catalog lookup bug: workspace identity is being overwritten by the execution path at the runtime/persistence boundary.

## Semantic boundary

`workspacePath` and `workingDirectory` must be stored separately:

```text
directory picker / current attachment
  workspacePath: /home/user/project/
             |
             +--> workspaceKey / provider registry / task index
             |
             +--> AgentRuntimeConfig.workspacePath
                        |
                        +--> session.path + session.directory (identity resume)

execution chain
  workspacePath: /home/user/project/
             |
             +--> path.resolve(...)
                        |
                        +--> workingDirectory: /home/user/project (cwd / files / Git)
```

- `workspacePath`: keep the caller's actual path representation; used for local workspace identity resume.
- `workingDirectory`: may be normalized; used only for execution semantics — command cwd, file reads/writes, Git.
- Never normalize `workspaceKey` globally, to avoid migrating or breaking existing persisted keys (tabs, task index, provider registry).

## V4 cold resume

A conversation subscribe already sits inside a trusted workspace attachment and must pass the current `workspace` reference to cold resume:

```text
desktop / web attachment
  -> v4/conversation/subscribe { sessionId, workspace }
  -> ColdSessionResumeCoordinator
  -> activateSessionForResume({ sessionId, workspace })
  -> provider registry hit by current workspaceKey
```

Priority:

1. The `workspace` carried by the current subscribe.
2. Only when the caller has no workspace context, fall back to the persisted session `path` / `directory`.

This fixes persistence for newly created sessions and immediately restores historical sessions that older versions already wrote with no trailing `/`.

## Acceptance scenarios

1. With a trailing `/` in the local workspace path, a new session persists that path while the runtime cwd stays normalized.
2. When a historical session recorded no trailing `/` but the current attachment has one, cold resume uses the attachment workspace; provider models work and messages can continue.
3. Compatibility calls without current workspace context still resume from the persisted session path.
4. Remote workspaces keep carrying full `workspaceIdentity` and `remoteSessionId`; never isolate by `workspacePath` alone.
5. Desktop continuous and mobile replayable share only the workspace reference passthrough; snapshot, gap, queue, and message delivery boundaries are unchanged.
