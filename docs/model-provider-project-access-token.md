# First-party Token Auth Migration

Status: token-only request entry is wired and Key ID persistence is implemented; local regressions
pass. Known limitations: CLI full lint still fails on pre-existing `max-lines` baseline errors
(including `auth-login.ts`); real backend inference, mobile E2E and mixed-version remote sync are
not verified. Decision (2026-09-23, user-confirmed): keep the dedicated Key lookup/create flow, take
the returned apiKey ID to exchange for a Token; no Copy Secret and no legacy Key fallback.

Full history: `git show d4fcb892:docs/model-provider-project-access-token.md`

## Confirmed behavior

- Personal / team / Standalone looks up a dedicated Key; creates one if absent. Personal name
  `zcode-api-key`; team name `zcode-team-api-key` with `keyType=2`; creation passes explicit
  `usageScene=1`. Queries add no `usageScene` filter.
- The returned `apiKey` is a non-Secret Key ID used as the issuance path parameter. Organization,
  project and Key ID are encoded separately; never pick a Key across projects.
- `POST /api/biz/v1/organization/{org}/projects/{project}/api_keys/{id}/access_tokens` with Bearer
  login JWT; body includes `clientType=zcode` and the real `clientVersion`.
- Every business API that previously used an API Key can use the Token; retest via the interface
  table below. Compatibility is no longer an implementation blocker.
- New clients are token-only with no legacy Key fallback. `enable=false` or no usable PAT: issuance
  failure or malformed response records a redacted log and fails. Early refresh with an unexpired
  PAT tolerates only the transient-failure rules below. Omitted `enable` defaults to enabled, but
  Token and validity are still strictly validated.
- Project Access Tokens are platform-issued and still pass the official request security checks —
  Token use never skips them; manual user Keys keep their existing security-check behavior.
- CLI manual Keys with an explicit manual source marker keep independent semantics. Legacy records
  with no source marker and no OAuth cannot be classified — require re-login or manual Key
  re-selection; never guess the source and fall back. Third-party provider Keys keep their
  contract; Start Plan, official MCP and reset keep the existing JWT identity channel.
- OAuth-derived long-term Secrets are no longer read or stored; login state shared with old clients
  is not deleted; manual Keys are not cleaned up. Old clients' use of the original server APIs is
  not rewritten by new clients.

## Dedicated Key management compatibility contract

- Personal reuses `zcode-api-key` by name; a same-name entry without an ID fails — never duplicate
  creation. Team reuses only entries named `zcode-team-api-key` with `keyType=2` and non-empty ID;
  the creation response must satisfy all three conditions or the exchange stops. Unrelated broken
  entries do not affect valid ones.
- Management authorization (updated 2026-10-13 for upstream 3.15.2 parity): `getCustomerInfo`
  carries the raw login JWT for both families; personal `api_keys` list/create use Bearer for Z.AI
  and the raw login JWT for BigModel; team list/create use the raw login JWT for both families and
  keep the org/project headers. Only `access_tokens` uniformly uses Bearer. The CLI business-JWT
  401 recovery recognizes the rejected token in both raw and Bearer-prefixed forms.
- Desktop personal flow skips team projects (`projectType` trimmed != 2) and candidates without an
  organization ID; Standalone keeps default-org/default-project-first-else-first-item with no new
  project-type filter. Team member matching keeps trimming IDs on both ends.
- The project selection strategy is passed explicitly by the caller into the shared exchange client
  and participates in the in-memory and persisted ID scope, so desktop and CLI sharing records
  never overwrite each other's choice. Existing Token owner, refresh and logout invalidation
  ordering are unchanged.
- Acceptance covers: error team creation response, unrelated broken entries, personal same-name bad
  ID, both families' management/issuance headers, mixed project selection, and cross-strategy ID
  isolation.

## Legacy credential dependency and upgrade constraints

OAuth account restore, availability and request auth must never read, decrypt or depend on legacy
`account-provider:\*:api-key`. With valid login state and a missing or corrupt legacy Key, the
account still exchanges for a Token under its original identity. Standalone legacy records without
a source marker but with OAuth auto-use OAuth; only an explicit `manual` marker reads the manual
Key, and manual mode does not depend on a separately stored OAuth being decryptable. Historical
ambiguous records without login state still require re-selecting a login method.

