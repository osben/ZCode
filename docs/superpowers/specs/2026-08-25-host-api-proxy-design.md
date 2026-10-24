# Host External Business API Proxy Design

## Status

- Stage: implemented; the explicit port consumer for remote resource downloads was added 2026-08-28.
- Related feedback: `ZCT-2092222819015462912`.
- Change layer: `commit-effect`, `validation`.
- The `NodeApiClient` Host proxy described here is implemented; the later remote resource download extension
  keeps reusing the same request-scoped transport.

## Problem summary

The settings page already applies `httpProxy`, `httpProxyNoProxy` and `httpProxyCaCertPath` to the Electron
Session and injects the matching network configuration when starting the Agent, but the Window Host's own
external business API requests did not consume these three settings. OAuth browser authorization and the
deep-link callback can succeed, yet the Host's following token exchange still goes straight to the public
network; on a forced-proxy network the request therefore times out.

```text
Browser                  Electron Main              Window Host
   | OAuth authorize          |                         |
   |------------------------->|                         |
   | callback / deep-link     |                         |
   |------------------------->| route callback          |
   |                          |------------------------>|
   |                          |                         | NodeApiClient
   |                          |                         | -> global fetch
   |                          |                         | -> direct egress
   |                          |                         X corporate firewall
```

## Facts, inferences and unknowns

### Confirmed facts

- `AppSettings` is the persistent authority for the desktop explicit proxy, No Proxy and custom CA; the
  settings page says changes take effect after restart.
- `packages/services/src/providers/api/nodeApiClient.ts` calls `globalThis.fetch` by default and has no Host
  network policy.
- `packages/services/src/node.ts` creates the `NodeApiClient` shared by the local service collection; OAuth,
  model provider config, Coding Plan, usage, client scenes, feedback, Repo Snapshot metadata and other
  services reuse it.
- `packages/desktop/src/host/remoteWorkspaceServiceCollection.ts` creates a second `NodeApiClient` for the
  local-machine global services of desktop-attached remote; OAuth, credentials and package facts are still
  held by the desktop Host.
- The Main-to-Host environment construction cleans the shell's `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`,
  `NO_PROXY` and CA variables; this is existing isolation design and must not be bypassed by inheriting the
  environment variables again.
- The Host still has direct `fetch` egresses such as Bot, telemetry, object-storage upload and off-peak, which
  are outside the current unified business API boundary of `NodeApiClient`.

### Inferences supported by evidence

- Injecting an explicit proxy-aware fetch into `NodeApiClient` is enough to fix the OAuth, Coding Plan and
  `client-scenes` failures of the ticket without changing the business services.
- A process-global dispatcher would also change third-party, intranet, local and object upload traffic in the
  Host that is outside this ticket, with a clearly larger regression surface.

### Classified follow-up egresses

- Remote resource manifests, component archives and progress `HEAD` of desktop-attached SSH/WSL/Docker have
  been classified: they are app-managed downloads that reuse this design's Host lifecycle transport but are
  injected through an explicit `RemoteAssetNetworkPort`, without setting a global dispatcher.
- Whether Bot, telemetry, Repo Snapshot object upload and other bare `fetch` calls should all follow the App
  proxy still needs a separate egress classification; a global dispatcher does not answer for the product in
  advance.
- The system proxy is not an implicit source for Host app-managed APIs. With empty settings it stays direct; if
  a system fallback is ever added, a trust boundary different from the Electron embedded browser must be
  defined separately.

## Architecture contract

### Boundary diagram

```text
setting.json
  httpProxy / httpProxyNoProxy / httpProxyCaCertPath
                 |
                 | read asynchronously and frozen when the Host first builds the network egress
                 v
       HostApiNetworkPolicySnapshot
                 |
                 v
        request-scoped fetch transport
          | final URL -> No Proxy?
          |             | yes -> direct dispatcher + optional CA
          |             ` no  -> proxy dispatcher + optional CA
          v
             NodeApiClient
          /       |        \
       OAuth   Coding Plan  client-scenes / provider / usage / feedback

