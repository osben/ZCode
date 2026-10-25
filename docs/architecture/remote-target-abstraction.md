# Remote Target Abstraction

## Background

The remote connection core is not SSH-specific. `packages/server/src/remote/connect.ts` depends only on `IRemoteBackend`; deploy, stdio handshake and RPC proxy are reusable. What tied the capability to SSH was the entry protocol at the desktop -> main -> host layer: shared types used `SSHConnectOptions`, the old remote Host init payload used `sshOptions`, and the Host instantiated `SSHBackend` directly in the entry branch, so each new remote form (WSL, Docker) would need its own `ConnectWSL` / `InitWSL` / `setupWSLConnection` set.

The connection contract is now unified (the shared target, the backend factory, platform detection and a single connection dialog all exist; see below).

## Unified target

The shared layer defines the `RemoteTarget` discriminated union with `kind: "ssh" | "wsl" | "docker"`. `IPlatformService.connectRemote()`, `PlatformChannels.ConnectRemote` and the Main -> Window Host `ConnectRemoteWorkspace` payload all pass `target`. Main only forwards the request; the `RemoteConnectionRegistry` inside the Window Host owns connection reuse and logical-session lifecycles.

## Backend factory

`packages/server/src/remote/create-backend.ts` converts a `RemoteTarget` into an `IRemoteBackend`: SSH reads the private key and creates `SSHBackend`; WSL creates `WSLBackend`; Docker creates `DockerBackend`. The Window Host control layer therefore need not know the transport. It:

1. receives `ConnectRemoteWorkspace { requestId, target }`;
2. calls `createRemoteBackend(target)`;
3. passes the result to `connectRemote()`;
4. allocates `remoteSessionId` and exposes a scoped attachment that strictly validates identity/path.

## Platform detection and unified UI

`IPlatformService` has three host capabilities: `isDockerAvailable()`, `listWSLDistros()`, `listDockerContainers()`. Desktop calls the detection functions in `@zcode/server/remote` dynamically through the main process; the Web implementation is empty.

The UI uses a single remote-connection dialog instead of `SSHDialog` / `WSLDialog` / `DockerDialog`: SSH is always shown, WSL only on Windows desktop, Docker only when the local Docker daemon is available. Adding a transport needs only a shared target type, a backend-factory branch, a platform-detection capability and a mode in the unified dialog.

## Current status

- `kind: "ssh"`: available.
- `kind: "wsl"`: available; prefers direct file copy through `\\wsl.localhost\` / `\\wsl$\`, falling back to shell streaming upload.
- `kind: "docker"`: available; connects to a local container with `docker exec` and streaming writes through stdin. The uploaded file is created by the container's current user to avoid ownership mismatches on later replacement.
- WSL and Docker reuse the same deploy/handshake/RPC path as SSH; no new Host/Main protocol is needed, and entry-point names are not tied to a transport.
- Desktop UI: SSH / WSL / Docker selectable in the unified dialog. Web UI: SSH only; WSL / Docker detection is an empty implementation, so those entries are not shown.

## Follow-ups

1. Keep and verify that "Docker via SSH" does not regress.
2. Add more detailed E2E coverage for the remote dialog (WSL/Docker tab switching, container selection).
3. Add backend capabilities as needed (for example all Docker containers or default WSL distro metadata).
