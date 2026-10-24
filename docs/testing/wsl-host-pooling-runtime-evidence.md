# WSL Host Pooling Runtime Verification Evidence

## Scope

- Date: 2026-07-20 (Asia/Shanghai)
- Branch: `fix/wsl-remote-process-cleanup`
- Commit under test: `8a9f553abfcdc53ddb514fce372b118428a2a84b`
- Platform: Windows + WSL2 `Ubuntu`, Linux user `dev`
- App version `3.4.0`, Electron `41.0.3`
- remote assets: intranet CDN `http://intranet.example.invalid:12345/zcode/@electron/release/v3.4.0/`; launch variables `ZCODE_DEV_REMOTE_ASSET_USE_CDN=1` and `ZCODE_REMOTE_ASSET_CDN_BASE_URL` pointing at that root.

The run uses the `packages/desktop/out` rebuilt from the current branch; the renderer's Chromium arguments contain `--app-path="E:\GitProject\z-code\z-code\packages\desktop"`. No previously installed ZCode was used.

## Automated verification

Local repository binaries were called directly to avoid a pnpm wrapper install in the offline environment:

```text
vitest desktop affected: 6 files, 54 tests passed
vitest server affected: 5 files, 46 tests passed
vitest services affected: 1 file, 79 tests passed
vitest shared validation: 1 file, 25 tests passed
tsc -b ...: exit 0
oxlint: 0 errors, 52 existing warnings
```

Covered: release during connection establishment, Host shutdown phase, window-level pool, 60-second fake timer, running task blocking release, mobile attachment owner, Docker dedicated, WSL discovery cache, remote asset installer, WSL backend and stdio lifecycle.

## How it was run

The desktop app was started from the current branch and the preload bridge was called through the dev-mode fixed CDP port `9229`:

```js
window.zcode.connectRemote(
  { kind: "wsl", distro: "Ubuntu" },
  requestId,
  { workspacePath, workspaceIdentity },
);
```

Process sampling:

```powershell
Get-CimInstance Win32_Process
wsl.exe -d Ubuntu -- bash -lc "ps -eo pid,ppid,rss,lstart,args"
```

## Sharing results

### One workspace

First connection succeeded, logical session `80b8b530-d2ca-447a-9966-9d3472f76dae`:

| Layer | PID | RSS | Start time | Note |
| --- | ---: | ---: | --- | --- |
| Windows remote UtilityProcess Host | 24868 | not sampled separately | 17:26:13 | Created by the first WSL workspace |
| WSL `zcode-server` | 1083 | 192188 KiB | 17:26:24 | The only server |

### Two workspaces

The second logical session is `ba41c70a-8a04-46dc-a193-aeaa9062d8f0`. After connecting, the Windows remote Host is still PID `24868`, the WSL `zcode-server` is still PID `1083` and the server count is `1`.

### Five concurrent workspaces

After cleaning the previous round and restarting the app, five connections of the same distro/user and different workspace identities ran concurrently:

```text
elapsedMs=9985
success=5/5
remoteSessionId:
  6de57d48-38ea-4c13-b1cc-2ec5c8d0b180
  9987c0cf-6aa2-4462-9fa0-a66cd96a5616
  e386ab31-8ca7-4db7-ab05-693e42ea9bde
  60557e34-c818-4d4c-943b-a324b4a0d83a
  0e03e8c0-213f-4966-a119-0a4ebfcf6808
```

| Layer | PID | PPID | RSS | Count |
| --- | ---: | ---: | ---: | ---: |
| Windows remote UtilityProcess Host | 24708 | 3596 | not sampled separately | 1 |
| Windows `wsl.exe` launcher | 26684 | 24708 | not sampled separately | 1 launcher chain |
| WSL `zcode-server` | 1106 | 1105 | 198232 KiB | 1 |

After releasing logical sessions 4 and 5 and keeping three workspaces, the Host PID is still `24708`, the server PID still `1106`, the server count still `1`; RSS was `167216 KiB`.

Conclusion: 1, 3 and 5 logical workspaces of the same window, distro and user all reuse one Windows Host and one WSL `zcode-server`. Later attaches created no new server.

## Reclamation timing

### Single workspace detach

After closing the first logical session the second session still holds the owner: Host PID `24868` and server PID `1083` both stay, so the shared connection is not killed by mistake.

### Last owner and idle TTL

After closing the last logical session:

```text
T+2s: Host PID 24868 present; server PID 1083 present
after about the 60s boundary: Host PID 24868 absent; zcode-server-count=0
```

Command sampling and the WSL start itself add a few seconds of scheduling overhead, so the runtime only records "about the 60 s boundary"; the exact `60_000ms` is asserted with a fake timer in `remoteWslHostPool.test.ts`.

### App exit overrides the TTL

After reconnecting one workspace:

| Resource | PID before exit | About 4.0s after normal close |
| --- | ---: | --- |
| Windows remote Host | 25468 | absent |
| WSL `zcode-server` | 1122 | count 0 |

After the main window called `CloseMainWindow()` the main process exited in `741ms`; from the close request to the final PID check was `4024ms`. A second round repeated the close with three workspace owners still held: main exited in `396ms` and at the `3641ms` check Host PID `24708` and server PID `1106` were also gone.

Conclusion: really closing the whole app skips the 60-second idle TTL and enters bounded reclamation immediately.

## Not covered and boundaries

- No actual task was started, so no workspace Agent/MCP PID was produced; running-task draining is verified by unit tests.
- No update install was run; only the app/window shutdown manager path shared with updates and the app-exit runtime were verified.
- No real-device mobile replayable connection was run; the mobile attachment owner boundary is covered by desktop manager tests.
- Docker was not part of this WSL PID measurement; code and tests confirm it still uses a dedicated `InitRemoteWorkspace` and this change added no shared pool for Docker.
- `wsl --terminate` and `wsl --shutdown` are not called; after verification the distro can keep running and only the ZCode-owned server is reclaimed.
