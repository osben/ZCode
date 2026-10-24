# ZCode JWT Expiration Reauthentication

## Status

Defines authentication recovery semantics for Desktop and Web after `zcodejwttoken` expires. The
signature and final validity of `zcodejwttoken` remain the server's responsibility; the client only
parses the JWT `exp` to avoid restoring obviously expired local sessions.

## Problem

The old implementation restored login display state from cached `user_info`, checking only that
`zcodejwttoken` exists and not its `exp`. After expiry the UI still showed logged in while balance,
model and other business requests kept carrying the expired credential and failed.

The old `useTokenRefresh` only exposed callbacks and did not listen for 401, and Z.AI / BigModel
have no client-side refresh to renew `zcodejwttoken`, so a confirmed expiry requires re-login.

## Product semantics

Cached session recovery returns three structured states:

- `authenticated`: the cached user is complete and the client does not consider the JWT expired.
- `signed-out`: no complete cached session; no expiration prompt is shown.
- `reauthentication-required`: the JWT has a valid `exp` and has expired at the current time
  (including clock deviation).

When the JWT cannot be parsed or has no `exp`, the client cannot prove expiry and keeps handling
the cache compatibly; the server may still reject later requests. A server-side unified expiration
broadcast for 401/403 is separate follow-up work and is not spread to all providers by string
matching here.

## State and timeline

```text
Persistent OAuth session
        |
        v
Read user_info + zcodejwttoken
        |
        +-- Incomplete session ----------------------> signed-out
        |
        +-- JWT no available exp / not yet expired -> authenticated
        |
        +-- JWT exp expired
                |
                v
        Verify within mutation queue whether provider, user_info,
        zcodejwttoken, and session generation still match the read snapshot
                |
                +-- Snapshot has changed (new login/provider switch)
                |       |
                |       v
                |   Discard old cleanup and re-read current session
                |
                +-- Snapshot still consistent
                |       |
                |       v
        Atomic cleanup of active provider, OAuth token,
        zcodejwttoken, and cached user_info
                |
                v
        Best-effort cleanup of derived Coding / Start Plan providers
        (failures only log warn, must not restore old login state)
                |
                v
        reauthentication-required
                |
                v
        UI displays "Login has expired, please re-login"
                |
                v
        User clicks "Re-login" -> Welcome login page
```

## Interaction constraints

- Authentication expiry is not an active logout: no "confirm disconnect" and no running-session
  secondary confirmation.
- Authentication facts are cleaned before the dialog is shown; the dialog is never a blocking point
  for continued use of the old JWT.
- "Re-login" opens the existing Welcome login entry directly, without active-logout telemetry or an
  App relaunch.
- A provider startup gate may only close the `startup-provider-required` it opened; it must not
  override the `session-expired` written by the JWT expiry flow with `open=false`.
- At most one expiration prompt per startup recovery.
- Desktop Root uses a unified AlertDialog supporting Chinese/English and light/dark themes; the Web
  login entry clears the expiry localStorage after cleanup and returns straight to the login page
  without restoring a pseudo-login state.

## Process and platform boundaries

- The Local Host OAuth service is the authoritative owner of desktop local OAuth credentials; the
  renderer only consumes structured recovery results.
- Web login uses browser localStorage but reuses the same JWT `exp` semantics.
- Remote workspaces create no separate authentication state; expiry handling does not modify
  task/session, relay, stream, snapshot or owner states, and does not change the `desktop-continuous`
  and `web-remote-replayable` message chains.

## Verification requirements

- An expired JWT must not restore the cached user and must clear OAuth session credentials.
- A non-expired JWT keeps restoring the cached user and does not request remote userinfo at startup.
- Tokens without `exp` (historical/test tokens) stay compatible.
- `reauthentication-required` is returned even when derived-provider cleanup fails.
- When expiry recovery races with a new OAuth callback, it must not clear the new login or new
  provider-switch credentials.
- An expired JWT in Web localStorage is cleared without restoring the user.
- The UI shows one prompt for `reauthentication-required`; after confirmation it enters the login
  page.
