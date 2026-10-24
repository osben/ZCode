# Todo 93: A Lost Plan Notifies Once, and the User Clicks to Switch

> Verification ownership (2026-09-09): residual untested/failing/manual-promotion items moved to [Todo102](todo-102-verification-debt-closeout.md). Historical evidence stays; the hand-off does not mean the tests pass.

> Status: implemented and reviewed; unit tests and Pro core E2E re-verified; unrun full-platform visuals at the end. 2026-09-08. This item replaces Todo88 R06's product ruling "on finding the current connection unavailable, auto-save a replacement connection"; the old implementation and old passing tests stay as history.

## 1. Problem and final ruling

Air runtime evidence: on 2026-09-08 a personal plan was saved at 14:06:35.055 and Team at 14:06:35.990, repeated several times that day. The root observer judged only `current && availability === unavailable`, so manually picking an unactivated plan also triggered an automatic fallback.

Final rule: when the same account's same current connection goes from available / pending to explicitly unavailable, notify once, with a button pointing at a specific alternative plan. Without a click nothing switches and no setting is written; a user's manual choice of an unactivated personal plan may stay and is not pulled back by the background.

| Boundary | Confirmed handling |
| --- | --- |
| notice form | reuse the existing Toast, for example "当前体验套餐已不可用。" + "切换至「具体团队名」" (current trial plan no longer available; switch to the named team); not open settings or a menu first |
| repeated refresh | the same loss notifies once; closing the notice, opening settings and ordinary Provider config refresh do not re-notify |
| loss after recovery | a new state change, may notify again |
| unknown / query failure | not treated as explicit loss, does not clear the last confirmed state, and old-account facts never judge a new account |
| manual switch / account change / Team identity change | a new identity builds a new baseline; an old Team's available is never compared with the new personal unavailable |
| startup | the first confirmed state only builds a baseline; an unavailable state at startup shows no "changed" notice and does not auto-replace the saved connection |
| first start with no saved selection | keep the existing initialization rule; a legacy connection pending migration is not "first, no selection" and keeps its migration protection |
| no usable alternative | the loss shows status only, no fake switch button, no auto-choosing a purchase entry |
| persistence | only a user click with a successful commit writes the existing `providerFamilyConnectionSelections`; no de-dup field, migration or new config file |
| Start hidden | the settings-page Start entry filter is unchanged; no new invisible, no `ProviderConfig.visibility` change |

The existing action "choosing in settings saves the connection" is kept; the previously discussed split of "browsed plan vs actual connection" into two selections is not implemented. Cancelling the auto fallback solves the bounce-back; no entitlement still cannot execute.

## 2. State, observation and commit boundary

```text
existing account / connection settings + Provider Settings View change
 -> App-root observer (memory; not unmounted with the settings page)
    identity change -> new observation generation, drop old suggestions and in-flight results
    first confirmed state -> baseline, no notice
    same identity available/pending -> unavailable -> one loss event
 -> read-only compute of the specific alternative plan -> Toast (no settings write)
 -> user click -> verify account / original connection / target identity / current availability
 -> existing settings-service conditional write -> existing Provider refresh
```

- The observed identity distinguishes at least account principal, Family and full connection selection; Team includes productId / organizationId / projectId (two Teams sharing a Provider ID are not the same connection).
- Notice de-dup is per "one loss in this observation generation", not the View's JSON fingerprint, nor the Toast's short-term dedupeKey alone. The generation is remembered before a request starts; a late result for an old account/selection must not produce a notice or write.
- Repeated unavailable is not re-handled; unknown keeps the last confirmed state; if the first state is unknown, wait for the first confirmed state to set the baseline; available -> unknown -> unavailable is still one recognizable loss.
- The observer's lifecycle follows the App account observation, not the page; check React effect dependencies so ordinary settings updates/language changes do not rebuild the baseline; only logout/account change isolates old facts; no new polling or retry system.
- If the original connection recovers, the user switched account/connection, or the button's target became invalid, the old button must not commit; repeated clicks must not produce concurrent switches.
- The button binds a specific target and full identity and shows the real Team name. Candidate priority reuses the original logic but must confirm availability (existing in the team list is not equal to passing the target Team entitlement check); Team A is never swapped for Team B; "has models" never decides entitlement.
- The old reconciliation's "compute alternative" and "write selection" are split. The async query is outside the write queue, the commit reuses the settings service's conditional write and checks account/selection unchanged; no new Repo or persistence lock.
- A write failure keeps the actual original selection and shows the operation failure without claiming a switch; a successful write followed by a failed refresh acknowledges the saved setting without pretending a rollback; an invalid old suggestion closes/updates the notice, never re-picking a target in the background.
- Not clicking leaves the original selection alone; existing entitlement, Registry/Model admission and Effective Selection resolution still apply ("keeping the selection" never bypasses execution checks).

