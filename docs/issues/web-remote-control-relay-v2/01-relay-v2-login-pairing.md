# 01 — Web remote control on Relay V2: phone logs in, then connects to the desktop

**What to build:** Switch the Web remote-control relay layer from V1 (anonymous registration + a QR code
carrying `pass_hash` for a nonce/HMAC challenge-response) to zcode-server's Relay V2 (JWT-registered device +
one-time connection token). Desktop and phone implement V2 only; the phone must log in with the same account
as the desktop before it can scan or pick a desktop from the device list and enter the existing workspace
bridge / `rpc-frame` chain. The phone page stays at `/remote/v4` and is isolated from older App versions by
OSS version directories.

**Blocked by:** Development is not blocked. Production release is blocked by the four items under
"Supplementary notes → External dependencies".

**Status:** ready-for-agent

**Parent:** [Web remote control overview and external relay architecture](../../web-remote-control/web-remote-control-architecture.md)

## Problem

- Server Relay V2 is merged into zcode-server `staging` and live in the test environment; the V1 entry is a
  legacy path controlled by `relay.disable_v1`. Clients only have V1, so once V1 is disabled all versions of
  Web remote control break.
- V1's security model is "whoever has the QR URL controls the computer": `pass_hash` is in the URL in
  plaintext and unrelated to user identity. The phone has no login and cannot know "which devices are mine".
- The `/web-remote` entry reserved in April for "phone logs in then picks a device" never went live; the edge
  gateway redirects it to the website 404 in production and test, which also invalidates the OAuth callback.

## Solution

- The desktop must be logged in (ZAI or BigModel, any provider that can issue a zcode JWT) before starting
  remote control. On first start it registers the device with the JWT and persists `device_sid`; before every
  connection it requests a one-time `role=device` token and connects `/api/v1/remote/ws2`.
- The QR code carries only `app_version`, `sid`, `mid`, `name`, no authentication material.
- The phone opens `/remote/v4` behind a login gate; after login, with `sid` it connects that device, without
  `sid` it connects the last device or shows the account's online device list. Before every connection it
  requests a `role=terminal` token.
- OAuth callbacks return directly to `/remote/v4` (the page recognizes `code`+`state`); the login state is
  written to same-origin localStorage, then the page redirects to the original URL with full parameters.
- App payloads above the relay, the workspace bridge, `rpc-frame` fragmentation/ACK, replayable recovery and
  the version-sync guard are unchanged.

## User stories

1. Desktop user: if logged in, opening the remote dialog directly yields a QR code as before.
2. Desktop user: if logged out, the dialog shows "login required" with a login entry.
3. Desktop user: the QR code contains no secret, so screenshots or forwarded links leak no control.
4. Desktop user: the "remote control was on" intent is restored after app restart.
5. Desktop user: when the login expires, remote control stops in an explicit "re-login required" state
   without logging the whole app out, and resumes automatically after re-login.
