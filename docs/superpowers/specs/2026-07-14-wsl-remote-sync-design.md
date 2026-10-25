# WSL Remote Sync Entry Design

## Background

Skill, MCP, and Plugin remote sync was designed for SSH workspaces, with SSH-named UI entries and copy. Desktop WSL workspaces already run the unified `RemoteTarget` / `InitRemoteWorkspace` / remote service collection chain, with `skillSyncService`, `mcpSyncService`, and `pluginSyncService` coming from the WSL remote host.

## Goals

- SSH and WSL workspaces show the same remote sync entries.
- The sync target stays the current remote runtime's user directories: `~/.zcode/skills`, `~/.zcode/cli/config.json`, `~/.zcode/plugins`.
- Local workspaces show no remote sync entries.
- Docker is not extended this round — no spreading plugin-install and MCP environment-compatibility risk into containers.

## Design

The UI-layer `shouldShowSshRemoteSyncActions` generalizes into a remote sync capability check accepting `remoteTarget.kind` of `ssh` or `wsl`. Remote service wiring gains no branch and reuses the existing remote workspace services.

Target labels per kind:

- SSH: `user@host:port · /remote/workspace`
- WSL: `WSL · distro · user · /remote/workspace`

Copy moves from "SSH host" to "remote target / 远端目标" so WSL is not mislabeled. MCP and plugin environment notices keep explaining that things run in the remote environment after sync; if a local MCP command or plugin depends on Windows-only capabilities under WSL, status checks surface the unavailability — no silent filtering at the sync entry layer.

## Write-permission preflight

Before sync starts, the remote sync service runs a write preflight:

- Skills: `~/.zcode/skills`
- MCP: `~/.zcode/cli`
- Plugins: `~/.zcode/plugins` and `~/.zcode/cli`

The preflight only does `mkdir -p`-equivalent directory creation, writes a `.zcode-sync-preflight-*` temp file, and deletes it immediately. No `chmod`/`chown` — the WSL/SSH user's permission model is never changed. If a directory is owned by another user, the target path is a file, or the remote user cannot write, the UI shows an error before exporting local resources and stops the sync.

Preflight is part of the sync lifecycle. After clicking start, the flow must enter the `preflighting` activity state before the first remote RPC await, with a ref-level in-flight guard against fast repeat clicks while React state is uncommitted. Neither `preflighting` nor `syncing` may close the dialog; on preflight failure the flow returns to `selection` and never proceeds to export, import, or plugin install.

The preflight remote RPC has a UI-side bounded wait, 15 s by default. On timeout the UI restores `selection`, releases the in-flight guard, and shows a localized error; a late RPC return no longer advances the sync. The service layer has no cancellation token and the preflight only does repeatable marker-file write/delete, so this version keeps the UI main flow recoverable without introducing a remote runtime or new cancellation channel.

## Web remote-control boundary

Sync entries show only on the desktop `desktop-continuous` surface. Mobile web remote control uses shared-host attachment, where `baseServices` means the current bridge host; when that bridge host is itself a WSL/SSH remote workspace host, `local*SyncService` and `remote*SyncService` can point at the same remote host, breaking the invariant "source = desktop local user directory, destination = current remote user directory".

The current version therefore hides Skills/MCP/Plugins remote sync entries on the `web-remote-replayable` surface, and never spins up a separate mobile Agent runtime, local host, or remote session. If mobile sync is required later, it must explicitly inject the desktop-local source service through the existing host attachment while keeping the destination as the current remote workspace service.

## Verification

- UI helper unit tests: SSH and WSL show sync entries; local and Docker do not; the Web remote surface hides them (no remote-to-self sync).
- Connected-directory page covers the WSL sync dropdown; skill sync target format covers the WSL label.
- Service unit tests cover remote write-preflight success and unwritable-target failure.
- Sync dialog unit tests cover the `preflighting` close protection and in-flight guard; the preflight helper covers timeout convergence (a permanently pending remote RPC must never lock the dialog).
- Run `pnpm typecheck` and `pnpm lint`.
