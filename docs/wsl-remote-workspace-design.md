# WSL remote workspace support

## Background

ZCode supports SSH and Docker remote connections. This document records the WSL (Windows Subsystem
for Linux) design and implementation state.

## Implementation state

Done:

- `WSLBackend` (`packages/server/src/remote/wsl-backend.ts`).
- `WSLDetect` tool (`packages/server/src/remote/wsl-detect.ts`).
- `createRemoteBackend` factory supports wsl (`packages/server/src/remote/create-backend.ts`).
- UI: WSL option in KindStep, WSL form in SettingsStep, WSL in ConnectingStep.
- i18n copy (en-US / zh-CN).
- Feedback module supports WSL connection failures.

## SSH vs WSL

| Dimension       | SSH                                   | WSL                                    |
| --------------- | ------------------------------------- | -------------------------------------- |
| Connection      | TCP protocol, ssh2 library            | Local subprocess, `wsl.exe`            |
| Authentication  | Password / private key / SSH Agent    | Windows user identity (none needed)    |
| File system     | SFTP / exec pipe                      | Windows path mapping `\\wsl$\Distro`   |
| Deploy path     | Remote `~/.zcode/server`              | WSL path `/home/user/.zcode/server`    |

## Release lifecycle

WSL uses a window-scoped pooled Remote Host: logical workspace sessions of the same window and the
same normalized distro/user share one Host, one `wsl.exe` server launcher and one `zcode-server`.
Each session keeps its own `remoteSessionId`, attachment and `workspaceKey`. Minimizing, hiding to
tray, renderer reload and a mobile `/remote` attachment disconnect do not destroy the Host directly.

```text
last reference of a single workspace closes
  -> Host releases preparation/Agent runtime by workspace generation
  -> with a running task, defer until terminal
  -> quick reopen of the same workspace first waits for the acquire ACK, then attaches the RPC port

last Host owner closes
  -> keep a 60 s idle TTL during which the same Host/server can be reused

real window close / app quit / update install
  -> RemoteSessionManager snapshots and dedupes Remote Hosts
  -> Main sends Host Dispose and waits for Host exit
  -> Host releases services in stages
  -> RemoteConnection calls stdin.end() synchronously and waits for remote stdio close
  -> WSLBackend waits for the wsl.exe child it created to exit
  -> after the grace timeout, kill only the child recorded by that backend
```

Release must never call `wsl --terminate` or `wsl --shutdown`. The distro may still show Running; that
is distro-level state and does not mean ZCode's Host, `wsl.exe` or remote `zcode-server` is still held.
Any fallback may act only on the child process the current backend explicitly spawned; never scan or
kill by process name, which could hit the user's other tasks in the same distro.

Main's Remote Host set includes WSL/SSH shared Hosts, Docker/Server dedicated Hosts and the Bot
remote runtime. App quit and update install use the same idempotent wait barrier; once the barrier
starts, creating a new Remote Host is rejected so no new process lands outside the snapshot.

## Design: composition + unified interface

`WSLBackend` implements the existing `IRemoteBackend` interface
(`packages/server/src/remote/backend.ts`) with a `wsl.exe` subprocess in place of ssh2.
`packages/server/src/remote/connect.ts` orchestrates the connection and `createRemoteBackend` picks
`ssh` or `wsl` by `RemoteBackendType = "ssh" | "wsl"`; `detectEnv.ts` is reused for environment
detection. WSL options: `distribution` (e.g. "Ubuntu"); SSH options: host, port, username, plus
shared `privateKeyPath` / `password`.

Command execution must use `wsl.exe --distribution <distro> --exec bash -c <command>`, not `--`.
Without `--exec`, `wsl.exe` hands the raw command line to the user's default shell `-c`; the double
quotes Node adds make the outer shell expand `"$var"` first, so local variables become empty strings
before reaching `bash -lc` (root cause of the 2026-09-14 false "remote lacks tar" report). `--exec`
parses per `CommandLineToArgvW` and execs directly.

`~` in remote paths expands to the distro user's home, queried with
`wsl.exe --distribution <distro> --exec bash -c "printf %s \$HOME"` (fallback `/home/user`).

## Key implementation details

1. **Path conversion.** WSL can be accessed as the internal path `/home/user/.zcode` or from Windows as `\\wsl$\Ubuntu\home\user\.zcode`; for consistency with SSH, use WSL-internal paths.
2. **File upload.** SSH uses SFTP + exec fallback. WSL: small files via `wsl.exe --exec cat` + stdin pipe; for large files consider `wsl.exe cp` or writing the `\\wsl$\Distro` path directly.
3. **Deploying zcode-server.** Identical to SSH: `ZCODE_SERVER_RUNTIME_ROOT=~/.zcode/server ~/.zcode/server/node ...`, run through `wsl.exe --exec bash -c "..."` instead of `ssh user@host "..."`.
4. **Listing distros.** `wsl.exe --list --quiet`, split by line, trimmed, empties dropped.

## UI

The connection dialog offers a connection type choice SSH / WSL. SSH mode shows host, port, username
and auth method. WSL mode shows a distro choice (defaulting to the detected available list).

## Risks and notes

1. WSL2 is required (supports `wsl.exe --exec`).
2. Path separators: Windows `\`, WSL `/`.
3. Permissions: WSL runs as the current Windows user, no extra authentication.
4. Performance: WSL communication is faster than SSH (local process vs TCP).
5. Platform: available only on the Windows desktop app.
