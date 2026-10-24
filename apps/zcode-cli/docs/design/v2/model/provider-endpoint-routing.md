# Provider Endpoint Routing

## Status

- Defines the facts of model provider endpoint forwarding in the ZCode CLI; dynamic routing and the
  static gateway share one contract and call chain.
- The capability exists only in the default AI SDK provider transport of `apps/zcode-cli`. It changes
  neither the user provider config, the ZCode Protocol, Desktop/Web renderer networking, WebFetch, MCP,
  OAuth, plugin downloads nor tool child processes.
- A trusted `custom` provider owns its transport and is outside transparent forwarding.

## Goals

### Implementation assembly boundary

`ProviderEndpointRoutingPort` and `createProviderEndpointRoutingFetch` are the public boundary. bootstrap
creates the implementation through `createProviderEndpointRoutingPort`; the CLI, TUI, desktop stdio
Agent, workflow and subagent keep the same dependency injection, and wiring is not removed by release
edition.

```text
bootstrap process registry (endpoint origin + network policy)
  -> createProviderEndpointRoutingPort
       -> dynamic edition: reads remote config on demand, owns the original snapshot and single-flight
       -> static edition: matches only built-in endpoints, issues no config request and reads no source
          identity
  -> the same ProviderEndpointRoutingPort
  -> the same fetch wrapper: keeps query/body/auth/signal, clears the old Host
  -> the existing proxy / No Proxy / CA transport
```

The implementation directory is adapters `model/endpoint-routing-edition/`. The public factory parameters
and the static resolver live outside the directory; an export replaces only that directory and not the
public source. Tests specific to the dynamic edition are explicitly excluded, while the public fetch
tests and the static edition tests are kept in both editions. The public factory exposes no snapshot,
refresh budget or implementation class upward. The network client and source identity are passed in as
dependencies, and the static edition calls neither.

The fork ships a direct edition: the edition returns `routed:false` for every request and never rewrites
an endpoint. Reason: the platform gateway (the `/api/v1/ultra-zai/anthropic/v1/messages` path under the
runtime ZCode origin) returns 404 for GLM-5.3 (GLM-5.3-Flash works), while the `agent/configs` control
plane currently returns no `proxyEndpoint`, so the official closed-source assembly connects to the
provider directly and GLM-5.3 works there. The upstream static gateway table stays in
`official-coding-plan-gateway.ts` and its tests, no longer referenced by the edition; to restore gateway
routing, point the edition back at `createStaticProviderEndpointRoutingPort`.

Original behavior of the upstream static gateway (effective only when pointed back):

| Exactly matched HTTPS endpoint               | Target path under the current runtime ZCode origin |
| -------------------------------------------- | ------------------------------------------ |
| `open.bigmodel.cn/api/anthropic/v1/messages` | `/api/v1/ultra/anthropic/v1/messages`      |
| `api.z.ai/api/anthropic/v1/messages`         | `/api/v1/ultra-zai/anthropic/v1/messages`  |

Default port, host case, trailing `/` and query follow the matching rules below; other protocols, ports,
paths, subdomains and third-party Providers are not rewritten. The origin reuses
`resolveRuntimeZCodeEndpointOrigin` and adds no user config or environment variable. The static edition
has no route snapshot or refresh timer. Reuse of the process registry and network isolation remain the
responsibility of bootstrap.

The order of public request handling is unchanged: SDK/final body conversion, the request safety
validation of the official edition, routing, network proxy. The request-time apiKeyId still comes only
from the account owner, and ordinary requests incur no extra wait from edition assembly. Desktop
continuous and mobile replayable keep entering the original CLI, adding no runtime, queue or protocol
field.

### Dynamic edition

The ZCode CLI reads on demand when a model request happens:

```text
GET https://zcode.z.ai/api/v1/agent/configs
```

Tests and non-production environments must reuse the existing endpoint selection rule of
`buildRuntimeZCodeApiUrl`; a parallel environment variable must not be added. `data.proxyEndpoint.mapping`
in the response decides whether an explicit provider endpoint is rewritten to a ZCode proxy endpoint. A
legal empty mapping returned by the server turns forwarding off; the client neither modifies nor persists
the provider `baseURL`.

Example:

