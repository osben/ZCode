# Remote Target Abstraction

## Background

The core implementation of remote connections is no longer specific to SSH:

- `packages/server/src/remote/connect.ts` depends only on `IRemoteBackend`.
- Deploy, stdio handshake, and RPC proxy can all be reused.

What once tied the capability to SSH was the entry protocol at the desktop → main → host layer:

- Shared types used `SSHConnectOptions`.
- The old remote Host init payload used `sshOptions`.
- The Host directly instantiated `SSHBackend` in the entry branch.

This meant that every new remote form (WSL, Docker) required copying a set of `ConnectWSL` / `InitWSL` / `setupWSLConnection` methods.

## Changes in This Update

Three steps have now been completed:

- Phase 0: unify the connection contract without changing the main deploy/handshake flow.
- Phase 1: connect the WSL/Docker backends to the unified target.
- Phase 2: add platform detection and a unified remote-connection UI to the desktop/web entry points.

### Unified Target

The shared layer adds the `RemoteTarget` discriminated union:

- `kind: "ssh"`
- `kind: "wsl"`
- `kind: "docker"`

`IPlatformService.connectRemote()`, `PlatformChannels.ConnectRemote`, and the Main→Window Host `ConnectRemoteWorkspace` payload all pass `target`. After R1, Main only forwards this request; the `RemoteConnectionRegistry` inside the Window Host owns connection reuse and logical-session lifecycles.

### Backend Factory

`packages/server/src/remote/create-backend.ts` converts `RemoteTarget` into an `IRemoteBackend`:

- SSH: reads the private key and creates `SSHBackend`.
- WSL: creates `WSLBackend`.
- Docker: creates `DockerBackend`.

The Window Host control layer therefore no longer needs to know the specific transport. It only:

1. Receives `ConnectRemoteWorkspace { requestId, target }`.
2. Calls `createRemoteBackend(target)`.
3. Passes the result to `connectRemote()`.
4. Allocates `remoteSessionId` and exposes a scoped attachment that strictly validates identity/path.

### Platform Detection and Unified UI

`IPlatformService` adds three host capabilities:

- `isDockerAvailable()`
- `listWSLDistros()`
- `listDockerContainers()`

Desktop dynamically calls the detection functions in `@zcode/server/remote` through the main process; the Web implementation remains empty.

The UI no longer splits the entry point into `SSHDialog` / `WSLDialog` / `DockerDialog`; it uses a single remote-connection dialog:

- Always show SSH.
- Show WSL only on Windows desktop.
- Show Docker only when the local Docker daemon is available.

When adding a transport, the entry layer only needs:

1. A shared target type.
2. A backend-factory branch.
3. Platform-detection capability.
4. A mode in the unified dialog.

## Results

- The existing SSH path remains available.
- WSL reuses the same deploy/handshake/RPC path; no new Host/Main protocol is needed.
- Docker reuses the same deploy/handshake/RPC path; no new Host/Main protocol is needed.
- Remote entry-point names are no longer tied to a specific transport.

## Current Status

- `kind: "ssh"`: available.
- `kind: "wsl"`: available; it prefers direct file copying through `\\wsl.localhost\` / `\\wsl$\`, falling back to shell streaming upload when unavailable.
- `kind: "docker"`: available; it connects directly to a local container using `docker exec` and streaming writes through stdin. The uploaded file is created by the container's current user to avoid ownership mismatches during later replacement.
- Desktop UI: SSH / WSL / Docker can be selected from the unified remote dialog.
- Web UI: SSH only; WSL / Docker detection is an empty implementation, so those entry points are not shown.

## Follow-up Suggestions

1. Keep and verify that “Docker via SSH” does not regress.
2. Add more detailed E2E coverage for the remote dialog (WSL/Docker tab switching, container selection).
3. Add backend capabilities as needed (for example, all Docker containers or default WSL distro metadata).
