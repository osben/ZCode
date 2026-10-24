# ARMS RUM user.id Injection — Login Account userId

Desktop has two telemetry stacks with different user dimensions:

1. ARMS RUM (`@arms/rum-electron`, initialized in the Electron main process): `armsRum.init(...)` (`appARMSBootstrap.ts`) passes no `user`, and the renderer's `buildArmsBrowserInitConfig()` (`armsRumShared.ts`) doesn't either — ARMS "users" are anonymous SDK sessions. The only identity dimension is the three `armsRum.setConfig("properties", { device_mid, ... })` calls, where `device_mid = sha256(app.getPath("userData")).slice(0, 32)` (`index.ts:353`) — one value per device, unrelated to the login account.
2. The in-house telemetry core (`createTelemetryCore` in `@zcode/shared` / `packages/services`, running in the forked host child process) uses the real account `userId` from `createTelemetryUserIdLoader` (`node.ts:453`), i.e. OAuth `loadUserProfile(activeProvider).id`.

Goal: inject the real account `userId` into ARMS RUM `user.id`.

Architecture facts:

- The ARMS SDK initializes in the Electron main process; the OAuth logout hook (`oauthService.onProviderLogout`) lives in the forked host `utilityProcess`, out of the main process's reach.
- The main process itself holds `appTelemetryCredentialService` (`index.ts:220`) and can read the userId directly (`createTelemetryUserIdLoader` is based on it) — no cross-process call needed.
- The ARMS Electron SDK supports runtime updates: `armsRum.setConfig("user", { id })`; `IConfiguration.user?: { id?, name?, tags? }`.
- Main-process init auto-injects `user:{ id: getUserId() }` into the renderer browser SDK, so one main-process change covers main + renderer reporting.

Decisions (aligned with the user):

- Dynamic sync: best-effort set at init; refresh on login-callback completion and on window focus, so login/logout/account switch all reach ARMS.
- Not-logged-in fallback: when `userId` is empty, `device_mid` becomes `user.id`, so every report has a non-empty (device-level) user dimension; the real account id overrides after login.

Design:

- New module `packages/desktop/src/main/armsUserIdentity.ts` — single responsibility: resolve the current ARMS `user.id` and write it to the SDK with dedup. `createArmsUserIdentitySync(deps)` takes injected `loadUserId: () => Promise<string>` (reusing the existing `createTelemetryUserIdLoader(appTelemetryCredentialService)`), `deviceMid: string`, and `setUser: (user: { id: string }) => void` (wrapping `armsRum.setConfig("user", ...)`, stubbable). `refresh()` resolves `(await loadUserId()) || deviceMid`, skips when unchanged from the last write (no setConfig per focus), otherwise writes and caches; concurrent refreshes are serialized/last-wins (in-flight flag + final re-run) so a stale value can't be written back. A `loadUserId()` throw is treated as logged-out (device_mid fallback), never propagated.
- Wiring (`packages/desktop/src/main/index.ts`, after `await armsInitPromise` at L1221): (1) initial `void armsUserIdentitySync.refresh()` (usually logged-out → device_mid); (2) on login, `refresh()` next to the `OAuthCallbackHandled` listener in `desktopMainIpcRemote.ts:155` — injected as an optional `onOAuthCallbackHandled` bypass or the sync handle in that module's options, rather than widening `appTelemetryRuntime`'s public surface; (3) logout/account-switch coverage rides the existing `app.on("browser-window-focus", syncAppTelemetryInteractiveState)` handler (`index.ts:249`) — the main process gets no immediate host-side logout signal, so returning to the window triggers the refresh.

Unchanged: the host child process and in-house telemetry core (userId chain), the three `setConfig("properties", { device_mid })` calls (device dimension coexists with `user.id`), and renderer `armsBrowserInit.ts` / web (user.id flows down via autoInject).

Tests (`armsUserIdentity.test.ts`, stub deps, no real SDK): empty `loadUserId` → `{ id: deviceMid }`; `"acc-123"` → `{ id: "acc-123" }`; unchanged id across refreshes → single `setUser` call; login → logout → second refresh falls back to device_mid; `loadUserId` throw → device_mid fallback, no throw. No new wiring tests (existing telemetry integration path). Root `pnpm typecheck` does not cover desktop main — run `tsc -p` separately for `packages/desktop`.
