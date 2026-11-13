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

1. Accounts come from `oauth:chatgpt:accounts` (JSON array of `{accountKey, sub?, email?, name?, addedAt?}`),
   entries whose `accountKey` is 16 lowercase hex (`isChatGptPlanAccountKey`), first occurrence wins.
2. An account is listed only if `oauth:chatgpt:<K>:access_token` or `…:refresh_token` is present (Node
   `listSiwcPlanAccounts`). It is entitled iff `oauth:chatgpt:<K>:scopes` (space separated) contains
   `chatgpt.tokens.use.direct`; an identity-only account is listed but not executable.
3. The builtin rule `account:chatgpt-plan` is replaced by one rule per account, id `account:chatgpt-plan:<K>`,
   `providerName` = `email ?? name ?? accountKey`, same `config` plus `access.entitled`. Every
   `builtinProviderModelRules` entry for the base id is cloned per account (so `enabled` / `contextWindow` survive).
   The base id is never published; with zero accounts the family is absent.
4. A change of the account set, a label, or an entitlement changes the registry signature (one new revision). The
   revision is a counter: no account key or email appears in it or in logs.
5. Unreadable credentials (cipher unavailable) keep the last published snapshot (cipher spec rule).
6. `chatgpt-account` is an account access: the provider is enabled regardless of `enabled`, executable only when
   entitled, its static `Authorization` / `x-api-key` headers are dropped, and its endpoint is renewable.

### Request auth

7. Hosted: `interaction/requestProviderRuntimeHeaders` with `providerId` and `modelSelection`, **without**
   `accountAccess` (the Host routes ChatGPT by provider id; a zhipu-shaped access could send it into the
   request-verification branch).
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
    the AI SDK role (`developer` for those models, else `system`); Rust never emits `type: "message"` system items,
    so Node's remap to `instructions` has nothing to do.
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
code); its own class applies after that one renewal. Codes are matched in `error.code` or `error.type`, in HTTP error bodies and in stream `error` /
`response.failed` events. `{"detail": "…"}` bodies keep the raw text as the message.

## Known gap (separate change)

The Desktop limit banner (`chatgpt-plan-limited`) and the sign-in error banner read
`lastError.attribution.providerErrorCode || lastError.code`. Rust publishes `lastError.code = "fault.turn.failed"`
with no attribution for every model failure (the zhipu quota banners have the same gap), because a model error
reaches the turn as `QueryStop::ApiError { message }`. Until the provider code is carried to the turn outcome, a
ChatGPT limit or sign-in failure on Rust shows the generic error banner with the Node message text. Tracked as a
follow-up; not part of this change.

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
| R11 | Body over 1 MiB                                           | wire              | gzip body + `content-encoding: gzip`; ≤ 1 MiB stays plain                           |
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