```json
{
  "code": 0,
  "msg": "",
  "data": {
    "proxyEndpoint": {
      "mapping": [
        {
          "from": "https://open.bigmodel.cn/api/anthropic/v1/messages",
          "to": "https://zcode.z.ai/api/v1/ultra/anthropic/v1/messages",
          "zcodeAuthorizationHeader": "X-Zcode-Authorization"
        },
        {
          "from": "https://api.z.ai/api/anthropic/v1/messages",
          "to": "https://zcode.z.ai/api/v1/ultra-zai/anthropic/v1/messages",
          "zcodeAuthorizationHeader": "X-Zcode-Authorization"
        }
      ]
    }
  }
}
```

### ZCode gateway identity header

The optional field `zcodeAuthorizationHeader` of a mapping entry means that when the entry is hit, the
login identity is attached to the request to the final ZCode gateway. The field value must equal
`X-ZCode-Authorization` case-insensitively; the client always uses the canonical name:

```http
X-ZCode-Authorization: Bearer <zcodejwt>
```

The identity header may only be sent to two path families under the current runtime ZCode origin:

- `/api/v1/ultra` itself and its subpaths;
- `/api/v1/ultra-zai` itself and its subpaths.

Paths are judged by URL segment; `/api/v1/ultra-other` does not belong to `/api/v1/ultra`. If an entry
carrying the identity field has a target origin or path that does not satisfy the restriction, the whole
new snapshot is rejected and the previous usable snapshot is kept. Existing mappings without the field
keep following the original routing rules.

The only source of the JWT is `zcodejwttoken` in the credential store of the current Environment. After a
route hit it is read per request and the JWT is not cached:

- With a non-empty JWT the identity header is attached; when it already has a `Bearer` prefix it is not
  added again.
- When not logged in, the JWT is missing/blank, or the credential read fails, the existing URL routing is
  still completed but no identity header is attached.
- The JWT represents the ZCode login identity of the current Environment, is independent of the model
  Provider Token/API Key, and does not require account generation consistency.
- Direct requests, mappings without the identity field and other ZCode APIs neither read nor send the JWT.

The target Environments of SSH, WSL and Docker already sync `zcodejwttoken` through the credential
allowlist of Provider Provisioning, so the remote Source Server and the local CLI use the same
target-side read logic; no Host-to-CLI protocol field is added, and the OAuth credential format, login
rollback and Provider request authentication material are unchanged.

## Boundary

| Item | Constraint |
| ---- | ---------- |
| Effective runtime | standalone CLI, TUI, desktop stdio Agent, main session, workflow and subagent child runtime |
| Effective requests | model HTTP(S) requests issued by the default AI SDK provider |
| Ineffective requests | WebFetch, MCP, OAuth, plugins, Bash/tool, Desktop/Web renderer, `custom` provider transport |
| Config owner | the shared routing registry inside the ZCode CLI process |
| Persistence | none; re-read after process restart |
| Protocol/config | the private requestAuth keeps only the existing optional apiKeyId; no new protocol field, user config or environment variable |

Desktop `desktop-continuous` and mobile `web-remote-replayable` still describe only session/task message
delivery. This capability changes only the final HTTP destination from the Agent to the model provider
and does not change stream, snapshot, queue, owner, workspace identity or recovery semantics.

## State and timing

```text
AI SDK provider request
          |
          v
ProviderEndpointRoutingPort.resolve
          |
          +-- snapshot fresh (< 5m) -------------------+
          |                                            |
          +-- snapshot stale / absent                  |
                    |                                  |
                    v                                  |
          shared in-flight agent/configs GET           |
                    |                                  |
          +---------+----------+                       |
          |                    |                       |
       valid code=0       timeout/error/invalid         |
          |                    |                       |
    atomically replace     keep last-known-good         |
    mapping snapshot       or cold-start direct         |
          |                retry no sooner than 30s     |
          +---------+----------+-----------------------+
                    |
                    v
       endpoint match -> rewritten/original URL
                    |
                    v
       HTTP proxy / No Proxy / custom CA
                    |
                    v
            provider streaming response
```

- A successful snapshot is valid for 5 minutes from the time the refresh completes.
- An expired cache is refreshed only when a new model request arrives; no timer is created and an idle
  process does not touch the network.
- Concurrent refreshes of the same routing key must be single-flight; all waiters observe the same atomic
  result.
