# Rust MCP OAuth (zcode-rs) — parity with Node

Status: draft, PR1 scope only. Node is the reference; Rust must read and write the same shared state.

## Background

Node (`apps/zcode-cli/packages/adapters/src/mcp/oauth*.ts`) runs the MCP SDK `auth()` flow with a
`ZCodeMcpAuthorizationCodeProvider`. zcode-rs has no MCP OAuth: `crates/ext/src/mcp/node_config.rs`
warns `oauth is not supported; connecting without it`, a remote server answering HTTP 401 ends
`failed`, and `mcp/list` never reports an `authorization` object.

## Owners

| Concern                                       | Owner                                            | Notes                                                                                                                             |
| --------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Credential values (`mcp:oauth:<hash>:*` keys) | `crates/platform` `CredentialStore`              | Existing `credentials.json` reader and `enc:v2` sealing. OAuth must not add a second cipher or file.                              |
| Pending-authorization lease and record        | `crates/ext/src/mcp/oauth/lease.rs`              | Node `oauth-lease.ts`. Path and key format must match Node byte-for-byte.                                                         |
| Discovery record (24 h TTL)                   | `crates/ext/src/mcp/oauth/discovery.rs`          | Node `oauth-shared.ts`.                                                                                                           |
| Pending-authorization lookup for rows         | `crates/ext/src/mcp/oauth/` (single `lookup` fn) | Keyed by `workspaceIdentity?.trim() \|\| workspacePath` plus server name. `app_workspace.rs` `live()` calls it as a small hook.   |
| `mcp/list` `authorization` field              | `crates/cli/src/frontends/app_workspace.rs`      | Protocol type `zcodeMcpServerStatusSnapshotSchema.authorization` already exists in `packages/shared/src/zcode-protocol/index.ts`. |
| Flow (discovery, DCR, PKCE, callback)         | `crates/ext/src/mcp/oauth/flow.rs` (PR2)         | Callback is a loopback listener, as in Node `localhost-callback.ts`.                                                              |
| Refresh under lock, 401 re-auth (PR3)         | `crates/ext/src/mcp/oauth/refresh.rs`            | Refresh lock 45 s wait, 30 s expiry skew.                                                                                         |

`McpServerState` gets no new variant. A pending authorization is reported as
`status: "connecting"` plus `authorization`, the same shape Node emits.

## Shared state (must match Node)

- Credentials: key prefix `mcp:oauth:<sha256(serverName\nserverUrl\nclientId\nscope\nredirectPath)[0..24]>`,
  canonical key `authorization_credentials` (v1 and v2 accepted; writes v2), legacy
  `client_information` and `tokens` read-only fallback, `discovery_state` with
  `discovery_state_fetched_at`, `pending_authorization`.
- Values live in `~/.zcode/v2/credentials.json` through the existing `enc:v2` sealing.
- Lease and refresh lock paths: see `resolveAuthorizationLeasePath` and `resolveRefreshLockPath`
  in Node. Lease wait 250 ms, owner-less grace 100 ms. Refresh lock wait 45 s.

## Event order (connect mode)

```mermaid
sequenceDiagram
  participant UI as Settings UI
  participant Host as mcp/list (connect)
  participant Mgr as MCP manager
  participant Auth as OAuth module
  participant Srv as MCP server
  UI->>Host: mcp/list mode=connect
  Host->>Mgr: connect server
  Mgr->>Srv: initialize
  Srv-->>Mgr: HTTP 401
  Mgr->>Auth: classify (interactive required)
  Auth->>Auth: acquire lease, publish pending_authorization
  Auth-->>Host: lookup -> authorizationUrl
  Host-->>UI: status connecting + authorization (poll up to 5 s, 100 ms)
  Note over Auth: callback listener on loopback; token exchange; publish canonical credentials; release lease
```

Status mode (`mode=status`) only reads: it never acquires the lease and never cancels another
workspace's flow.

## Acceptance scenarios (PR1)

