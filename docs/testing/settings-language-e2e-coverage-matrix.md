# Settings Language E2E Coverage Matrix

Full history: `git show b8876e8b:docs/testing/settings-language-e2e-coverage-matrix.md`

## Scope

Settings language coverage verifies that the General settings language selector keeps locale preference and resolved UI locale separate.

## State Dimensions

| Dimension                 | Values                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------ |
| Platform locale source    | Electron `app.getPreferredSystemLanguages()` preferred list, Electron `app.getLocale()` fallback |
| User preference           | `system`, `zh-CN`, `en-US`                                                                       |
| Persisted resolved locale | `zh-CN`, `en-US`                                                                                 |
| UI surface                | Settings General section, application chrome driven by `ZCodeIntlProvider`                       |

## Accepted Cases

| Case                                                            | Setup                                                                                                                            | Action                                      | Assertions                                                                                                      | Spec                                                                                    |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| SL-01 system preferred Chinese with English app locale fallback | Mock preferred languages as `["zh-Hans-CN", "en-CN"]`, mock `app.getLocale()` as `en-US`, start from explicit English preference | Select `System default` in Settings General | UI switches to Chinese, `setting.json` keeps `localePreference: "system"` and writes resolved `locale: "zh-CN"` | `packages/desktop/test/e2e/settings/settings-language-system-default.test.ts`           |
| SL-02 explicit language labels are autonyms                     | Current locale may be English or Chinese                                                                                         | Open language selector                      | `中文简体` and `English` remain readable in their own language                                                  | Pending behavior coverage; the source-string guard was removed during unit-test cleanup |

SL-01 completes first-run occupation onboarding through a shared UI helper before checking locale behavior.

## Pruned Cases

| Case                                 | Reason                                                                                                            |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Full OS language mutation during E2E | Mutating host OS language is not deterministic in CI; SL-01 uses Electron API mocks at the host boundary instead. |
| Provider replay fixtures             | Settings language selection does not call model providers, so no DeepSeek request fixture is required.            |

## Plan navigation labels

- PN-01 (formal, reviewed 2026-09-18): BigModel/Z.ai x zh-CN/en-US. In an isolated unauthenticated profile, open Model settings; assert BigModel/Z.ai and Start Plan (unchanged across locales) by their distinct navigation keys, then click each and assert its selected state and detail heading (brand vs Start Plan).
- PN-02 (formal, reviewed 2026-09-18): repeat at narrow renderer width; assert both accessible names and hover tooltip. Chinese/dark and English/light at wide and narrow widths cover presentation pairwise; no claim of phone remote transport coverage.
- Existing entitlement, payment and usage cases are pruned from this label-only change. Provider IDs, selection commands, detail brand names and persistence contracts remain unchanged.
- Navigation uses BigModel/Z.ai and Start Plan in both locales (names restored 2026-09-18); PN-01/02 assert the restored names, including accessible labels and narrow-layout tooltips.
- Spec: `packages/desktop/test/e2e/settings/provider-plan-navigation-labels.test.ts` (in the formal `settings/` directory; the promotion dry run supports only conversation-session paths, so the existing settings-domain migration procedure was followed). No model request fixture is needed: this case never sends a prompt or connects an account.

### Related fixes found during verification

- CTP-02 had a stale connection-mode expectation (`Personal Plan` instead of the current `Individual Plan`); corrected independently of the sidebar labels.
- CTP-02B/CTP-05: the English UI already displayed the `Team` badge and `Individual Plan` usage tab; the former assertion accepted only Chinese and the latter only obsolete English wording. Both cases now run explicitly in zh-CN/en-US, assert the specific badge/tab and retain quota, model and connection persistence checks.
- A source audit found no navigation selector requiring the former BigModel/Z.ai label; brand checks in login actions remain valid.

### Verification status

macOS Electron replays passed for PN-01/02 (4 family/locale cases: detail selection, wide/narrow layouts, accessible names, hover tooltips), SL-01, OAuth credential recovery, CTP-02 and CTP-02B/CTP-05 (zh-CN/en-US); formal replay without `ZCODE_E2E_MANUAL_REVIEW` 4/4. Typecheck, desktop E2E typecheck, lint (0 errors) and architecture checks passed. Docker verification/admission was excluded at the user's request. These macOS renderer checks do not establish phone remote transport or Windows/Linux coverage, and the targeted runs do not claim full-suite coverage.