- A config request takes at most 3 seconds and the response body is at most 256 KiB.
- After a refresh failure no config request is issued within 30 seconds; an existing snapshot may keep
  being used until the next successful refresh, and a cold start without a snapshot connects directly.
- Cancelling a single model request must stop its wait at once but must not cancel the config refresh
  shared with other requests.
- The JWT read after an identity mapping hit is part of the same request cancellation boundary;
  cancellation must reject immediately, and a late read result must not keep sending the request.

## Config request and validation

The config request must be issued through a separate general `HttpClientPort` and reuse the explicit
proxy, No Proxy and custom CA. It must not pass through provider endpoint routing, to avoid
`/agent/configs` self-recursion.

The request is a parameterless GET. Besides `Accept`, the source identity must reuse the same shared
construction rule as `buildZCodeSourceHeaders` and send:

- `Accept: application/json`
- `HTTP-Referer`, following the current runtime ZCode endpoint origin
- `User-Agent: ZCode/<version>`
- `X-ZCode-App-Version` when the version is valid
- `X-Title`: `Z Code@cli` for the standalone CLI/TUI, `Z Code@electron` for the desktop stdio Agent
- `X-Platform`, `X-Release-Channel`, `X-Client-Language`, `X-Client-Timezone`, `X-Os-Category` and a
  valid `X-Os-Version`
- `X-Device-Mid` when a legal `deviceMid` already exists in `~/.zcode/v2/telemetry-state.json` (or the
  directory of `ZCODE_DATA_BASE_DIR`); the config request must not create a new device identity
- when `requestAuth.apiKeyId` of an account request is non-empty, the config GET carries `x-api-key-id`;
  the value must be printable ASCII after trim.

The ID comes from the same PAT exchange result of the authentication owner, passed through a dedicated
parameter and not read from the model request headers. `x-api-key`, `Authorization`, OAuth/PAT, the
request body or provider query must not be sent; a manual Provider sends only client source headers. No
GET is issued while the snapshot is valid; a single-flight refresh uses the ID of the initiator. A blank,
control-character or non-ASCII ID does not enter the header but does not block the config refresh.

The shared source header injection point may only provide the ZCode source identities above; even if
`x-api-key-id`, `Authorization`, Cookie or other undeclared headers are wrongly injected, they must not
cross the config request boundary. The `x-api-key-id` of the config GET may only come from the dedicated
parameter of this `resolve`.

```text
runtime/env + OS/locale + existing deviceMid
                    |
                    v
       shared ZCode source headers ------------------+
                                                     |
requestAuth.apiKeyId --explicit ID only-----------------+--> agent/configs GET
                    |
                    +----X----> Authorization / other model headers
                    +----X----> WebFetch / MCP / OAuth / tool
```

The config endpoint receives the provider `x-api-key-id` before the routing decision and is a trusted,
sensitive control plane; the client must not log or persist it, nor place it in the routing registry key,
snapshot or error context.

Only the following responses may replace the current snapshot:

1. HTTP 2xx.
2. The `code` of the JSON envelope strictly equals `0`.
3. `data` is an object; a missing `proxyEndpoint` or an empty `mapping` is a legal empty snapshot.
4. mapping has at most 256 entries and passes validation as a whole; a bad entry, a duplicate `from` or
   exceeding the limit rejects the whole.
5. `from` and `to` are both HTTPS URLs without username, password, query or fragment.
6. A missing/blank `zcodeAuthorizationHeader` attaches no identity; when non-empty it must be the fixed
   name and `to` must hit the `/api/v1/ultra` or `/api/v1/ultra-zai` path family of the current runtime
   ZCode origin.

Fields in `data` unrelated to this feature are allowed. `to` is an arbitrary HTTPS target of the trusted
control plane; this means that on a hit the original model authentication headers and request content are
sent to that target, so the publishing permission of server config must be managed as a sensitive control
plane.

## Matching and rewriting

- The mapping key is the normalized `scheme + hostname + effective port + pathname`.
- The URL parser normalizes scheme/hostname case and default ports; apart from the root path a trailing
  `/` is treated as equivalent.
- Matching ignores the model request query; after a hit the target is replaced by the full `to`, and the
  original query is appended to `to` unchanged.
- No hostname-only, prefix or wildcard matching, so a mapping cannot take over other APIs on the same
  domain by accident.
