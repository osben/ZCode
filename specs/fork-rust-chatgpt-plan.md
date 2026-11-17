# Rust agent: ChatGPT Plan (SIWC) account models

Status: spec for `feat/rust-chatgpt-plan-3b1827` (2026-11-13).
Parent: `specs/fork-rust-agent-parity.md` (this replaces its "ChatGPT Plan account access" out-of-scope bullet).
Product rules of the feature itself: `specs/chatgpt-plan-signin.md`. Credential decrypt: `specs/fork-rust-credential-cipher.md`.
Code: `packages/rust-cli/crates/{base,platform,model,protocol-zcode}`.

## Problem

With `ZCODE_FORK_AGENT_RUNTIME=rust` a signed-in ChatGPT Plan account is unusable:

- `crates/platform/src/providers/rules.rs` `provider_issues` only knows `zhipu-account`, `api-key` and
  `zhipu-coding-plan-api-key`; the builtin `account:chatgpt-plan` rule (`access.type = chatgpt-account`) gets the
  `access` issue and is never executable.
- Nothing derives the per-account entries `account:chatgpt-plan:<accountKey>` that the Desktop sessions and the
  picker bind to, so a session created on Node with a ChatGPT model fails on Rust with "model … is not available".
- `crates/protocol-zcode/src/headers.rs` always sends a zhipu-shaped `accountAccess` and drops `requestAuth.accountScope`.
- The Responses body carries `max_output_tokens` and `temperature`, which the SIWC direct route rejects.
- `subscription_sharing_usage_limit_exceeded` (429) is retried like any rate limit.

## Scope decisions

- **Hosted mode only (Desktop app-server).** The Desktop Host (`SiwcAuthService`, `packages/services/src/oauth/siwc/`)
  owns sign-in, refresh, the per-account lock `siwc-chatgpt.<K>.refresh`, refresh-token rotation and terminal
  clearing. The Rust agent never refreshes, never calls `auth.openai.com`, and never writes `oauth:chatgpt:*` keys: a
  second refresher would reuse a rotated refresh token (`refresh_token_reused`), which revokes the grant.
- **Standalone `zcode-rs` (no Host)** derives the same entries but refuses the request with the stable message
  `chatgpt_plan_host_required: ChatGPT Plan models need the ZCode app in Rust mode` (`ModelError::Authentication`).
  The Node standalone CLI's own SIWC resolver and `zcode login chatgpt` are out of scope for Rust.
- **Usage display does not exist.** Usage stages, the composer chip and pace were removed from Node on 2026-10-26
  (`chatgpt-plan-signin.md` "Usage limits": official surface only). The only usage signal is the 429 code. The Node
  CLI's passive `x-codex-*` header capture (`chatGptPlanUsageUpdated`) is ignored by the Host and is not ported.
- **Legacy flat-key migration** (`oauth:chatgpt:client_id` → per-account slot) is a write: the Host and the Node
  worker do it. Rust only reads the per-account keys.
- **Prompt-cache headers.** `chatgpt-plan-signin.md` names `session-id` / `thread-id` / `x-client-request-id`, but the
  Node agent sends none of them (only the generic `x-session-id` / `x-request-id` attribution headers). Rust matches
  Node's wire, not the spec text.

## State owners

| Fact                                      | Owner                                                       | Rust role                   |
| ----------------------------------------- | ----------------------------------------------------------- | --------------------------- |
| Account index, tokens, scopes             | Host `SiwcAuthService` → `credentials.json` (enc:v2)        | read-only (cipher via Host) |
| Access token freshness, refresh, rotation | Host `SiwcAuthService.resolveAccessToken` (+ file lock)     | asks per request            |
| Account scope                             | Host `SiwcAuthService.resolveAccountScope`                  | remembers per issued token  |
| Per-account provider entries              | each process registry (Node worker wrapper / Rust registry) | derives from the index      |
| Request shaping (SIWC compat)             | model request encoder (Node `siwc-request-compat.ts`)       | platform patch + transport  |
| Error mapping                             | errors layer (Node `failure-provider-business-codes.ts`)    | `crates/model/src/errors/`  |