Reused through an explicit port:
  desktop-attached remote manifest / component archive / progress HEAD

Outside this boundary:
  Electron Session | Agent/CLI | Bash/stdio MCP | Bot direct fetch
  telemetry direct fetch | object-upload fetch | RPC/WS/SSH | relay
```

### Decision D1: the settings authority is unchanged

**Choice**: the Host reads only `AppSettings.httpProxy`, `httpProxyNoProxy`, `httpProxyCaCertPath`; an empty
value means direct or default TLS trust. Keep cleaning the user shell's standard proxy and CA variables.

**Reason**: consistent with the existing app/provider network isolation rule; avoids invisible,
undiagnosable behavior obtained from the launch shell.

**Not chosen**: removing the cleanup of standard network variables in `sanitizeZCodeRuntimeEnv`; using
`NODE_USE_ENV_PROXY`.

### Decision D2: request-scoped dispatcher, no process-global dispatcher

**Choice**: create a proxy-aware fetch at the Node HTTP provider boundary of `packages/services` and inject it
through `NodeApiClientOptions.fetchImpl`. Proxy mode uses an explicit `undici` dispatcher; direct mode keeps a
direct dispatcher.

**Reason**: changes only requests already declared to use the unified external business API egress, keeping
dependency injection and test replaceability.

**Not chosen**: calling `setGlobalDispatcher` at Host startup. It would take over remote server probing, Bot,
telemetry, upload and localhost requests, needing extra product decisions and a regression matrix.

### Decision D3: freeze the configuration per Window Host lifecycle

**Choice**: the first time each Window Host needs the network policy, it asynchronously reads the settings and
CA file through a single-flight Promise and builds an immutable snapshot, reused within that Host's lifecycle.
A settings change takes effect at the next app/Host restart.

The policy transport is a non-RPC managed resource of the Host collection: the local collection and the
desktop-attached remote collection each register a lifecycle disposer; synchronous exit triggers a best-effort
destroy and awaitable exit awaits dispatcher close. The transport must not be registered as a business service
callable by the renderer, nor rely only on process exit to reclaim the connection pool.

**Reason**: keeps the existing settings page contract "takes effect after restart", avoids reading the disk on
each request, and avoids switching connection pools mid-request.

**Failure boundary**: if reading settings fails the current request fails closed, and a rejected promise must
not be cached; later requests may re-read the settings and retry. When an explicit configuration exists but the
proxy or CA is invalid, that request must fail closed and never silently fall back to direct.

### Decision D4: rewrite the endpoint first, then choose the egress

**Choice**: `NodeApiClient` first rewrites the default ZCode endpoint to the currently effective endpoint under
the existing rules, then runs No Proxy and dispatcher selection on the final URL.

**Reason**: No Proxy must match the real target, not the pre-rewrite production domain.

### Decision D5: No Proxy and custom CA match the existing explicit semantics

**Choice**: No Proxy supports `*`, exact host, host:port, `.example.com` and `*.example.com`; on a match it
bypasses only the proxy, not the custom CA. The custom CA applies to direct TLS, the HTTPS proxy and the target
TLS after HTTP CONNECT.

**Failure boundary**: if the CA file does not exist, is unreadable or cannot be parsed, requests managed by the
policy return a structured network error; TLS verification is never turned off.

### Decision D6: owner boundaries of local and remote workspaces are unchanged

**Choice**:

- desktop local: the `NodeApiClient` of local `createLocalServices` uses the Host policy.
- desktop-attached SSH/WSL/Docker: remote Agent/file IO is unchanged; app-global OAuth, provider, usage,
  Coding Plan and client scenes inside the desktop Host use the same kind of Host policy.
- server remote: keeps using the server's authoritative services; the desktop Host does not override its
  network egress.
- mobile `/remote`: reuses only the existing shared-host attachment; no new Agent, Host, relay state or
  network configuration protocol.

### Decision D7: diagnostic logs are low-frequency and redacted

**Choice**: policy snapshot construction success or failure logs at most one lifecycle log; per-request egress
selection is allowed only at `debug`, with fields only `mode`, the redacted target host, the proxy host, the
No Proxy hit and custom CA enabled; never proxy credentials, full URLs, OAuth code, token or header values.

## Impact Brief

### State Owners And Commit Sinks

| State/fact                      | Draft/display owner  | Authoritative owner | Commit command/service   | Persistence/cache                  | Evidence                              |
| ------------------------------- | -------------------- | ------------------- | ------------------------ | ---------------------------------- | ------------------------------------- |
| proxy / no-proxy / CA path      | SettingsPage         | `AppSettings`       | `settingService.update`  | `setting.json`                     | `settingService.ts`                   |
| effective Host policy           | none                 | Window Host process | lazy snapshot creation   | process-memory snapshot + disposer | planned provider boundary             |
| OAuth pending callback          | OAuth UI/service     | `OAuthService`      | `handleCallback`         | process memory + credential repo   | `oauthService.ts`                     |
| remote workspace app-global API | remote UI projection | desktop Window Host | local service collection | local settings/credentials         | `remoteWorkspaceServiceCollection.ts` |

### Must-Preserve Invariants

| Invariant                                                                                              | Surfaces/modes        | Proof needed                                 | Evidence                     |
| ------------------------------------------------------------------------------------------------------ | --------------------- | -------------------------------------------- | ---------------------------- |
| Without an explicit proxy, Host business APIs keep going direct                                        | all                   | direct test                                  | `HAP-001`                    |
| An explicit proxy failure must not fall back to direct                                                 | forced-proxy network  | capture upstream direct connection count = 0 | `HAP-004`                    |
| Local-identity APIs of desktop-attached remote use the desktop policy, server remote is not overridden | remote modes          | wiring tests                                 | `HAP-008/009`                |
| No change to the Agent, Electron Session, Bot, telemetry, object upload egresses                       | all                   | dependency and regression checks             | `HAP-010`                    |
| No change to continuous/replayable, workspace identity or session state                                | desktop/mobile/remote | no protocol/schema/state diff                | static diff + existing tests |

## Case Planning

### Dimensions And Candidate Combinations

| Candidate ID | State                                 | Event                           | Target/surface                | Expected guard/effect                               | Status   | Notes                  |
| ------------ | ------------------------------------- | ------------------------------- | ----------------------------- | --------------------------------------------------- | -------- | ---------------------- |
| HAP-001      | no explicit policy                    | API request                     | ZCode endpoint                | direct, existing behavior                           | accepted | baseline               |
| HAP-002      | explicit proxy                        | OAuth callback                  | final token URL               | exactly one proxied request                         | accepted | core ticket            |
| HAP-003      | proxy + matching No Proxy             | API request                     | exact/suffix/host:port target | direct, CA still applies                            | accepted | bypass semantics       |
| HAP-004      | unreachable proxy                     | API request                     | external endpoint             | structured failure, zero direct fallback            | accepted | security invariant     |
| HAP-005      | custom CA, no proxy                   | HTTPS request                   | private CA endpoint           | direct TLS succeeds                                 | accepted | direct CA              |
| HAP-006      | proxy + custom CA                     | CONNECT request                 | private CA endpoint           | tunnel TLS succeeds                                 | accepted | enterprise path        |
| HAP-007      | settings changed during Host lifetime | later request                   | same Host                     | old snapshot until restart; new Host uses new value | accepted | restart contract       |
| HAP-008      | desktop-attached remote               | local OAuth/Coding Plan request | desktop Host local service    | desktop policy applies                              | accepted | local authority        |
| HAP-009      | server remote                         | remote-owned API request        | server service                | desktop Host policy does not replace it             | accepted | authority isolation    |
| HAP-010      | explicit proxy                        | non-ApiClient direct fetch      | Bot/telemetry/object upload   | unchanged in this phase                             | accepted | scope guard            |
| HAP-011      | endpoint override + No Proxy          | request                         | rewritten endpoint            | match final URL                                     | accepted | ordering               |
| HAP-012      | timeout/abort                         | proxied streamed response       | ApiClient                     | existing abort/timeout/stream behavior preserved    | accepted | transport parity       |
| HAP-013      | system/shell proxy only               | API request                     | Host                          | ignored; direct                                     | accepted | sanitization invariant |

### Accepted Cases And Evidence

| Case ID     | Setup                                    | Action                                    | Assertions                                    | Evidence layers            | E2E status |
| ----------- | ---------------------------------------- | ----------------------------------------- | --------------------------------------------- | -------------------------- | ---------- |
| HAP-001     | no settings                              | request test server                       | direct success, no proxy agent                | unit + network             | planned    |
| HAP-002     | local CONNECT proxy; direct route denied | complete OAuth token request              | proxy observes final URL; response succeeds   | unit + integration/network | planned    |
| HAP-003     | explicit bypass patterns                 | request matching and nonmatching targets  | correct dispatcher chosen                     | unit                       | planned    |
| HAP-004     | dead proxy                               | request reachable direct upstream         | fails without upstream hit                    | integration/network        | planned    |
| HAP-005/006 | private CA endpoint; direct/proxy        | request endpoint                          | TLS succeeds only with configured CA          | integration/network        | planned    |
| HAP-007     | write setting after first request        | second request, then recreate Host/client | old/new lifecycle policies observed           | unit                       | planned    |
| HAP-008/009 | remote collection fixtures               | resolve local and server-owned services   | correct client authority                      | wiring unit                | planned    |
| HAP-010     | direct fetch spy                         | construct scoped client                   | global fetch/dispatcher unchanged             | unit/static                | planned    |
| HAP-011     | test endpoint rewrite                    | request production URL                    | No Proxy sees rewritten origin                | unit                       | planned    |
| HAP-012     | slow/stream server                       | abort and timeout                         | current `ApiError`/stream semantics preserved | unit + network             | planned    |

No conversation formal-proof or conversation E2E handoff is needed; this change adds no product state, command,
snapshot or replayable combination. A real Windows forced-proxy smoke is a supplementary pre-release check and
does not replace the deterministic local proxy integration tests.

## Risks and rollback

| Risk                                                  | Mitigation                                                                     |
| ----------------------------------------------------- | ------------------------------------------------------------------------------ |
| Wrongly proxying localhost / intranet / remote server | scoped client + No Proxy + no global dispatcher                                |
| Wrong match on endpoint override                      | rewrite-before-routing tests                                                   |
| Direct leak after proxy failure                       | fail-closed integration test counting direct upstream hits                     |
| CA covering only one TLS segment                      | verify direct, HTTPS proxy and CONNECT separately                              |
| Connection pool or dispatcher leak                    | the Host lifecycle owns it and closes it on service dispose; test open handles |
| Settings hot-update semantics drift                   | immutable lifecycle snapshot, settings page copy unchanged                     |

Rollback only needs reverting the `NodeApiClient` fetch injection and the Host policy provider; there is no
schema, protocol, credential, settings format or data migration, and the existing Electron Session and Agent
network paths are unaffected.

## Implementation conclusion

Owner, configuration source, scope, activation timing, remote boundary, failure modes, tests and rollback are
all implemented and closed. Whether the other Host bare network egresses should all follow the App proxy still
needs item-by-item classification and must not be smuggled in through a global dispatcher. Remote resource
download has been closed by a separate spec as an explicit port consumer and does not change the remaining
egresses such as Bot, telemetry and object upload.
