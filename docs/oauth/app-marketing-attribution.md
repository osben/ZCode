# App Marketing Attribution and Telemetry

## Objectives

ZCode Desktop receives official website marketing attribution from a unified OAuth callback, and uniformly carries the top-level string field `marketing_params` in all business telemetry sent to `/api/v1/event/report`.

## Callback Protocol

The unified callback `zcode://oauth/callback` supports:

- `channel_id`
- `utm_source`
- `utm_campaign`

All three marketing parameters are allowed to exist partially; blank values are not saved. The app does not receive or maintain marketing attribution expiration times.

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

- New valid promotion callbacks fully overwrite old values.
- Pure attribution callbacks are a transit phase before the final authorization; the same OAuth state accepts at most one; it does not consume the final authorization code callback.
- Repeated pure attribution callbacks must not write attribution again, nor extend the 5-minute lifecycle of the pending state.
- Re-initiating OAuth cancels the old state; attribution-then-final authorization is only allowed to continue on the same unexpired state.
- Saved attributions do not expire automatically, until overwritten by a new attribution or local credentials are cleared.
- Compatible with the briefly-used `{ params, expiresAt }` storage structure from early this branch; on read, ignore `expiresAt` and keep only the three marketing fields.

## Telemetry Contract

All events reported through `TelemetryCore` to `/api/v1/event/report`, including
`app_launch`, `app_daily_active`, and renderer business events, carry:

```json
{
  "marketing_params": "{\"channel_id\":\"douyin\",\"utm_source\":\"wechat\",\"utm_campaign\":\"summer_sale_2026\"}"
}
```

The field is retained even when there is no attribution:

```json
{
  "marketing_params": "{}"
}
```

ARMS crash, performance, resource, and network observations are not `/api/v1/event/report` business telemetry,
and do not carry marketing attribution.

The attribution credential read is additional context for telemetry, not a pre-condition for reporting. On read exception, send the original event anyway,
with `marketing_params` as an empty object; the same `TelemetryCore` lifecycle records a single fixed redaction alert via service logger,
without attaching the original Error, stack, local paths, or credential backend details, to avoid flooding high-frequency events and expanding the privacy exposure surface.

## Audit Fix Coverage

| Case ID       | Setup                                      | Action                                             | Assertions                                                    |
| ------------- | ------------------------------------------ | -------------------------------------------------- | ------------------------------------------------------------- |
| OAuth-ATTR-01 | Pending state has not received attribution | Submit pure attribution callback                   | Save once and enter `phase="awaiting-code-after-attribution"` |
| OAuth-ATTR-02 | Same state already received attribution    | Repeatedly submit pure attribution callback        | Reject and do not overwrite first attribution                 |
| OAuth-ATTR-03 | Same state already received attribution    | Submit final authorization code                    | Clear pending and complete login                              |
| OAuth-ATTR-04 | Old state already received attribution     | Call `startOAuth` again                            | Old state expires, new state continues                        |
| OAuth-ATTR-05 | Same state already received attribution    | Wait over 5 minutes then submit authorization code | Reject by state expiration                                    |
| OAuth-ATTR-06 | Attribution credential read failure        | Telemetry report                                   | Continue sending with `{}` and alert only once                |

## Storage Boundaries

Attribution is saved as key `oauth:login_attribution`, encrypted via CredentialService into App
global credential storage. It is not isolated by provider, window, or workspace; local and remote workspace
windows share the same App attribution.
