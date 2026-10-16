# Todo117: Preserve the Account Domain When Saving a Provider, Complete Plan Selection, and Remove Account Disablement

> Status: Implemented on 2026-09-11; focused review, related unit tests, and shared-browser verification passed. Final acceptance of the full batch and push remained pending. No real mobile shared-host / Pro integration testing was run and it is not counted as tested.

> Latest decision (2026-09-11): Built-in account Providers cannot be disabled. This supersedes the earlier rule that only hid the entry point while allowing existing `enabled=false` to remain effective. Manual-key Providers, including instances created from presets, may still be enabled/disabled.

## Background and Root Cause

Air logs show that after saving the Provider Overlay at 15:12:34, `providerFamilyDomain` was cleared from `bigmodel`. The user then selected a team; entitlement was true, but the account domain was still missing, so Account State `current=false` made plan models unavailable. The logs did not record complete arguments for that save, so they do not prove which control the user clicked.

`ModelProviderSection.handleSave()` cleared the account domain based on the saved Provider's `executable` status, conflating execution eligibility with the user's connection selection. Switching plans writes only the plan selection and cannot restore the account domain. Settings may look correct by falling back to the login identity, but that does not mean the Host's persisted selection is complete.

## Approved Changes

### 1. Remove Automatic Clearing After Save

- Saving a Provider saves only its config and updates the existing view/required refresh. Remove the branch that clears the account domain because there is no executable Provider in the current domain.
- Remove `hasUsableProviderInFamilyDomain` and unused dependencies used only by that branch.
- Disabled state, missing Key, missing entitlement, or incomplete config affect execution eligibility only; they do not change account selection, timestamps, or migration markers.
- Keep normal clearing on logout/unbinding. Do not change Overlay merge behavior.

### 2. Save the Complete Selection When the User Explicitly Switches Plans

```text
User explicitly selects BigModel Team (including selecting the current item again)
  → compare account domain and complete plan identity
  → if changed / account domain missing: update Settings once
       providerFamilyDomain = bigmodel
       connectionSelections.bigmodel = selected team identity
  → reuse existing Provider refresh and shared execution-eligibility check
```

- Preserve existing plan-identity fields such as kind, organization, project, and product. Preserve the other account domain's selection; do not invent a new identity structure.
- “Selection unchanged” must compare both account domain and plan. Selecting the same item again may fill a missing account domain. When both already match, retain existing retry/deduplication semantics.
- Write the account domain using existing Settings timestamps and migration-marker conventions; add no state field.
- Trigger only on an explicit user choice. Opening the page, automatic hydration, background refresh, or entitlement changes must not automatically choose a domain or plan.
- Implementation audit found that after refreshing a team subscription, the current page automatically changed an invalid team to personal. This effect directly conflicts with the preceding rule; remove automatic switching and its dedicated helper in this item too. Entitlement failure remains visible through shared eligibility checks and must not cause a plan switch.
- If the target is unavailable, the shared judgment reports it unavailable; do not loosen the Resolver, silently replace a model, or enable a Provider.

### 3. Remove Master Disablement for Account Providers

- Use `access.type === "zhipu-account"` to determine that an account Provider should not show a Provider-wide toggle in Settings. Do not check its name or hard-coded Provider ID.
- Retain the master toggle for `api-key` and `zhipu-coding-plan-api-key`; a manually supplied Coding Plan Key is not an account connection.
- Built-in account Providers cannot be disabled. The UI hides the entry, the shared config-write boundary rejects new disable operations, and shared resolution treats an existing account `enabled=false` as no longer effective. Merely hiding the switch while leaving an unrecoverable disabled state is insufficient. Settings and execution eligibility must read the same result; do not fake “enabled” only in the UI.
- Keep the generic outer Provider `enabled` Schema and manual-key semantics. Add no Family switch, state cache, or data migration. Existing account disable values can lose their disabling effect without bulk file deletion or changing real user data; implement through the shared config/resolution boundary.
- “Cannot be disabled” does not mean “always executable.” Shared checks for current connection, entitlement, credentials, config completeness, and available models still apply; do not force `executable=true` for accounts.
- Per-model enable/disable controls remain unchanged; do not affect pinned running execution.
- This decision supersedes the former requirement to show and honor enable/disable controls for account Providers. It pairs with Todo118 so initial migration does not import old disable values for built-in accounts. Do not use this round to include Todo115's separate detail-header, menu, and manual-key-toggle layout changes.

