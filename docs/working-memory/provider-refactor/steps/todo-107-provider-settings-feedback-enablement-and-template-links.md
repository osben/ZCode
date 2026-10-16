# Todo107: Improve Provider Settings Feedback, Enablement State, and Template Entry Points

> Status: Implementation, combined admission tests, and browser verification at two viewport sizes/themes completed on 2026-09-10. See [batch delivery review](./provider-todos-105-113-delivery-review.md) for implementation/test evidence, item-by-item boundary review, and real-environment limits.

## 1. This Round's Todo Overview

| Todo                                                  | Scope                                                                                                                                  | Status                                                  |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| [105](./todo-105-account-provider-model-list-trim.md) | Remove GLM-5-Turbo and GLM-5.2 from personal/team Account Provider preset lists                                                        | Implemented                                             |
| [106](./todo-106-mcs-capability-rule-correction.md)   | MCS support scope, default Opus 4.8 capability, Start/off-peak MCS and native search, one site rule per URL                            | Implemented                                             |
| This Todo                                             | Delete feedback, close button for connection tests, vertical dragging, API Key entry, Provider `enabled`, and unified status indicator | Implemented; see delivery review for verification scope |

For exact requirements of 105 and 106, see their individual documents; do not maintain a duplicate acceptance checklist here. Implement 106 according to the new principle in [Design V2](../design-v2/design.md): “mainstream configuration, official sources first; do not lower default capabilities for outdated third parties.”

Core product decisions for this Todo have been made. If implementation shows that current interfaces cannot support them or would require changing an approved semantic, record the specific discrepancy rather than reopening settled decisions.

## 2. Delete-Model Feedback Must Match the Actual Action

Symptom: after successfully deleting a model, the UI says “Saved successfully.” The deletion path in `InlineEditableProviderCard.tsx` reused save copy from `runSaveOperation`.

- Reuse existing action feedback, but distinguish in-progress, success, and failure copy for deletion in both Chinese and English. Save actions continue to use save copy.
- Retain the target Provider/model identity; do not delete A and show the result for B.
- Retrying a failure must retry the original delete operation, not turn into a save, and must not affect notices for other actions.
- Show success only after deletion actually succeeds; on failure retain the current error and existing retry semantics.
- Do not add a parallel Toast system or redesign the save transaction to fix copy.

## 3. Consistent Close Controls for Connection-test Notices

- Provide a close button for success and failure, with complete Chinese/English accessible labels.
- Do not provide a close × while testing, to avoid implying that it cancels the test.
- Keep existing auto-dismiss durations: success 3.5 seconds, failure 8 seconds, and no auto-dismiss while in progress.
- Manual close removes only the relevant notice; it does not cancel requests or affect tests/feedback for other models.
- Preserve replacement from pending → success/failure for the same test identity and existing timer cleanup; do not add a second source of state.
- Do not change the approved connection-test prompt, authentication, model selection, or request content.

## 4. Restrict Provider Reordering to Vertical Dragging

Symptom: dragging a Provider row right moves it out of view, and it returns on release. The existing drag transform is not restricted horizontally, while the navigation container clips overflow.

- Continue to allow vertical reordering in Provider navigation but constrain visual drag displacement to the vertical axis so an item cannot be dragged out of view to the right.
- Reuse the current drag mechanism and vertical constraint; do not solve this by removing overflow clipping from the whole panel or enlarging the overlay.
- Preserve the existing sortable-member scope, persistence, and cancellation semantics; do not grant the account group unauthorized sorting capability.
- Preserve click-to-select, keyboard reordering, and keyboard-event boundaries for inputs/dialogs. Account for touch scrolling on phones; sorting must not consume normal vertical scrolling.
- This is limited to Provider navigation sorting; do not rewrite model-list dragging.

## 5. Add “Get API Key” to Preset Templates

The split between ordinary Zhipu/Z.ai API and Coding Plan templates, signing for manually supplied plan keys, and personal/team acquisition entry points are handled by the later [Todo111](./todo-111-zhipu-coding-plan-api-key-and-standard-api-templates.md). The general entry-point rules here still apply. Follow Todo111 for the specific template assignment and links for those providers so the old two-template names do not lead to incorrect links.

- Only preset templates provide this entry; never guess a URL for a user-created Provider.
- Do not hide the entry based on whether an API Key is already present. The URL declared by the template is accessible both with and without a key.
- Inspect every currently maintained template and fill missing entries, explicitly including Kimi from the feedback; do not fix one company and claim the entire set is complete.
- URL priority: stable official API Key management/creation page → official console entry point → official instructions for obtaining a key. Requiring sign-in is normal; anonymous access to the key-management UI is not required.
- Distinguish domestic/international sites and different plans. Do not reuse private URLs containing a user, organization, project, Token, or temporary login state.
- Record official evidence and the check date for each URL. Do not guess an address just to fill a gap. If a direct management page cannot be confirmed, use the higher-level official entry above and state that accurately.
- Keep the URL in the existing template metadata as the single source of truth. The UI reads it and opens it through the platform API; do not maintain another brand URL table in a component.
- Check display and open behavior on desktop and mobile Web; do not expand this round into account sign-in or automatic key retrieval.

