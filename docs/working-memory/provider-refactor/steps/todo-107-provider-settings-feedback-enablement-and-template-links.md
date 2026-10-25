# Todo107: Provider Settings Feedback, Enablement State and Template Entry Points

> Status: Completed (2026-09-10): implementation, combined admission tests and browser verification at two viewport
> sizes/themes. Evidence, boundary review and real-environment limits: [delivery review](./provider-todos-105-113-delivery-review.md).
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/todo-107-provider-settings-feedback-enablement-and-template-links.md`

## 1. Round Overview

| Todo                                                  | Scope                                                                                                                      | Status      |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------- |
| [105](./todo-105-account-provider-model-list-trim.md) | Remove GLM-5-Turbo and GLM-5.2 from personal/team Account Provider preset lists                                            | Implemented |
| [106](./todo-106-mcs-capability-rule-correction.md)   | MCS scope, default Opus 4.8 capability, Start/off-peak MCS and native search, one site rule per URL                        | Implemented |
| This Todo                                             | Delete feedback, close button for connection tests, vertical dragging, API Key entry, Provider `enabled`, status indicator | Implemented |

105/106 requirements live in their own documents. 106 follows the [Design V2](../design-v2/design.md) principle
"mainstream configuration, official sources first; do not lower default capabilities for outdated third parties". If
implementation shows an approved semantic cannot be supported, record the discrepancy instead of reopening decisions.

## 2. Delete-Model Feedback Matches the Action

The deletion path in `InlineEditableProviderCard.tsx` reused save copy from `runSaveOperation`, so a successful delete said
"Saved successfully".

- Reuse existing action feedback but give deletion its own in-progress/success/failure copy in Chinese and English; save keeps save copy.
- Keep the target Provider/model identity (never show B's result for deleting A).
- Retrying a failure retries the original delete (not a save) and does not affect other actions' notices.
- Success is shown only after deletion succeeds; on failure keep the current error and retry semantics.
- No parallel Toast system and no redesign of the save transaction.

## 3. Close Controls for Connection-Test Notices

- Success and failure notices have a close button with full Chinese/English accessible labels; none while testing (so it
  does not imply cancellation).
- Auto-dismiss durations stay: success 3.5 s, failure 8 s, none while in progress.
- Manual close removes only that notice; it does not cancel requests or affect other models' tests/feedback.
- Pending -> success/failure replacement for the same test identity and timer cleanup are preserved; no second state source.
- Connection-test prompt, authentication, model selection and request content are unchanged.

## 4. Provider Reordering Restricted to Vertical Dragging

Dragging a Provider row right moved it out of view (the drag transform was not horizontally restricted and the nav
container clips overflow).

- Keep vertical reordering in Provider navigation but constrain visual drag displacement to the vertical axis; reuse the
  current drag mechanism rather than removing overflow clipping or enlarging the overlay.
- Sortable-member scope, persistence and cancellation semantics are unchanged; the account group gets no sorting.
- Click-to-select, keyboard reordering and input/dialog keyboard-event boundaries are preserved; on phones sorting must
  not consume normal vertical scrolling.
- Only Provider navigation sorting; model-list dragging is not rewritten.

## 5. "Get API Key" on Preset Templates

The split between ordinary Zhipu/Z.ai API and Coding Plan templates, signing of manually supplied plan keys and
personal/team acquisition entries is in [Todo111](./todo-111-zhipu-coding-plan-api-key-and-standard-api-templates.md);
follow it for those providers' template assignment and links. General rules:

- Only preset templates provide the entry; never guess a URL for a user-created Provider; the entry is shown with or
  without an existing key.
- Every maintained template is inspected and gaps filled (explicitly including Kimi); one company is not fixed and called complete.
- URL priority: stable official API Key management/creation page, then official console entry, then official instructions
  for obtaining a key. Sign-in required is fine. Domestic/international sites and plans are distinguished; no private URLs
  with user, organization, project, Token or temporary login state.
- Record official evidence and check date per URL; no guessed address; if no direct management page can be confirmed, use
  the higher-level official entry and state that accurately.
- The URL lives in the existing template metadata as the single source; the UI reads it and opens it through the platform
  API; no brand URL table in a component. Check display and open behavior on desktop and mobile Web; no account sign-in or
  automatic key retrieval.

## 6. Provider `enabled` and Unified Status Indicator

### 6.1 Field and Write Boundaries

- `enabled` is on the outer object of the specific Provider (same level as `providerId` and `providerName`), not in model
  config or nested `config`, and not an Account Family master switch.
- The toggle is saved through the existing settings-write mechanism to that Provider's Personal Overlay/outer rule,
  reusing version-conflict, refresh and distribution mechanisms; no direct file writes or independent storage.
- A Provider with no `enabled` defaults to enabled, decided by the config/resolution layer (no UI-local fallback; adding
  the field must not disable existing Providers). Current outer Schema/Overlay semantics are reused; no compatibility for
  unshipped erroneous intermediate config.
- Disabling does not delete the Provider, clear Key/address/model config, disable models individually, unbind a plan or
  clear any persisted Model Selection. Re-enabling preserves each model's `enabled`; the shared resolver recomputes
  execution eligibility.

### 6.2 Single Source of Judgment

```text
Provider enabled + config completeness + model executability + Account entitlement/current connection facts
  -> Shared Resolver -> Provider enabled / executable
  -> disabled: gray;  enabled and executable: green;  enabled but not executable: yellow
