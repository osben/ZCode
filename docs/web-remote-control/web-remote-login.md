# Web Remote Login V2

`/remote/v4` (with trailing slash) is the only official OAuth/QR entry of phone remote control. The phone uses
Relay V2 only; `/web-remote`, its callback and waiting page, and the remoteControlToken/relayOrigin bootstrap
are removed. The ordinary Web + Server `/ws` and `/ws/remote/:id` are unchanged.

Full history: `git show b8876e8b:docs/web-remote-control/web-remote-login.md`

## Entry and authentication

- `code` / `authCode` + `state` (or OAuth `error` + `state`) render the existing `WebCallbackPage` first;
  `WebAuthService` validates the nonce, exchanges the token, writes same-origin localStorage, then replaces to
  a safe app_return_to.
- The OAuth callback address is based on `/remote/v4` of the build endpoint origin, keeping the
  `app_version/sid/mid/name` parameters (including empty values and an encoded device name) of the
  same-origin remote control URL before login. It copies no unknown parameters, old credentials, historical
  code/authCode/state/error or fragment; share login keeps its own callback address. Z.AI uses
  `redirect_uri`, BigModel uses `redirect`, and the authorization origin follows the build environment.
- When starting authorization `WebAuthService` saves this login record (nonce, provider, full callback
  address) in same-origin localStorage through `BrowserOAuthCredentialRepo`, keyed by nonce. The callback takes
  out only the record for the nonce in state, deleting it as it goes, then exchanges the token with that
  record's provider and address; with no record it reports a CSRF failure, requests no token and leaves other
  records untouched. The token request address must never be assembled from the callback URL carrying
  authorization parameters. Reason and boundary: [callback lands in another tab](#callback-lands-in-another-tab-of-the-same-browser).
- Without a JWT the page shows the same two OAuth entries as the desktop (Z.AI first, with the desktop icons,
  connect copy and global/China labels), prompting to use the same platform and account as the computer. The
  login card header has the title bar's app logo (40px, decorative image) on the left and the "ZCode" brand
  text and title on the right; no accent-color letter placeholder. The device list page and the QR placeholder
  page use the 20px version of the same logo plus "ZCode" (see the
  [device list spec](./relay-v2-pairing.md#list-layout-and-text-wireframe)). After a choice both buttons are
  disabled and the chosen provider is passed through entry orchestration into the existing WebAuthService; the
  callback exchanges and saves credentials by the pending provider. There is no API Key entry because remote
  control needs an account identity; the QR code carries no credential and infers no login platform.
- Without a JWT the login page renders with appReturnTo as the current full URL. The safe return keeps only
  same-origin `/remote/v4`, `/remote/__test__` (both with trailing slash) and existing share paths; the query
  allowlist is app_version/sid/mid/name.
- With a JWT and a SID: request a terminal token and connect V2 directly. Without a SID: read the current
  account's devices; connect directly if the most recent SID is online; if the most recent SID is offline but
  the same computer (recent MID) has exactly one online connection, connect to it; otherwise show the device
  list (rules in [landing](./relay-v2-pairing.md#landing-state-ownership-and-refresh)). Offline devices are not
  clickable; picking an online device writes sid/mid/name/app_version back and connects; manual and
  foreground refresh are supported. The device page shows the current account and platform under the title,
  and "切换" (Switch) opens the confirmation dialog below.
- A token 401 clears the local session and returns to the login gate without confirmation; a manual "switch
  account" must be confirmed first, then clears the session and keeps the current URL. AUTH_FAILED is not
  treated as a network error to retry forever.

### Manual switch-account confirmation

The "切换账号" of the device list page and of the `device-not-owned` failure page share one centered
confirmation dialog. Title "切换账号？", description "将退出当前手机网页端账号，返回登录页。电脑端仍保持登录。",
actions "取消" on the left and "退出并切换" on the right. English: "Switch account?", "You will sign out of this
mobile web session and return to the sign-in page. Your computer will stay signed in.", "Cancel" / "Sign out &
switch". Buttons use neutral primary/secondary styles, not danger red.

The dialog open state is held only by the shared confirm component's Dialog and copies no auth state; the UI
exposes the existing Dialog primitives through the `@zcode/ui/dialog` subpath, the Web layer composes this
feature's copy and trigger button, and the confirm button reuses `WebRemoteControlEntry.switchAccount()`.
Default focus is on cancel and focus is trapped in the dialog; cancel, overlay or Esc close it and focus
returns to the entry button. Before confirming nothing is cleared: credentials, entry view and the list
request are untouched; after confirming the original logout and URL-keeping logic runs. Automatic
invalidation paths such as 401 or a missing JWT do not go through this dialog. The desktop continuous / phone
replayable recovery boundaries are unchanged.

```text
manual entry → Dialog opens (still logged in)
             ├─ cancel / overlay / Esc → original page (still logged in)
             └─ sign out & switch → Entry.switchAccount → reset → auth.logout → login page
auth invalid ─────────────────→ Entry.switchAccount → reset → auth.logout → login page
```

Acceptance: both manual entries cover open, cancel, overlay, Esc and confirm; cancel keeps credentials, URL
and the original page; confirm clears the phone web credentials and returns to login keeping the URL; 401
shows no dialog. Browser verification covers 390px / 1024px, Zai Light / Zai Dark, zh/en, checking focus
return, Tab trapping, button reachability and no horizontal overflow. Regression lives in
`webRemoteControlSwitchAccount.test.ts` and the pending `remote-login-v2.mjs` (MC01); controlled-browser
evidence does not replace real-phone OAuth acceptance. Local verification (2026-09-22) passed; real phone,
real OAuth and online deployment were not run.

## Storage and boundaries

`BrowserOAuthCredentialRepo` is the only auth storage boundary and keeps using zcodejwttoken,
oauth:zai:access_token, oauth:zai:user_info, oauth:active_provider and the existing separate BigModel keys;
in-progress login records use `oauth_pending_logins`. An incomplete or expired session is cleaned up and
treated as logged out; clearing login credentials or logging out does not delete in-progress login records.
The pre-orchestration reads the JWT through WebAuthService and copies no auth cache; the token is not
persisted and does not enter the QR, logs or business payload.

## Dev callback forwarding

`VITE_DEV_ORIGIN=http://192.168.x.x:5173` writes a private-network `/remote/v4` into OAuth state.return_to,
keeping the same set of remote control parameters. A deployed callback forwards only when
`VITE_WEB_REMOTE_ALLOW_DEV_RETURN_TO=true` is set explicitly; forwarding keeps the allowlisted parameters and
appends this round's code/error/state, and nonce validation and token exchange finally run at the same origin
that started login. Existing share callback paths keep working. A Vite-specific proxy forwards
`/api/v1/oauth/token` and `/api/v1/remote` to the current build endpoint, ahead of the ordinary `/api` proxy.

The full sequence, error mapping, copy table and acceptance matrix are in
[Relay V2 phone first entry and recovery](./relay-v2-pairing.md#phone-first-entry-and-recovery-05).

Local `pnpm dev:web-remote-control` keeps the Vite root base, and the desktop's default QR address is synced to
`http://localhost:5173/remote/v4`; for phone debugging point `ZCODE_WEB_REMOTE_CONTROL_URL` at a reachable
same path with the matching `VITE_DEV_ORIGIN`. Avoid the `/remote` alias that is not in the OAuth return
allowlist, which loses the SID.

### Test-entry login return

The retained `/remote/__test__` test resource chain uses the same login gate. It is an allowed login source
and return path, while the OAuth callback stays `/remote/v4`; the private-network callback allowlist is not
widened. Starting authorization keeps the test link's app_version/sid/mid/name, and after a successful
callback restores the original test path and parameters. Re-login after a 401 session clear follows the same rule.

```text
before: __test__ scan → login → source rejected, callback without params → safeReturn=null → /remote/v4
after:  __test__ scan → /remote/v4 callback with the scan parameters
                     → original credential owner validates nonce, exchanges token → original __test__ link → V2 pairing
```

Acceptance reuses ML04: `/remote/v4` and `/remote/__test__` x Z.AI/BigModel x 390px/1024px x first
login/401 re-login, asserting the actual authorization callback keeps parameters, the token request uses the
original redirect_uri, and the return to the original entry completes pairing. Unit tests also cover the test
entry's trailing slash, foreign-origin and unknown-path rejection, sensitive query/fragment stripping, and
that the callback allowlist is not widened. Desktop continuous, phone replayable and business owners are unchanged.

Test resource deployment still requires the same-origin `/remote/v4` callback page to contain this return-path
rule and the gateway to load the matching version. Controlled browser regression does not replace real OAuth
allowlist, gateway and test image joint debugging (not done: no real OAuth, device or deployment run).

## Dual-provider login regression

```text
before: single-button login page → entry passes no provider → WebAuthService defaults to zai
after:  login page picks zai / bigmodel → entry passes provider + original QR URL
        → WebAuthService / BrowserOAuthCredentialRepo saves nonce, pending provider
        → matching platform authorization → original owner validates callback and stores credentials → original QR URL → Relay checks account ownership
```

Credential owner, storage keys and nonce validation are unchanged; the connection, recovery and business
owner of desktop continuous / phone replayable are unchanged. An existing Web login state keeps working, and
switch account and 401 return to the same dual-provider gate.

Acceptance reuses `packages/web/test/e2e/manual-review/pending/remote-login-v2.mjs`:

- 390px / 1024px x Zai Light / Zai Dark x zh/en show the two entries with order, platform names and labels matching the desktop.
- Each platform verifies click, authorization parameters, pending provider, token-request provider, separate credential keys, return to the original QR address and terminal pairing; BigModel uses an authCode callback.
- After an ownership failure, switching to BigModel; and after a 401, re-picking a platform, keep the original device URL.
- Build config tests cover the BigModel authorization domains of test / production; real third-party authorization and real-phone QR scanning are joint-debugged separately, and local controlled responses are not online acceptance.

## Callback keeps QR parameters

```text
before: versioned QR URL → WebAuthService → fixed callback /remote/v4 → gateway loads latest
after:  versioned QR URL → WebAuthService → callback with app_version/sid/mid/name
                       └→ BrowserOAuthCredentialRepo saves this address
       → gateway loads the page by app_version → original owner validates nonce → exchanges token at the saved address
       → clean the pending address → replace safe app_return_to → original V2 pairing flow
```

Reuse the ML04 browser case: two platforms x phone/wide take the callback address from the actual
authorization URL, assert the QR parameters are fully kept, navigate after appending authorization
parameters, and check the token request's redirect_uri equals the one at authorization. Unit tests add
Unicode/empty values, stripping of unknown and historical authorization parameters, cross-page recovery,
nonce failure, old pending session compatibility and private-network forwarding. This change involves Web
OAuth only; desktop login, continuous/replayable and business owners are unchanged. After release, real
phones must verify both platforms allow and keep the callback address with a query; an entry without
app_version still depends on latest, so this cannot be claimed to fix old online resources.

## Callback lands in another tab of the same browser

On some phone browsers the callback page after the OAuth round trip is not in the tab that started login, or
the tab was recycled by the system and rebuilt (for example while switching to an SMS app to read a verification
code). The login record used to live only in the initiating page's sessionStorage, so the callback page could
not read it and reported "OAuth CSRF 检测失败" before exchanging the token; "re-login" kept failing in the same
environment, and only another browser could complete it.

```text
before: Tab A writes sessionStorage[A].nonce=N → provider login → callback lands in Tab B / rebuilt Tab A
        → sessionStorage empty → null≠N → CSRF failure (no token requested)
after:  Tab A writes localStorage.oauth_pending_logins += {N, provider, redirectUri}
        → provider login → callback lands in any same-origin tab → take and delete the record for N → exchange token → safe return
```

- Records are keyed by nonce, so several tabs starting login concurrently do not overwrite each other; at
  most the 5 most recent are kept, so abandoned logins do not accumulate forever.
- The nonce is still random, same-origin visible and single-use. A nonce in state with no record is rejected
  and other records are kept.
- A callback landing in a different browser app is still rejected: that browser has no record of this login,
  which is the intended result of the CSRF check.
- The old `oauth_pending_nonce` / `oauth_pending_provider` / `oauth_pending_redirect_uri` that older versions
  wrote to sessionStorage are no longer read. The gateway loads the same version directory for the initiating
  and callback pages by `app_version`, so only logins in progress during a deployment switch are affected and
  the user just logs in again.

Acceptance: `browserOAuthCredentialRepo.test.ts` covers cross-tab retrieval, taking only the matching nonce,
delete-on-take, the count cap and corrupted records; `webAuthService.test.ts` covers both platforms
completing login with an empty sessionStorage on the callback page, no token request and the record kept on
nonce mismatch, and two tabs logging in in parallel each completing. The browser regression `remote-login-v2.mjs`
ML07 completes the callback in a new tab of the same browser context, asserting token request parameters,
return and terminal pairing. Controlled browser evidence does not replace real-phone browser acceptance.
