# Todo116: Remove the Team-Specific Key Link and Unify the Acquisition Entry

> Status: Completed. 2026-09-12 whole-chain review, local whole-batch gates and Pro native-open acceptance (real settings
> page to system browser) passed. Phone login-to-console and remote-control joint on-device runs were not tested and are
> not claimed. Implementation commit: `5123ebc5a5`.
>
> 2026-09-11 user correction of Todo111: remove the team-specific field entirely, not just hide the button.
>
> Full history: `git show 37b98ff8:docs/working-memory/provider-refactor/steps/todo-116-single-api-key-management-url.md`

## Rulings and Boundaries

1. Access keeps only the single `apiKeyManagementUrl` field for acquiring a Key; the team-specific field is deleted from
   the schema, types, Overlay, serialization, template config and UI pass-through.
2. Every preset template shows one "获取 API Key / Get API Key" button; showing it does not depend on whether a Key is
   filled in, and links are never guessed from account, plan or domain.
3. Each template keeps its existing `apiKeyManagementUrl`; personal/team no longer have separate entries. Z.ai Coding Plan
   is `https://z.ai/manage-apikey/apikey-list`, BigModel Coding Plan `https://bigmodel.cn/coding-plan/personal/overview`;
   ordinary API and other templates keep their existing main link. It is not claimed that the console needs no team
   switching by the user.
4. The Built-in template is still the default link source; config resolution and template detail consume the same field and
   reuse the platform's external-link opening; no navigation state or service path is added.
5. No alias, migration or lenient parsing for the unshipped dual-entry intermediate state; real user files are untouched;
   the schema stays strict and no longer accepts the deleted field.
6. No change to Key content, Provider identity, Access type, personal/team signing, account connection or model config;
   Todo115 is not implemented along the way.
7. Desktop and mobile Web use the same component and localization; Host attachment, continuous/replayable and sync order are unchanged.

## Verification (all done)

Failing tests first (old field rejected; single main-link Overlay, clearing, Registry serialization and config round trip;
published templates have no extra link field); product code, dual-button props and translations deleted, Builtin revision
incremented with existing main links kept as-is; browser interaction in Chinese/English, narrow light / wide dark, one
entry with and without a Key, click delivers the configured main URL; Todo111, the design spec and the case matrix synced
to drop the dual-entry requirement and a repository-wide search for leftovers (negative tests and this correction note do
not count as residue); targeted unit tests, browser regression, typecheck, lint, architecture check and E2E typecheck;
whole review of rulings, field-deletion impact and the Provider abstraction boundary; whole acceptance of the single entry,
target URL and multi-end verification boundary before closing.

## Implementation and Evidence

- The team-specific chain was deleted from schema, config object, Overlay, Registry serialization and UI; both Built-in
  templates dropped the team link; published revision 19 -> 20. A repository search finds only tests that reject the old
  field or assert templates lack it.
- Red first (both manual Access types still accepted the old field, templates still had it: 3 expected failures); after the
  change the whole Provider / Provider Node suites plus UI link, form boundary, Key persistence and template-selection
  targeted regressions: **42 files, 454 items pass**.
- Browser shared-component regression **2/2 pass**: 390px Chinese light, 1200px English dark, one button with and without a
  Key delivering the original main link; enable/disable, horizontal drag, delete-failure retry and notice-close assertions
  are kept. The new clear-Key action runs after the other actions so the test's own async save does not race the delete
  gate; product save logic was not changed.
- `pnpm typecheck`, desktop `typecheck:e2e`, architecture check (0 violations) pass; `pnpm lint` 0 errors, 41 existing
  warnings. The Builtin integrity test's release-version assertion was synced.
- Boundary: the browser fixture uses real shared components and isolated write routes with the external-open callback
  recording the URL; not verified on Air / a real phone or a logged-in console. No real user data written; pending cases
  not promoted to formal Electron regression.

## Goal Review (2026-09-11)

A repository-wide product-chain search again: the team field remains only in two strict-rejection / template-lacks-field
negatives. Schema -> Access class/Overlay -> Resolver serialization -> form projection -> single button -> existing
platform open chain all carry only the main URL; no frontend hardcoded second link, lenient read or migration. Both manual
Access types keep main URL / clear semantics and the Key; account identity and signing are unchanged. Six files / 49 items
rerun (Provider schema/Overlay/Registry/template, Node codec/actual published config); 18 browser items in the batch pass,
two being the real single entry, with/without Key and click-delivers-URL. Root typecheck/lint/architecture pass with the
131 group. Desktop native open and a real phone login-to-console were not run, and browser callbacks are not on-device evidence.

## Pro Native-Chain Acceptance (2026-09-12)

New pending `provider-key-native-open.test.ts`, K116-N01 passes: isolated real Personal Config -> Settings View -> the only
button -> platform interface / preload / main IPC -> un-mocked `shell.openExternal` -> the system default browser GETs a
unique canary path on a random local port. Both an ordinary API Key (non-empty) and a Coding Plan API Key (empty) template
instance pass; nothing was visited before the click, the exact hit happened after it, and the config file bytes did not
change. No model request, account login or other browser page reading. Exact official template URLs reuse the earlier
config/schema tests.

Log `/tmp/provider-20260912-pro-native-key2.log`; artifacts under
`/Users/dev/provider-stabilization-pro.euQzIZ/packages/desktop/.e2e-artifacts/provider-20260912-pro-native-key2/summary.md`.
It reused the App built from `fc757c0ec9`; no product code changed this round, the new test and manifest were synced
separately. The first test omitted `templateId` and had no button; after checking the product rule "only templates show the
entry" the fixture was corrected without loosening UI or schema. Not promoted to formal regression.

Review: the canary can only be reached by the system browser after a real click (not a Renderer callback stub or a test
fetch); both Access types share one test path; no production state / sync / signing branch was added. Phone-width
two-theme real component clicks already have passing evidence; a real phone login-to-console stays out of scope.

A final assertion that the canary entered no Electron WebContents and the main settings page stayed was added and rerun
(`/tmp/provider-20260912-pro-native-key3.log`); that run recorded 0 model requests. Whole-batch business tests without new
proof value were not rerun. Root typecheck, desktop typecheck:e2e, lint (0 errors / 42 existing warnings), architecture
(0 violations) and the conversation coverage audit pass. `e2e:fixture:check` does not support the settings directory
(tool limitation, recorded as not passed); the manifest's no-provider contract was checked separately without loosening the
checker or promoting pending.
