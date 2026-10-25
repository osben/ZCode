# Todo114: Account Unavailable-Reason Sync and Personal-Plan Key Fetch Failure

> Numbering note: upstream original Todo105; renamed Todo114 on merge (2026-09-10) to avoid clashing with the existing
> "personal/team model list trim" Todo105. Case IDs `T105-*` and temporary evidence paths below keep the original names
> for traceability.
>
> Status: Implemented, with targeted unit/integration tests and component-browser verification passed. The full Electron /
> phone remote-control chain was not run and is not counted as passing evidence.
> Baseline: `fix-account-status-sync` from staging with `origin/fix/coding-plan-not-purchased-status` (`da708b7d4a`)
> merged without conflict.
>
> 2026-09-16 behavior update: the active retry after a personal-plan credential failure is now the user clicking "Log in
> again" (contract: [failure state spec](../../../ui/coding-plan-entitlement-failure-state.md)); the assertion below that
> login callbacks are zero is no longer applicable.
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/todo-114-account-status-sync-and-key-retry.md`

## 1. Background and Rulings

The original branch fixed "logged in and the server explicitly says no personal plan, yet the UI showed not connected":
the Host sends `unavailableReason` with the Account State and the UI separates "not entitled" from "fetch failed". This
keeps the single fact source and does not restore a second entitlement probe in the UI.

Two gaps were found: the strict sync schema used by the CLI did not accept the new field and rejected the whole Account
snapshot; and when a personal Coding Plan Key fetch fails, Z.ai classified by local login info while BigModel always
reported not connected.

User rulings:

- The sync schema accepts the optional reason field and stays strict; the whole state is not restructured and reason is
  not required to be a discriminated union with availability.
- The two families' personal-plan Key-fetch-failure classification is aligned; API domains, Authorization and secretKey
  adapters stay as they are.
- **Logged in but no Key obtained shows "fetch failed" and is retryable; a missing Key alone must not force re-login.**
  Local user info only proves a past login, not that the Token is still valid.
- Only explicit login-credential-invalid evidence is enough to require re-login. The Key service currently normalizes
  failures to null; this change does not extend the failure protocol and does not treat null or a model API Key 401/403 as
  OAuth invalidation.
- Not logged in keeps the existing connect entry; a successful query with explicitly no plan still shows not entitled with
  the subscribe entry. Start, Team and Off-Peak are not adjusted.
- Existing reason names are kept; `credential-failed` here means fetching/validating the credential failed, not that OAuth
  is invalid.

## 2. Structure and Boundaries

```ts
unavailableReason?:
  | "not-authenticated"
  | "not-connected"
  | "credential-failed"
  | "not-entitled";
```

The reason enum is defined once in the shared schema (types derive from it; Provider reuses it through the existing shared
dependency). Sync still uses `zcodeProviderUpdateAccountConfigParamsSchema`: no new command, no weakened strictness, no
new state owner.

```text
Host fetches personal-plan Key
  missing Key + no local login info -> not logged in / connect entry
  missing Key + local login info    -> fetch failed
  Key present -> subscription query -> available / explicitly not entitled / existing unknown state
Account State (Host sole owner) -> shared sync schema -> CLI receives the full snapshot
                                -> Settings View -> fetch-failed card -> click retry
                                -> existing settings-manual refresh -> Host refetches and publishes
