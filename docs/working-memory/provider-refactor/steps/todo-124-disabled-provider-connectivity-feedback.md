# Todo124: Connection-Test Entry and Failure Notice for a Disabled Provider

> Status (2026-09-11): implemented, local review, unit tests and shared-browser verification passed; whole-batch final
> acceptance and push were pending; real multi-end integration was not tested.
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/todo-124-disabled-provider-connectivity-feedback.md`

## Problem

After disabling a Provider, settings keep its config and model list, but the Resolver no longer publishes it to the
execution Registry. The model row's test button only checked "testing in progress", empty model ID and callback presence,
not the Provider's enabled state. Clicking ran the connection test through the formal Model creation chain, the Registry
returned `provider-not-found` and the user saw "provider does not exist", wrongly implying the config was lost.

## Rules

1. When the connection test can confirm the Provider is currently not executable, show "this provider is currently
   unavailable, cannot test the connection" instead of reading a disabled state as nonexistent config; when the model
   itself is unavailable show "this model is currently unavailable, cannot test the connection"; Chinese and English.
2. When a Provider is disabled, the model-row test button is greyed out and may hint "enable the provider first"; the
   Provider config and other model-row operations are unchanged.

```text
settings read Provider enabled -> disabled: test button greyed
test call arrives (e.g. state changes after click) -> existing public execution eligibility / formal execution-chain validation
  -> available: test normally;  unavailable: clear notice, no temporary enabling or model replacement
```

Implementation contract: after the existing waitForProviderOperations, read the current Settings Facade eligibility facts.
First judge whether the Provider exists/is enabled, then the target model's own disabled/config problem, then the public
executable; Key/entitlement are not re-queried. A confirmed eligibility failure returns an optional code on
`ModelConnectivityResult.error` (`provider-unavailable` / `model-unavailable`) with a default message and the UI localizes
by code; other error messages are kept as-is. The result belongs to the existing App settings service and the Agent
execution protocol is unchanged; the target environment still keeps the final formal validation after the check.

## Boundaries

- Reuse the existing public config/execution eligibility results; no rewriting of Key, entitlement or model-config rules in
  the UI or test service, and no new state cache or sync wait.
- The notice is handled at the connection-test boundary: no global replacement of the Registry's `provider-not-found`, no
  change of other business error contracts.
- Not every test failure (network, authentication, signature) becomes "unavailable"; real error information is kept, and a
  cause that cannot be confirmed as an eligibility problem is not rewritten.
- No change to Registry publication rules, ModelFactory final validation or the principle that connection tests reuse the
  formal request chain; no silent enabling of the Provider, no bypassing config, no model switch, no clearing saved selections.
- Similar single-model-disabled problems are checked along the way, not expanded into redoing all test-button states or the
  error system. Desktop and phone share the settings entry; layout and remote transport boundaries are unchanged.

## Acceptance (done) and Review

Spec updated first, discriminating tests first; after disabling a Provider the test button cannot trigger, and re-enabling
restores per existing conditions without changing each model's own state; a direct call to the test entry, or a Provider
disabled after the click, gives the provider-unavailable notice with no model request bypassing the disable; model-own
unavailability is distinguished from Provider unavailability while normal tests and network/authentication/signature errors
are unaffected; settings interaction E2E covers disable, re-enable and the notice for shared desktop/phone and i18n
(unfinished environment verification recorded); related unit tests, typecheck and lint in one batch.

Result: Provider `enabled` flows from the card along the existing list to the test button, and disabling affects only the
test button (re-enabling keeps each model's own state and config). The service reads the Settings Facade's current public
facts after the existing operation queue finishes; an ineligible case does not call the formal test, and a known
Provider/Model eligibility error returns a local stable code for UI Chinese/English rendering. No Key/entitlement check was
copied, no global Registry error change, no state wait. Later formal request failures are returned as-is and the target
Environment keeps its final validation; no promise that config never changes after one read, and no wait for cross-process
strong consistency. 4 service failure cases failed first; run together with 119, 74 passed; after adding the missing
Provider/Model and upstream-signature-error-not-rewritten cases, the service's 10 pass (overlapping with the previous
batch). 4 shared-browser cases pass (disable / re-enable, Chinese/English, two themes, phone and desktop sizes). Root
typecheck/lint and architecture pass; review found no model-request bypass, auto-enabling, selection rewrite or
remote-control protocol change. Real Host / phone shared-host integration not tested; the final batch still needed delivery
review.

## Code Entries

`packages/ui/src/settings/model-provider-section/ProviderFormControls.tsx` (model-row test button condition),
`InlineEditableProviderCard.tsx`, `ProviderCardSections.tsx` (Provider state and test callback passing),
`packages/services/src/model-provider/providerFacadeServices.ts`, `providerSettingsConnectivity.ts` (connection test
service entry and error return), `apps/zcode-cli/packages/bootstrap/src/app/session-facade.ts` (auxiliary level
completion and formal connection test entry), `packages/provider/src/resolver.ts`, `registry.ts` (existing execution
eligibility and validation facts, not changed in principle).
