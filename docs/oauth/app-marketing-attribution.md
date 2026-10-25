# App Marketing Attribution and Telemetry

## Objectives

ZCode Desktop receives official-website marketing attribution through the unified OAuth callback
and carries it as the top-level string field `marketing_params` in all business telemetry sent to
`/api/v1/event/report`.

## Callback protocol

The unified callback `zcode://oauth/callback` supports `channel_id`, `utm_source` and
`utm_campaign`. Any subset may be present; blank values are not saved. The app neither receives nor
maintains an attribution expiration time.

## Lifecycle

```text
startOAuth
  -> pending(state, phase="awaiting-attribution-or-code")
       ├─ First pure attribution callback
       │    -> Save attribution
       │    -> pending(state, phase="awaiting-code-after-attribution")
       │         ├─ Repeated pure attribution callback -> Reject, do not write again
       │         └─ Final authorization code callback -> Clear pending -> Token exchange
       ├─ Directly received final authorization code callback -> Clear pending -> Token exchange
       ├─ startOAuth again -> Clear old pending -> Create new state
       └─ 5-minute timeout -> Clear pending

Local attribution record
  -> Telemetry report reads
       ├─ Read success -> marketing_params={...}
       └─ Read failure -> Single throttled alert + marketing_params={}, continue reporting
```

- A new valid promotion callback fully overwrites the old values.
- A pure attribution callback is a transit phase before the final authorization. The same OAuth
  state accepts at most one, and it does not consume the final authorization code callback.
- A repeated pure attribution callback neither rewrites attribution nor extends the 5-minute
  lifecycle of the pending state.
- Re-initiating OAuth cancels the old state; attribution-then-authorization may continue only on
  the same unexpired state.
- Saved attribution does not expire automatically; it is replaced by a new attribution or removed
  when local credentials are cleared.
- Reading tolerates the briefly used `{ params, expiresAt }` storage shape: `expiresAt` is ignored
  and only the three marketing fields are kept.

## Telemetry contract

Every event reported through `TelemetryCore` to `/api/v1/event/report` (`app_launch`,
`app_daily_active`, renderer business events, ...) carries:

```json
{
  "marketing_params": "{\"channel_id\":\"douyin\",\"utm_source\":\"wechat\",\"utm_campaign\":\"summer_sale_2026\"}"
}
```

The field is kept when there is no attribution:

```json
{
  "marketing_params": "{}"
}
```

ARMS crash, performance, resource and network observations are not `/api/v1/event/report` business
telemetry and carry no marketing attribution.

Reading the attribution credential is extra context, not a precondition for reporting. On a read
exception the original event is still sent with `marketing_params` as an empty object, and the same
`TelemetryCore` lifecycle logs one fixed redacted alert via the service logger, without the
original Error, stack, local paths or credential backend details. This avoids flooding on
high-frequency events and widening privacy exposure.

## Acceptance scenarios

| Case ID       | Setup                                      | Action                                             | Assertions                                                    |
| ------------- | ------------------------------------------ | -------------------------------------------------- | ------------------------------------------------------------- |
| OAuth-ATTR-01 | Pending state has not received attribution | Submit pure attribution callback                   | Save once and enter `phase="awaiting-code-after-attribution"` |
| OAuth-ATTR-02 | Same state already received attribution    | Repeatedly submit pure attribution callback        | Reject and do not overwrite first attribution                 |
| OAuth-ATTR-03 | Same state already received attribution    | Submit final authorization code                    | Clear pending and complete login                              |
| OAuth-ATTR-04 | Old state already received attribution     | Call `startOAuth` again                            | Old state expires, new state continues                        |
| OAuth-ATTR-05 | Same state already received attribution    | Wait over 5 minutes then submit authorization code | Reject by state expiration                                    |
| OAuth-ATTR-06 | Attribution credential read failure        | Telemetry report                                   | Continue sending with `{}` and alert only once                |

## Storage boundaries

Attribution is stored under the key `oauth:login_attribution`, encrypted via CredentialService in
App-global credential storage. It is not isolated by provider, window or workspace; local and
remote workspace windows share the same App attribution.
