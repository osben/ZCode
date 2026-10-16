# Todo119: Restore Green Success Feedback for Connection Tests and Use the Provider Display Name

> Status: Implemented on 2026-09-11; focused review, unit tests, and shared-browser verification passed. Final acceptance of the full batch and push were pending; no real mobile shared-host / Pro integration testing was done.

## Confirmed Root Causes

- The success banner previously used green text, a light-green background, and a green border. `31231492a8` changed shared Provider-success feedback to neutral styling, retaining only the green check icon; the later `aa0d7970cd` added a close × without changing colors. These changes must not be conflated as one cause.
- The connection test in `ProviderFormControls.tsx` passed `provider: providerId` directly for in-progress, success, returned failure, and exception branches; it did not use the Provider display name. This was not a normal fallback caused by a missing name.

## Approved Changes

1. Restore green feedback for successful connection tests: green text, light-green background, and green border using project semantic colors. Keep the close ×, existing auto-dismiss duration, and ability to retry tests. Do not use this as an opportunity to redesign failure or in-progress states.
2. Use the existing Provider display-name resolution for every connection-test notice: prefer the name and fall back to the Provider ID only when the name is actually missing. Reuse `getProviderFormLabel` and the current View; do not make another name table based on account type. A test rerun after renaming must show the new name.
3. Use the display name only in copy. Continue using Provider ID for request parameters, feedback-deduplication keys, model identification, configuration persistence, and log identity. Keep the model ID unchanged.
4. Reuse the shared feedback component; do not duplicate a banner. The component also handles save/delete feedback, whose existing styles must not change accidentally. If success styling needs to be distinguished, use the smallest explicit presentation input; do not infer business type from copy or deduplication keys.
5. Do not change the test prompt, signature, authentication, model resolution, Provider draft submission, or request execution logic. Do not include other banner issues that have not been confirmed.

```text
Click connection test
  ├─ Provider ID / Model ID → existing test request and feedback identity
  └─ Provider display name  → in-progress / success / failure notice
                               └─ success: green feedback + close ×
```

## Acceptance and Review

- [ ] Add tests first: the success banner has semantic colors, check icon, and close button together; failure/in-progress feedback, auto-dismiss, and close behavior remain correct.
- [ ] Verify custom names, account Provider names, fallback for missing names, and displaying the renamed value on a later test. Cover success, returned failure, and exception branches; requests still use the original ID.
- [ ] Update shared-interaction E2E for desktop and mobile Web, Chinese/English, light/dark themes, long-name wrapping, and a clickable close button; do not expand to a full product regression.
- [ ] Confirm shared save/delete banners were not recolored and the ordering of config save before a connection test is unchanged.
- [ ] Run the relevant tests, typecheck, lint, and architecture check as a batch. Review this Todo fully and record evidence and untested limits before marking it complete.

## Implementation and Review

- Passed the display name through `getProviderFormLabel` along the card → model list → test row path. All four result messages use the name; deduplication keys and model request parameters remain the original ID. The existing fallback for a missing name is unchanged.
- Added only a `successEmphasis` presentation input to shared feedback and explicitly enabled it for connection-test success. Save/delete remain neutral. Close and timer behavior were not rewritten.
- Five tests failed before the fix and passed afterward. Together with Todo124, Hook, and service tests, 74 tests passed, covering success, returned error, thrown exception, retry after the name was passed through, empty-name fallback, and actual request identity. The existing neutral-save-style assertion also passed.
- Four browser checks passed (shared account/manual cards, 390px Chinese light and 1200px English dark), verifying the green class and actual non-transparent background, name, close action, and delete retry. Real mobile/Pro were not tested; do not claim full-platform acceptance.
- Root typecheck, lint (0 errors / 41 warnings), and architecture check (0 violations) passed. A line-by-line review found no changes to test prompts, authentication, signatures, draft timing, or request timing; the final batch still needs delivery review.
