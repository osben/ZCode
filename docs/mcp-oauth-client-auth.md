# MCP OAuth Client Authentication

> Follow-up design: cross-process OAuth single-flight and refresh race fixes are in `docs/mcp-oauth-two-phase.md` (v4 two-phase connection). This document covers config shape, credential integrity, and settings-page boundaries; provider shape, lock contracts, and error classification for two-phase connection follow that document.

## Background

The MCP 2025-11-25 Authorization spec defines authorization for HTTP-based transports:

- HTTP/SSE MCP clients must support the `WWW-Authenticate` challenge, OAuth Protected Resource Metadata (RFC 9728), Authorization Server Metadata/OIDC discovery, Resource Indicators (RFC 8707), and the Bearer token header.
- stdio MCP is out of scope and keeps reading credentials from process env vars.
- Access tokens must never enter URL query parameters; always send `Authorization: Bearer <access-token>`.

The ZCode MCP adapter already supports `stdio`, `http`, and `sse`, but HTTP/SSE previously supported only static headers. When a protected MCP server returns 401, the client must discover OAuth metadata, complete user or machine authorization, store the token, and retry — otherwise OAuth servers like Figma remote MCP cannot work out of the box.

## Goals

1. The config layer lets HTTP/SSE MCP servers declare `oauth`.
2. The agent runtime passes `oauth` unchanged from UI/desktop protocol, CLI config, and plugin MCP config into the MCP adapter.
3. The MCP adapter injects the SDK `OAuthClientProvider` for HTTP/SSE transports, reusing the SDK's 401-challenge, metadata-discovery, token acquisition, refresh, resource-parameter, and bearer-header logic.
4. Interactive `authorization_code` OAuth uses PKCE, dynamic client registration, localhost callback, browser authorization, token persistence, and reconnect retry — covering user-authorization servers like Figma remote MCP.
5. `client_credentials` keeps supporting machine-credential OAuth without a browser.
6. stdio MCP ignores `oauth` and keeps the env-var credential path.
7. E2E tests use a local protected MCP HTTP server and a local OAuth authorization server: an initialize without a token gets 401, the client discovers metadata, opens the authorization URL, receives the callback code, exchanges the token, retries with a bearer token, and finally lists tools.
8. When the authorization server needs user interaction, the MCP settings page shows a manual "open authorization" entry. Never auto-open the system browser by default, so status refreshes, background connects, or startup checks never interrupt the user.
9. When a session starts MCP servers, the **caller wait budget** for `authorization_code` OAuth is fixed at 15 seconds; after that the server is marked failed for this session round and the session continues, so a missing human authorization cannot stall model requests for minutes. The 15 seconds bound only this caller, not the authorization transaction's lifetime: the transaction survives in the background under a 300-second global TTL, and background reconnect registers tools on completion. See `docs/mcp-oauth-two-phase.md`.

## Config

```json
{
  "mcp": {
    "servers": {
      "protected": {
        "type": "http",
        "url": "https://mcp.example.com/mcp",
        "oauth": {
          "type": "authorization_code",
          "clientName": "ZCode",
          "scope": "mcp:connect"
        }
      }
    }
  }
}
```

Fields:

- `oauth.type`: `"authorization_code"` or `"client_credentials"`.
- `clientId`: OAuth client id; optional for interactive OAuth — omitted, it is obtained via dynamic registration at the authorization server.
- `clientSecret`: OAuth client secret; only for machine credentials or a pre-registered confidential client.
- `scope`: optional; configure explicitly if the server requires a fixed scope. Without it the client sends no scope, and acceptance depends on the server's default policy.
- `clientName`: optional, derived from the MCP server name by default.
- `redirectPath`: optional, `authorization_code` only; defaults to `/oauth/callback/mcp/<serverName>`, with the real redirect URI using a random localhost port.

## Manual authorization entry

`authorization_code` OAuth keeps the PKCE verifier, localhost callback server, and token persistence inside the agent MCP adapter. The UI holds no token, and OAuth state never sinks into desktop main, relay, or web remote business state.

Credential persistence keys are isolated by the five dimensions `serverName`, `serverUrl`, `clientId`, `scope`, and `redirectPath`; any change to these authorization-semantic fields requires re-authorization, never reusing old tokens or dynamic-registration client info.

