# ZCode Endpoint DeviceMid Header

## Background

When the App layer accesses a ZCode endpoint (default `https://zcode.z.ai`, or the endpoint derived
from the current `ZCODE_BASE_URL` / `ZCODE_PRODUCTION_BASE_URL`), it must uniformly carry a device
identity header so the backend can align OAuth, client configs, billing, snapshot and similar requests
with the existing telemetry/ARMS device dimension.

## Design

- The device id reuses `deviceMid` from the existing telemetry state, i.e. the `deviceMid` field of `{appConfigDir}/telemetry-state.json`.
- `buildZCodeSourceHeadersFromContext()` is the pure cross-App/Agent source-header assembly rule; the app service layer's `buildZCodeSourceHeaders()` keeps reading the existing `deviceMid` and then calls that shared rule.
- Only an existing `deviceMid` that is valid as an HTTP header is read; on read failure or a missing field this function generates no new device id, so the device id lifecycle is not changed.
- In the generic rule `X-Device-Mid` is "carried only when present", but the server treats `/api/v1/zcode-plan/billing/balance` as requiring it (missing returns `400 code 3001 parameter error`). Any runtime that issues a Start Plan entitlement query must therefore ensure `deviceMid` is persisted before the first request, not rely on the optional header succeeding when absent.
- Generating the device id belongs to each runtime's lifecycle owner: Desktop main ensures it synchronously before window creation; remote `zcode-server` (SSH/WSL/Docker stdio entry) calls `ensureTelemetryDeviceMid()` asynchronously after the handshake and before services are created; standalone CLI ensures it itself at the first model request. All three read and write the same `deviceMid` field of `telemetry-state.json`, mutually excluded by the same-named `telemetry-state.lock`.
- `NodeApiClient` still only injects the headers returned by `buildZCodeSourceHeaders()` when a request hits the current ZCode endpoint, and preserves same-named headers the caller passes explicitly.
- ZCode CLI's provider endpoint routing config GET reads the same telemetry state asynchronously through an independent bootstrap source-header provider and then calls the shared assembly rule; this read does not enter the model transport or ordinary tool HTTP egress.

## Coverage

Covers ZCode endpoint requests through `NodeApiClient` in app services, including OAuth token, client
configs, release latest, Start Plan billing and feedback, plus the provider endpoint routing config GET
that ZCode CLI issues itself. Other requests that bypass `NodeApiClient` still need handling at their
own egress.

## Remote server device identity

A remote workspace (SSH/WSL/Docker) has only `zcode-server` and the Agent process, no Desktop main.
Since 3.12.0 account entitlements such as Start Plan are queried by the remote itself, and the server
treats `X-Device-Mid` as required for `billing/balance`; if no process on the remote host ever wrote
`telemetry-state.json`, the request lacks the header and is rejected as `parameter error`, so Start
Plan is judged not enabled in the remote workspace.

```text
Desktop                                  Remote host
main --ensureDesktopDeviceMidSync--+     entry-stdio --ensureTelemetryDeviceMid--+
                                   |-> ~/.zcode/v2/telemetry-state.json.deviceMid <-|
host --buildZCodeSourceHeaders read-+    services --buildZCodeSourceHeaders read---|
                                         zcode-cli --ensureCliDeviceMid-----------+
```

- The remote server calls `ensureRemoteServerDeviceMid()` in `packages/server/src/entry-stdio.ts` after the handshake and before services are created; internally it reuses `ensureTelemetryDeviceMid()` from `@zcode/services/node`, with the same file, field and lock as telemetry reporting and the CLI, so server and Agent on the same host get the same `deviceMid`.
- The remote owns its device identity; it neither borrows nor receives the desktop `deviceMid`, and the identity stays stable when several desktops connect to the same remote.
- An ensure failure (filesystem or lock error) only logs warn and startup continues; the request then omits `X-Device-Mid` as before the fix and never fabricates a device id.
