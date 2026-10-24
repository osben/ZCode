# Web Remote Control Relay Message Logging (Disabled)

## Purpose

Records the historical design of the remote-control relay message chain trace and its current disabled
policy, so high-frequency message summaries are not written to `~/.zcode/v2/logs/web-remote-control` again.

## Where it applies

The desktop currently enables no relay message trace in either development or production, and no longer
writes `~/.zcode/v2/logs/web-remote-control/web-remote-control-relay-YYYY-MM-DD.log`.

Ordinary Web remote-control lifecycle logs are unaffected and still go to the main log `~/.zcode/v2/logs/YYYY-MM-DD.log`.

## Coverage

- Desktop: `packages/desktop/src/main/web-remote-relay/webRemoteControlTransport.ts`

## Log content

A historical trace may output only message summaries, never the full payload. To re-enable it in the
future, this file must be updated first and the log volume and sensitive-information risk re-evaluated.

Historical summary fields:

- `type`
- `pair_status` (if any)
- `role` (if any)
- `code` (if any)
- `payload` summary: `zcode_type` / `requestId` / `bridgeSessionId`
- desktop `recv` additionally carries `bytes`

## Not logged

No relay message trace is recorded now. Even if re-enabled in the future, outputting the full `data.payload`
body must remain forbidden, to avoid:

- log volume growing linearly with the message flow
- sensitive-information leaks (text content, paths, request parameters)
- production I/O pressure and performance jitter

## Typical log prefix

- Disabled on desktop: `[web-remote-control][relay-message]`