## Event order (one model request, hosted)

```mermaid
sequenceDiagram
  participant Q as Rust transport (Connect)
  participant P as Rust platform (endpoint)
  participant H as HostHeaders (protocol-zcode)
  participant S as Desktop Host (zcodeAgentService)
  participant A as SiwcAuthService (+ siwc-chatgpt.<K>.refresh lock)
  participant O as api.openai.com/v1/responses
  Q->>P: endpoint(selection account:chatgpt-plan:<K>)
  P->>H: request_auth(provider id, session)
  H->>S: interaction/requestProviderRuntimeHeaders {providerId, no accountAccess}
  S->>A: resolve(forceRefresh=false)
  A-->>S: access token (refreshed under lock if near expiry), accountScope
  S-->>H: {headersApplied, requestAuth:{apiKey, accountScope}}
  H->>H: remember sha256(apiKey) → accountScope
  P-->>Q: endpoint (Bearer, SIWC patch, compress over 1 MiB, renewable)
  Q->>O: POST /responses (store:false, stream:true, forbidden fields removed)
  O-->>Q: 401
  Q->>P: endpoint(rejected = previous endpoint)
  P->>H: request_auth(rejected fingerprint)
  H->>S: {rejectedProjectTokenFingerprint, expectedAccountScope}
  S->>A: resolve(forceRefresh=true); scope must equal expected
  S-->>H: new token + same scope (else headersApplied=false)
  H->>H: scope differs → siwc_account_scope_invalidated
  Q->>O: retry once; a second 401 ends the request with the provider error
```

## Rules

### Catalog (registry)

1. Accounts come from `oauth:chatgpt:accounts` (JSON array of `{accountKey, sub, email?, name?, addedAt?}`),
   entries whose `accountKey` is 16 lowercase hex (`isChatGptPlanAccountKey`) and whose `sub` is non-empty (Node
   `parseAccountRecord`), first occurrence wins.
2. An account is listed only if `oauth:chatgpt:<K>:access_token` or `…:refresh_token` is present (Node
   `listSiwcPlanAccounts`). It is entitled iff `oauth:chatgpt:<K>:scopes` (space separated) contains
   `chatgpt.tokens.use.direct`; an identity-only account is listed but not executable.
3. The builtin rule `account:chatgpt-plan` is replaced by one rule per account, id `account:chatgpt-plan:<K>`,
   `providerName` = `email ?? name ?? accountKey`, same `config` plus `access.entitled`. Every
   `builtinProviderModelRules` entry for the base id is cloned per account (so `enabled` / `contextWindow` survive).
   The base id is never published; with zero accounts the family is absent.
4. A change of the account set, a label, or an entitlement changes the registry signature (one new revision). The
   revision is a counter: no account key or email appears in it or in logs.
5. Unreadable credentials (cipher unavailable, a value that does not decrypt) keep the last published snapshot
   (cipher spec rule). A missing or unparsable `credentials.json` is "signed out" for every account provider, as for
   the zhipu accounts (fail-closed).
6. `chatgpt-account` is an account access: the provider is enabled regardless of `enabled`, executable only when
   entitled, its static `Authorization` / `x-api-key` headers are dropped, and its endpoint is renewable.

### Request auth

7. Hosted: `interaction/requestProviderRuntimeHeaders` with `providerId` and `modelSelection`, **without**
   `accountAccess` (the Host routes ChatGPT by provider id; a zhipu-shaped access could send it into the
   request-verification branch). The platform marks the request `HeaderAccess::ChatGptPlan` from the provider's
   `access.type` (`chatgpt-account`); the header source never re-derives the kind from the provider id.
8. The answer's `requestAuth.accountScope` is remembered against `sha256(apiKey)` (bounded memo, like
   `auth.rs` `issued`).
