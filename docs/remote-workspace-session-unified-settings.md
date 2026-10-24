# Remote Workspace Session Unified Settings

## Background

Workspace session state used to be spread across three fields — `lastOpenTabs`, `remoteWorkspaceHistory`, `lastWorkspaceSession` — so restore, reconnect, and removal each maintained multiple sources of truth and drifted.

## Current structure

Only `lastWorkspaceSession` remains:

```json
[
  {
    "kind": "local",
    "workspacePath": "/Users/dev/ZCodeProject/3DAutoSnake"
  },
  {
    "kind": "remote",
    "workspacePath": "/home/ubuntu",
    "workspaceIdentity": "remote:docker:zcode-ssh-container:/home/ubuntu",
    "target": {
      "kind": "docker",
      "container": "zcode-ssh-container"
    },
    "lastOpenedAt": 1776220448653,
    "lastConnectionStatus": "failed",
    "lastConnectionError": "..."
  }
]
```

- `local` entries store only the local workspace path.
- `remote` entries store the remote target, identity key, and latest connection status.
- `workspaceIdentity` is retained for remote workspace isolation and deduplication.

## Migration

- Old `setting.json` is migrated automatically during schema parsing on read.
- Old `lastOpenTabs` entries become `local` entries.
- Old `lastWorkspaceSession.remote(historyId)` entries expand into full `remote` entries using `remoteWorkspaceHistory`.
- The migrated runtime object no longer exposes `lastOpenTabs` / `remoteWorkspaceHistory`.

## Restore and removal rules

- Tabs restore on startup from `lastWorkspaceSession` only.
- A remote workspace restores only as a disconnected tab; no background auto-reconnect.
- Closing a remote tab is an explicit removal: delete it from `lastWorkspaceSession` and clean the matching SSH credential key if present.

## Reconnect rules

- A remote workspace reconnects only via an explicit sidebar reconnect click.
- On success, update the entry's `lastOpenedAt` / `lastConnectionStatus`.
- On failure, update the failure status only and keep the tab so the user can retry.