## Scope and Acceptance

- Do not refactor single connections, account synchronization, authentication, Registry, Model Selection, or initial migration. Add only the account non-disable constraint at the shared write/parse boundaries; Todo118 owns initial migration. Do not add automatic inference.
- Desktop and mobile Web reuse shared components and Settings services; do not add Host/Agent or change continuous/replayable boundaries. Record any untested platforms.
- [ ] Add tests first: saving a Provider in the current domain does not additionally clear the account domain or change plan when it is disabled, lacks entitlement, or is incomplete and there are no executable Providers.
- [ ] Add plan-interaction tests: both account domains, selecting the same item to restore a missing domain, switching plan/team identity, preserving deduplication for an identical complete selection, and no writes during background refresh.
- [ ] Verify recovery from a missing domain allows team models again when original shared eligibility permits it; missing entitlement or a non-current connection remains non-executable, as does a disabled manual-key Provider.
- [ ] Existing account `enabled=false` no longer disables that Provider. Reject a new account disable through the official write entry point. Settings view and shared execution result agree; do not fake success in UI. Cover personal, team, Start, and off-peak accounts and both families; per-model disabled remains effective.
- [ ] Add shared UI interaction tests: account Providers have no master switch; both types of manual-key Provider have a switch and save correctly; per-model switch behavior is unchanged. Cover Chinese/English and desktop/mobile widths.
- [ ] Implement the three focused fixes and remove obsolete branches/dependencies; do not expand to other existing issues.
- [ ] Batch related unit tests, interaction E2E, typecheck, lint, and architecture checks; review against runtime evidence without repeating broad regressions for each small item.
- [ ] Review every requirement in this Todo, record evidence and untested limits, and commit before marking complete. Changes to real user config require separate authorization.

## Implementation and Item-by-item Review (2026-09-11)

- Save now writes only the Provider. Removed clearing the domain based on `executable` and the dedicated helper. Explicit plan switching writes complete account domain/identity, timestamp, and migration marker in the same update; deduplication uses persisted domain rather than the display fallback. Existing logout behavior remains.
- A mounted React regression also reproduced “background team list empty → automatically save personal.” Removed that effect, its helper, and obsolete test. `dep:refs` across the repository found only that business call; checked test references separately with `rg`. The team list still displays normally and eligibility still comes from the shared result. Added no account query or automatic plan switch.
- The shared Resolver ignores a legacy account `false`; shared save rejects a new account `false`; no old data is deleted. Settings Facade and Registry use the same resolution. Coverage included two families across four modes, no entitlement/non-current, per-model disabled, and disabled manual Keys.
- A batched suite of 503 tests passed. After adding assertions for system-disabled reasons/missing Keys and team-project changes, 18 tests passed on rerun (overlap exists; do not add counts). Four real-browser card cases passed in Chinese/English, light/dark, at 390px/1200px: account has no master switch but retains per-model switch; manual-key enable/disable, Key retention, single links, and error retry do not regress.
- Root typecheck passed; lint had 0 errors / 41 warnings; architecture had 0 violations. Browser startup first lacked `libatk`; tests ran using existing isolated dependencies at `/tmp/zcode-xvfb-LMxR8B/root/usr/lib/x86_64-linux-gnu`. No system or user config was changed.
- Scope review found no changes to Model Selection, execution objects, account synchronization, Overlay merging, or remote-control protocol. Page-callback/mount tests and shared-card browser coverage do not represent real Host/mobile integration; final batch delivery review remained pending.