Remote provisioning syncs only the OAuth allowlist; the remote issues via its own Token owner —
never exports legacy account Keys or short-term Tokens, never copies Key ID caches across
environments. Legacy `schemaVersion=1` `account-provider` entries are only format-validated then
ignored; existing legacy/manual Keys are not read, overwritten or deleted. Explicit manual
provider Keys in Personal Config keep their configured sync channel.

Team Key ID readiness checks and per-request non-empty credential checks stay; the `apiKey`
transport field stays for compatibility with the OAuth value being the Token. Removed: the uncalled
UI Key fingerprint refresh function and invalid Credential Store injections, to avoid reintroducing
a "Key must be on disk to be usable" condition. Login token invalid, no permission and team ID
creation failure stay explicit errors — no legacy Key fallback.

Desktop additional remote-workspace usage auth reuses the existing Local Host owner in
`sourceServices`; when the legacy attach entry has no owner, it uses the same exchange factory
inside the original local service boundary — no read-only legacy Key, no parsing callback that is
always empty. Personal and team share one Token client and ID store; login changes clear the cache;
mobile replayable routing is unchanged.

Acceptance: recover with legacy Key missing/corrupt but OAuth valid; manual Key unaffected by bad
OAuth; bad legacy keys local or remote do not block sync and original records stay untouched; legacy
envelopes are received but their Keys not applied; OAuth delete, rollback, idempotency and existing
mobile/desktop owner and flow boundaries hold.

Retained checks: non-empty validation of manually configured `api-key`; team `apiKeyStatus` ID
readiness; per-request `auth.apiKey` non-empty (OAuth value is the Token). None checks for a legacy
account-provider Secret. UI save-time Key change comparison applies to manual access only; OAuth
returns empty and refreshes via account/entitlement events.

Upgrade compatibility: this Host version does not modify legacy Key records; legacy Source → new
Target schema v1 envelope has regression coverage. New Source emits v2; old Target's v1 validation
rejects before any write, so sync errors but never deletes existing credentials — upgrade the
Target to continue syncing. Normal remote assets use the client-version CDN path.

## State and boundaries

```text
login state / stable account identity → existing account auth owner → valid Token → single HTTP attempt
                                        │                    ↑
                                        └─ memory cache / concurrent merge ┘
logout / account switch → clear cache and invalidate generation → reject late results
```

Host keeps `IAccountRequestAuthService`; Standalone keeps the request adapter. Key IDs persist as
`organizationId/projectId/apiKeyId` only, scoped by environment, family, stable account and
personal/team project; short-term Tokens and login JWTs never enter the record. Restart reuses the
ID to exchange directly; an explicit 404 from issuance clears the metadata and the next run looks
up/creates again; other auth errors only fail — never fall back to legacy Keys. Tokens are never
written to Provider Config, Registry, Session, UI snapshots, logs or `credentials.json`.

Refresh happens per the issuance response validity with 120 s lead plus 0–60 s jitter; established
SSE is kept, new HTTP attempts re-check validity. Early refresh reuses the current unexpired,
not-model-rejected PAT only on explicit network/timeout or HTTP 429/5xx transient faults, at most
until the original `expiresAt`, with refresh re-attempts at most every 5 s and a fixed redacted
event `project_token_refresh_deferred`. Cache and pending stay under one owner; concurrent requests
share refresh and degradation results. 401/403/404, `enable=false`, cancellation, unknown errors
and malformed responses fail immediately and clear the cache; late failures during logout/account
switch never return an old PAT. On explicit fingerprint rejection, remove the old value first; a
failed refresh never reuses it. This tolerance never reads long-term API Keys, never extends
validity, never replays model requests.

```text
same PAT owner: early refresh → success replaces cache
              → transient fault + original PAT valid and not rejected → share old value, 5 s backoff
              → auth rejection / expired / logout / invalid response → clear and fail
```

Issuance and management responses share the success-code contract: numeric or string 0/200; Token
type, non-empty value and validity remain strictly validated. Mock compatibility tests are not
completed backend integration.

Account identity must not hash the short-term Token. Desktop continuous, mobile replayable and
`workspaceIdentity` isolation are unchanged.

## Long tasks and business login credential refresh

