# ZCode JWT Expiration Reauthentication

## Status

- This document defines authentication recovery semantics for the Desktop and Web sides after `zcodejwttoken` expiration.
- The signature and final validity of `zcodejwttoken` are still the server's responsibility; the client only parses the JWT `exp` to avoid restoring obviously expired local sessions.

## Problem

The old implementation restored login display state using cached `user_info`, only checking whether `zcodejwttoken` exists, without checking JWT `exp`. Therefore, after JWT expiration, the UI still showed as logged in, but balance, model, and other business requests would continue to carry expired credentials and fail.

The old `useTokenRefresh` only exposed callbacks, without actually listening for 401; meanwhile, Z.AI / BigModel currently have no client-side refresh implementation available to renew `zcodejwttoken`, so confirmed expiration requires re-login.

## Product Semantics

Cached session recovery returns three structured states:

- `authenticated`: Cached user is complete, and the JWT is not determined expired by the client.
- `signed-out`: No complete cached session; do not show expiration prompts.
- `reauthentication-required`: JWT contains valid `exp`, and has expired at the current time (including clock deviation).

When the JWT cannot be parsed or lacks `exp`, the client cannot prove it has expired, and continues to process compatibly with the cache; the server may still reject it in subsequent requests. The server's unified expiration broadcast for 401/403 is a subsequent independent work, not diffused to all providers via string matching in this fix.

## State and Timeline

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

## Interaction Constraints

- Authentication expiration is not an active user logout; do not show "confirm disconnect" or running session secondary confirmation.
- Cleanup of authentication facts occurs before the dialog is displayed; the dialog cannot be a blocking point for continuing to use the old JWT.
- After the user clicks "Re-login," directly open the existing Welcome login entry, without triggering active logout telemetry or App relaunch.
- Provider startup gates can only close the `startup-provider-required` they opened; must not override the `session-expired` written by the JWT expiration flow with `open=false`.
- At most one expiration prompt is shown per startup recovery.
- The Desktop Root uses a unified AlertDialog supporting Chinese/English and light/dark themes; the Web login entry clears expiration localStorage after cleanup and returns directly to the login page, without restoring pseudo-login state.

## Process and Multi-Platform Boundaries

- The Local Host OAuth service is the authoritative owner of desktop local OAuth credentials; the renderer only consumes structured recovery results.
- Web login uses browser localStorage, but reuses the same JWT `exp` judgment semantics.
- Remote workspaces do not create independent authentication states; expiration handling does not modify task/session, relay, stream, snapshot, or owner states.
- This change does not alter `desktop-continuous` and `web-remote-replayable` message chains.

## Verification Requirements

- Expired JWTs must not restore cached users, and must clear OAuth session credentials.
- Non-expired JWTs continue to restore cached users, and do not request remote userinfo at startup.
- Tokens without `exp` (historical/test tokens) remain compatible.
- Return `reauthentication-required` even when derived provider cleanup fails.
- When expiration recovery races with new OAuth callbacks, must not clear new logins or new provider switch credentials.
- Expired JWTs in Web localStorage are cleared without restoring users.
- The UI shows one prompt for `reauthentication-required`; after confirmation, enters the login page.