9. After a 401 the next call sends `rejectedProjectTokenFingerprint` and `expectedAccountScope` (the remembered scope
   of the rejected token). Without a remembered scope the request is not retried (Node `canRecoverProjectToken`
   needs a scope): `siwc_account_scope_invalidated`. A returned scope different from the expected one fails with
   `siwc_account_scope_invalidated`.
10. A renewable endpoint is renewed at most once per request (Node `AccountRequestRetry` `#used`): a second auth
    rejection ends the request with the provider's error. This applies to every account model.
11. Standalone: refused (see Scope decisions).

### Request shaping (after the option-map patches)

12. Removed: `background`, `conversation`, `max_output_tokens`, `max_completion_tokens`, `max_tool_calls`,
    `metadata`, `moderation`, `multi_agent`, `prompt`, `prompt_cache_retention`, `safety_identifier`, `temperature`,
    `top_logprobs`, `top_p`, `truncation`, `user`, `previous_response_id`. Forced: `store: false`, `stream: true`.
13. `include: ["reasoning.encrypted_content"]` only for models the AI SDK 3.0.65 treats as reasoning models
    (`o1`, `o3`, `o4-mini`, `gpt-5*` except `gpt-5-chat`); otherwise `include` is removed. The system prompt keeps
    the AI SDK role (`developer` for those models, else `system`), as on Node's wire: AI SDK 3.0.65 encodes the
    system prompt as `{"role": "system", "content": …}` without `type: "message"`, so Node's
    `remapSystemInputItems` (which matches `type === "message"`) never folds it into `instructions` (checked
    2026-11-13 by running `siwc-wire.test.ts` with a `system` prompt; that test's `instructions` assertion passes
    on `String(undefined)`). Both runtimes use one predicate for these models
    (`rust_cli_base::models::openai_reasoning_model`).
14. Bodies over 1048576 bytes are gzip-compressed with `content-encoding: gzip` (Node prefers zstd when
    `node:zlib` has it and falls back to gzip; Rust uses gzip, the spec's allowed fallback). Only for ChatGPT plan
    endpoints. The model-io trace records the uncompressed body.

### Errors (`crates/model/src/errors/siwc.rs`, OpenAI protocols)

| Code                                                                              | Class (Rust)   | Retry                | Message (Node text)                                             |
| --------------------------------------------------------------------------------- | -------------- | -------------------- | --------------------------------------------------------------- |
| `subscription_sharing_user_not_eligible`                                          | InvalidRequest | no                   | "Your ChatGPT plan is not available for this app or workspace…" |
| `subscription_sharing_usage_limit_exceeded`                                       | QuotaExhausted | no                   | "ChatGPT plan usage limit reached. Manage your usage at …"      |
| `subscription_sharing_unsupported_capability`                                     | InvalidRequest | no                   | "The ChatGPT plan direct route rejected a request field…"       |
| `subscription_sharing_route_not_supported`                                        | InvalidRequest | no                   | "The ChatGPT plan direct route does not support…"               |
| `subscription_sharing_invalid_user`                                               | AuthRejected   | renew once (rule 10) | "The ChatGPT plan no longer accepts this account…"              |
| `chatpass_v2_scope_not_authorized`, `chatpass_v2_invalid_authorization_context`   | AccessDenied   | no                   | "The ChatGPT plan grant does not include the required scope…"   |
| `subscription_sharing_usage_unavailable`, `subscription_sharing_user_unavailable` | ServerError    | yes (backoff)        | "The ChatGPT plan service is temporarily unavailable…"          |

Any of these codes at HTTP 401 is `AuthRejected` first (Node `AccountRequestRetry` renews on the status, not the
code); the error is always the code's own, so after that one renewal the request ends with it (a usage limit at
401 still ends as `QuotaExhausted` with its text). The scope codes are a sign-in error (Node
`ProviderNotConfigured`) with or without an HTTP status, so a stream error gets the same error as a 403. Codes are matched in `error.code` or `error.type`, in HTTP error bodies and in stream `error` /
`response.failed` events. `{"detail": "…"}` bodies keep the raw text as the message.