1. A Node-written `credentials.json` entry (v2 canonical, and legacy keys) is read by Rust and
   round-trips unchanged.
2. A 401 remote server yields a row `status: "connecting"` with
   `authorization.type == "oauth_authorization_code"` when a pending record exists, and `failed`
   otherwise. No `failed` row for a pending authorization.
3. Plugin rows (from PR #501 `plugin_row_config`) get the same mapping. Do not duplicate #501's row merge.
4. `mode=status` never takes the lease.
5. Config with `oauth.type == "authorization_code"` no longer logs the "not supported" warning;
   `node_config_tests.rs` L19 expectation is updated accordingly.

## As built in PR1

- Read side: `crates/ext/src/mcp/oauth/` (keys, lease path, pending, discovery, canonical records),
  behind `McpOAuthStore`. `platform` implements it over `credentials.json` through the existing
  `CredentialStore` (the `enc:v2` cipher), verified against a Node-sealed fixture (env secret).
- 401: `is_authorization_challenge` (connect error `HTTP 401 ...`). The row gets `failureKind:
"not_authenticated"` and stays `failed` until PR2 starts the flow (Node then reports `connecting`).
  403 is not classified: its `WWW-Authenticate` header is not carried in the transport error.
- Row hook: `AppWorkspace::with_pending_authorization` (status loop). A live pending record turns a
  `connecting`, `failed` or `disconnected` row into `connecting` with `authorization`. The identity
  comes from the row config (`url` and an `authorization_code` `oauth` block). Plugin rows (#501) carry
  neither yet, so they pick the hook up only once #501's row config includes `url` and `oauth`.
- Not in PR1: the lease itself, writes, discovery, DCR, PKCE, callback server (PR2); refresh and
  re-auth (PR3). `client_credentials` is handled in PR2 together with the provider.

## PR2: interactive authorization flow (as specified)

Scope: discovery, dynamic client registration (DCR), PKCE, the loopback callback, the
`authorization_code` token exchange, `client_credentials`, the authorization lease, and the writes
of `pending_authorization`, `discovery_state` and canonical credentials. A connect that gets HTTP 401
starts the flow, as Node does. Not in PR2: refresh, 401 re-auth after connect, invalidation (PR3).

### Owners (PR2 additions)

| Concern                                                              | Owner                                                                                    | Notes                                                                                                       |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Credential write API (`put`, `delete_if_value`, `publish_canonical`) | `McpOAuthStore` trait in `ext`, implemented by `platform` over `CredentialStore::mutate` | `ext` never depends on `platform`. The trait gets write methods; PR1 only read.                             |
| Lease acquire/release, attempt id                                    | `ext/src/mcp/oauth/lease.rs`                                                             | `fs::acquire_file_lock` (`LockOptions{retry [25], grace 100, max_wait 250}`), Node `oauth-lease.ts`.        |
| Pending record write and attempt-CAS delete                          | `ext/src/mcp/oauth/lease.rs`                                                             | Byte-compatible JSON, field order `attempt_id, authorization_url, baseline_generation?, expires_at, state`. |
| Discovery read/write (24 h)                                          | `ext/src/mcp/oauth/discovery.rs`                                                         | Node `oauth-shared.ts`. Bare `discovery_state` plus `discovery_state_fetched_at`.                           |
| Protocol: metadata, DCR, PKCE, token request                         | `ext/src/mcp/oauth/protocol.rs`                                                          | Pure HTTP helpers on an injected client; order copied from the MCP SDK `auth()` (see below).                |
| Loopback callback listener                                           | `ext/src/mcp/oauth/callback.rs`                                                          | 127.0.0.1, port 0, path from `redirectPath`, `state` check. Node `localhost-callback.ts`.                   |
| Flow orchestration (lead/follower, TTL 5 min)                        | `ext/src/mcp/oauth/flow.rs`                                                              | Node `oauth-interactive.ts`. One owner per flow task; cancel token; no lock held after the callback.        |
| 401 hook into the connect path                                       | `ext/src/mcp/manager.rs` (small hook only)                                               | Calls `flow::start_for_challenge`. Keeps #501's manager edits minimal.                                      |
| Bearer injection on connect                                          | `ext/src/mcp/connection.rs` (small hook)                                                 | Adds `Authorization: Bearer` from canonical credentials; stored credentials only, never logged.             |

### Event order (PR2, connect mode)

```mermaid
sequenceDiagram
  participant UI as Settings UI
  participant Host as mcp/list (mode=connect)
  participant Mgr as MCP manager
  participant Flow as oauth::flow (lead)
  participant Lease as lease (.authz lock)
  participant Cb as loopback 127.0.0.1:0
  participant Srv as MCP server / AS
  UI->>Host: mcp/list mode=connect
  Host->>Mgr: connect
  Mgr->>Srv: initialize
  Srv-->>Mgr: HTTP 401
  Mgr->>Flow: start_for_challenge(identity)
  Flow->>Lease: try acquire (25 ms retry, 250 ms max)
  alt lease busy
    Flow-->>Mgr: follower: return (pending record shown)
  else lease acquired
    Flow->>Srv: discovery (PRM -> AS metadata), DCR (fresh per flow)
    Flow->>Cb: listen 127.0.0.1:0, redirect_uri=http://127.0.0.1:<port><path>
    Flow->>Lease: publish pending_authorization {attempt_id, url, state, expires_at=now+5 min}
    Host-->>UI: poll 5 s every 100 ms: status connecting + authorization
    UI->>Cb: user opens authorizationUrl, AS redirects with code+state
    Cb-->>Flow: code (state verified)
    Flow->>Srv: token request (code + PKCE verifier)
    Flow->>Flow: publish canonical credentials (generation advances)
    Flow->>Lease: delete pending if attempt matches; release lock
    Flow-->>Mgr: authorized: reconnect with Bearer
  end
```

`mode=status` only reads: it never acquires the lease and never publishes or cancels a flow.

### SDK order that PR2 ports (from `@modelcontextprotocol/client` `auth()`, `authInternal`)

1. Cached discovery state is used when present (`discovery_state`, 24 h TTL). Otherwise:
2. Protected resource metadata (RFC 9728): the `resource_metadata` URL if one is given, else
   `/.well-known/oauth-protected-resource<path>` on the server origin, then
   `/.well-known/oauth-protected-resource` at the root. Any non-404 failure or 404 falls through.
   The `WWW-Authenticate` `resource_metadata` value is NOT parsed in PR2 (see follow-ups).
3. Authorization server: `authorization_servers[0]` if the PRM lists one, else the server origin (`/`).
4. AS metadata (RFC 8414), `buildDiscoveryUrls` order: with no path,
   `/.well-known/oauth-authorization-server` then `/.well-known/openid-configuration`; with a path,
   `/.well-known/oauth-authorization-server<path>`, `/.well-known/openid-configuration<path>`,
   `<path>/.well-known/openid-configuration`. 4xx (except 502) skips to the next URL; 5xx throws.
   The parsed `issuer` must equal the AS URL (trailing `/` ignored) unless skipped.
5. Client information: a saved DCR client is used if its issuer matches. Otherwise DCR (RFC 7591)
   POST to `registration_endpoint`, with `redirect_uris=[current callback URL]`,
   `grant_types=["authorization_code","refresh_token"]`, `response_types=["code"]`,
   `token_endpoint_auth_method` from the Node provider, `client_name`, and `scope` when set.
6. Authorization URL: `response_type=code`, `client_id`, `code_challenge` (S256 of a 43+ char
   verifier), `code_challenge_method=S256`, `redirect_uri`, `state`, `scope` when set,
   `prompt=consent` when scope has `offline_access`, `resource` when known.
   The server must list `code` in `response_types_supported` and `S256` in
   `code_challenge_methods_supported` when that field is present, else the flow fails.
7. Token request (`authorization_code`): `grant_type`, `code`, `code_verifier`, `redirect_uri`,
   `resource` when known; client auth from `token_endpoint_auth_methods_supported` (basic when the
   list is empty or includes `client_secret_basic`, else post); form-encoded; JSON response.
8. On `invalid_client` / `unauthorized_client` / `invalid_grant` the SDK retries once; PR2 does not
   retry (PR3 owns invalidation).

### Canonical credential write (Node `publishCanonicalCredentials`)

`authorization_credentials` = `{client_information, tokens, generation, obtained_at, expires_at?,
issuer?, published_by, version: 2}`. The legacy mirror keys `client_information` and `tokens` are
written in the same `mutate` call. `generation` is a fresh id per publish.

### Acceptance criteria

1. Lease file is `<credentials dir>/<sanitized prefix>.authz`; a Node-held lease blocks Rust and the
   reverse. Tested against a Node-generated fixture.
2. Pending record written by Rust parses in Node's `loadPendingAuthorization` (fixture round-trip)
   and vice versa. Byte-compared against Node output for a fixed input.
3. Discovery record written by Rust is read by Node `loadDiscoveryRecord` (fixture).
4. Discovery URL order (#8) and PRM fallback (#2) are unit-tested against a fake server.
5. PKCE S256: `code_challenge == base64url(sha256(verifier))`, verifier 43-128 chars.
6. DCR request body contains the callback URL with the port of the current listener.
7. Callback: a request with a wrong `state` is rejected and the flow keeps waiting; the right
   `state` completes it; the listener closes after completion or after the 5 min TTL.
8. Pending record is removed only if its `attempt_id` matches (CAS).
9. `mode=status` never acquires the lease (test via a lease fake that panics if called).
10. Logs and errors never contain the access token, refresh token, code, verifier or client secret.
11. E2E: `conversation-session-mcp-oauth-status-isolation` passes on Rust with the same assertions as Node.

### Status of this branch (PR2, partial)

Built and tested (ext unit tests 38/38 with the Node fixture; platform `mcp_oauth` 2/2; clippy clean on
`rust-cli-net`, `rust-cli-platform`, `rust-cli-ext`):

- Store writes: `McpOAuthStore::apply` (atomic batch: `Put`, `DeleteIfValue`) and `try_acquire_lease`, implemented
  in platform over `CredentialStore::mutate` and `rust_cli_fs::acquire_file_lock`.
- Entropy, clock, egress and loopback are injected through `McpOAuthRuntime` (ext cannot use them directly,
  `clippy.toml`). Platform implements it over `ring`, `rust-cli-net::Egress` and the new `rust-cli-net::loopback`.
- Pending record bytes match Node (`pending_record_json`); attempt-CAS delete; discovery order and fallbacks per
  the SDK list above; PKCE S256; DCR body; callback state check; lead/follower flow with the 5 min TTL, canonical
  v2 write with legacy mirror keys, and lease release in every outcome.

Not done in this branch (PR2 is not complete):

- The 401 trigger in `crates/ext/src/mcp/manager.rs` (connect error path) and the coordinator that owns the
  flow task, its cancel token, and the reconnect after success. This needs `oauth` config from the row, which is
  not parsed by `node_config.rs` yet.
- Bearer injection on connect (`Authorization` header from canonical credentials). Without it, a connect after
  authorization still gets 401.
- The Node-side `localhost-callback` test against the real listener, and the E2E
  `conversation-session-mcp-oauth-status-isolation` run (depends on #501's plugin rows).
- `resource_metadata` from `WWW-Authenticate` is not carried; the transport error drops the header.

Decision recorded: lease acquisition lives in the platform store (the lock directory sits next to
`credentials.json`), not in ext, so ext keeps no fs or network categories.

### Follow-ups (not PR2)

- PR3 brief: refresh under lock, 401 re-auth after connect, invalidation on `invalid_grant`.
- `WWW-Authenticate` `resource_metadata` and challenge `scope` are not carried by the transport error.
- #501 plugin rows do not carry `url` or `oauth`; the row hook needs them (see PR1 note).
