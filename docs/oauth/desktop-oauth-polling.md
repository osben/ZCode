# Desktop OAuth Polling Login

## Objectives

Z.AI and BigModel Desktop login no longer rely on `zcode://oauth/callback` as the only completion
path. The app uses the short-lived OAuth flow of the ZCode backend and polls the flow status after
the user authorizes in the browser; the deep link stays as a compatibility path. The polling
interface `provider` is `zai` or `bigmodel`; both share the flow lifecycle, while the `ready`
credential fields differ by provider. After BigModel creates the flow, the app rewrites the callback
in the authorization URL to the official old redirect page `https://zcode.z.ai/app/oauth/login`
(the matching test site in test environments). That page keeps passing `authCode/state` to
`zcode://oauth/callback`, and the Host polling flow stays active at the same time.

## Timeline

```text
Desktop App                 ZCode Backend                 Browser / Z.AI
    | POST /oauth/cli.init        |                              |
    |---------------------------->|                              |
    | flow_id + authorize_url     |                              |
    |<----------------------------|                              |
    | open authorize_url --------------------------------------->|
    |                             |<---------- OAuth callback ---|
    | GET /oauth/cli/poll/:id     |                              |
    |---------------------------->|                              |
    | pending / ready / failed    |                              |
    |<----------------------------|                              |
    | persist once + refresh UI   |                              |
```

BigModel dual path:

```text
BigModel Browser
    | authCode/state
    v
ZCode Website /app/oauth/login -----> zcode://oauth/callback -----> Desktop deep link
                                                                    |
Desktop Host ---------------- GET /oauth/cli/poll/:id --------------+
```

The Desktop adds the compile-time `app_version` to the official redirect address. The website
enables the no-auto-deep-link polling bridge only for valid versions strictly greater than `3.9.1`;
`3.9.1`, lower, missing or invalid versions keep the original auto deep link, so old app versions
that cannot complete via polling do not get stuck in the login intermediate state.

When logins start in quick succession, the later request owns the flow; an earlier init response
that returns late is stale and must not overwrite the new flow:

```text
App                  init A                  init B                  Host pending
 | start A ------------>|                                              |
 | start B ---------------------------------->|                         |
 |                         |<---- A returns    |                         |
 |                         |      stale, drop  |                         |
 |                         |                   |<---- B returns          |
 |                         |                   |------------------------>| flow B
```

## Contracts and boundaries

- The app generates a 32-byte random `poll_token` per login and sends it only via
  `Authorization: Bearer`; it is never written to logs, settings or URLs.
- `flow_id`, `expires_at` and `poll_interval_sec` returned by `init` live only in Host memory.
- The app accepts only an HTTPS `authorize_url`, a future `expires_at`, and a `poll_interval_sec`
  of at least 1 second and less than the remaining flow lifetime. An abnormal server response ends
  the flow without opening any external address.
- The resident root layer queries the pending flow in the Host; with no pending flow no network
  request is made.
- Only `zai` and `bigmodel` poll; extension providers keep the original deep-link process and do not
  start empty Root polling.
- The BigModel browser callback uses the official `/app/oauth/login?redirect=zcode://oauth/callback`
  and must not display the success or failure pages of `/oauth/cli/callback/bigmodel`. Changing the
  callback address does not cancel Host polling.
- `pending` keeps polling at the server interval; `ready` writes atomically once and ends;
  `failed`, expiration, cancellation or business errors end the current flow.
- Unknown poll status, field type errors or a missing provider token fail as protocol errors, not
  JS type exceptions.
- `OAuthService` is the sole owner of login completion. Deep-link and polling results are processed
  serially in arrival order; validation, token exchange/normalization and persistence all sit in the
  same completion boundary. After the first path succeeds the later path neither validates nor
  exchanges; when the first path fails, an already-arrived other path is processed independently
  and cannot reuse the failed Promise.
- When another completion path is pending, a failure waits for its result; another success ignores
  earlier failures. A deep-link failure alone does not cancel valid polling; a terminal polling
  error ends the flow only when no candidate is left or all candidates failed.
- `channel_id`, `utm_source` and `utm_campaign` are handled separately from the login result:
  callbacks of the current flow still save the parameters; after polling succeeds first, callbacks
  of the same state inside the original 30-second dedup window still save attribution but do not
  parse authorization codes or request tokens. Error states, cancellations and callbacks replaced by
  a new flow must not be written. Existing authorize URL parameters, `app_version`, redirect and
  state-passing rules are unchanged.
- Only results that still belong to the current pending flow may be persisted; cancellations, login
  switches and old HTTP results (including 4xx) must not clear a new flow or overwrite a completed
  login.
- An old local pending flow is canceled before a new login starts; user cancellation also
  invalidates init responses that have not returned. The backend has no cancel interface, so
  cancellation only stops App queries and backend flows expire by TTL.
- Web `/remote`, shared-host attachment, session/task realtime and replayable recovery chains are
  unchanged.

## Acceptance scenarios

- While the Z.AI or BigModel deep link has not returned, polling `ready` still completes login and
  refreshes existing Coding Plans.
- When the deep link completes first, polling stops; when polling completes first, a late deep link
  is ignored.
- Nothing is persisted on user cancellation, on starting a new login, on flow `failed` or after
  flow expiration.
- When two flows start in quick succession the later flow stays valid; a late old init/poll must
  not overwrite it.
- BigModel uses the original official redirect page for deep-link compatibility while keeping the
  polling flow.

### Dual-path race regression

```text
Callback / poll response -> Host completion queue -> Validation and exchange -> Save once
                          ├─ Success -> Subsequent candidates skip (attribution still saved)
                          └─ Failure -> Next candidate independently validates and exchanges
```

- Cover both arrival orders: first success, first failure then another success, both failures.
- A later candidate cannot start parsing authorization codes or normalizing tokens before the first
  candidate completes.
- Attribution parameters received while a callback waits and after polling success are retained;
  old-flow parameters must not overwrite a new flow.
- Service-layer controlled Promises verify the micro-timing; Desktop E2E verifies, through real Host
  HTTP and preload callbacks, that the failure fallback UI succeeds with no login failure prompt.
  Mobile remote control adds no OAuth entry and does not change continuous/replayable chains.

### Callback cancellation and error ownership

- A received callback invalidated by cancellation or a new flow returns `null`; Root ignores it
  silently, without updating users, success state or error prompts.
- When both paths fail, each caller receives the original error of its own path; waiting for the
  backup path cannot overwrite the first path's diagnostics.
- The 30-second post-success dedup window is judged by callback arrival time at the service.
  Callbacks received while pending or inside the window do not lose attribution by queuing past the
  window; callbacks newly received after the window are still rejected. Cancellation and new-flow
  isolation take priority over this rule.

```text
Callback received within window -> Enqueue -> Wait over 30 seconds -> Still save attribution
Callback received after window ends         -> Reject
Cancellation / new flow -> Old callback returns null -> Root ignores
```
