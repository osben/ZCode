# Desktop OAuth Polling Login

## Objectives

Z.AI and BigModel Desktop login no longer use `zcode://oauth/callback` as the sole completion path. The app uses the short-lived OAuth flow already available on the ZCode backend, polling flow status after authorization in the browser; deep links are retained as a compatibility path. The `provider` in the polling interface uses `zai` or `bigmodel`, which share the flow lifecycle, but `ready` credential fields are differentiated by provider. After BigModel creates the flow, the app changes the callback in the authorization address to the official old redirect page
`https://zcode.z.ai/app/oauth/login` (the corresponding test site for test environments); the redirect page continues to pass `authCode/state`
to `zcode://oauth/callback`; the polling flow in the Host is retained simultaneously.

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

When the Desktop constructs the official redirect address, it carries the compile-time `app_version`. The website only enables the no-auto-deep-link polling bridge for strictly greater than `3.9.1`
valid versions; `3.9.1`, lower versions, missing, or illegal versions continue to use the original auto deep link, avoiding old app versions stuck in the login intermediate state due to lacking polling completion capability.

When rapidly initiating consecutive logins, the later request owns the flow; an earlier but later-returned init response is treated as stale and must not overwrite the new flow:

```text
App                  init A                  init B                  Host pending
 | start A ------------>|                                              |
 | start B ---------------------------------->|                         |
 |                         |<---- A returns    |                         |
 |                         |      stale, drop  |                         |
 |                         |                   |<---- B returns          |
 |                         |                   |------------------------>| flow B
```

## Contracts and Boundaries

- The app generates a 32-byte random `poll_token` for each login, sending only through `Authorization: Bearer`,
  not written to logs, settings, or URLs.
- The `flow_id`, `expires_at`, and `poll_interval_sec` returned by `init` are saved only in Host memory.
- The app only accepts HTTPS `authorize_url`, future `expires_at`, and `poll_interval_sec` of at least 1 second and less than the remaining flow lifetime; abnormal server responses terminate directly without opening external addresses.
- The root resident layer queries the pending flow in the Host; no network requests are made when there is no pending flow.
- Only `zai` and `bigmodel` use polling; extended providers still follow the original deep link process, not starting Root empty polling.
- BigModel's browser callback uses the official `/app/oauth/login?redirect=zcode://oauth/callback`, and must not directly display
  the success or failure pages of `/oauth/cli/callback/bigmodel`; changing the callback address does not cancel Host polling.
- `pending` continues to query at the server interval; `ready` atomically writes once and ends; `failed`, expiration, cancellation, or
  business errors end the current flow.
- Unknown poll status, field type errors, or provider-missing tokens fail as protocol errors, not throwing JS type exceptions.
- `OAuthService` is the sole owner of login completion. Deep link and polling results are processed serially by arrival order to the service,
  with validation, token exchange/normalization, and persistence all within the same completion boundary. After the first path succeeds, the later path does not validate or exchange; when the first path fails, the already-arrived other path continues to process independently and cannot reuse the failed Promise.
- When another completion path is waiting, failures must wait for its result; another success ignores prior failures. Deep link alone failing
  does not cancel valid polling; polling's terminal errors end the flow only when no candidates are available or all candidates fail.
- The callback's `channel_id`, `utm_source`, `utm_campaign` are handled separately from the login result; callbacks from the current flow still save
  parameters; after polling succeeds first, callbacks from the same state within the original 30-second dedup window still save attribution, but do not parse authorization codes or request tokens. Error states, cancellations, or callbacks replaced by new flows must not be written. Existing authorize URL parameters,
  `app_version`, redirect, and state passing rules remain unchanged.
- Only results still belonging to the current pending flow can be persisted; cancellations, login switches, and old HTTP results (including 4xx)
  must not clear new flows or overwrite completed logins.
- Old local pending flows are canceled before new logins start; user cancellation also invalidates not-yet-returned init responses. Since the backend has no
  cancel interface, cancellation only stops App queries; backend flows expire by TTL.
- Web `/remote`, shared-host attachment, session/task realtime, and replayable recovery chains are unchanged.

## Acceptance Scenarios

- When Z.AI or BigModel deep link has not returned, polling `ready` can still complete login and refresh existing Coding Plans.
- When deep link completes first, polling stops; when polling completes first, late deep links are ignored.
- No persistence on user cancellation, starting new logins, flow `failed`, or after flow expiration.
- When rapidly starting two flows, the later-flow remains valid; late old init/poll must not overwrite it.
- BigModel uses the original official redirect page to maintain deep link compatibility, while simultaneously retaining polling flow.

### Dual-Path Race Regression

```text
Callback / poll response -> Host completion queue -> Validation and exchange -> Save once
                          ├─ Success -> Subsequent candidates skip (attribution still saved)
                          └─ Failure -> Next candidate independently validates and exchanges
```

- Both arrival orders covered: first success, first failure then another success, both failure.
- Later candidates cannot start parsing authorization codes or normalizing tokens before the first candidate completes.
- Attribution parameters during callback wait and after polling success must all be retained; old flow parameters must not overwrite new flows.
- Service-layer controlled Promises verify micro-timing; Desktop E2E verifies failure fallback UI success and no login failure prompts through real Host HTTP and preload callbacks. Mobile remote control has not added new OAuth entries or modified continuous/replayable chains.

### Callback Cancellation and Error Ownership

- When received callbacks become invalid due to cancellation or new flows, return `null`; the Root silently ignores, without updating users, success states, or error prompts.
- When both paths fail, each caller receives the original error from their own path; waiting for the backup path cannot overwrite the first path's diagnostic information.
- The 30-second dedup window after success is judged by callback arrival time to the service. Callbacks received during pending or within the window
  do not lose attribution by queuing past the window; callbacks received new after the window are still rejected. Cancellation and new-flow isolation take priority over this rule.

```text
Callback received within window -> Enqueue -> Wait over 30 seconds -> Still save attribution
Callback received after window ends         -> Reject
Cancellation / new flow -> Old callback returns null -> Root ignores
```