When the MCP adapter detects that user authorization is needed, it puts the pending authorization URL into the MCP status snapshot but does not auto-open the browser. On seeing a pending OAuth, `mcp/list` returns the current status quickly instead of waiting out the full 5-minute authorization timeout. The settings page shows a manual open button on the server row; clicking opens the same authorization URL via the platform `openExternal`.

The agent runtime keeps the ability to explicitly inject `openAuthorizationUrl` for E2E tests or specific automation flows; without injection, the authorization jump must be triggered by a user action in the UI.

The authorization URL is valid only for the current pending authorization. After the user completes browser authorization, the localhost callback returns to the agent, the adapter runs `finishAuth`, saves the token, and reconnects. Access and refresh tokens never enter URLs or reach the UI.

## Session startup timeout

Session runtime and settings-page refresh use different OAuth wait policies:

- Session runtime passes a 15-second OAuth wait cap in `connectConfiguredServers`. Without an immediate browser authorization, only that MCP server fails — the round's model requests are not blocked, and the background authorization transaction is not terminated (caller budget vs transaction lifetime, per `docs/mcp-oauth-two-phase.md`).
- `mcp/list` settings refresh passes no session cap; the adapter keeps the default authorization window, returning the URL quickly on pending authorization while waiting in the background.
- When the settings page and a session hit the same pending OAuth connection, they share only the authorization URL, PKCE/state, callback, and underlying connection lifecycle; each caller keeps its own `oauthAuthorizationTimeoutMs` and `AbortSignal` wait boundary. A single caller's timeout or cancel returns the then-current runtime snapshot and must not close an OAuth session other callers still wait on.
- The MCP transport's normal `timeoutMs` bounds only protocol requests (connect/listTools/callTool) and must not re-extend the session's 15-second OAuth callback wait.

## Concurrent authorization transaction boundaries

OAuth state splits into transaction state and config-level snapshots; never stitch independent fields across lifecycles:

- Dynamically registered client information and the PKCE `code_verifier` belong to a single transaction while authorization is in flight. The provider must pin this transaction's client within one OAuth `state` lifecycle; repeated `clientInformation()` calls during SDK registration or code exchange must not re-read a client published by another transaction. The dynamic-registration result is also written immediately to the legacy client key as a recovery seed for a new authorization after provider rebuild; the current transaction still uses only its in-memory pinned client and never re-binds due to concurrent registration.
- After a successful token exchange, the dynamic client information and `access_token` / `refresh_token` form one config-level canonical credential pair. The pair must be published atomically in one credential key via a single cross-process-locked read-modify-write; overwriting the shared `client_information` and `tokens` keys separately is forbidden — the last write could mix a client and tokens from different transactions.
- Canonical-pair provider reads must also be snapshot-based. One provider's `clientInformation()` and `tokens()` read the same pair, avoiding a swap between two file reads by another process. The cache is marked loaded only after shared-credential I/O, parsing, and snapshot derivation all succeed; lock timeouts or transient I/O failures must keep it unloaded so the same provider's next call can retry.
- Discovery metadata stays a config-level shared cache; PKCE verifiers stay isolated per OAuth `state` under the credential prefix. Different adapters, callback ports, or concurrent reconnects must never read/write the same verifier key.

Each `authorization_code` authorization keeps its own random `state`, PKCE verifier, localhost callback server, and dynamic port. When one caller times out, cancels, or closes, it may close only its own callback server and clean its own transaction's verifier/client — never other pending authorizations under the same MCP config, and never unconditionally delete the config-level canonical pair.

After invalid client/grant, the SDK calls `invalidateCredentials()` and retries. The provider may delete only the canonical raw snapshot it actually read or published: deletion must compare current vs expected values under the credential file lock and delete only on match. If another process has published a new pair, the compare-and-delete must fail and keep the new value; the provider then clears its local snapshot and re-reads. Comparing only `publishedBy` with the current state does not cover refresh, because a refresh session legitimately consumes the pair published by an earlier state.