## Provider attribution on the limit and sign-in banners (implemented)

The Desktop limit banner (`chatgpt-plan-limited`, `useV4SessionQuotaBanner.ts`) and the sign-in error banner read
`lastError.attribution.providerErrorCode`, falling back to `lastError.code`. The zhipu quota banners read the same
field. Node's `lastError.code` is the provider code when the error has one (`error-payload.ts` `selectErrorCode`),
and its attribution is `projectErrorAttribution` over the error context.

Rule (Rust):

- The provider code is carried typed on the error: `ModelError::Provider { provider: ProviderFailure, error }`
  (`crates/kernel-api/src/model.rs`), where `ProviderFailure` is `{ code, status, retryable }`. The classifiers wrap a
  failure only when the body carried a code: the plan table (`siwc.rs`) and the zhipu table and unknown codes
  (`zhipu.rs`). `error` is the unchanged classification. Consumers that match on the class call `peel()` first.
- The query loop carries it as `Outcome::Failed { provider }` and `QueryStop::ApiError { provider }`. The session
  maps it to `TurnOutcome::Failed { code, provider }`, with `code` = the provider code (Node parity).
- The projection sets `lastError.attribution` in Node's shape (`projection/provider_error.rs`):
  `{source: "provider", exceptionKind: "provider_business", providerErrorCode, retryable, statusCode?}`.
  `statusCode` is present only for a response with an HTTP status (Node omits it for a stream error).

Node golden (generated 2026-11-16 by running Node's own functions with `tsx`: `classifyModelFailure`
(`apps/zcode-cli/packages/adapters/src/model/failure-classifier.ts`) over a `ProviderBusinessError`, `toAdapterError`
(`runner-retry.ts`) for the error context, and `projectExecutionErrorPayload` (`core/src/errors/error-payload.ts`) for
the attribution). The request is the chat model path, which streams, so `transport` is `sse`.

| Case                                             | Node `attribution` (full payload)                                                                                                                                                                                                                                                                         | Node `code`                               |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| ChatGPT usage limit, HTTP 429, before the stream | `source` provider, `reason` rate_limited, `errorPhase` prepare, `exceptionKind` provider_business, `providerId` account:chatgpt-plan:K, `modelId` gpt-6.1-sol, `providerKind` openai, `transport` sse, `statusCode` 429, `providerErrorCode` subscription_sharing_usage_limit_exceeded, `retryable` false | subscription_sharing_usage_limit_exceeded |
| zhipu 1113, HTTP 429, before the stream          | `reason` unknown, `errorPhase` prepare, `providerKind` anthropic, `statusCode` 429, `providerErrorCode` 1113, `retryable` false (plus the same source/phase/transport/ids)                                                                                                                                | 1113                                      |
| zhipu 1302, error event in the stream            | `reason` rate_limited, `errorPhase` stream, `providerKind` anthropic, `providerErrorCode` 1302, `retryable` true, no `statusCode`                                                                                                                                                                         | 1302                                      |
| zhipu 1113, error event in the stream            | `reason` unknown, `errorPhase` stream, `providerErrorCode` 1113, `retryable` false, no `statusCode`                                                                                                                                                                                                       | 1113                                      |

The per-code `reason` and `retryable` of every zhipu and plan code is the fixture
`crates/model/tests/fixtures/node-provider-codes.json`, checked by `errors/provider_table_tests.rs`. Five zhipu codes
(1210, 1211, 1213, 1214, 1301) are not in Node's mapping: Node classifies them by HTTP status. A 429 is `rate_limited`
and retries; without a status they are `unknown` and do not retry. Other statuses for those five codes are not in the
fixture and are reported as `unknown`, not verified.

Fields and sources (Rust): `reason`, `retryable`, `providerErrorCode` from the classifier's table; `errorPhase` is
`prepare` for a response with a status and `stream` for an error event; `transport` is `sse`; `providerKind` follows
the wire protocol (`anthropic`, `openai`, `openai-compatible`); `providerId` and `modelId` are the request's selection,
added in the query loop (`ModelError::with_model`).