## 3. Impact

Layers: presentation, validation, commit-effect and startup recovery; account connection/settings domain; persistence structure unchanged.

| Scenario / UI entry | Shared implementation and state owner | Source, validation, commit | Mode and isolation |
| --- | --- | --- | --- |
| running current plan lost / root Toast | `useRootOAuthEffects` -> `accountConnectionRefreshObserver`; in-memory baseline/loss event | Account View confirmed state; read-only before the click, `settingService.update` conditional write after | Desktop/Web use their own injected services; no remote sync added |
| manual personal/Team/Start choice in settings | ModelProviderSection -> `persistProviderFamilyModeForNavItem` | keeps saving the user's explicit connection; the observer builds a new baseline on generation change | no fallback for lack of entitlement; Start visibility rules not extended |
| startup restore of an existing connection | `refreshRestoredOAuthProviderFamilyAfterStartup` | refresh facts, keep existing settings; no automatic replacement save | distinct from first no-selection initialization and legacy data migration |
| click on the suggestion | existing Toast actionLabel / onAction; reuses alternative resolution | same account / original selection / target re-verified, existing settings-service authoritative write | no bulk change of Session, tasks, Bot or Markdown |

must-inspect: `accountConnectionRefreshObserver.ts` state detection; `useRootOAuthEffects.ts` subscription/Toast/lifecycle; `oauthProviderFamilySelectionRefresh.ts` (startup and later reconciliation share the write path, so changing only the observer would leave startup auto-switching); `lib/modelProviderFamilyConnectionSelection.ts` alternative computation and Team full-identity/actual-availability validation. should-inspect: `ModelProviderSection.tsx` manual connection write, pending selection and saved settings handoff; Toast button and failure feedback. invariant-only: Account State/Overlay/Registry layering, Off-Peak/Ticket, model requests and history selection unchanged; no pre-send remote sync, no change to desktop-continuous / web-remote-replayable. evidence-only: `accountConnectionRefreshObserver.test.ts`, Root OAuth restore tests, Toast tests, the old SPMC-08 loss-switch scenario.

State authority stays in three layers: the persisted Family Connection Selection is the user's choice; AccountProviderState is the live fact; the Account Config Overlay is the config projection. The observer only consumes facts and proposes; it is not an entitlement source. Settings-page explicit selection and the loss notice deliberately differ in commit trigger. Codegraph unavailable (precise imports/callers depth 2). Graph drift: `surface.provider-settings` did not record the root plan reconciliation seed; the source/seed and the "to be implemented" invariant were added, with no new Provider state entity.

## 4. Test plan and rulings

2026-09-08: the user asked to cancel the auto jump and notify once only on change, explicitly choosing the "switch to the specific target" button rather than opening a menu; startup first state builds only a baseline, no persistent de-dup, Start filter unchanged; no blocking open ruling. Dimensions: state transition x identity generation x click timing x write result; BigModel/Z.ai as symmetric representatives; theme/language only for readability of the existing Toast and target name (no Toast redesign).

| Case | Setup / action | Must assert | Evidence |
| --- | --- | --- | --- |
| C93-01 | current available plan becomes unavailable, a legal alternative exists | one notice naming the specific target; settings unchanged before the click | observer unit + Electron/disk read |
| C93-02 | repeated same-state refresh, open/close settings, close Toast | no re-notice, no write; opening settings is not a baseline reset | unit + Electron |
| C93-03 | unavailable -> available -> unavailable | the second real loss notifies again | state-sequence unit |
| C93-04 | available -> unknown -> unavailable; initial unknown -> unavailable | the former notifies only on confirmed loss; the latter builds a baseline on the first confirmed state with no notice | unit |
| C93-05 | Team manually switched to an unactivated personal; switch to another Team; change account | no cross-identity comparison; the personal page stays with no automatic write-back; old async results dropped | unit + Electron/disk read |
| C93-06 | startup already saved unavailable; first no selection; legacy connection pending migration | the first neither prompts nor replaces; the other two keep their initialization/migration boundaries | startup unit + cold-start E2E |
| C93-07 | pending -> unavailable; pending -> available | the former notifies, the latter is not a loss; pending is not no entitlement | unit |
| C93-08 | click the specific Team button, then click repeatedly | writes the button's full identity exactly once; View and actual connection agree after success | conditional-write service + Electron |
| C93-09 | after the notice: manual switch away/back, change account, original plan recovers, target becomes invalid | an old suggestion cannot override new intent; no automatic different target committed | controllable async unit + representative E2E |
| C93-10 | no alternative, or alternative query fails | no fake available target, no saved purchase entry, no looping notice or background retry | unit |
| C93-11 | save fails after the click; save succeeds but refresh fails | correctly distinguish whether the setting actually changed; visible error, no fake success/rollback | unit + failed-operation E2E |
| C93-12 | zh/en, light/dark, narrow notice and keyboard | clear target, accessible button; same settings service injected, no phone/desktop message-flow change | Toast/layout representatives |

