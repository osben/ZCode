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

| Concern                                                  | Owner                                                                     | Notes                                                                                                       |
| -------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Credential writes (`McpOAuthStore::apply`, atomic batch) | `platform` `mcp_oauth.rs` over `CredentialStore::mutate` (trait in `ext`) | `ext` never depends on `platform`; the trait carries the write methods.                                     |
| Authorization lease (`try_acquire_lease`)                | `platform` `mcp_oauth.rs` (`rust_cli_fs::acquire_file_lock`)              | Lock sits next to `credentials.json` (`lease_path`). `ext` never takes the lock. Node `oauth-lease.ts`.     |
| Pending record write and attempt-CAS delete              | `ext/src/mcp/oauth/lease.rs`                                              | Byte-compatible JSON, field order `attempt_id, authorization_url, baseline_generation?, expires_at, state`. |
| Discovery read/write (24 h)                              | `ext/src/mcp/oauth/discovery.rs`                                          | Node `oauth-shared.ts`. Bare `discovery_state` plus `discovery_state_fetched_at`.                           |
| Protocol: metadata, DCR, PKCE, token request             | `ext/src/mcp/oauth/protocol.rs`                                           | Pure HTTP helpers on an injected client; order copied from the MCP SDK `auth()` (see below).                |
| Loopback callback listener                               | `ext/src/mcp/oauth/callback.rs`                                           | 127.0.0.1, port 0, path from `redirectPath`, `state` check. Node `localhost-callback.ts`.                   |
| Flow orchestration (lead/follower, TTL 5 min)            | `ext/src/mcp/oauth/flow.rs`                                               | Node `oauth-interactive.ts`. One owner per flow task; cancel token; no lock held after the callback.        |
| 401 hook into the connect path                           | `ext/src/mcp/manager.rs` (small hook only)                                | Calls `flow::start_for_challenge`. Keeps #501's manager edits minimal.                                      |
| Bearer injection on connect                              | `ext/src/mcp/connection.rs` (small hook)                                  | Adds `Authorization: Bearer` from canonical credentials; stored credentials only, never logged.             |

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

### Status of this branch (PR2)

Built and tested (ext `mcp` unit tests 124 passed before the CLI wiring, `rust-cli-ext --lib` 220 passed after; net `--lib` 46 passed; platform `mcp_oauth` passes; workspace clippy `-D warnings` clean):

- Store writes: `McpOAuthStore::apply` (atomic batch: `Put`, `DeleteIfValue`) and `try_acquire_lease`, implemented in platform (`mcp_oauth.rs`).
- Runtime seam `McpOAuthRuntime` (entropy, clock, egress, loopback). Platform implements it; the loopback listener is `rust-cli-net::loopback`, with four listener tests.
- Flow (`flow.rs`): lead/follower, 5 min TTL, cancel token, SDK discovery order, DCR per flow, PKCE S256, pending record, canonical v2 write with legacy mirror keys, lease and attempt-owned pending delete on every outcome.
- Coordinator (`coordinator.rs`): one flow task per server; cancel; reconnect through the manager after success; canonical bearer lookup (expiry skew 30 s); in-memory `client_credentials` token with `client_secret_basic`.
- Connection hooks (`oauth_hooks.rs`, small call sites in `manager.rs`): bearer added as `Authorization` before each connect attempt (unless the server sets its own); HTTP 401 starts the flow; user-scope remote servers without an `oauth` block act as `authorization_code`, as Node does.
- Row config (`node_config.rs`): strict `oauth` block for Node-config servers (`authorization_code`, `client_credentials`); the old "not supported" warning is removed.
- CLI wiring: `AppWorkspace::with_mcp_oauth(store, runtime)` calls `enable_oauth` on each lane manager.

Tests (PR2 close-out):