6. Desktop user: logging out in the app stops remote control immediately.
7. Desktop user: switching accounts re-registers the device under the new account (new account's phone can
   connect, old account's cannot).
8. Desktop user: switching endpoint (production/test) rebuilds the device identity so a test sid never reaches
   production.
9. Desktop user: the dialog no longer has "refresh QR code".
10. Desktop user: "copy link" remains for sending to a phone without scanning.
11. Phone user: scanning while logged out shows the login page and returns to the scanned target device.
12. Phone user: log in with ZAI or BigModel, consistent with the desktop.
13. Phone user: scanning while logged in connects the target directly with no intermediate page.
14. Phone user: opening the remote page without scanning can log in and pick a computer from a list.
15. Phone user: the list puts online devices first sorted by name; offline devices are greyed and not clickable.
16. Phone user: the list refreshes manually and on return to foreground.
17. Phone user: opening without parameters auto-connects the last used computer if online.
18. Phone user: after selecting from the list the address bar carries the device parameters so refresh or
    history entry restores it.
19. Phone user: logging in with the wrong account shows "this device does not belong to the current account"
    with one-tap account switching.
20. Phone user: if the target device was removed, the user is told and can pick another.
21. Phone user: the page recovers automatically from brief desktop disconnects and relay rolling releases.
22. Phone user: an expired login returns to the login page and back to the original place after login.
23. Phone user: when another phone takes over, this one stops reconnecting and says so (no mutual kicking).
24. Phone user: task list, message stream, permission requests, reconnect and snapshot alignment after entering
    chat are exactly as today.
25. Phone user: after the desktop upgrades, the page prompts a reload to the matching version.
26. Security reviewer: whether the phone can control the computer is decided purely by "same account", so a
    leaked URL no longer means loss of control.
27. Security reviewer: the one-time token is requested only before connecting, never stored or logged.
28. Security reviewer: the JWT lives only in existing credential stores (desktop credential service, phone
    same-origin localStorage), never in the QR code, relay messages or settings file.
29. Operator: new desktop builds use V2 only, old builds keep V1, so V1 can be turned off on the existing
    `relay.disable_v1` schedule.
30. Operator: the new phone page is published only under a new version directory, never overwriting pages used
    by older Apps.
31. Operator: the old Docker build chain is removed from the repo so nobody ships the V2 page to the old single
    deployment.
32. Operator: existing telemetry such as pairing success/failure is unchanged.
33. Developer: integration with the test environment (V2 deployed) and a real phone works without spending a
    new official version number.
34. Developer: both transports, managers and the phone pre-connection orchestration have automated tests
    against a fake relay, with no dependency on live environments.
35. Developer: spec and architecture docs describe the final V2 behavior, with no V1 comparison needed.

## Implementation decisions

### A. Scope and compatibility

- New desktop and phone pages implement V2 only. Delete both V1 transports, HMAC proof computation,
  `pass_hash` storage, and shared V1 relay message types and proof test vectors; add V2 relay message types and
  the device/token HTTP contract types, shared by both ends.
- The phone entry stays `/remote/v4`. Version isolation relies on OSS multi-version publishing: the desktop QR
  carries its own `app_version`, the gateway serves the page by version directory; 3.13.0 and earlier Apps keep
  using the V1 pages built from their tags. No dual mode and no `/remote/v5`.
- Delete the `/remote`, `/remote/v3`, `/remote/v4` Docker build chains (Dockerfile, nginx config, build/push/
  verify scripts, package.json commands, doc references to the old infrastructure repo and its path variables);
  keep the `/remote/__test__` chain and the OSS pipeline. Docs note that the old deployment is frozen at the
  last V1 image.
- Delete the `/web-remote` route check, the logged-in waiting page, the old `remoteControlToken`/`relayOrigin`
  bootstrap and its `/api/remote-control/*` requests; reuse the login page, callback page, Web auth service,
  browser OAuth credential repository and OAuth state codec. The April Web remote login design doc is marked
  superseded by this spec.
- Pure client adaptation: no change is requested from zcode-server; everything follows the current staging
  contract.

### B. Desktop: login gate and device identity

- "Logged in" means `zcodejwttoken` exists in the credential store (ZAI and BigModel both qualify).
- When logged out the dialog shows "login required" with a login entry; no device registration, no relay
  connection, no internal start ticket.
- Lazy registration: on first start while logged in, call the device registration endpoint; `device_mid` reuses
  the existing desktop deviceMid (uuid, display and gateway hashing only), `meta.name` is the hostname. Persist
  `{deviceSid, userId, endpointOrigin}` to AppSettings, not to credentials.
- Identity rebinding: on start, if the current user id or endpoint origin differs from the persisted record, or
  the server returns `AUTH_FAILED` at `auth_init`, re-register and make a best-effort call to the delete
  endpoint for the old record (failure ignored, never blocking).
- On first entry to V2, delete the V1 leftover `deviceSid` setting and `passHash` credential without migration.
- A one-way renderer→main login-state notification is added: after login, main retries restoring the "last
  enabled" target (the window workspace must still be synced); after logout, main stops the current runtime and
  sets status `auth-required` without clearing the enabled record. If there is no JWT at app start, recovery
  stays at `auth-required` waiting for this notification.
- The dialog drops the "refresh QR code" button, the confirmation dialog and the `resetPairingAuthorized` IPC;
  "copy link" stays. The IPC surface shrinks to `authorizeStart`, `startAuthorized`, `stop`, `getStatus`.

### C. Desktop: connection and token

- Before every connection, request a one-time `role=device` token with the JWT; the WebSocket URL is
  `wss://<endpoint origin>/api/v1/remote/ws2?token=<token>&mid=<deviceMid>`. Every WebSocket failure requests a
  fresh token; the URL is never reused. Delete the `X-Device-ID` header. The
  `ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL` debug override stays with V2 address semantics; the test endpoint
  still maps to the test domain.
- `auth_init` carries only `device_sid`, `meta`, `client_ts` (no `role`); `pair_status_query` has no
  `device_sid`; `client_ts` is Unix seconds.
- Heartbeat base 5 s, jitter ±1 s, ACK watchdog 15 s; existing constraints stay: recursive `setTimeout`, no
  backfill of missed heartbeats, a small random delay added to watchdog-triggered reconnects.
- `KICKED` is retried in a bounded way: random 2-5 s delay, reconnect once with a fresh token; a second
  `KICKED` within 60 s stops auto-reconnect, status `kicked`, external failure `session-conflict`.
- Token endpoint 401 → new failure reason `auth-required`, runtime goes to `error` and stops auto-reconnect,
  no global logout, enabled record kept. 5xx and network errors use exponential backoff from 1 s up to 30 s
  with jitter, reset after `auth_ack`; other 4xx → terminal `relay-unavailable`.
- Desktop main calls the device and token endpoints directly with Node global fetch and
  `Authorization: Bearer <jwt>`, not through the services process, and does not reuse the services-side 401
  global-logout observer.

```text
Desktop device state machine (V2)
idle ─start─▶ auth-check ─no JWT─▶ auth-required (waits for login notification)
   │                └JWT─▶ registering (no sid / identity mismatch) ─ack─▶ token-acquiring
   │                                                            └────────▶ token-acquiring
token-acquiring ─token─▶ connecting ─open─▶ authenticating(auth_init) ─auth_ack─▶ waiting_terminal | paired
   │ 401 → auth-required (terminal, waits for login notification)
   │ 5xx/network → backoff → token-acquiring
paired/waiting_terminal ─KICKED(first)─▶ delay 2~5s → token-acquiring
                        ─KICKED(second within 60s)─▶ kicked (terminal, session-conflict)
                        ─ACK watchdog 15s / socket close─▶ token-acquiring
```

### D. Phone: login, device selection and connection

- `/remote/v4` parsing: with `code`+`state` in the URL enter OAuth callback mode; otherwise read `app_version`,
  `sid`, `mid`, `name`, all optional. `hash` and `t` are deleted.
- OAuth `redirect_uri` is `<origin>/remote/v4`. The `app_return_to` allow-list changes from `/web-remote` only
  to `/remote/v4` (trailing slash included) plus existing share paths; query allows `app_version`, `sid`, `mid`,
  `name`. After the callback, `location.replace` to `app_return_to`, and the gateway picks the version by
  `app_version`. The dev-mode `return_to` forwarding stays.
- Login gate: logged out renders the existing login page (provider follows the build environment); logged in
  enters the pre-connection orchestration.
- Landing rules: with `sid` → connect directly; without `sid` → read the recent device from localStorage and
  call the device list endpoint; if online connect directly, otherwise render the device list page. The
  connection failure page offers "select another device" into the list.
- Device list: fetched on entry, on manual refresh and on `visibilitychange` back to foreground; no polling.
  Online devices first, sorted by `meta.name`; offline devices greyed, not clickable, showing the first 8
  characters of `device_mid`. The list page and login page are standalone full-screen pages before connection,
  same layout on narrow and wide screens, outside the `Root`/sidebar shell, reusing login page styles and the
  `zai-dark` default theme, with copy in `zh-CN`/`en-US`.
- After selection, `history.replaceState` writes `app_version` (original kept), `sid`, `mid`, `name` back to
  the URL and the recent sid to localStorage; existing sid-keyed local state keeps working.
- Before every connection, request a `role=terminal` token with the JWT from localStorage and connect
  `wss://<origin>/api/v1/remote/ws2?token=…&mid=…` (`mid` from the URL or the list's `device_mid`). 401 →
  clear the local session, go to the login page with `app_return_to` holding the full current URL. 5xx/network
  errors keep the existing 500 ms x 2^n backoff capped at 10 s.
- Error mapping: `AUTH_FAILED` after `auth_init` → new failure reason `device-not-owned` with "switch account"
  (log out, return to the login page keeping the return address) and "select another device"; `WRONG_PARAM` →
  `invalid-mobile-connection`; `DEVICE_OFFLINE` keeps the existing grace recovery; `KICKED` uses the same
  bounded retry as the desktop, second `KICKED` → `session-conflict`; `INTERNAL` keeps existing recoverable
  handling.
- Heartbeat, watchdog, `client_ts`, `auth_init`/`pair_status_query` fields match the desktop.
- bootstrap-request/response, workspace-list, workspace-bridge-open/ready, rpc-frame/ack,
  `mobile-view-state-update`, the version-sync guard and the replayable recovery order are all unchanged.

```text
Phone first entry (V2)
open /remote/v4?app_version&sid&mid&name
  ├─ has code+state ─▶ callback page exchanges token → localStorage → replace(app_return_to)
  ├─ no JWT ─▶ login page ─▶ OAuth (redirect_uri=/remote/v4, state.app_return_to=current URL)
  └─ has JWT
       ├─ has sid ─▶ request terminal token ─▶ ws2 ─▶ auth_init(sid) ─▶ auth_ack
       │                                          └─ AUTH_FAILED → device-not-owned failure page
       └─ no sid ─▶ recent device online? ─yes─▶ as above
                                          └no─▶ device list ─select─▶ replaceState(URL) ─▶ as above
auth_ack(matched) ─▶ bootstrap-request ─▶ version guard ─▶ workspace-bridge-open ─▶ existing chain
```

### E. Deployment and integration

- Phone pages publish through the existing OSS multi-version pipeline to `/remote/v4/<version>/`; the page
  route stays `/remote/v4`. The desktop QR path selection logic (>= 3.4.0 uses v4) is unchanged.
- During integration the branch keeps root `package.json` version `3.13.0` and uses the OSS test pipeline to
  overwrite the test environment's `3.13.0/` directory; desktop dev uses the test endpoint. For fast local
  iteration, the dev-mode `return_to` forwarding lets one login on the test domain feed same-origin
  localStorage. Colleagues still using the 3.13.0 V1 desktop in the test environment cannot pair meanwhile and
  must be told.

### F. Documentation

- New `docs/web-remote-control/relay-v2-pairing.md`: registration/token/handshake sequence diagrams, both
  transport state machines, `KICKED` bounded retry, `auth-required`/`device-not-owned` semantics, acceptance
  scenarios and known limitations.
- The architecture doc's Transport, Desktop Main and Web sections switch to V2 and link the new doc, dropping
  V1 and Docker deployment parts; `remote-v4-static-deployment.md` drops the Docker chain but keeps OSS and
  version sync; `web-remote-login.md` is rewritten as the `/remote/v4` V2 login gate.

## Test decisions

- Good tests observe external behavior only: what the relay receives, how the HTTP endpoints are called, what
  runtime status/failure is exposed, what the page renders in which state, what URL/localStorage become. No
  assertions on private state or timer handles.
- The only new fixture is a **fake relay V2**: in-process device register/list/delete and token HTTP handlers
  plus a `/ws2` WebSocket server that can script `auth_ack` `pair_status`, `KICKED`, `AUTH_FAILED`,
  `DEVICE_OFFLINE`, `INTERNAL`, disconnects and HTTP 401/5xx. Desktop and phone tests share it. Precedent: the
  existing transport tests use a local WebSocketServer as the relay.
- Desktop main seam is the manager public interface, with the real V2 transport, fake relay, fake credential
  reading and fake login-state notifier, covering: refuse to start when logged out, lazy registration and
  persistence, re-registration with best-effort delete on user/endpoint change, `AUTH_FAILED` re-registration,
  token 401 → `auth-required` without clearing the enabled record, logout stop, post-login restore, QR URL
  shape, and the external status of `KICKED` bounded retry. Wire-level details (5 s heartbeat/jitter/15 s
  watchdog, `client_ts` seconds, `auth_init` and `pair_status_query` fields, backoff sequence) are covered at
  the transport against the fake relay with fake timers.
- Phone main seam is the extracted pre-connection orchestration module with injected login state, device API,
  location/history/localStorage and transport factory, covering callback-mode detection, login gate, with/
  without sid landing, recent-device online/offline split, list sorting and refresh triggers, URL write-back
  after selection, 401 back to login with the return address, and the `device-not-owned` actions. The terminal
  transport is tested against the fake relay like the desktop.
- shared: QR URL build/parse (no `hash`/`t`, optional `sid`), runtime validation of V2 messages, OAuth state
  allow-list and query pass-through.
- UI acceptance: the device list page of ticket 06 is the only brand-new page; before implementation,
  `relay-v2-pairing.md` carries a text wireframe and copy table (header and switch-account entry, list item
  layout, online marker, offline grey, empty state, refresh button position) for user confirmation. Tickets
  03/04/05 only add/remove states on existing dialog, login and failure pages; new copy is listed in each
  ticket doc first. Every UI-touching ticket delivers a screenshot matrix after implementation: desktop dark/
  light x zh-CN/en-US (04's E2E yields it), phone narrow/wide x dark/light x zh-CN/en-US (new pending
  screenshot case modeled on `packages/web/test/e2e/manual-review/pending/remote-version.mjs`, never
  auto-promoted).
- Desktop E2E adds exactly one case: "with the user logged out, opening the remote dialog shows login required
  and main made no registration or relay connection", added and promoted per the E2E workflow skill.
- Real-device acceptance runs manually in the test environment and is recorded in the new doc: first scan with
  login, logged-in direct connect, no-code device selection, account mismatch, takeover by another phone,
  desktop logout/login, `KICKED` recovery after relay rolling restarts.
- Required verification per AGENTS: `pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed`,
  affected unit tests and the new E2E.

## Out of scope

- Multiple windows each starting remote control sharing one device identity and kicking each other: keep as is,
  document the risk only.
- Phone-side device deletion, renaming, device management page; a desktop "re-register this device"
  troubleshooting entry.
- Any zcode-server change (distinguishing `KICKED` from owner loss, persisting offline device `meta`, `client_ts`
  unit documentation).
- Timing of V1 shutdown and `relay.disable_v1`; compatibility maintenance of old Apps.
- Remote control for logged-out users; login methods other than ZAI and BigModel.
- Gateway, ESA, OSS and OAuth allow-list infrastructure changes themselves (this spec only lists requirements
  and acceptance methods).
- A new protocol-version telemetry dimension; cleanup of unrelated historical fields in
  `WebRemoteControlStatus`; the `/remote/__test__` chain and share pages.

## Supplementary notes

### External dependencies (block production release, not development)

| Item | Owner | Status | Acceptance |
| ---- | ----- | ------ | ---------- |
| Production zcode-server deploys V2 | server | `zcode.z.ai/api/v1/remote/token` returns 404 | the endpoint returns 401 without JWT |
| Production gateway forwards `/api/v1/remote/ws2` exactly to the V2 relay, device and terminal landing on the same instance by `mid` | ESA/Alibaba Cloud gateway maintainers | currently falls to the V1 handler by the `/api/v1/remote/ws` prefix (returns 400) | 401 without token; stable pairing for the same `mid` |
| Production gateway serves OSS `<version>/index.html` by `app_version` and `/remote/v4/<dir>/<path>` from the matching directory | ESA/Alibaba Cloud gateway maintainers | works in test; production returns the same index for all versions and `/remote/v4/3.13.0/release-manifest.json` returns index.html | the manifest returns JSON; different `app_version` returns its own version's assets |
| OAuth allow-list registers `https://zcode.z.ai/remote/v4` (listed twice in the source for the two providers) | ZAI and BigModel OAuth providers | not started | one real login redirect in the test environment |

The old infrastructure repo no longer carries zcode.z.ai backend or frontend configuration; this task changes
nothing there.

### Release order

Production server V2 → the two gateway rules → OAuth allow-list → publish phone page under the new version
directory → release the desktop App carrying that version. The manual latest job does not run before the
gateway supports version directories.

### Known limitations

- A phone using an old link saved before the upgrade (old `app_version`) against a V2 desktop lands on the V1
  page and stays at "waiting for computer"; it cannot self-correct and needs a fresh scan.
- The server returns no `meta` for offline devices, so offline entries can only show a `device_mid` fragment.
- The server sends `KICKED` for both "replaced" and "owner lost"; the client compromises with bounded retry.
  If the server later distinguishes the codes, it can return to "stop on receipt".

### Relation to higher-level rules

- The desktop `desktop-continuous` and phone `web-remote-replayable` recovery boundary, the
  workspaceIdentity/workspacePath split, the relay not parsing business payloads, and main holding no
  task/stream state all stay. The one-time internal start ticket, the IPC surface shrink (no
  `resetPairingAuthorized`) and the Office XSS compensation boundary notes stay valid.

## Acceptance criteria

- [ ] Logged-out desktop opening the remote dialog shows login required, registers no device, connects no
  relay, and the status has no QR code.
- [ ] First start while logged in registers and persists `{deviceSid, userId, endpointOrigin}`; the QR is
  `/remote/v4?app_version&sid&mid&name` without `hash`/`t`; V1 leftover sid/passHash are cleared.
- [ ] User/endpoint change or `AUTH_FAILED` at `auth_init`: re-register and best-effort delete the old record;
  delete failure does not block start.
- [ ] A new token is requested before every connection; `auth_init` has no `role`; `pair_status_query` has no
  `device_sid`; `client_ts` is seconds; heartbeat 5 s ±1 s; reconnect after 15 s without ACK.
- [ ] Token 401: status `error`/`auth-required`, reconnect stops, no logout, enabled record kept; auto-resume
  after the login notification. Logout notification: runtime stops and goes to `auth-required`.
- [ ] `KICKED`: first one reconnects with a new token after 2-5 s; a second within 60 s stops and reports
  `session-conflict`.
- [ ] Phone with `sid`, logged out: login page → OAuth back to `/remote/v4` callback mode → redirect to the
  original URL → direct connect. Logged in with `sid`: direct connect.
- [ ] Phone without `sid`: recent device online connects directly, otherwise the list page; list online-first
  by name, offline grey and unclickable, manual and foreground refresh; URL written back after selection and
  restorable on refresh.
- [ ] Phone `AUTH_FAILED`: `device-not-owned` page with "switch account" and "select another device"; 401:
  back to login and return to the original URL afterwards.
- [ ] After entering chat, bootstrap, bridge, `rpc-frame`, replayable recovery and version guard behave as
  before the upgrade.
- [ ] The repo no longer contains the v2/v3/v4 Docker build chains or references to the migrated
  infrastructure; `/remote/__test__` and the OSS pipeline work; V1 code on both ends and shared V1 types are
  deleted.
- [ ] The new doc and the three existing docs match the final behavior; the April login design doc is marked
  superseded.
- [ ] typecheck, lint, architecture check, affected unit tests and the new E2E pass; test-environment
  real-device steps are recorded.
