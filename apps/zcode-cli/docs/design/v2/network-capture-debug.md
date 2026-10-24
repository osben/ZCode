# Debug Network Capture

`debug` provides local development-time network capture that ties the provider, MCP, plugin and other
external HTTP(S) requests of the Jcode/ZCode CLI to a `traceId`. It belongs to the debug app only and is
not part of the default production CLI execution path.

## Goals

- The debug server starts, by default, an HTTP(S) MITM proxy bound to the loopback address.
- The mature library `http-mitm-proxy` provides the HTTP proxy, HTTPS CONNECT, per-domain certificate
  generation and WebSocket proxy basics.
- A local certificate container directory in the repository holds the locally generated CA certificate
  and private key; generated files are not committed.
- The UI shows recent network requests live: method, URL, status code, duration, request/response
  bytes, error and attributable trace.
- A dedicated network requests page lists the requests and converts attributable requests into
  `network` lane spans of the Gantt chart.
- The API and UI expose the explicit environment variables for launching Jcode/ZCode,
  `ZCODE_HTTP_PROXY` and `ZCODE_AGENT_CA_CERT`, with a one-click copyable shell snippet in the UI.

## Non-goals

- No system-wide proxy installation and no change to the operating system trust chain.
- No long-term storage of full request bodies, response bodies or sensitive headers.
- No guarantee of capturing traffic that ignores proxy environment variables, uses certificate pinning,
  native sockets, HTTP/3/QUIC, or bypasses Node/adapters.
- Business modules do not read debug proxy state directly; if the runtime must propagate a trace, it
  injects the header through the HTTP adapter contract.

## Certificate container

Default container directory:

```text
packages/debug/certs/network-ca/
```

`http-mitm-proxy` maintains in this directory:

- `certs/ca.pem`: the local CA certificate, to be imported into the local trust chain or exposed to the
  ZCode runtime explicitly via `ZCODE_AGENT_CA_CERT`.
- `keys/ca.private.key`: the local CA private key, used only to generate site certificates on this
  development machine; it must be excluded by `.gitignore`.
- `keys/ca.public.key`: the local CA public key; not committed either.

To replace the certificate, delete `packages/debug/certs/network-ca/` and restart the debug server. The
directory is local state of the debug app and is not part of release artifacts.

## Startup and configuration

The debug server enables the network proxy by default and listens on:

```text
127.0.0.1:4184
```

Supported debug app environment variables, all affecting the debug server only:

- `ZCODE_DEBUG_NETWORK_CAPTURE=0|false|off`: disables the default network proxy.
- `ZCODE_DEBUG_NETWORK_HOST`: proxy listen host, default `127.0.0.1`. Do not bind a public address
  unless a remote machine must connect.
- `ZCODE_DEBUG_NETWORK_PORT`: proxy listen port, default `4184`.
- `ZCODE_DEBUG_NETWORK_CA_DIR`: certificate container directory, default
  `packages/debug/certs/network-ca/`.
- `ZCODE_DEBUG_NETWORK_MAX_ENTRIES`: number of recent requests kept in memory, default `300`.

Launch Jcode/ZCode with the explicit environment variables returned by the API, for example:

```sh
ZCODE_HTTP_PROXY=http://127.0.0.1:4184 \
ZCODE_AGENT_CA_CERT=/absolute/path/to/packages/debug/certs/network-ca/certs/ca.pem \
pnpm --filter @zcode/cli dev
```

The ZCode runtime filters the standard proxy/certificate variables of the user shell. The debug app
provides only `ZCODE_HTTP_PROXY` and `ZCODE_AGENT_CA_CERT` as the explicit entry for model/provider
capture. Standard user variables such as `http_proxy` are set aside and restored only for Bash/tool/MCP
stdio child processes. To capture model traffic during development use these `ZCODE_*` variables; to
route only user commands, curl or git through the local proxy, keep using the standard proxy variables.

The network requests page must render these variables as copyable launch snippets and support at least:

- POSIX shell: `export NAME='value'`
- PowerShell: `$env:NAME = 'value'`
- Windows cmd: `set "NAME=value"`

Copying writes only to the browser clipboard. It never changes the user shell, system environment
variables or the debug server process environment.

## Trace attribution

The proxy extracts attribution from request headers and query:

- `x-zcode-trace-id`, `x-trace-id`, `traceparent`
- query `traceId`, `trace_id`

The HTTP adapter writes the `traceId` of the current `ExecutionContext` to the `x-zcode-trace-id`
header. Finer diagnostic fields (`sessionId`, `turnId`, `spanId`, `parentSpanId`, `modelRequestId`)
stay in runtime events and logs and are not sent as outbound network headers. The proxy only reads
attribution; it does not create new runtime traces and does not pass unattributed requests off as
attributed.

## API contract

### `GET /api/network/status`

Returns proxy status, port, certificate paths, copyable environment variables, recent-request capacity
and the latest error.

### `GET /api/network/requests`

Query:

- `traceId?: string`
- `limit?: number`

Returns recent requests in reverse chronological order. With `traceId`, only matching requests are
returned.

### `GET /api/network/events`

Server-Sent Events. On connect it first sends `status` and `snapshot`, then live:

- `status`: proxy started, stopped or failed.
- `request`: a network request added or updated.
- `reset`: the request buffer was cleared.

## Gantt integration

The frontend can convert a `NetworkRequestRecord` to a `TraceSpan`:

- `id = "network:" + request.id`
- `lane = "network"`
- `source = "network"`
- `startAt = request.startedAt`
- `endAt = request.completedAt`
- `status = pending -> running, complete -> ok, error -> error`
- `traceId` follows the proxy attribution field; `sessionId`, `turnId`, `spanId`, if displayed, are
  merged from the runtime event/log side

Unattributed requests may appear only on the dedicated network requests page. When a user views a trace
in the Gantt chart, only network requests with a matching `traceId` are merged, so traffic from other
processes is not wrongly attached to the trace.

## Data safety

By default only a redacted copy of headers and byte counts are stored, never the body. These header
values must display as `[redacted]`:

- `authorization`
- `proxy-authorization`
- `cookie`
- `set-cookie`
- `x-api-key`
- `api-key`
- `openai-api-key`

## Test coverage

- The API returns a stable disabled status when the proxy is not enabled.
- The proxy store keeps recent requests within capacity and filters by `traceId`.
- Header/query trace attribution recognizes `x-zcode-*` and query parameters.
- The HTTP proxy smoke test uses a temporary local upstream and a temporary certificate directory and
  depends on neither the real internet nor user certificates.
