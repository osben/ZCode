# Todo119: Restore Green Success Feedback for Connection Tests and Use the Provider Display Name

> Status: Implemented on 2026-09-11 with focused review, unit tests and shared-browser verification passed; final
> acceptance of the full batch and push were pending; no real mobile shared-host / Pro integration test was done.
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/todo-119-connectivity-feedback-style-and-provider-name.md`

## Confirmed Root Causes

- The success banner used green text, light-green background and green border. `31231492a8` changed shared
  Provider-success feedback to neutral styling, keeping only the green check icon; the later `aa0d7970cd` added a close ×
  without changing colors (two separate causes).
- The connection test in `ProviderFormControls.tsx` passed `provider: providerId` directly for in-progress, success,
  returned-failure and exception branches instead of the display name; not a normal fallback for a missing name.

## Rules

1. Successful connection tests show green feedback again (green text, light-green background, green border from project
   semantic colors), keeping the close ×, the auto-dismiss duration and the ability to retry. Failure and in-progress states
   are not redesigned.
2. Every connection-test notice uses the existing Provider display-name resolution: the name first, the Provider ID only
   when the name is actually missing, via `getProviderFormLabel` and the current View (no per-account-type name table). A
   test rerun after renaming shows the new name.
3. The display name is used only in copy. Provider ID stays for request parameters, feedback-dedup keys, model
   identification, config persistence and log identity; model ID is unchanged.
4. The shared feedback component is reused (no duplicated banner); it also serves save/delete feedback, whose styles must
   not change. If success styling needs distinguishing, use the smallest explicit presentation input, not business type
   inferred from copy or dedup keys.
5. No change to the test prompt, signature, authentication, model resolution, Provider draft submission or request
   execution logic, and no other unconfirmed banner issues.

```text
click connection test -> Provider ID / Model ID: existing test request and feedback identity
                      -> Provider display name: in-progress / success / failure notice (success: green feedback + close ×)
```

## Acceptance (done) and Review

Tests first: success banner has semantic colors, check icon and close button together; failure/in-progress feedback,
auto-dismiss and close stay correct. Custom names, account Provider names, missing-name fallback and the renamed value on a
later test across success, returned failure and exception branches, with requests still using the original ID.
Shared-interaction E2E for desktop and mobile Web, Chinese/English, light/dark, long-name wrapping and a clickable close
button (no full product regression). Shared save/delete banners not recolored and config-save-before-test ordering
unchanged. Relevant tests, typecheck, lint and architecture check as a batch.

Result: the display name flows through `getProviderFormLabel` along the card -> model list -> test row path, and all four
result messages use it; dedup keys and request parameters stay the original ID; the missing-name fallback is unchanged.
Only a `successEmphasis` presentation input was added to shared feedback, enabled for connection-test success; save/delete
stay neutral; close and timer behavior untouched. Five tests failed before and pass after; with Todo124, Hook and service
tests 74 pass (success, returned error, thrown exception, retry after the name passes through, empty-name fallback, actual
request identity, existing neutral-save assertion). Four browser checks pass (shared account/manual cards, 390px Chinese
light and 1200px English dark) for the green class, actual non-transparent background, name, close action and delete retry.
Real mobile/Pro not tested. Root typecheck, lint (0 errors / 41 warnings) and architecture (0 violations) pass; review
found no change to test prompts, authentication, signatures, draft timing or request timing; the final batch still needed
delivery review.