```

Card retry reuses the existing refresh and its concurrency/version guards: it does not clear OAuth, start login, or add
timers, caches or sync bypasses. Desktop and phone share the settings components and services; the Host/Agent sync path,
continuous/replayable, owner/lease and remote attachment are unchanged.

## 3. Implementation Order

1. Failing tests first: protocol round trip, both families' missing-Key classification, card retry scenarios.
2. shared gains the reason schema, Provider reuses the derived type and completes the sync `states` member.
3. services unify both families' missing-Key judgment in the existing helper, without changing Key-fetch network adapters or caches.
4. UI offers retry when the personal plan fetch fails, reusing the existing refresh entry; other plans and the upgrade flow keep their login action; existing translations, components and loading states are reused.
5. Verify, review, write back actual evidence and commit; no push or MR was authorized.

## 4. Verification and Compatibility

- Protocol: four reasons round-trip losslessly; no reason still accepted; wrong reason and unknown fields rejected; a mixed available/unavailable Provider snapshot is received whole.
- Services: Z.ai/BigModel each cover missing-Key with and without login info and send no subscription request; success with/without subscription and other plans' existing cases regress clean.
- Interaction: clicking retry on a fetch failure triggers a refresh, not login; a failed retry can be retried again and success restores the current state. Settings scenarios use E2E, separating desktop narrow-window from real phone evidence.
- Runtime verification uses the real schema and state producer/consumer functions, not source-string assertions.
- Targeted tests, typecheck, lint, architecture:check; E2E adds typecheck:e2e. Environment blocks are recorded as they are; the whole E2E infrastructure is not rebuilt.
- Only an optional runtime field is added: no new file storage, table or migration. App and CLI must ship together; an old CLI (strict) rejects the new field, so cross-version mixing is not claimed compatible.

## 5. Delivery and Remaining Issues

### Push Gate Supplement (2026-09-10)

The user asked to push back to the original MR !2594 branch `fix/coding-plan-not-purchased-status`. The first pre-push
affected tests: 14,484 passed, 2 failed, both from existing share components' React reference-stability checks (SessionPane
passed an inline callback to a memo confirm Dock; the Selection Dock default preflight created an object every time).
Only reference stabilization was done: a `useCallback` depending on `sessionId` and `updateShareDockState`, and the
read-only idle default moved to a module constant; function bodies, state ownership, display, interaction, share protocol
and permission rulings are unchanged. The failing tests serve as regression and the fix is a separate commit. After the
fix, the reference-stability and share-related four test files pass 45/45, with typecheck, lint (41 warnings / 0 errors),
architecture check and format checks; share E2E was not rerun (no new share interaction).

### Accepted Browser Case (fixed before implementation)

T105-UI01: render the Z.ai and BigModel personal-plan "fetch failed" cards; clicking retry disables the button during a
controlled unfinished refresh; after a first refresh that still fails, retry again; a second refresh recovers to explicit
not-entitled showing subscribe. Login callbacks stay zero throughout. Covers 390px Chinese light and 1200px English dark,
saving browser errors, screenshots and refresh counts. The case is at
`packages/ui/test/browser/manual-review/pending/account-provider-key-retry.*`, reusing the Vite + Playwright component
browser workflow. It proves actual card interaction; Host actual resolution -> protocol is covered by integration tests;
the component fixture is not claimed as a full Electron or phone shared-host E2E.

### Delivered

- The sync protocol gains the optional reason field and stays strict; the public subpath `shared/account-provider-state`
  provides the single reason schema and derived type, Provider keeps its original export name. The light subpath avoids the
  Provider build pulling Node environment definitions through the shared main entry; no package dependency or sync command change.
- Z.ai/BigModel personal plans treat a missing Key by each family's local user info uniformly. Existing early returns for
  missing account identity, other plans, caches and network adapters are unchanged.
- The personal-plan `credential-failed` card gets a retry action through Detail, calling the existing
  `useModelProviders.refresh()` -> `settings-manual` with its loading/version guards and error log. The button does not
  trigger OAuth login; Start/Team and the upgrade flow keep their existing actions.
- The new source schema module and test files are code organization, not new user-directory storage files.

### Evidence (2026-09-10)

- Tests first produced 8 expected failures (4 protocol reasons, 2 BigModel classification, 2 retry buttons), all fixed.
- Final 7 targeted files 280/280 pass: protocol round trip/strict rejection, model config build closure, plan
  availability, account Connection Resolver, Account State projection, card detail, navigation projection.
- Service integration with the real Family Availability -> Connection Resolver -> Account Config Resolver -> sync schema:
  both families publish `credential-failed` when the Key is missing, and an available Start Plan in the same snapshot is not blocked.
- Component browser T105-UI01, four groups pass (two families x 390px Chinese light / 1200px English dark): retry request
  counts, disabled while refreshing, second click after failure, subscribe button after recovery, zero login calls, no page
  JS exception. The environment first lacked Chromium / libatk (browser installed, temporary dynamic libraries reused); the
  first English assertion wrongly used "Failed to fetch" and was corrected to the product's existing "Fetch failed".
- `pnpm typecheck` (including desktop `tsconfig.e2e.json`) passes; `pnpm lint` 0 errors / 41 warnings (not in changed
  production code); `pnpm architecture:check --changed` 0 violations / 0 baseline / 0 new; format and `git diff --check` pass.
  Touched modules shared, provider, services, ui are unmanaged in the current policy with no independent CONTRACT; no new
  cross-layer IO or mutable state owner.

### Boundaries and Remaining Verification

- The Key fetch still returns null without separating network, Key creation or OAuth failure; no "OAuth explicitly
  invalid" detection or reason enum was added; a missing Key never forces re-login.
- The browser fixture only proves actual component interaction; full Electron, real account API and real phone
  shared-host/SSH were not run (the first follows the original branch's environment/fixture gap); remaining product-chain
  verification is registered under Todo102.
- The Linux browser lacked Chinese fonts, so Chinese screenshots show missing-glyph boxes; Chinese DOM text and click
  assertions pass but the screenshots are no evidence of glyph rendering.
- App/CLI release pairing is unchanged (new App with old CLI is not compatible with the new field). No user config written,
  no storage migration, no push or MR.

The original branch's history document is `docs/coding-plan/connection-status-semantics.md`; its "fetch failed -> re-login"
and the §7.2 undecided candidates are superseded by this Todo's user rulings.
