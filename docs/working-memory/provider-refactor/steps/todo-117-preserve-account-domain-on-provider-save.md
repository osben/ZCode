# Todo117: Preserve the Account Domain When Saving a Provider, Complete Plan Selection, Remove Account Disablement

> Status: Implemented on 2026-09-11 with focused review, related unit tests and shared-browser verification passed; final
> acceptance of the full batch and push were pending. No real mobile shared-host / Pro integration test was run.
>
> Latest decision (2026-09-11): Built-in account Providers cannot be disabled. This supersedes the earlier rule that only
> hid the entry while an existing `enabled=false` stayed effective. Manual-key Providers, including instances created from
> presets, may still be enabled/disabled.
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/todo-117-preserve-account-domain-on-provider-save.md`

## Background and Root Cause

Air logs show that after saving the Provider Overlay at 15:12:34, `providerFamilyDomain` was cleared from `bigmodel`. The
user then selected a team; entitlement was true but the account domain was missing, so Account State `current=false` made
plan models unavailable. The logs do not record the full save arguments, so they do not prove which control was clicked.

`ModelProviderSection.handleSave()` cleared the account domain based on the saved Provider's `executable` status,
conflating execution eligibility with the user's connection selection. Switching plans writes only the plan selection and
cannot restore the domain. Settings may look right by falling back to the login identity while the Host's persisted
selection is incomplete.

## Approved Changes

### 1. Remove Automatic Clearing After Save

Saving a Provider saves only its config and updates the existing view/required refresh. The branch clearing the account
domain when the current domain has no executable Provider is removed, together with `hasUsableProviderInFamilyDomain` and
dependencies only it used. Disabled state, missing Key, missing entitlement or incomplete config affect execution
eligibility only, never account selection, timestamps or migration markers. Normal clearing on logout/unbinding stays; the
Overlay merge is unchanged.

### 2. Save the Complete Selection on an Explicit Plan Switch

```text
User explicitly selects BigModel Team (including re-selecting the current item)
  -> compare account domain and complete plan identity
  -> if changed / domain missing: update Settings once (providerFamilyDomain = bigmodel; connectionSelections.bigmodel = selected team identity)
  -> reuse existing Provider refresh and shared execution-eligibility check
```

- Existing plan-identity fields (kind, organization, project, product) and the other domain's selection are preserved; no
  new identity structure.
- "Selection unchanged" compares both domain and plan; re-selecting the same item may fill a missing domain; when both
  already match the existing retry/dedup semantics stay. The domain is written with existing Settings timestamps and
  migration-marker conventions; no state field is added.
- Only an explicit user choice triggers it. Opening the page, automatic hydration, background refresh or entitlement
  changes never choose a domain or plan automatically.
- The audit found that after refreshing a team subscription the page automatically changed an invalid team to personal.
  That conflicts with the rule above, so the automatic switching and its helper are removed too; entitlement failure stays
  visible through shared eligibility and never causes a plan switch.
- If the target is unavailable the shared judgment reports it so; the Resolver is not loosened, no model is silently
  replaced and no Provider is enabled.

### 3. Remove Master Disablement for Account Providers

- `access.type === "zhipu-account"` decides that an account Provider shows no Provider-wide toggle in Settings (no
  name or hard-coded Provider ID checks). `api-key` and `zhipu-coding-plan-api-key` keep the master toggle (a manually
  supplied Coding Plan Key is not an account connection).
- Built-in account Providers cannot be disabled: the UI hides the entry, the shared config-write boundary rejects new
  disable operations, and shared resolution treats an existing account `enabled=false` as no longer effective. Hiding the
  switch while leaving an unrecoverable disabled state is not enough; Settings and execution eligibility read the same
  result and the UI never fakes "enabled".
- The generic outer Provider `enabled` schema and manual-key semantics stay. No Family switch, state cache or data
  migration; existing account disable values lose their effect without bulk file deletion or changing real user data,
  implemented at the shared config/resolution boundary.
- "Cannot be disabled" is not "always executable": current connection, entitlement, credentials, config completeness and
  available models are still checked; `executable=true` is never forced. Per-model enable/disable is unchanged and pinned
  running execution is unaffected.
- This supersedes the former requirement to show and honor enable/disable for account Providers and pairs with Todo118 so
  initial migration does not import old disable values for built-in accounts. Todo115's detail-header, menu and manual-key
  toggle layout are not part of this round.

## Scope and Acceptance

No refactor of single connections, account sync, authentication, Registry, Model Selection or initial migration (Todo118);
only the account non-disable constraint at the shared write/parse boundaries; no automatic inference. Desktop and mobile
Web reuse shared components and Settings services with no Host/Agent change and no continuous/replayable change;
untested platforms are recorded. Acceptance (tests first, then implementation, review with evidence and untested limits):

- Saving a Provider in the current domain does not additionally clear the account domain or change plan when it is
  disabled, lacks entitlement or is incomplete and no Provider is executable.
- Plan interaction: both account domains; re-selecting the same item restores a missing domain; switching plan/team
  identity; dedup for an identical complete selection; no writes during background refresh.
- Recovering a missing domain allows team models again when the original shared eligibility permits; missing entitlement
  or a non-current connection stays non-executable, as does a disabled manual-key Provider.
- Existing account `enabled=false` no longer disables the Provider; a new account disable is rejected at the official
  write entry; Settings view and shared execution result agree; covers personal, team, Start and off-peak accounts of both
  families; per-model disabled stays effective.
- Shared UI interaction: account Providers have no master switch; both manual-key Provider types have a switch and save
  correctly; per-model switch unchanged; Chinese/English and desktop/mobile widths.
- The three focused fixes with obsolete branches/dependencies removed; no expansion to other issues; batched unit tests,
  interaction E2E, typecheck, lint and architecture checks. Real user config changes need separate authorization.

## Implementation and Review (2026-09-11)

- Save writes only the Provider; clearing the domain by `executable` and the dedicated helper are gone. An explicit plan
  switch writes the complete domain/identity, timestamp and migration marker in one update; dedup uses the persisted domain
  rather than the display fallback. Logout behavior is unchanged.
- A mounted React regression also reproduced "background team list empty -> automatically save personal"; that effect, its
  helper and the obsolete test were removed (`dep:refs` found only that business call; test references checked with `rg`).
  The team list still displays and eligibility still comes from the shared result; no account query or automatic switching was added.
- The shared Resolver ignores a legacy account `false`; shared save rejects a new account `false`; no old data is deleted.
  Settings Facade and Registry use the same resolution. Coverage: two families across four modes, no entitlement /
  non-current, per-model disabled, disabled manual Keys.
- A batched suite of 503 tests passed; after adding assertions for system-disabled reasons / missing Keys and team-project
  changes, 18 tests passed on rerun (overlapping, counts not added). Four real-browser card cases passed (Chinese/English,
  light/dark, 390px/1200px): account has no master switch but keeps the per-model switch; manual-key enable/disable, Key
  retention, single links and error retry do not regress.
- Root typecheck passed; lint 0 errors / 41 warnings; architecture 0 violations. Browser startup first lacked `libatk`;
  tests ran with existing isolated dependencies at `/tmp/zcode-xvfb-LMxR8B/root/usr/lib/x86_64-linux-gnu`; no system or
  user config changed.
- Scope review found no change to Model Selection, execution objects, account sync, Overlay merging or the remote-control
  protocol. Page-callback/mount tests and shared-card browser coverage do not represent real Host/mobile integration; final
  batch delivery review was pending.
