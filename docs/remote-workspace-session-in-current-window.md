# Remote Workspace Session in a Workspace Window (current state)

A remote workspace opens as a logical session/tab inside the current workspace window; no separate BrowserWindow is created per workspace. Local and remote scopes are both owned by the window's single Window Host. SSH shares a Host connection by `remoteHostKey`, WSL by `normalized(distro,user)`; Docker/Server use dedicated connections but create no extra Host PID.

```text
Workspace Window
  └─ Window Host（唯一 PID）
      ├─ LocalSource -> local workspaceKey -> local zcode-cli
      └─ RemoteConnectionRegistry
          ├─ shared SSH connection (remoteHostKey)
          │  ├─ remoteSessionId A -> ssh workspaceKey A
          │  └─ remoteSessionId B -> ssh workspaceKey B
          ├─ shared WSL connection (normalized distro/user)
          │  ├─ remoteSessionId C -> wsl workspaceKey C
          │  └─ remoteSessionId D -> wsl workspaceKey D
          ├─ dedicated Docker connection -> docker workspaceKey
          └─ dedicated Server connection -> server workspaceKey
```

## Identity and routing

- `workspaceIdentity` is the isolation identity; `workspacePath` is the real path in the target environment.
- Sessions, tabs, CLI, caches, queues, history, and remote-control keys use `workspaceKey = workspaceIdentity?.trim() || workspacePath`.
- File operations and command cwd use `workspacePath`.
- A remote workspace must pass a uniformly constructed `workspaceIdentity`; remote control must also pass `remoteSessionId`.
- The renderer selects the workspace scope through the workspace service resolver, never by path alone.

## Lifecycle

```text
select/connect remote workspace
  -> establish remote workspace scope
  -> register workspaceIdentity + remoteSessionId
  -> Main forwards request to the window Host
  -> Window Host allocates remoteSessionId and resolves/creates connection
  -> Window Host creates identity-validated scoped attachment
  -> pane subscribes session projection
  -> mobile may attach to the same Host/CLI
```

Closing a pane or switching workspaces must not kill another workspace's CLI; closing a single attachment does not destroy the Window Host or a connection still in use. When a WSL logical session closes, its runtime is released per workspace generation, with a 60-second idle TTL after the last owner disappears; Docker/Server dedicated connections are reclaimed with the logical session lifecycle. Main/relay only handle connection requests, ports, and attachment scheduling — they do not duplicate remote session state.

## Regression boundaries

- Same path with different remote identities must be isolated.
- Desktop continuous and mobile replayable must connect to the same workspace CLI.
- After switching workspaces, file/terminal cwd uses the new `workspacePath`; caches and sessions stay isolated by workspaceKey.
- Mobile must not start its own Host or Agent runtime; it can only attach to an existing scope of the desktop window's single Window Host.
- The Window Host registry is not shared across BrowserWindows, keeping identity, ports, and failure domains inside the window boundary.
