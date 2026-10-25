# Coding Plan Entitlement Failure State

## Background

The Z.ai / BigModel Start Plan and Coding Plan content areas of the Model Provider settings page query entitlement state through `useUsageEntitlement`. Previously, if the query promise hung on a Windows network, proxy or system certificate chain, the Plan Card stayed on `Checking` forever and the user could not tell whether it was still loading or had failed.

## Design

- The Plan Card adds no whole-card skeleton and no new visual level.
- The entitlement query must have a frontend timeout boundary; after a timeout it reuses the existing `unavailable` state and shows "获取失败 / Fetch failed".
- With an existing cache and a silent refresh timeout, the cached snapshot is kept, only exiting loading and recording the error, so network jitter does not briefly turn an available plan into an empty state.
- A first query without cache that times out clears the snapshot and enters the failure state, avoiding an endless `Checking`.
- The failure state keeps the existing connect, retry or re-login entries and does not change the Z.ai / BigModel family mode, provider id or entitlement decision rules.

## Impact

- Desktop, Web and mobile remote control share the UI hook; the timeout only affects the entitlement display state and does not change provider registry, task realtime, stream or replayable/continuous semantics.
- Windows/macOS/Linux behave uniformly: when the underlying request does not settle within the timeout, all go from `checking` to `unavailable`.

## Active re-login after a personal-plan credential failure

For the `credential-failed` state of the Z.ai / BigModel personal Coding Plan, the right-side action is "重新登录" (re-login), with the description "获取套餐失败，请重新登录后重试。" (failed to fetch the plan, please log in again and retry). This state is not interpreted as OAuth having expired, and the account is not logged out automatically. Other failures, not logged in, not purchased, and Start/Team states keep their original behavior. A failed fetch of a logged-in Start plan keeps offering "重试" (retry), reusing the Host manual refresh; a logged-out Start plan still goes through the login entry.

```text
Host Account State: credential-failed -> settings page shows the failure hint
user clicks re-login -> onLogin({ forceOAuth: true })
-> existing requestLoginEntry(current family) -> unified OAuth login
-> oauth-login-entitlement -> Host re-obtains credentials and publishes entitlement
```

Login state is still managed by the unified login flow; the UI adds no credential cache or state owner. Desktop and mobile share the component and the continuous/replayable recovery boundary is unchanged. Cancel or failure reuse the existing login flow and allow acting again.

Acceptance: both personal plans show re-login and the failure hint, and the click must pass forceOAuth (even if the same family is logged in it must not degrade to a silent refresh); the button is disabled during loading; other plans do not show this specific action. Component browser coverage includes desktop/narrow screens, Chinese/English and light/dark themes; a component fixture is not equivalent to a full Electron/mobile remote-control OAuth E2E.