- Manager level (`mcp/oauth_hooks_tests.rs`, `FakeMcp` transport): a 401 starts one flow; the bearer is added when the server sets none and kept when it sets its own; a successful flow reconnects the server with the bearer; a status snapshot starts no flow and takes no lease (checks the manager snapshot only; the row status path in `app_workspace` is covered by `lease_tests::status_lookup_never_takes_the_lease`).
- Integration over real HTTP (`crates/cli/tests/mcp_oauth_http.rs`): a mock MCP and OAuth server on 127.0.0.1 (discovery, DCR, token, an MCP endpoint that answers 401 without a bearer). The real streamable-HTTP transport, the platform store and runtime, and `enable_oauth` are used. The test checks the first 401 with a pending authorization and its URL, plays the browser with a GET on the loopback callback, checks the stored token, the reconnect, and the listed tool, and covers the `client_credentials` server.
- Found and fixed by that test: the lease failed on a fresh home because the lock directory beside `credentials.json` did not exist. `try_acquire_lease` now creates the private parent directory first.

Substitution, stated plainly: the integration test stands in for the desktop E2E of user servers, which this box cannot run. It is not the desktop E2E. The lane wiring is covered by `app_workspace_tests::a_401_starts_the_flow_and_the_row_shows_connecting_with_the_authorization`: it builds the workspace with `with_mcp_oauth`, lets the lane manager connect, and checks that the row turns `connecting` with the authorization. The production call site in `app_server.rs` is guarded by `the_production_app_server_wires_mcp_oauth_into_the_workspace` (a source check on the whitespace-stripped file). The integration test calls `enable_oauth` directly, because `AppWorkspace` is `pub(crate)`.

Not closed in this PR:

- Plugin rows (#501) do not carry `oauth` or `url`; they get no bearer and no flow.
- `resource_metadata` from `WWW-Authenticate` is not carried; the transport error drops the header.
- Client-credentials tokens are not refreshed; they are re-requested 30 s before expiry.
- The desktop E2E for user servers is not run (see above).

Decision recorded: lease acquisition lives in the platform store (the lock directory sits next to `credentials.json`), not in ext, so ext keeps no fs or network categories.

### Follow-ups (not PR2)

- PR3 brief: refresh under lock, 401 re-auth after connect, invalidation on `invalid_grant`.
- `WWW-Authenticate` `resource_metadata` and challenge `scope` are not carried by the transport error.
- #501 plugin rows do not carry `url` or `oauth`; the row hook needs them (see PR1 note).

## PR3: refresh under lock, 401 retry, invalidation (as specified)

Scope: proactive refresh before a connect when the canonical token is within the 30 s skew, one
reactive refresh and retry after a connect 401, re-authorization when the refresh is rejected, and
credential invalidation with compare-and-swap. Not in PR3: 403 `WWW-Authenticate` carriage (see
"Deferred" below), `resource` (RFC 8707) on refresh, and saving discovery from the refresh path.

### Owners (PR3 additions)

| Concern                                              | Owner                                                    | Notes                                                                                                                              |
| ---------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Refresh lock (`<prefix>.refresh`, 45 s wait)         | `platform` `mcp_oauth.rs` `try_acquire_refresh_lock`     | Separate from the `.authz` lease: the refresh lock is held while `apply` writes `credentials.json`. Node `resolveRefreshLockPath`. |
| Refresh decision, coalescing, failure classification | `ext/src/mcp/oauth/refresh.rs`                           | Node `oauth-refresh.ts` `refreshLocked` and `handleRefreshFailure`.                                                                |
| Guarded invalidation (`DeleteGuarded`)               | `ext/src/mcp/oauth/store.rs` (trait), `platform` (apply) | Node `invalidateCanonicalCredentials`: delete the key set only if the canonical value still equals the observed raw.               |
| Proactive refresh in `bearer_for`                    | `ext/src/mcp/oauth/coordinator.rs`                       | Near-expiry with a refresh token calls `refresh::refresh_under_lock` (reactive = false).                                           |
| Reactive refresh after a connect 401                 | `ext/src/mcp/oauth_hooks.rs` (connect path, small hook)  | One retry of the connect with the new bearer; a rejected refresh falls through to the flow (`start_oauth_on_challenge`).           |

### Event order (PR3, refresh under lock)

```mermaid
sequenceDiagram
  participant Conn as connect (manager)
  participant Ref as oauth::refresh
  participant Lock as refresh lock (<prefix>.refresh)
  participant Store as McpOAuthStore (credentials.json)
  participant AS as token endpoint
  Conn->>Ref: refresh_under_lock(observed = canonical generation)
  Ref->>Lock: acquire (wait up to 45 s)
  alt lock timed out
    Ref->>Store: re-read canonical
    Ref-->>Conn: reuse token if generation changed, else temporary failure
  else acquired
    Ref->>Store: re-read canonical (under lock)
    alt generation changed and token present
      Ref-->>Conn: reuse winner's token (no second POST)
    else no refresh token
      Ref-->>Conn: interactive required (no_refresh_token)
    else
      Ref->>AS: POST grant_type=refresh_token (discovery fetched; see deviations)
      alt 2xx
        Ref->>Store: apply v2 canonical + legacy mirror (refresh token kept if omitted)
        Ref-->>Conn: new access token
      else 400 invalid_grant
        Ref->>Store: DeleteGuarded(canonical, legacy tokens) if canonical unchanged
        Ref-->>Conn: interactive required (invalid_grant)
      else 400 invalid_client / unauthorized_client
        Ref->>Store: DeleteGuarded(canonical, legacy tokens, legacy client) if unchanged
        Ref-->>Conn: interactive required (invalid_client), or config error when clientId is static
      else network, 5xx, timeout, other 4xx
        Note over Ref: credentials untouched
        Ref-->>Conn: reactive: temporary failure; proactive: current token
      end
    end
    Ref->>Lock: release
  end
```

### Connect-time 401 rule (decision)

1. A connect that fails with HTTP 401 and has a refresh token runs `refresh_under_lock(reactive=true)`.
2. Success: the connect is retried once with the new bearer. A second 401 starts the flow.
3. `invalid_grant` or `invalid_client` (or no refresh token): credentials were invalidated by the refresh,
   so the flow starts (`start_oauth_on_challenge`) and the row reports `connecting`.
4. A temporary failure: the credentials are kept and the row reports the error (`failed`); no flow starts,
   because the grant is not known to be invalid.
5. A connected server whose token expired mid-session takes the same path on its next connect (reconnect);
   a live session gets the 401 on the next request, which is the Node `recoverToolCallAuthorization` path
   and is deferred (see below).

### SDK and Node retry order (reference)

1. `token()` (Node `oauth-provider.ts`): load the pair; no token gives no bearer; not near expiry gives
   the token; near expiry without refresh token gives the current token; otherwise refresh (reactive=false).
2. A 401 calls `onUnauthorized()`: no refresh token gives interactive required (`no_refresh_token` or
   `no_credentials`); otherwise refresh (reactive=true). The SDK retries the request once.
3. The refresh itself (`refreshLocked`): re-read under the lock; coalesce on generation change; discovery
   (cached or fresh, failure is fail-soft); `refreshAuthorization`; publish canonical; classify errors.

### Records (byte-compatible with Node)

- Canonical v2 written by refresh: `{client_information, tokens, generation, obtained_at, expires_at?,
issuer?, published_by: "refresh:<prefix>", version: 2}` plus the legacy `client_information` and `tokens`
  mirror keys, in one `apply`. The refresh token is kept from the previous tokens when the response omits it.
- Node-generated fixture: `testdata/node_pr3_fixture.json` (generator `gen-pr3-fixture.mts` next to the
  PR2 generator) holds the refresh-lock path and a post-refresh canonical record written by Node's
  `publishCanonicalCredentials`.

### Acceptance criteria

1. Refresh lock path is `<credentials dir>/<sanitized prefix>.refresh`; matches the Node fixture.
2. Near-expiry canonical token with a refresh token is refreshed before the connect; the connect uses the new bearer.
3. Two concurrent refreshes produce exactly one token POST; the second returns the winner's token.
4. The refresh response without `refresh_token` keeps the old refresh token in the published record.
5. `invalid_grant` deletes canonical and legacy tokens (CAS) and returns interactive required (`invalid_grant`).
6. `invalid_client` deletes canonical, legacy tokens and legacy client (CAS); with a static client id it returns
   a configuration error and deletes nothing.
7. A 5xx, network error or timeout on refresh keeps the credentials; reactive returns temporary failure,
   proactive returns the current token.
8. `DeleteGuarded` removes nothing when the canonical value changed after it was observed (a newer write survives).
9. A connect 401 with a refresh token refreshes and retries once (real HTTP integration test, mock AS and MCP).
10. `invalid_grant` on that path leads to re-authorization (the pending authorization is published).
11. Logs and errors never contain tokens, refresh tokens, codes or client secrets.

### As built in PR3 (deviations and status)

Built and tested: refresh lock (`platform` `try_acquire_refresh_lock`, 45 s, `<prefix>.refresh`), `refresh.rs`
(coalescing, classification, guarded invalidation), `DeleteGuarded` in `McpOAuthStore::apply`,
`fresh_bearer` (proactive refresh in the bearer path), the connect-time 401 rule (`refresh_on_challenge` in
`oauth_hooks.rs`, one retry in the manager connect loop), and the static-client configuration error.

Deviations from Node, each deliberate for this PR:

- The refresh reads the canonical record only. Node's `loadCredentialPair` also derives a pair from the
  legacy `tokens` and `client_information` keys. A legacy-only record therefore gives `no_credentials`
  (interactive authorization) instead of a refresh. Legacy-pair derivation is a follow-up.
- Discovery is fetched on every refresh. The cached `discovery_state` read is not ported (the write side
  stays in PR2's flow). Behaviour is the same, one extra discovery round trip.
- `resource` (RFC 8707) is not sent on the refresh request (see Deferred).

## PR3 follow-up: mid-session 401, 403 insufficient_scope (as built)

Owners: `kernel-api` `McpError::Http { status, message, www_authenticate }` (the header, typed) ->
`env-local` `http.rs` (sets it on a non-success status) -> `ext` `rpc.rs` `RpcError::Http` ->
`connection.rs` `ConnectFailure { reason, www_authenticate }` -> `oauth_hooks.rs` (challenge decisions) ->
`oauth/challenge.rs` (RFC 6750 parser). The row text is unchanged (`HTTP <status>: <body>`).

Event order, tool call on a live connection:

```mermaid
sequenceDiagram
  participant Tool as McpTool::call
  participant Client as connection (old)
  participant Mgr as McpManager
  participant Ref as oauth::refresh
  participant New as connection (new)
  Tool->>Client: tools/call (bearer B1)
  Client-->>Tool: RpcError::Http 401 (not retried yet)
  Tool->>Mgr: recover_call_challenge
  Mgr->>Ref: refresh (reactive)
  alt refreshed
    Ref-->>Mgr: Retry
    Mgr->>Client: restart; wait for the new client
    Mgr-->>Tool: true
    Tool->>New: tools/call (bearer B2), once
  else invalid_grant or no refresh token
    Mgr->>Mgr: start flow (row connecting)
    Mgr-->>Tool: false: return the original error text
  else temporary failure
    Mgr-->>Tool: false: credentials kept, original error text
  end
```

- A 401 mid-session: one refresh, one retried call. A second 401 returns the server's text.
- Node returns the original error to the model when recovery does not connect (`throw input.error`).
  This port does the same: the tool result is the transport's error text, not a new message.
- A 403 `insufficient_scope` on connect or on a call: a new authorization for the configured scope
  united with the header's `scope`, discovery from the header's `resource_metadata` (tried first), and the
  credential key prefix unchanged (keyed on the configured scope, as Node). No refresh.
- Deviation: the union omits the stored token's scope (Node includes it). A server that drops a scope it
  granted earlier could therefore see a narrower request.
- Deviation: the header does not cross the executor wire (`exec-server` maps `Http` to `Io`); a remote
  executor's 401/403 reaches the hooks as text only, with no refresh and no scope challenge.

Still deferred (not in PR3):

- `resource` (RFC 8707) on the refresh request.
- Plugin rows (#501) do not carry `oauth` or `url`, so they get neither refresh nor flow.