Acceptance:

| #   | Given                                                        | When       | Then                                                                                      |
| --- | ------------------------------------------------------------ | ---------- | ----------------------------------------------------------------------------------------- |
| P1  | HTTP 429 plan usage limit                                    | classify   | `ModelError::Provider` with code, status 429, retryable false; `peel()` is QuotaExhausted |
| P2  | HTTP 503 plan usage unavailable                              | classify   | provider code, status 503, retryable true                                                 |
| P3  | Stream error with a plan code (no status)                    | classify   | provider code, status None                                                                |
| P4  | zhipu 1302 / 1113 response and stream                        | classify   | provider code (string), status per response, retryable per class                          |
| P5  | Failed turn with a provider failure, full Node payload       | projection | `lastError.code` = provider code; attribution equals the Node golden row above            |
| P6  | Failed turn on zhipu 1308 at HTTP 429, the integration suite | run a turn | `TurnOutcome::Failed { code: "1308", provider }` with reason, phase, transport, kind, ids |
| P7  | Every zhipu and plan code, at 429 and without a status       | classify   | `reason` and `retryable` equal the Node fixture row                                       |
| P8  | A 429 for codes 1210, 1211, 1213, 1214, 1301                 | classify   | `rate_limited`, retryable; without a status `unknown`, not retryable                      |

Not verified here: the banner E2E (none exists in the repo) and a live ChatGPT account.

## Acceptance

| #   | Given                                                     | When              | Then                                                                                |
| --- | --------------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------- |
| R1  | Index with an entitled account K (tokens + direct scope)  | catalog           | `account:chatgpt-plan:<K>` models listed, executable, label = email; base id absent |
| R2  | Account K has scopes without `chatgpt.tokens.use.direct`  | catalog           | listed, not executable                                                              |
| R3  | Account K in the index without tokens                     | catalog           | not listed                                                                          |
| R4  | Model rules for the base id (`gpt-6.1-sol` window 500000) | catalog           | the per-account model has window 500000                                             |
| R5  | Account added to `credentials.json` while running         | next catalog read | new revision lists it                                                               |
| R6  | Hosted request on K                                       | first auth        | reverse request has `providerId`, no `accountAccess`, no fingerprint                |
| R7  | 401 on K                                                  | renewal           | fingerprint of the rejected token + its remembered scope; retried once              |
| R8  | Host returns another scope after a 401                    | renewal           | `siwc_account_scope_invalidated`, no second request                                 |
| R9  | Second 401 after the renewal                              | transport         | request fails with the provider message, no third attempt                           |
| R10 | Request with option-map `max_output_tokens`, temperature  | wire              | body has neither; `store:false`, `stream:true`; `include` per rule 13               |
| R11 | Body over 1 MiB                                           | wire              | gzip body + `content-encoding: gzip`; exactly 1 MiB stays plain                     |
| R12 | 429 `subscription_sharing_usage_limit_exceeded`           | transport         | one request, `QuotaExhausted` with the Node text                                    |
| R13 | 503 `subscription_sharing_usage_unavailable`              | transport         | retried with backoff                                                                |
| R14 | Standalone (no Host) request on K                         | endpoint          | `chatgpt_plan_host_required` authentication error                                   |

Live (needs the user's ChatGPT account, not runnable in CI or the E2E box): a real turn on `gpt-6.1-sol`, the 401
force-refresh path, the 429 limit, an identity-only account shown disabled.

## Verification

`cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo nextest run --workspace` from
`packages/rust-cli`; `pnpm typecheck`, `pnpm lint` from the root. R1–R5 in `crates/platform` (fake credentials),
R6–R8 in `crates/protocol-zcode/src/headers_tests.rs`, R9–R13 in `crates/model/tests/suite/chatgpt.rs` (fake
server) and `crates/model/src/errors/siwc_tests.rs`, R10's patch and R14 in `crates/platform/src/lib_tests.rs`.