Idle-time models must exchange the current PAT from the Host over the existing Provider Runtime
Headers private channel on every physical HTTP attempt. Dispatch freezes only the ticket and the
account scope constraint — a dispatch-time PAT is not the credential for the whole round.
`requestAuth.accountScope` is a Host-generated irreversible scope check value (login lifecycle,
family, personal/team, org/project/product): not an account identity, contains no short-term PAT,
never persisted or logged. Later requests carry `expectedAccountScope`; scope change on
account/plan change or mid-exchange fails immediately — the original ticket is never reused on a
new account. Mocks have no real PAT; static injection stays.

```text
dispatch → Host account owner generates scope check value + original ticket
each model attempt → private runtime headers channel (carrying expected scope)
                   → same Host owner validates scope → PAT TTL check/exchange → re-validate scope
                   → CLI only updates the Coding Plan Token, keeping the ticket and the round's JWT
logout/switch account/switch plan → scope mismatch → current round fails, no legacy credential fallback
desktop continuous / mobile replayable → original task owner, workspaceIdentity and event order
```

Desktop Z.AI deep link and polling both call `/api/auth/z/login` at the `ZaiProviderAdapter` login
boundary; `oauth:zai:access_token` is already the business JWT — personal/team PAT owners use it
directly, no second exchange. Standalone stores the raw OAuth token, so its exchange location
differs. Regression covers polling → business JWT persisted → personal/team metadata → PAT issuance
order.

Standalone Z.ai `/api/auth/z/login` results are cached for the earliest of `expires_in` /
`expiresIn` and JWT `exp`, refreshed 120 s early; without validity metadata, cache at most 5
minutes. Concurrent refreshes merge; clear/login changes reject late results. On business HTTP 401,
re-exchange the business JWT and retry the exchange once only — 403/network errors never trigger
this recovery; a second 401 clears the failed business JWT, later calls may retry. This recovery
covers metadata/issuance requests only, never replays model inference.

Business JWT early refresh reuses the HTTP adapter transient-fault classification (network,
timeout, 429, 5xx). Only when the known original validity is unexpired, the JWT not rejected and
the login generation unchanged do all concurrent calls share the old value with 5 s backoff — no
validity extension, fixed event `project_token_business_login_refresh_deferred`. The 5-minute cache
cap without validity metadata is not a real validity, so no transient-fault degradation there.
Auth rejection, cancellation, unknown errors, malformed responses, logout and account switch never
degrade.

```text
CLI ZaiBusinessTokenCache (single owner)
  → early exchange → success: replace business JWT
                  → transient fault + known unexpired + not rejected + same login: share value, 5 s backoff
                  → other failure: clear value and error
  → clear / login switch: reject in-flight results; invalidate: forbid reuse of a rejected JWT
```

Standalone PAT, Key ID lookup and Z.AI business-JWT single-flight requests are owned by a
resolver/cache owner that never inherits any single model request's `AbortSignal` (including the
abortSignal inside the execution context). Shared HTTP keeps only trace/logger context with a 15 s
per-request timeout; each caller waits independently outside `resolve` / `resolveMaterial`,
cancellation terminates only its own wait and removes its listener, never clears the shared cache
or affects other waiters. Cancelled calls never start an exchange; once all waiters cancel, an
in-flight exchange still honors timeout and login generation, and late failures are consumed.
logout/clear still invalidates in-flight results; established model streams are never replayed.

```text
session A ─ independent wait (cancel ends only A) ─┐
                                                   ├─ resolver/cache owner → single-flight exchange HTTP (15 s timeout)
session B ─ independent wait ──────────────────────┘                     → cache result → B
```

A plain model HTTP 401 allows one PAT recovery: only for personal/team plan idle-time OAuth PAT
requests; manual Keys, Start Plan and accelerator cards do not participate. The model call holds a
one-shot recovery budget, reusing the existing `auth_refresh` retry state and physical request
loop; a failed re-issue or a second 401 fails immediately — never fall back to a Key. 401 is a
recovery trigger, not a confirmed Token-expiry cause. `VERIFY_APIKEY_EXPIRED` /
`VERIFY_SIGNATURE_INVALID` belong to the official request security check's own error recovery and
keep their independent handling.

```text
model HTTP 401 (no output committed) → private request carries original account scope + SHA-256 fingerprint of failed PAT
→ auth owner validates scope → invalidate only fingerprint-matching PATs → merge concurrent issuance
→ retry once with new PAT → success / terminate with error
```