- method, existing headers, body, AbortSignal and the response stream must stay unchanged; the final
  `Host` is generated by fetch from the target URL.
- The identity header declared by the routing decision must cover the three fetch input forms Request,
  URL and string, including calls without `init.headers`; it must not rely on the SDK happening to supply
  headers.
- URL rewriting must come before HTTP proxy/No Proxy resolution, so the egress policy judges by the final
  target.
- The new provider/model config used by later Model creation must not lose the injected routing port; the
  execution facts of an already created Model stay frozen.

## Logging and privacy

- When the new snapshot differs from the previous one, log `info` once with the mapping count only.
- A refresh failure logs `warn` per 30 second cooldown window with only the error class and the config
  endpoint host.
- A single hit may log only `debug`, with only the source/target host and the normalized path.
- Never log the raw config response, query, headers, API Key, OAuth token, JWT, model body or model
  output.

## Impact Brief

| Field | Value |
| ----- | ----- |
| Developer intent | Assemble dynamic routing or the static gateway through the same port, keeping the public model request chain consistent |
| Capability | provider endpoint routing |
| Change layer | commit-effect / persistence / recovery |
| Operating mode | implementation-handoff |
| Primary seeds | `createProviderEndpointRoutingPort`, `createProviderEndpointRoutingFetch`, `AiSdkModelExecution.bindModel` |
| Out of scope | UI, provider config persistence, non-provider network egress |

This capability has no UI surface, draft state or user submit action. The authoritative owner is the
in-process routing registry; Model execution, workflow child and script workflow child hold only the same
port reference. The downstream that must be checked is the provider fetch composition order and all
default model adapter creation paths; WebFetch/MCP/tool and the desktop/mobile delivery semantics are only
isolation invariants. The repository currently has no codegraph index, so caller evidence comes from the
live source seeds above and tests.

`x-api-key-id` has no UI, draft or persistence owner; its only authoritative source is the
requestAuth.apiKeyId returned by the account authentication owner, and its only sink is the single GET of
the separate config `HttpClientPort`. The feature graph gained the isolation edge
`supplies-x-api-key-id-on-stale-refresh`; only the dynamic edition consumes the value. No codegraph impact
scan was run this time; boundaries were verified by the source call chain and tests of both editions,
introducing no conversation/E2E state combination.

## Confirmed cases

Edition replacement acceptance:

| Case | Setup / Action | Assertions |
| --- | --- | --- |
| PER-019 | Two official endpoints, default ports, trailing slash, query | The fork direct edition always returns `routed:false` unchanged with zero configuration IO; the static resolver's own rewriting assertions stay in its dedicated tests |
| PER-020 | Different scheme/host/port/path and third-party URLs | The direct edition returns them unchanged and never widens matching |
| PER-021 | Static port sends Request/URL/string through the shared wrapper | method/body/auth/signal/response unchanged, stale Host removed |
| PER-022 | Repeated creation for the same endpoint/network, or a changed network | Factory sharing/isolation follows the existing process registry contract |
| PER-023 | Build and send a real model request after replacing the edition | The default assembly connects directly (`routed:false`); the static gateway source is retained but not referenced by the edition; the shared call chain and tests are preserved |

PER-019 to PER-023 and the dynamic cases below were updated before implementation. The dynamic tests keep
covering cache, failure, cancellation and ID isolation; this change has no UI interaction, so the entry
is verified with real HTTP/model execution integration and the exported tree run, and no conversation
product state is added.

