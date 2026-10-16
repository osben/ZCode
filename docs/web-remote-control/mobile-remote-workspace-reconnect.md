# Mobile Remote Workspace Reconnect

The mobile Web remote control workspace list retains SSH remote projects from the desktop window, even if the project has disconnected. Disconnected items are displayed with status via `connectionState: "disconnected"` and optional `lastConnectionError`, but no workspace bridge is created.

Reconnection is triggered by the mobile client sending a `workspace-reconnect-request` app payload to desktop main, which then calls the existing remote workspace reconnection flow through renderer IPC. The renderer remains the sole owner of SSH connections, credentials, and tab state; the mobile client only triggers reconnection and refreshes the list.

Disconnected remote workspaces cannot open or create tasks before reconnection succeeds. After reconnection succeeds, the next workspace list returns a new `remoteSessionId`, at which point the mobile client can create a bridge to enter chat.

After entering chat, the message stream resumes according to the mobile remote control replayable semantics:

- The mobile bridge attaches to the remote session host already existing on the desktop, without creating a new SSH/WSL/Docker session.
- After disconnection recovery, the bridge is restored first, then the current task is aligned via task snapshot.
- `runtime.streamWatermark` is used to determine whether the snapshot covers the replayable stream gap.
- `pendingPermissions`, `pendingElicitations`, and `pendingCommands` are restored with the snapshot, preventing permissions, `askUserQuestion`, or already-accepted send queues from remaining only in the mobile page memory.
