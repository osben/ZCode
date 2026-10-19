# UI test language and copy convention

## Default locale

UI component and browser tests use `en-US` as their deterministic default locale. A test may use another locale only when locale resolution, language switching, locale-specific formatting, or a translated catalog is the behavior under test. Such tests must be listed in the locale-test allowlist below and must state which locale behavior they cover.

Test setup must not select `zh-CN` merely to make translated UI copy predictable. The English catalog is the canonical source for UI copy expected by tests.

## Locating elements

Do not locate UI elements by visible copy, whether English or translated. Prefer the shared `TID_*` constants from `packages/shared/src/test-ids.ts` and the existing platform selector helper (`getByTestId` in Testing Library or `sel(TID_...)` in desktop E2E). Use semantic roles when the role and accessible state are the behavior under test and the accessible name is not a changeable copy string. Add a shared test ID when neither option gives a stable selector.

## Asserting content

When displayed content itself is relevant, derive expected UI copy from the English catalog with `expectedCopy("catalog.key", values?)`; do not hard-code localized literals. This keeps tests coupled to the catalog key and interpolation contract, not to a particular sentence. Missing keys must fail clearly. Test user-provided content, protocol values, identifiers, fixture data, and formatting outputs directly when those values—not UI copy—are the behavior under test.

Tests should prefer stable DOM state (`data-state`, `data-status`, `aria-*`, input values) for behavior and state assertions instead of copy.

## Locale-test allowlist

Only tests whose subject is locale behavior may deliberately set a non-English locale. Keep the allowlist explicit and narrow; adding an entry requires a short reason in the test and in this list.

Initially allowed categories/files:

- `packages/ui/test/i18nCatalogParity.test.ts` — validates catalog parity.
- `packages/ui/test/localeContentCatalogs.test.ts` — validates locale-specific catalog content.
- `packages/ui/test/localeFormatting.test.ts` — validates locale-sensitive formatting.
- `packages/ui/test/localeSettingsSchema.test.ts` and `packages/ui/test/localeSupport.test.ts` — validate locale preference/schema and locale resolution.
- `packages/ui/test/intlProviderLocalePreference.test.ts` — validates how the intl provider resolves and persists the locale preference.
- `packages/desktop/test/e2e/settings/settings-language-system-default.test.ts` — validates host system locale resolution.
- `packages/web/test/conversationShareLandingPage.test.ts` — explicitly verifies the share-status locale marker for English and Chinese locale inputs.
- `packages/desktop/test/e2e/help-client-config.test.ts` — validates locale-specific help URL selection.
- `packages/desktop/test/e2e/help-menu-about.test.ts` — validates the Chinese-localized Help menu and About entry.
- `packages/desktop/test/e2e/settings/settings-ui-polish.test.ts` — compares locale-specific presentation and layout.
- `packages/desktop/test/e2e/plugins/manual-review/pending/plugin-localization-creator.test.ts` — validates plugin localization behavior.
- `packages/desktop/test/e2e/bots/feishu-bound-groups-ui.test.ts`, `packages/desktop/test/e2e/bots/feishu-runtime-error-ui.test.ts`, and `packages/desktop/test/e2e/bots/feishu-streaming-card-lifecycle.test.ts` — validate locale-dependent bot UI/message behavior.
- Tests that explicitly iterate supported locales to validate locale-dependent behavior, including `packages/desktop/test/e2e/settings/provider-plan-navigation-labels.test.ts` and `packages/desktop/test/e2e/coding-plan-team-usage.test.ts`.

Locale-behavior tests added during the migration (each one asserts zh-CN or a locale switch as its subject):

- `packages/ui/test/browser/manual-review/pending/share-failure.test.mjs` — share error message text for network and HTTP 405 failures per locale.
- `packages/ui/test/browser/manual-review/pending/start-plan-followup.test.mjs` — Start Plan follow-up UI copy and actions per zh-CN/en-US locale behavior.
- `packages/ui/test/browser/manual-review/pending/thought-level-display.test.mjs` — thought-level option labels and aria-labels per locale.
- `packages/ui/test/browser/manual-review/pending/topic-preparation.test.mjs` — bot topic-preparation layout across an en-US and zh-CN viewport/theme matrix.
- `packages/ui/test/chatInputContextUsage.test.ts` — formatContextUsageSummary Chinese compact token units.
- `packages/ui/test/intlPlural.test.ts` — createIntl zh-CN plural selection rules.
- `packages/ui/test/marketingPopupAdapter.test.ts` — Start popup settings button label per locale.
- `packages/ui/test/modelProviderCodingPlan.test.ts` — zh-CN date formatting and billing-discount copy resolution.
- `packages/ui/test/pluginStoreTryPrompt.test.ts` — localized plugin display label in the try prompt.
- `packages/ui/test/remoteSkillSyncDialog.test.ts` — zh-CN size-limit error after a locale switch.
- `packages/ui/test/savedWorkflowLaunchPrompt.test.ts` — zh-CN and en-US saved-workflow launch prompt output.
- `packages/ui/test/v4ConversationRowViewTimelineMarker.test.ts` — timeline model-marker copy per zh-CN and en-US.
- `packages/ui/test/workflowRunSave.test.ts` — zh-CN save-request prompt and saveRun catalog parity.

Bot-message locale behavior and CLI locale detection are domain-level locale tests and are outside the UI-test default-locale rule.

## Enforcement

Run `pnpm test-copy:check` (also part of `pnpm verify:pre-push`). It fails on two things:

- a `zh-CN` locale setup (`initialLocale`, `locale`, `navigator.language`) in a test file outside the allowlist above;
- a CJK string passed to a text or role locator (`getByText`, `findByRole({ name })`, and so on). Such a locator must become a `TID_*` test ID or a role/state selector.

The guard ignores test titles, comments and content assertions, because those may validate user-provided fixture data; use `expectedCopy` for assertions about UI copy. Keep intentional locale tests in the explicit allowlist rather than weakening the guard globally. Blocking English copy locators is a separate follow-up and is not enforced yet.
