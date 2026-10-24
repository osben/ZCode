# BUG-GWT-004: Worktree setup failure/recovery UI renders raw i18n keys instead of text

- Status: FIXED (retest 2026-10-18, merge b67cc63f; UI-confirmed; marker removed / covered by upstream test)

- Severity: S3 (recovery works and Retry creates the worktree, but the failure step, Retry/Discard buttons and queued-message label are unreadable raw keys; the user cannot tell what failed — workaround: the translated recovery card "Unsent message saved / Restore / Dismiss saved message" and sidebar entry)
- Cases: C5 (forced EACCES failure), C8 (empty repo / unborn HEAD; the step text also never mentions the actual cause — permission denied / unborn HEAD)
- Environment: macOS 27.2, commit bd6a05b3b7dd045d10a47bc7a193a27f86e8f355, isolated QA instance (production build)

## Repro from scratch

Variant A (C5, forced failure):

1. Fixture R1 (`basic`) per QA-PROMPT §4; pre-create `$QA_ROOT/repos/basic-worktrees` and `chmod 555` it.
2. Open `basic` in the QA app; composer -> destination chip -> toggle Worktree ON.
3. Send any message. Wait ~4s for the failed step.

Variant B (C8, empty repo):

1. Fixture R2 (`empty`): `git init -b main`, no commits.
2. Open `empty`; toggle Worktree ON; send any message. Step fails in ~1–2s.

Observed in both: `data-worktree-setup-step="failed"` shows the literal string `worktreeSetup.stepFailed`; buttons read `worktreeSetup.retry` and `worktreeSetup.discard`; queued-message card header reads `worktreeSetup.queuedMessageLabel`; during creation/retry the step reads `worktreeSetup.stepCreating`, and after a successful retry `worktreeSetup.stepReady`.

## Expectation

specs/composer-worktree-setup-steps.md#Preparation states: "`failed` preserves the same session identity and a recoverable error." A recoverable error must be presented as human-readable text (with the failure reason and actionable Retry/Discard), per the same spec's §Timeline presentation (creation status rows rendered in the message column).

## Fact

- Raw untranslated keys instead of text on the failed step and its buttons (C5: `worktreeSetup.stepFailed`, `worktreeSetup.retry` (Retry button), `worktreeSetup.discard` (Discard button), `worktreeSetup.queuedMessageLabel`; after Retry `worktreeSetup.stepReady`; C8 also showed `worktreeSetup.stepCreating` live). Screenshot C5-1-failed-rawkeys.png.
- No failure-cause text at all: nothing about permission denied (C5) or empty repo/unborn HEAD (C8). The `{ reason }` placeholder of `stepFailed` never renders because the id itself is missing; the underlying service failure message is tracked separately (git.createWorktree returned OK on EACCES/unborn — bug class C5-(b)).
- Functional recovery parts ARE present and translated: `composer-worktree-recovery` card ("Unsent message saved", Restore, "Dismiss saved message"), frozen text preserved; after `chmod 755` Retry created the worktree successfully.

Git: no new garbage caused by this bug (C5 orphan branch / stuck-ready are separate bugs C5-(b)/(c)).

## Evidence

- `$QA_ROOT/evidence/C5-1-failed-rawkeys.png` — failed step with raw keys
- `$QA_ROOT/evidence/C8-1-failed-rawkeys.png`, `$QA_ROOT/evidence/C8-2-after-retry.png` — empty-repo failure, Retry loop
- Cases: `$QA_ROOT/cases/C5.md`, `$QA_ROOT/cases/C8.md`

## Cause

Confirmed: `packages/ui/src/v4/ConversationWorktreeSetupSteps.tsx` uses 11 unique `worktreeSetup.*` ids in `intl.formatMessage` calls, but the locale catalogs define only 5. Missing from ALL of `packages/ui/src/i18n/locales/en-US.ts`, `zh-CN.ts`, `uk-UA.ts` (verified by grep and by the test below):

- `worktreeSetup.stepCreating` (lines 210, 245)
- `worktreeSetup.stepFailed` (lines 223, 270)
- `worktreeSetup.stepExisting` (line 258)
- `worktreeSetup.stepReady` (line 261)
- `worktreeSetup.retry` (line 336)
- `worktreeSetup.discard` (line 371)
- `worktreeSetup.stepCreating.baseHead` (line 380)
- `worktreeSetup.queuedMessageLabel` (line 390)
- `worktreeSetup.orphanedNote` (line 399)

Present in catalogs: `worktreeSetup.created` (line 71), `worktreeSetup.connectionUnavailable` (line 239), `worktreeSetup.reconcile.staleCreating|worktreeMissing|markerSyncUnavailable` (used by `packages/ui/src/v4/composer/composerWorktreePipeline.ts`, not this component).

Confirmed (rendering mechanism): `packages/ui/src/i18n/createIntl.ts` — `formatMessage` returns `interpolate(lookup(id) ?? id, values)`: when both the current locale and the `FALLBACK_UI_LOCALE` ("en-US", `packages/shared/src/locale.ts:8`) lack the id, the raw id string is rendered verbatim. No missing-key warning exists, so the gap is silent.

Checked same-family files for the same defect: `packages/ui/src/v4/composer/composerWorktreePipeline.ts` uses only the existing `reconcile.*` ids; `packages/ui/src/v4/composer/ComposerDestinationControl.tsx` uses only the existing `connectionUnavailable`. The gap is confined to `ConversationWorktreeSetupSteps.tsx`.

Coverage gap (why existing tests missed it): `packages/ui/test/i18nCatalogParity.test.ts` only checks locale-vs-locale parity using en-US as reference — a key missing from every locale passes parity.

Hypothesis: none (the cause is confirmed at code and catalog level). Other components of the C5/C8 observations — RPC `git.createWorktree OK` on actual refusal (no reason for `{ reason }`) and no auto-activation after Retry-ready — are hypotheses/bugs of other numbers, not this file.

## Proposed fix

i18n layer: add the 9 missing `worktreeSetup.*` entries (with placeholders `{branch}`, `{path}`, `{reason}` per actual calls) to `en-US.ts`, `zh-CN.ts`, `uk-UA.ts`; no product code change needed. To prevent the defect class from recurring, extend catalog checks with a test "every formatMessage id from the sources exists in en-US" (the new test below already does this for this component). The failure-reason text (EACCES/unborn) additionally requires fixing the createWorktree service (separate bug); otherwise `{reason}` stays empty/generic.

## Test

- `packages/ui/test/worktreeSetupI18n.test.ts` (unit, vitest): parses the source of `ConversationWorktreeSetupSteps.tsx` with the regexp `formatMessage({ id: "…" })` and checks every id against the en-US/zh-CN/uk-UA catalogs; no mocks, no sleep, self-contained.
- Red without the marker: `AssertionError: expected { 'en-US': [ …(9) ], …(2) } to deeply equal { 'en-US': [], 'zh-CN': [], …(1) }` — the 9 missing ids (`worktreeSetup.discard`, `orphanedNote`, `queuedMessageLabel`, `retry`, `stepCreating`, `stepCreating.baseHead`, `stepExisting`, `stepFailed`, `stepReady`) in all 3 locales; 1 failed | 1 passed (2).
- With the marker `it.fails("BUG-GWT-004: …")`: 1 passed | 1 expected fail (2).
- Command: `"$QA_ROOT/bin/real-run.sh" "$NODE_BIN" scripts/run-vitest.mjs run packages/ui/test/worktreeSetupI18n.test.ts`