| Case | Setup | Action | Assertions |
| ---- | ----- | ------ | ---------- |
| PER-001 | Cold start, legal mapping | First model request | One config GET, URL rewritten on hit |
| PER-002 | Snapshot within 5 minutes | Several model requests | No repeated GET, routed by the same snapshot |
| PER-003 | Snapshot expired, concurrent requests | Concurrent model requests | Only one GET, new snapshot applied atomically |
| PER-004 | Existing snapshot, refresh fails | Model request | Old value kept, no retry within 30 seconds |
| PER-005 | Cold start, refresh fails | Model request | Original URL, direct connection |
| PER-006 | Legal empty mapping | Model request after refresh | Old forwarding cleared, direct connection |
| PER-007 | Some mapping entries illegal/duplicate | Model request after refresh | Whole rejected, old snapshot unchanged |
| PER-008 | Request carries query/stream/body | Mapping hit | Query and request/response semantics kept |
| PER-009 | WebFetch/MCP/tool/renderer | Issue a non-provider request | Routing snapshot neither read nor applied |
| PER-010 | CLI or desktop stdio Agent issues the config GET | Refresh routing snapshot | Carries the matching source, platform, language/timezone and the optional existing deviceMid |
| PER-011 | The account auth material that triggers the refresh has a real apiKeyId | Refresh routing snapshot | Config GET carries the same `x-api-key-id`; logs and snapshot do not contain the ID |
| PER-012 | Request-time material has no apiKeyId, even if a model header has Key / Authorization | Refresh routing snapshot | Config GET does not synthesize or send `x-api-key-id` |
| PER-013 | Manual `x-api-key` in Request or RequestInit | Cold-start refresh | Not passed through to the config endpoint, model auth kept |
| PER-014 | ID blank, with control characters or non-ASCII | Cold-start refresh | Config GET still runs but carries no `x-api-key-id` |
| PER-015 | Fresh snapshot exists, a later request uses a different ID | Model request | No config refresh, and the later ID is neither sent nor cached |
| PER-016 | A refresh carrying ID A fails, a request after cooldown carries ID B | Refresh again | The second GET carries only ID B; ID A does not enter the snapshot |
| PER-017 | The source header builder is wrongly injected with sensitive or undeclared headers | Cold-start refresh | Only the source allowlist is sent; `x-api-key-id` can only come from the triggering request |
| PER-018 | The first waiter carrying an ID cancels while another waiter still waits on single-flight | Cancel during refresh | Cancellation does not stop the shared GET; the config GET uses the ID from when the refresh started |

Identity header cases:

| Case | Setup / Action | Assertions |
| ---- | -------------- | ---------- |
| PER-024 | ultra mapping declares the identity field, target side has a JWT | Final request carries the fixed Bearer header |
| PER-025 | ultra-zai mapping declares a case variant of the field | Normalized to the fixed header name |
| PER-026 | Not logged in, JWT blank or read fails | Still routed, but no identity header attached |
| PER-027 | mapping declares no identity field | JWT not read, no header attached |
| PER-028 | Identity field points to another origin or another ZCode path | Whole snapshot rejected, old snapshot kept |
| PER-029 | JWT changes between two requests | The next request reads the new value, identity not cached |
| PER-030 | Request, URL, string and no init.headers | Identity header reaches the final request in all |

### Test dimensions and pruning

| Dimension | Equivalence classes | Representative cases |
| --------- | ------------------- | -------------------- |
| Snapshot state | absent / fresh / stale / failure cooldown | PER-011, PER-015, PER-003, PER-016 |
| ID source | valid requestAuth.apiKeyId / manual Key / source header injection | PER-011, PER-012, PER-017 |
| ID shape | explicit parameter / blank / control characters or non-ASCII | PER-013, PER-014 |
| Concurrency and cancel | single request / single-flight multiple waiters / single waiter cancel | PER-011, PER-003, PER-018 |
| fetch input | URL/string / Request / Request + RequestInit override | PER-012, PER-011, PER-013, PER-030 |
| Identity state | logged in / not logged in / blank / read failure / login state change | PER-024, PER-026, PER-029 |
| Identity target | ultra / ultra-zai / other origin / other path | PER-024, PER-025, PER-028 |

Personal, team accounts and manual Providers use real HTTP regression: the account config GET carries the
real ID; when an ultra/ultra-zai mapping that declares the identity field hits, the current ZCode JWT is
additionally carried if the target Environment is logged in, and the original model authentication is
kept if not. The manual config GET still carries no credential, and model requests still use the manual
Key. After cache expiry the ID is switched and the ID of the previous request must not be reused.
Desktop/TUI/workflow and the SSH/WSL/Docker Source Server share the same adapter, target-side credentials
and in-process port.

This feature does not change conversation product state and does not enter the conversation case catalog,
coverage matrix or formal-proof.

The account ID is passed explicitly into the routing port from the request-time auth material
`requestAuth.apiKeyId`; deriving it from model headers, PAT or a manual Provider Key is forbidden. A
manual Provider no longer passes credentials to the config endpoint.