Upgrade compatibility uses a two-way window: `saveTokens()` atomically publishes the v2 canonical pair plus matching legacy `client_information` / `tokens` mirrors in one credential-file critical section. A v2 reader adopts a new token written separately by an old process only when the legacy client equals the canonical client — confirming a refresh of the same client; a missing legacy token still means the old process invalidated it. If legacy client and token both changed relative to canonical, the generation-less old format cannot prove they came from one transaction: the v2 reader must keep the legacy client, drop the untrusted token, and re-authorize — no speculative stitching. The v1 canonical has no mirror promise and prefers that update only when legacy tokens were rewritten by an old process with a confirmable identity. Remove legacy keys later via a separate migration version, only after every supported version sharing the credentials can read canonical. CLI and desktop may upgrade independently while sharing the credential file, so a client seeing an unknown canonical version must keep the original value and fall back — never treat a newer snapshot as corruption and delete it.

Clean up the transaction verifier after a successful exchange or when the authorization session closes. The callback server keeps using `listen(0)` for a random port — no fixed ports, no cross-process port mutex.

The callback's random port, listening socket, and OAuth `state` belong to the current process; after exit, the original browser callback cannot be delivered. A rebuilt provider only restores the registered client and starts a new authorization attempt — it never promises to revive an expired callback URL. Post-authorization verifier cleanup is best-effort: failures must log a security event but never reverse a successful token exchange or connection retry into a failure.

## Shared credential file integrity

The CLI adapter and desktop host process both read/write the same `credentials.json`. All read-modify-write changes must follow:

- The whole read-modify-write critical section uses one cross-process file lock; locking only the individual `writeFile` cannot stop a stale snapshot from overwriting keys another process just wrote.
- Writes create a temp file in the target directory, set private file permissions, and atomically replace via rename; transient rename occupancy errors on macOS/Windows need a bounded retry.
- Only `ENOENT` means an empty credential file. Corrupt JSON, invalid schema, or other read errors must first idempotently preserve a `0600` `.corrupt-<content-hash>.bak` evidence copy keyed by content hash, then throw; the same corrupt content read by any number of processes produces exactly one backup. Never degrade corrupt content to `{}` and keep saving — that would wipe all credentials.
- The lock covers local credential I/O only — never browser-authorization waits, network token exchange, or the 15-second session authorization window.

Concurrency diagnostics log only safe identifiers: process PID, adapter instance id, credential key prefix, a short hash of the OAuth state, and the callback port. Never log verifiers, authorization codes, access/refresh tokens, or client secrets.

## Impact and case boundaries

The integrity fix's scope is `persistence + validation/recovery`; settings-page interaction, MCP protocol DTOs, and desktop-continuous / web-remote-replayable delivery semantics are unchanged.

| Trigger                                              | Boundary                | Required outcome                                                                        |
| ---------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------- |
| two adapters authorize the same MCP config at once   | OAuth transaction state | both states read their own verifier/client and both pass strict PKCE and code/client binding |
| two transactions succeed and publish tokens in turn  | OAuth config snapshot   | canonical client and tokens always come from one transaction; later refreshes never mismatch identities |
| an old process registers a client interleaved with another old process's refresh | version-compat window | drop tokens of unprovable ownership without generations; re-authorize instead of stitching identities |
| a failing transaction settles concurrently with a successful one | OAuth credential invalidation | the failing side only compare-and-deletes its own old snapshot, never the newly published pair |
| CLI and desktop host write different credential keys simultaneously | shared credential persistence | both changes survive; no whole-file lost update |
| credential file is invalid JSON or schema            | credential recovery     | save fails, the original file is not overwritten, and a diagnosable backup exists        |
| a single authorization wait times out or closes      | OAuth transaction lifecycle | only that state's callback/verifier is cleaned; other pending states unaffected          |

Merging the settings page and session adapter instances is not part of this fix.

Cross-process OAuth leader/lease and refresh-token single-flight have both graduated into the v4 two-phase connection design with real process/PID runtime evidence — see `docs/mcp-oauth-two-phase.md`. That design replaces this section's earlier "not for now" wording:

- passive connections use a pure `AuthProvider` with zero listeners, zero discovery, zero DCR;
- all refreshes (active and reactive) funnel through one cross-process refresh lock separate from the credentials file;
- interactive authorization gets cross-process and in-process single-flight via a dedicated authorization lock; the DCR client lives in memory only within the authorization transaction;
- the canonical pair gains a unique `generation` per publication; invalidation becomes a generation-conditional transaction.