All OAuth model requests return the account scope constraint; it is validated before and after
retry exchange — account/project switches never cross-use. A late old 401 cannot clear an updated
PAT; fingerprints are never persisted, never sent upstream, never logged with credential material.
After SSE has emitted text, thinking or tool calls, no replay; compact keeps the original
response-body boundary. Cancellation never triggers recovery. Desktop continuous and mobile
replayable state owners, session routing and replay rules are unchanged; SSH still exchanges over
the original private Runtime Headers channel.

Acceptance: within one idle round across TTL, new requests use the new PAT with an unchanged
ticket; account/project switch and mid-exchange scope change fail; without an owner, an expired
snapshot cannot be reused; Z.ai business JWT cross-TTL and concurrent refresh, single 401 recovery,
403/network no-retry and logout races are covered; established SSE is not replayed. Model PAT
recovery: a new PAT is actually used after the first 401; budget-1 requests still get one
recovery; second 401 / failed exchange terminates; a first SSE error chunk is recoverable while
text/tool output is not replayable; concurrent and late 401s neither double-issue nor clear the new
PAT; cancellation, manual Key, Start Plan and security-check errors never trigger PAT recovery; SSH
private protocol and sub-session routing keep scope and failure fingerprint.

## Subscription query and usage

Enterprise plan pricing/customerInfo keeps org-project and dedicated-Key metadata warm-up; no Copy
Secret. Usage types: 1=plan, 2=pay-as-you-go, 3=legacy mapping, -1=cache sentinel; creation allows
only 1/2. All existing auto-creation is plan type (1). No pay-as-you-go auto-creation entry exists
— do not invent one.

## Interface test table (2026-09-23)

Local automation vs. real backend integration are distinct; a mock pass is not verified online
compatibility. `…` is the confirmed `/api/biz/v1/organization/{org}` management path prefix.

| ID  | Method / path                          | Retest focus                                                            | Credential after change                        | Result                                                   |
| --- | -------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------- |
| K01 | GET /api/biz/customer/getCustomerInfo  | first personal/team org/project lookup; skip when persisted IDs exist    | login JWT                                      | public/service/CLI unit tests; desktop E2E pass          |
| K02 | GET …/projects/{project}/api_keys      | reuse dedicated-name IDs only; no usageScene filter                     | Login JWT (personal Z.AI: Bearer)              | both families, personal/team, present/absent combos pass |
| K03 | POST …/projects/{project}/api_keys     | create when missing; usageScene=1; team also keyType=2                  | Login JWT (personal Z.AI: Bearer)              | unit + BigModel/Z.AI desktop E2E pass                    |
| T01 | POST …/api_keys/{apiKeyId}/access_tokens | returns short-term Token; enabled by default; explicit disable/error fails | Bearer login JWT                            | unit + both families desktop E2E pass                    |
| T02 | local ID record / Token cache          | IDs survive restart; isolated by account/env/project; Token not on disk; 404 clears ID, 403 does not create | ID persistence only             | restart reuse/isolation/invalidation suites pass         |
| T03 | GET …/api_keys/copy/{id}               | first-party OAuth path no longer called                                 | no request                                     | static reference cleanup + unit/E2E Copy=0               |
| M01 | POST <provider-base>/v1/messages       | each new attempt gets Token via request-time auth; SSE/continuation protocol unchanged | Project Token                        | auth service/security-check transport unit tests pass; real inference not run |
| M02 | POST <provider-base>/chat/completions  | same request-time Token when the protocol is configured                 | Project Token                                  | shared credential entry; no separate protocol E2E        |
| S01 | GET /api/v1/agent/configs; POST /api/paas/c1f3a7e2/v2/client | Project Token obeys official request security-check admission; manual Keys unchanged | Project Token enters existing security check | corrected 2026-10-09 (no Token exemption); see topic doc |
| U01 | GET /api/monitor/usage/quota/limit     | personal/team use Token; team keeps type=2 and org/project headers      | Project Token                                  | usage/quota service regression pass; real backend not run |
| U02 | GET /api/monitor/usage/model-usage     | time range and team type=2 kept                                         | Project Token                                  | usage service regression pass; real backend not run      |
| U03 | GET /api/monitor/usage/tool-usage      | time range, team isolation, empty-data behavior kept                    | Project Token                                  | usage service regression pass; real backend not run      |
| U04 | GET /api/monitor/credit-usage/activity | personal type=1, team type=3 kept                                       | Project Token                                  | usage service regression pass; real backend not run      |
| U05 | GET /api/monitor/credit-usage/usage-detail | usageType=MODEL/MCP, time range, team type=3 kept                   | Project Token                                  | usage service regression pass; real backend not run      |
| U06 | GET /api/monitor/usage/model-performance-day | performance stats and date params kept                            | Project Token                                  | usage service regression pass; real backend not run      |
| O01 | GET /api/v1/off-peak/ticket/availability | idle availability uses current plan identity                          | existing JWT + X-Coding-Plan-Api-Key: Token    | idle client/integration regression pass                 |
| O02 | POST /api/v1/off-peak/ticket           | ticket claim keeps account/project ownership                            | existing JWT + Project Token                   | idle regression pass; real backend not run              |
| O03 | POST /api/v1/off-peak/ticket/status    | status polling re-parses current credentials                            | existing JWT + Project Token                   | idle regression pass; cross-TTL real queue not run       |
| O04 | POST /api/v1/off-peak/ticket/{id}/settle | settle and idempotency contract kept                                  | existing JWT + Project Token                   | idle regression pass; real backend not run              |
| O05 | POST /api/v1/off-peak/anthropic/v1/messages | keeps ticket headers and business Token                             | Project Token + existing ticket context        | shared request entry; real inference not run             |
| A01 | accelerator / Start Plan / official MCP / reset | keep existing login JWT channel; plan-credential consumers auto-switch to Token | resolved per existing channel        | accelerator/reset/auth service regression pass; E2E not run |
| C01 | Standalone OAuth login/model request/logout | source=oauth reads no legacy Key; stable identity; logout rejects late Tokens; manual independent | login JWT → Project Token       | CLI adapters 19 + bootstrap 24 tests pass                |
| R01 | desktop/mobile/remote workspace request-time auth | same Host owner and original continuous/replayable boundary       | private request auth channel                   | desktop create/exchange pass; mobile E2E not run this round |