## 6. Restore Provider `enabled` and Unify Status Indicators

### 6.1 Field and Write Boundaries

- `enabled` belongs on the outer object of the specific Provider, at the same level as `providerId` and `providerName`. It does not belong in model config or nested `config`, and it is not an Account Family master switch.
- Save the user's toggle through the existing settings-write mechanism to that specific Provider's Personal Overlay/outer rule. Reuse version-conflict, refresh, and distribution mechanisms; do not write files directly or add independent storage.
- A Provider with no `enabled` setting defaults to enabled, determined uniformly by the config/resolution layer. Do not implement UI-local fallbacks or let adding this field disable all existing Providers.
- Reuse current outer Schema/Overlay semantics; do not add compatibility machinery for erroneous intermediate config that has not shipped.
- Disabling does not delete a Provider, clear its Key/address/model config, disable models individually, unbind a plan, or clear any persisted Model Selection.
- Re-enabling preserves each model's existing `enabled` value; the shared resolver recalculates execution eligibility.

### 6.2 Single Source of Judgment

```text
Provider enabled + config completeness + model executability + Account entitlement/current connection facts
                                             |
                                       Shared Resolver
                                             |
                                  Provider enabled / executable
                                             |
                    +------------------------+------------------------+
                    |                        |                        |
                disabled              enabled and executable     enabled but not executable
                  gray                       green                         yellow
```

- **Ordinary API Key access:** retain existing config-completeness and “at least one enabled, executable model” checks. Do not require a successful connection test to show green and do not apply account-entitlement checks.
- **Account access:** retain account execution prerequisites such as entitlement in the shared judgment. Keep current-account constraints for the current single-connection architecture; do not use this Todo to implement the Todo101 multi-connection Draft.
- UI maps the shared result to a color only; do not traverse Keys, plan entitlements, or model lists again to create a second judgment.
- The account-group dot uses the shared result for the specific Provider associated with the current connection; do not use the plan menu's `statusActive` as execution eligibility.
- Green means configuration and current account facts satisfy execution prerequisites; it does not guarantee that the remote service will never fail. Yellow does not necessarily mean the plan is inactive; do not invent a specific failure reason.
- Check that the new `enabled` field is consistent in candidate lists, Registry publication, views of existing selections, and final execution validation. Do not erase a saved selection because it is temporarily not executable.

### 6.3 Toggle Display and Execution Boundaries

- Place the toggle in the Provider-level vendor section, not beside an individual model's toggle.
- In account groups, the toggle controls only the specific Provider for the current connection and makes it clear which current plan is controlled; it does not disable the entire BigModel/Z.ai family.
- Disabling affects subsequent execution eligibility and publication of executable models; do not unbind already selected models, interrupt running tasks, or replace models automatically.
- Provide accurate text or accessible descriptions for gray/yellow/green as well as color; follow `DESIGN.md` for light/dark and narrow screens.

## 7. Acceptance and Execution Granularity

- [x] Update the relevant current spec before implementation; add distinguishing tests first. Reuse existing components, Facade, and Resolver; do not add a parallel decision chain.
- [x] Action feedback: delete/save success and failure, delete-retry identity, manual close for success/failure, parallel feedback for multiple models, timer cleanup.
- [x] Navigation sorting: visible during obvious horizontal drag, vertical sort persists, cancellation makes no write, keyboard and touch scrolling do not regress.
- [x] Template links: every existing template has a destination, shown with/without a Key; no guessed link for custom Providers; correct domestic/international links.
- [x] Provider: unset/default enabled, explicit disabled, incomplete config, no executable models, ready API Key, Account with/without entitlement, and non-current-account combinations match between Settings and shared execution result.
- [x] Disable/re-enable does not lose Key/model state/saved selection; current-plan switch is isolated from other plans; running tasks are not interrupted.
- [x] Add relevant UI E2E for desktop/mobile Web, light/dark, and Chinese/English. Check that Host/Worker existing sync carries service-field changes completely; do not redesign synchronization.
- [x] Verify meaningful batches (feedback/dragging, template entry, Provider enablement) with shared typecheck, lint, relevant unit tests, and necessary desktop checks; do not run full regressions after every small change.
- [x] Review approved requirements, write boundaries, and Provider/Selection abstractions across the batch. Report unverified real environments accurately; a note that something was recorded is not completion evidence.

## 8. Explicitly Excluded / Deferred

- **Banner clipping:** the user asked to ignore this for now; it is not a prerequisite for closing this Todo. The [Pro investigation](./investigation-provider-feedback-clipping-20260910.md) remains “not reproduced, root cause unconfirmed.” Do not casually change blur, stacking, or clipping styles and claim a fix.
- **Still requiring approval after “Full Access”** and **disabled off-peak creation button with Coding Plan**: the user explicitly excluded these; do not investigate or implement them in this round.
- Do not change plan-switch semantics, implement multiple Account Providers in parallel, clean real user data, or publish/push automatically.