```

- Ordinary API Key access: keep the config-completeness and "at least one enabled, executable model" checks; a successful
  connection test is not required for green; no account-entitlement check.
- Account access: keep account execution prerequisites such as entitlement and the current-account constraint of the
  single-connection architecture; the Todo101 multi-connection draft is not implemented.
- The UI maps the shared result to color only (no second judgment from Keys, plan entitlements or model lists). The
  account-group dot uses the shared result of the specific Provider tied to the current connection, not the plan menu's `statusActive`.
- Green means configuration and current account facts satisfy execution prerequisites, not that the remote service never
  fails; yellow does not necessarily mean the plan is inactive and no failure reason is invented.
- `enabled` must be consistent across candidate lists, Registry publication, views of existing selections and final
  execution validation; a saved selection is not erased because it is temporarily not executable.

### 6.3 Toggle Display and Execution Boundaries

- The toggle sits in the Provider-level vendor section, not beside a model toggle. In account groups it controls only the
  specific Provider for the current connection and says which plan is controlled; it never disables the whole BigModel/Z.ai family.
- Disabling affects subsequent execution eligibility and executable-model publication; it does not unbind selected
  models, interrupt running tasks or replace models.
- Gray/yellow/green carry accurate text or accessible descriptions besides color; follow `DESIGN.md` for light/dark and narrow screens.

## 7. Acceptance (all done)

Spec updated first with distinguishing tests; existing components/Facade/Resolver reused. Covered: delete/save success and
failure feedback, delete-retry identity, manual close, parallel feedback for several models, timer cleanup; navigation
sorting (visible under horizontal drag, vertical sort persists, cancel writes nothing, keyboard/touch scrolling do not
regress); template links (every template has a destination, shown with/without Key, none for custom Providers, correct
domestic/international); Provider status matrix (unset/default enabled, explicit disabled, incomplete config, no
executable models, ready API Key, Account with/without entitlement, non-current-account combinations match between
Settings and the shared result); disable/re-enable keeps Key/model state/selection, plan switches are isolated, running
tasks are not interrupted; UI E2E for desktop/mobile Web, light/dark, Chinese/English; Host/Worker existing sync carries
the field completely; batches verified with shared typecheck, lint, unit tests and necessary desktop checks; batch review
of requirements, write boundaries and Provider/Selection abstractions with unverified real environments reported accurately.

## 8. Excluded / Deferred

- Banner clipping: ignored by the user for now, not a prerequisite for closing. The
  [Pro investigation](./investigation-provider-feedback-clipping-20260910.md) stays "not reproduced, root cause
  unconfirmed"; blur, stacking or clipping styles are not changed casually.
- "Still requiring approval after Full Access" and "disabled off-peak creation button with Coding Plan": explicitly excluded.
- No change to plan-switch semantics, no parallel multiple Account Providers, no cleaning of real user data, no automatic publish/push.