## Settings-page status-only refresh boundaries

- OAuth pending, post-callback follow-up, and refresh-on-return-to-app all use `mcp/list mode=status`, reading runtime status only and never converging the connection set.
- A normal full `connect` still handles adds, removals, config changes, and stale-server convergence; if a same-named server's config is unchanged and an authorization-code OAuth is already waiting for callback, repeated convergence must reuse that pending connection — never close the callback/session or mint a new authorization URL.
- Pending/follow-up caches, config-load readiness, queued requests, and response merging bind to `workspaceKey = workspaceIdentity?.trim() || workspacePath`. On workspace switch, immediately clear the old config and OAuth caches; requests not yet sent by the old workspace runner are dropped, results of already-sent requests must not merge into the new workspace, and the old workspace's env, headers, or OAuth `clientSecret` must never reach a new local or remote agent.
- A follow-up is one bounded retry window triggered by the pending-disappears edge; once created, same-workspace status-snapshot merges must not clear it. Only retry exhaustion, workspace switch, re-entering pending, or explicitly stopping polling ends the window.
- Pending-status polling uses a 5-minute wall-clock deadline computed at window creation; check it before each scheduling step and after each request completes — never approximate duration by request count, which slow requests could stretch into hours.
- Status-only and full connect use independent request epochs; starting status-only advances only its own epoch — it must not clear authorization/tool counts, project other changed/unknown rows as connecting, or invalidate a concurrent connect's results.
- On status-only failure, the settings page keeps the existing status snapshot, authorization URL, and other servers' connection states; never clear the snapshot or bulk-mark errors as a failed full connect would.
- If an old agent rejects `mode=status`, the service must not silently retry the default `connect` by omitting `mode`; it returns a stable "status-only unsupported" error code. The settings page then keeps the current UI snapshot, stops pending/follow-up timers and focus refreshes, and prompts once to upgrade/restart and reopen MCP settings for a full refresh; probing resumes only after a workspace switch or an explicit full refresh — avoiding persistent alarms or a compatibility path that changes the runtime connection set.

## Spec references

- MCP Authorization specification: https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
- TypeScript SDK OAuth providers: https://www.npmjs.com/package/@modelcontextprotocol/sdk

## Non-goals

- OAuth tokens never sink into desktop main, relay, or web remote business state; OAuth behavior lives only in the agent MCP adapter's HTTP/SSE transport.
- No separate Agent runtime or MCP runtime for mobile `/remote`.
- No embedded OAuth WebView or popup login in the renderer; interaction stays with the system browser + localhost callback, and the settings button just explicitly opens the same authorization URL.
- No OAuth flow for stdio MCP.

## Verification

Automated coverage must include:

- Config schema accepts HTTP/SSE `oauth.authorization_code` and `oauth.client_credentials` and rejects configs with missing required fields.
- The ZCode Protocol DTO preserves `oauth` across session create/resume/mcp list.
- The MCP adapter passes `authProvider` for HTTP/SSE transports, with static headers kept.
- The MCP status snapshot returns the authorization URL on pending authorization_code OAuth, and the settings page shows the manual open button.
- E2E: a protected Streamable HTTP MCP server connects and lists tools after 401 -> authorize redirect -> callback code -> token -> retry.
- A strict fake authorization server returns a different client per dynamic registration and validates the authorization code, client, redirect URI, and S256 challenge/verifier binding; two concurrent adapters must each complete authorization.
- After concurrent transactions complete, persisted canonical client/tokens come from one transaction; a new provider refreshing with that pair must not fall back to re-authorization.
- When one transaction fails and triggers credential invalidation, it must not delete the canonical pair another transaction just published.
- Concurrent writes to the shared credential file — same process and separate Node processes — lose no keys.
- The CLI adapter and desktop credential service both refuse to overwrite a corrupt credential file and keep `.corrupt-*.bak` evidence.
- Repeated reads of the same corruption, in one or many processes, produce an idempotent `0600` backup; only changed content creates new evidence.
- After a new provider publishes, an old provider can still read the legacy pair; after the old provider refreshes or invalidates, the new provider must not keep reading stale canonical data.