Pruning: ordinary config revisions and continuing unavailable are not new events; network unknown is not a loss; a non-current plan does not trigger this notice; Off-Peak has no `current` and no automatic suggestion; data migration, model remapping, the Start entry redesign and the claim "start now" are out of scope. E2E: review the existing account fixtures/manual-review flow per e2e-case-lifecycle; isolated data and controllable account responses, no real quota; extend the old SPMC-08 and revoke its "refresh switches automatically" expectation while keeping loss-chain coverage; timing via event/call completion and disk-read assertions, no fixed sleeps; Mac Electron verifies the click and real persistence (a narrow viewport is not a full mobile-remote acceptance).

## 5. Execution and review record (2026-09-08)

- `AccountProviderState.connectionKey` is a same-round digest of account principal, Family and full connection (no plaintext identity/credentials, not in Config, not persisted); ordinary API/Off-Peak get no `current`; unit tests verify the digest is stable, changes on account change, and Config does not include it.
- An independent root hook subscribes to the View; language/page redraws do not rebuild the baseline; settings/account intent changes drop old closures at once; unknown keeps the confirmed baseline; no polling, persistent de-dup or extra config file.
- The startup/observer shared auto fallback is removed: an existing selection is not re-chosen at startup; a first no-selection reuses the original initialization and legacy-pending unknown protection; active OAuth login and its conditional-write regression are kept.
- Suggestions follow the existing priority personal, specific Team, Start; Team is validated for entitlement by the full project and the fixed target is saved. No write before the click; an old suggestion / recovered original plan / invalidated target writes nothing; repeated clicks do not write concurrently. A write failure gives an explicit retry for the same suggestion; a refresh failure after success is not disguised as rollback; long Team names use the Toast with wrapping button text.
- Cleaned: the old `onConnectionReplaced` / `onlyIfProviderId` parameters, the auto-switch copy and the old auto-replacement test expectations; startup cases collapse to two Families x three connections while the independent login-race coverage stays.
- Verification: 6 targeted files 57 tests pass, Toast two files 11 pass; root typecheck pass, lint 0 errors / 40 existing warnings. Pro isolated directory `/Users/dev/zcode-todo93-e2e.88xgST`: SPMC round two 4/4, run `desktop-e2e-20260908-100921-925` (SPMC-08 loss writes nothing, a click save failure, a retry after restoring directory permissions succeeding, disk read; the daily account directory untouched). Round one `desktop-e2e-20260908-100502-105` was 3/4: Todo93's SPMC-08 passed while old SPMC-02 could not find the refresh button after publishing a balance; logs confirmed the background got the new balance and the button vanished normally, so the fixture order was changed (verify the card refresh request first, then publish the balance and verify convergence with the stable global refresh) with no product change and no swallowed failure. Final re-verification including the Toast wrapping change: Pro run `desktop-e2e-20260908-101239-586`, 4/4 (`ZCODE_E2E_MANUAL_REVIEW=1 ZCODE_E2E_SKIP_AGENT_BUILD=1 pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec ./test/e2e/start-plan-manual-claim-experience.test.ts`); old auto-switch results are not evidence for the new rule.
- Not covered: real-account entitlement loss, real mobile remote, Windows UI; fake account/billing fixtures consume no user quota. C93-12's full zh/en, light/dark and phone visuals still need manual review and are not claimed from the desktop pass.

### Pre-push supplementary review (2026-09-08)

The pre-push hook's widened related tests found an omission: `rootAccountRefreshLifecycle.test.ts` mocked React and manually ran only the first effect; after the subscription moved to its own hook it actually ran only the intent-invalidation effect, so error reporting had no subscription (first related regression 469 files pass, 1 file fails: 4721 tests pass, 1 fails, 7 skipped). Only that test changed: it now mounts the full lifecycle with real `renderHook`, with platform/broadcast dependencies and account intent supplied, confirming startup refresh errors are caught, the subscription still exists and is created once, and unmount cleans up exactly. No assertion loosened, production behavior untouched, no re-binding by effect index; the two targeted files pass 7/7, and the existing Pro E2E evidence still corresponds to the unchanged product code.
