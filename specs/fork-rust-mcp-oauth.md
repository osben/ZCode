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