The final interface table must record method/path, credential before/after, test data, expected,
actual, evidence and unverified reasons. Not claimed: real online Token issuance, model calls or
mobile end-to-end integration.

Legacy Key dependency scenarios (acceptance):

| Scenario | Expectation |
| --- | --- |
| OAuth valid, legacy Key missing or undecryptable | CLI snapshot/request succeeds; desktop Z.AI cold start recovers and exchanges without re-login; legacy record unchanged |
| Explicit manual Key, corrupt OAuth present | reads only the manual Key, independent auth |
| Remote sync, corrupt legacy Key local or remote | sync OAuth only; legacy envelope Key ignored; original record not overwritten or deleted |
| Remote attach personal/team usage | reuse original owner when present; real exchange flow without one; quota header is a test Token, Copy=0 |
| UI availability and Token failure | keep entitlement/ID/request-time credential checks; no legacy-Key-existence gate, no failure fallback |

## agent/configs account identity

`GET /api/v1/agent/configs` sends no `x-api-key` and no login/PAT Authorization. Account plans send
the real `apiKeyId` from the same exchange via `x-api-key-id`; never rename a PAT into the ID
header, never parse an ID out of a PAT/manual Key. Manual providers send no Key or Key ID and can
still read public configs.

```text
local Host / SSH Server / standalone CLI auth owner
  └─ platform exchange returns { token, apiKeyId }
       └─ request-time requestAuth (strict protocol validation)
            ├─ token → model auth
            └─ apiKeyId → agent/configs: x-api-key-id
manual provider → agent/configs: no credential header
```

The ID travels only with request-time auth material — never into static model config or model
request headers; retries keep the current owner's identity checks. The routing cache stays a
process-level shared map: 5-minute success / 30-second failure cooldown; cache hits do not
re-request configs. Upstream removed the security-check toggle request: manual providers use the
default security-check logic directly; only routing config reads agent/configs and never sends
manual Keys. Desktop and SSH share the Host/Server auth service; mobile reuses the existing host;
continuous/replayable message semantics are unchanged.

Acceptance: personal/team and BigModel/Z.AI pair the returned ID with the PAT; standalone CLI OAuth
returns an ID, manual login none; the protocol round-trip keeps the ID; config requests carry only
the real ID while model requests carry the PAT with no ID header; manual provider routing-config
requests leak no Key and security-check logic no longer requests the config toggle; new requests
after exchange/account switch use the matching ID. Needs a paired Host/Server and Agent that
include the apiKeyId private protocol; real platform and SSH environments are not yet integrated.
