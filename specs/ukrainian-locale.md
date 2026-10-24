# Ukrainian locale (`uk-UA`)

Status: implemented (PR `feat/theme-palettes` → osben/ZCode#9, 2026-10-10). Iterations I0–I8 were
executed in one branch (not separate PRs); behavior matches sections 1, 8 and 9. Known exceptions per
D10–D14: community in web stays `zh-CN`, no uk command aliases, release notes can show zh only when
the feed has no en version. This document is the current-state contract; the original plan (revision
2) is in git history.

Full history: git show 5df10a43f18201fe2dcfb1c8e1ccea240f50a0ef:specs/ukrainian-locale.md

## 1. Product rules

- `uk-UA` is a locale on par with `zh-CN` and `en-US`: selectable in Settings (language) and in the
  sidebar footer menu, plus the `system` mode.
- `system`: OS tag `uk*` → `uk-UA`; `zh*` (including `zh-TW`, `zh-HK`) → `zh-CN`; everything else →
  `en-US`. Behavior for the existing languages is unchanged.
- UI string fallback chain: `<locale> → en-US → id`. The Ukrainian interface never shows Chinese
  text. Exceptions: server-side content without an English version (release notes, D14) and community
  in web (D13).
- External services that only know `zh-CN`/`en-US` (share site, Coding Plan webview, community URL,
  release notes, feedback API) get a "service" locale: `uk-UA → en-US` (`toServiceLocale`).
- Plurals follow CLDR (`Intl.PluralRules`). Ukrainian has `one / few / many / other`
  (1 файл / 2 файли / 5 файлів / 1,5 файла).
- Language names in lists are endonyms, identical in every catalog: «中文简体», «English»,
  «Українська».

## 2. Owners and flow

### 2.1 UI locale owner (desktop + web)

```text
Settings Select (settingsPageHelpers.tsx ~296-318) ──┐ guard: SettingsPage.tsx:1278
Sidebar footer radio (WorkspaceSidebarFooter.tsx ~245-262) ┤ guard: WorkspaceSidebar.tsx:745
                                                      ▼
ZCodeIntlProvider.setLocalePreference      (packages/ui/src/i18n/IntlProvider.tsx — the single per-window owner)
  ├─ localStorage "zcode-locale-preference"           (window cache; wins over settings in web)
  ├─ broadcast "state:locale" {preference, resolvedLocale} → other windows
  └─ settingService.update({locale, localePreference}) → setting.json (appSettingsSchema)

useRootPlatformEffects.ts:555  platform.setApplicationLocale(locale)
  → IPC SetApplicationLocale  (desktopMainIpcPlatform.ts:230-237, localeSchema.safeParse)
  → main applyApplicationLocale (desktop/src/main/index.ts:2098)
       ├─ application menu / tray (desktopApplicationMenu.ts, shared/src/desktopMenu.ts)
       ├─ CUA indicator (windowsCuaOperationIndicatorContent.ts)
       ├─ Finder workflow (desktopFinderOpenFolderWorkflow.ts, macOS)
       └─ send ApplicationLocaleChanged → all windows
             └─ UpdateStatusWindowRoot.tsx:60-76 recreates the Provider with initialLocale

main startup: settings.locale (index.ts:1937-1946) ?? resolveSystemApplicationLocale()
            (desktopApplicationMenu.ts:33-38: app.getPreferredSystemLanguages()[0] ?? app.getLocale(), zh/en)
```

Other `ZCodeIntlProvider` mount points:

| Mount point                                                        | Locale source                                                              |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Desktop main window (`desktop/src/renderer/src/main.tsx:328`)       | settings + localStorage + host `resolveSystemLocale`                        |
| Desktop DB-start screen (`desktop/src/renderer/src/main.tsx:168`)   | `?locale=` flag (`:135-139`), else localStorage → host                      |
| Web (`packages/web/src/main.tsx:454`)                               | `settingService` + `broadcastService`; localStorage wins                    |
| `UpdateStatusWindowRoot.tsx:76` (mounted from `main.tsx:366`)       | `initialLocale`, recreated on `onApplicationLocaleChanged`                  |
| `resource-manager.tsx:59`                                          | no props → localStorage → navigator                                         |
| `ConversationShareReadonlyTimeline.tsx:1151`                        | `initialLocale` from the share route                                        |

Notes:

- The `preferSettingServiceLocale` flag in `IntlProvider.tsx` (`:76-90, 148, 227-259`) is passed by
  nobody — dead code. There is no separate mobile entry in `packages/web/src`; web and mobile behave
  the same.
- Desktop does not pass the locale to the CLI agent. CLI/TUI determine their own language (see 2.2).
- `ErrorBoundary.tsx:6-7, 64-90` does not use the Provider: it statically imports both catalogs and
  reads `zcode-locale-preference` and `navigator.language` itself.

### 2.2 Two independent i18n stacks

| Stack                     | Catalogs                                         | Type                                        | Size                                       |
| ------------------------- | ------------------------------------------------ | ------------------------------------------- | ------------------------------------------ |
| UI (desktop, web)         | `packages/ui/src/i18n/locales/{en-US,zh-CN}.ts`  | `Record<string, string>` (completeness unchecked by the compiler) | en 5 876 keys, zh 5 875; ~425 KB per language |
| CLI/TUI (`@zcode/i18n`)   | `apps/zcode-cli/packages/i18n/src/locales/*.ts`  | `ZCodeCopy` (TS-checked completeness)       | ~360 lines                                 |

The CLI resolves its language from `ui.locale` in its config (`adapters/src/config/schema.ts:213`)
and `LC_ALL/LC_MESSAGES/LANG/LANGUAGE`/Intl (`i18n/src/locale.ts` `normalizeLocale`). The stack is
independent of desktop.

## 3. Current-state details and limitations

- Plural conventions in the UI catalog (the parity tests guard these):
  - Pluralization is explicit (`intl.formatPlural`), never automatic in `formatMessage`: the `.other`
    suffix is also used by non-plural keys (`feedback.module.other`, `settings.plugins.store.category.other`,
    `settings.usage.modelChart.other`, `occupationOnboarding.other`, `resourceManager.storage.category.other`).
  - Families are `<base>.one` / `<base>.other`. The three pre-existing conventions were converted:
    A `.one`/`.other|.many` suffixes (18 families; `.many` meant "not one" and conflicted with the
    CLDR `many` category, so it was renamed to `.other`), B `xxxOne`/`xxx` key names (12 families,
    prefix `chat.toolCall.workflow.`), C word pairs `xxx`/`xxxs` (5 families,
    `chat.toolCall.workflow.card.*`, `digest.question/questions` via the `count()` helper in
    `timeline-summary.ts`).
  - `chat.toolCall.workflow.card.round` / `card.rounds` are chosen by `active`, not by count, and
    render only when `rounds >= 2`; `card.rounds` ("{count} rounds") still needs uk few/many forms
    (a `{count}` string outside the families; rule in section 7).
  - Call sites pass `count` variously (`String(n)`, number, `n.toLocaleString()`); `formatPlural`
    must not change this — `values.count` overrides the auto-substitution, otherwise zh/en thousand
    separators change.
  - About 25 en strings use "(s)" (for example `conversationShare.*`, `bots.setup.bound`,
    `feedback.time.daysAgo`, `automations.schedule.customYearly`) and ~263 strings carry
    `{count}`-like placeholders; the uk rule for them is in section 7.
  - The category is never carried across languages: uk `one` for 21 would give "21 file" in en.
- Settings protection (I0): in `appSettingsObjectSchema` only,
  `locale: localeSchema.default("zh-CN").catch("zh-CN")` and
  `localePreference: localePreferenceSchema.default("system").catch("system")`;
  `pendingPostUpdateReleaseNotes: postUpdateReleaseNotesPayloadSchema.optional().catch(undefined)`.
  `localeSchema` itself stays strict (used by IPC `desktopMainIpcPlatform.ts:232`,
  `migrateLegacyLocalePreference`, and as the `releaseNotesByLocale` key in
  `postUpdateReleaseNotesPayloadSchema`); `appSettingsPatchSchema` stays strict — an invalid patch
  must be rejected. CLI: `locale: z.enum(["auto","en-US","zh-CN"]).optional().catch(undefined)`
  (`adapters/src/config/schema.ts:213`). Reason: an unknown locale must not wipe the whole
  `setting.json` on rollback (a failed parse falls back to `defaultSettings()` which is then written).
- `desktop/src/preload/codingPlanWebview.ts:127, 141` keeps its inline locale validator: the code is
  inside a function serialized by `contextBridge.executeInMainWorld` (imports unavailable; comment at
  `:125`). Safe, because `codingPlanEmbeddedWebview.ts:201, 310` already normalizes any locale to
  `zh-CN | en-US` before the webview.
- Dead code kept as is (D11): Zustand `locale` (`ui/src/store/index.ts:112-113, 214, 267-270, 476`,
  key `zcode-locale`, default `"zh-CN"`, in `BROADCAST_FIELDS`, no readers; its broadcast handler
  accepts only a string while the Provider sends an object), `LocaleSwitcher.tsx` (exported from
  `i18n/index.ts`, unused; carries the label `"uk-UA": "Укр"`), `preferSettingServiceLocale`
  (see 2.1), and the key `settings.memory.viewer.disabled` (en-only, unused; the parity-test
  allowlist `KNOWN_EN_ONLY_KEYS`).
- Branches on `=== "zh-CN"` / `startsWith("zh")` outside the catalogs silently give English for uk.
  This is not a bug, but those spots stay untranslated (for example `draftSuggestedPromptItems`,
  `automationTemplateCatalog`, `savedWorkflowLaunchPrompt`, Coding Plan sections, `forceUpdatePrompt`,
  `embeddedBrowserJavaScriptDialog`, `main/index.ts:865` `resolveExternalWorkspaceConfirmationCopy`,
  `main/index.ts:1317` `isZh` in the exit confirmation, `desktopOAuthDeepLink.ts:142` — already
  `TODO(i18n)`). Inventory query:
  `rg -n '=== "zh-CN"|startsWith\("zh' packages -g '*.ts' -g '*.tsx' -g '!**/locales/**' -g '!**/dist/**'`.
- Not a bug: `ui/src/lib/taskTimelineGroups.ts:39` `weekStartsOn = en ? 0 : 1`; Monday is correct for
  uk. Do not touch.
- Bundle size: catalogs are imported statically (Provider and ErrorBoundary); the uk catalog adds
  roughly 600–700 KB UTF-8. Lazy-load was deferred (D7): revisit if web first-load time grows after
  I4 (compare chunk size before/after `pnpm --dir packages/web build`).
- String length: Ukrainian runs 15–30 % longer than English and 2–3× longer than Chinese;
  `DESIGN.md:260-261` forbids relying on text truncation.
- External URLs: share path `/cn` vs `""` (`shared/src/conversation-share.ts:14-30`;
  `parseConversationSharePathname` returns only zh/en; uk maps to the English site);
  `web/src/main.tsx:121-124` sets `lang`/title by route; `getCommunityUrlFromConfig(config, locale)`
  (`shared/src/remoteAppConfig.ts:61-64`) must receive `toServiceLocale(locale)` or the community
  button disappears; `helpAppConfig.ts:8-9, 38-39`; feedback `Accept-Language`
  (`feedbackHttpClient.ts:428-435`).
- Electron packs only the locales in `desktop/electron-builder.config.js:471`
  `electronLanguages: ["en-US", "zh-CN", "uk"]` (pak file name `"uk"`).
- Test infrastructure: `node:test` files only (`packages/ui/test`, `packages/services/test`,
  `apps/zcode-cli/packages/bootstrap/test`); no repo E2E. `test-actions.ts`
  (`getLocale`/`setLocale`) is the bridge for external E2E that does not exist in the repo.
  Tests run from the package directory (the `@/` alias does not resolve from the root).
- Architecture policy: `maxFileLines: 400` applies to managed modules only; `ui`/`shared`/`services`/
  `desktop`/`web` are `managed: false`, so the large `uk-UA.ts` is allowed.

## 4. Decisions

| #   | Question                                                        | Decision (✅ — confirmed by the user)                                                                                                                                                                                            |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Locale tag                                                      | `uk-UA`                                                                                                                                                                                                                              |
| D2  | UI string fallback                                              | `<locale> → en-US → id` for all locales (a missing zh key shows English, not the raw `id` — an improvement)                                                                                                                            |
| D3  | `system` for `ru*` and others                                   | unchanged → `en-US`                                                                                                                                                                                                                   |
| D4  | First delivery scope                                            | Desktop + Web UI + main process + content catalogs. Bots (I7) and CLI/TUI (I8) separately; before that they fall back to `en`                                                                                                        |
| D5  | Translation                                                     | ✅ LLM in batches by namespace + glossary (section 7). Review is done by an agent in a separate pass per section 7.1; no native-speaker review                                                                                      |
| D6  | Settings-protection release                                     | ✅ I0 ships as a separate release, at least one release before I3 (protects settings on rollback). I0 merges and releases immediately; I1–I2 can ride the next release; I3+ not before the release after I0                            |
| D7  | Lazy-load of catalogs                                           | not in this task; revisit if web first-load grows after I4 (compare chunk size before/after `pnpm --dir packages/web build`)                                                                                                          |
| D8  | Commit-message generation language (`gitCommitMessageGenerator.ts:226`) | `uk-UA` → `"Ukrainian"`                                                                                                                                                                                                     |
| D9  | `DEFAULT_LOCALE = "zh-CN"`                                      | do not touch                                                                                                                                                                                                                          |
| D10 | Bot commands (`/help`, Chinese aliases `/帮助`, `/项目`, reply-mode aliases `botsService.ts:189-204`) | For uk keep English command names, translate messages only. Do not add Ukrainian aliases                                                                                  |
| D11 | Dead code (section 3)                                           | ✅ Do not clean up in this task. Zustand `locale`, `LocaleSwitcher`, `preferSettingServiceLocale` and `settings.memory.viewer.disabled` stay; where they interfere (`Record<Locale,…>` types, parity test), complete them minimally |
| D12 | Visibility of the «Українська» item before the translation is done | no runtime flag: do not release I3–I4 separately (keep on a branch / do not merge to `main` until I4 is complete)                                                                                                             |
| D13 | Community locale source in web (`web/src/main.tsx:245`)          | ✅ Do not touch. `openCommunity` in web stays as is (locale from `<html lang>`, effectively always `zh-CN`) — for `uk-UA` in web, community opens in Chinese. Known exception from the section 1 rule, listed in section 10 |
| D14 | Release notes for uk when the server has no `en-US` version      | ✅ Chain `uk-UA → en-US → payload.markdown`. `payload.markdown` comes from the feed's common `releaseNotes` (server picks the language) or from `pickFallbackReleaseNotesMarkdown`, which for non-zh locales resolves `menuLocale → en-US → zh-CN`. Chinese for uk is possible only if the feed has no English at all; an accepted exception from the section 1 rule |
| D15 | Plugin sandbox permission dialogs                               | Title, text and buttons by locale: `uk-UA` → Ukrainian, `zh-CN` → Chinese, others → `en-US`. `getLocale` passes the language to `installPluginSandboxHost` (same source as `resolveEffectiveConfirmationLocale`); before it is wired in `index.ts`, the system language is used |

## 5. Implementation record (I0–I8, done)

Executed in order in one branch, each with green `pnpm typecheck`, `pnpm lint` (0 errors),
`pnpm fmt:check`, `pnpm architecture:check --changed` and the tests below:

- I0 settings protection (`.catch` in `appSettingsObjectSchema` + CLI `uiSchema.locale`) —
  `packages/ui/test/localeSettingsSchema.test.ts`.
- I1 shared locale helpers (`shared/src/locale.ts`: `isLocale`, `isLocalePreference`,
  `matchSupportedLocale`, `resolveSystemLocale`, `toServiceLocale`, `SUPPORTED_LOCALES`), explicit
  branches instead of "not en means zh" (bots, conversation share errors, release notes, autoUpdater),
  narrowed ad-hoc locale types to `ServiceLocale`/`Locale` — `packages/ui/test/localeSupport.test.ts`.
  The duplicated validators/detectors were replaced everywhere except the two non-importable spots
  (`codingPlanWebview.ts` serialization, CLI stack).
- I2 i18n engine: `createIntl.ts` with `formatMessage` (chain `[locale, FALLBACK_UI_LOCALE]`, missing
  key → raw `id`) and explicit `formatPlural` (per-catalog `Intl.PluralRules`, `${id}.${category}`
  with `${id}.other` fallback, `{count}` auto-substitution overridable via `values`);
  `.many` → `.other`; all 35 families converted to `.one`/`.other` —
  `packages/ui/test/intlPlural.test.ts`, `packages/ui/test/i18nCatalogParity.test.ts`.
- I3 `Locale = "zh-CN" | "en-US" | "uk-UA"` in `protocol.ts`, both settings enums, locale picker
  entries (`settings.locale.uk-UA`, `sidebar.settings.locale.uk-UA`, value «Українська» in all three
  catalogs), `Record<Locale, …>` completions (desktop menu, about, context menus, Finder workflow,
  share service, CUA permission panel, CUA indicator with per-locale window width, builtin skills,
  OAuth deep link), `gitCommitMessageGenerator` (D8), `electronLanguages` + `"uk"`.
- I4 full `packages/ui/src/i18n/locales/uk-UA.ts` translation in batches by namespace with the
  section 7 guide and the section 7.1 review; parity test extended to uk completeness (keys uk ⊇ en,
  plural families as `.one/.few/.many/.other`, every uk form carries `{count}`).
- I5 date/number formatting via `Intl.*` instead of `zh-CN` branches (`workDuration`,
  `conversationWorkDuration`, `memoryUpdatedAt`, usage stats, `commit.tsx:106`).
- I6 content catalogs and remaining `zh-CN` branches (builtin skills, automation templates,
  suggested prompts, saved workflows, plugin definitions via `resolveLocalizedText` `uk` prefix;
  main-process dialogs).
- I7 bots: `BotMessageLocale` extended to `Locale`, uk messages, commands stay English (D10);
  locale source `settings.locale` (cache `botsService.ts:1000`) —
  `packages/services/test/botMessagesLocale.test.ts`.
- I8 CLI/TUI `@zcode/i18n`: `SupportedLocale`, `GlobalLocale`, `normalizeLocale` `uk*` → `uk-UA`,
  `uiSchema.locale` enum (+ `.catch` from I0), catalog `i18n/src/locales/uk-UA.ts` (`ZCodeCopy`),
  `/locale` command — `pnpm --dir apps/zcode-cli/packages/i18n typecheck`.

Also updated: `packages/ui/test/updateReleaseNotes.test.ts` (release notes without zh for uk, D14).

Manual-only coverage (no automated tests): cross-window broadcast sync, main-process menu, Chromium
`.pak`, long-string layout, CLI schema (if `adapters` has no tests).

## 6. Verification

```bash
pnpm typecheck
pnpm lint            # 0 errors; warnings not above the pre-task baseline (70)
pnpm fmt:check
pnpm architecture:check --changed
```

Tests run from the package directory (the `@/` alias does not resolve from the root):

```bash
cd packages/ui && node --import tsx --test test/localeSettingsSchema.test.ts test/localeSupport.test.ts test/updateReleaseNotes.test.ts test/intlPlural.test.ts test/i18nCatalogParity.test.ts test/localeContentCatalogs.test.ts test/localeFormatting.test.ts
cd packages/services && node --import tsx --test test/botMessagesLocale.test.ts
```

Additional: `pnpm knip` (must show no new unused exports; the D11 ones remain),
`pnpm --dir apps/zcode-cli/packages/i18n typecheck`.

## 7. Translation guide (uk-UA catalog)

Source is `en-US.ts`; use `zh-CN.ts` to clarify meaning.

Rules:

- Keep verbatim: `{placeholders}`, HTML tags, `**`, `\n`, leading/trailing spaces, keyboard shortcuts
  (`⌘`, `Ctrl`), paths, commands, URLs.
- Strings with "(s)" and `{count}` outside plural families are translated neutrally, with the number
  after a colon: «Файлів: {count}». If a string is highly visible and the neutral form reads badly,
  create a plural family (en `.one/.other`, zh `.other`, uk 4 forms) and switch the call site to
  `formatPlural`.
- Address the user with «ви»; short imperative UI style («Зберегти», «Скасувати»); no Russian
  calques.
- Do not translate: ZCode, Z.ai, GLM, Coding Plan, Start Plan, MCP, Git, model and provider names,
  command names (`/help`), `CLAUDE.md`/`AGENTS.md`.
- New plural families: zh/en use `.one`/`.other`; uk uses `.one/.few/.many/.other`, and every uk form
  (including `.one`) carries `{count}` — the uk `one` category also covers 21, 31…, so a literal
  «1 файл» in `.one` is wrong. For zh, `Intl.PluralRules("zh").select(1) === "other"`, so zh `.one` is
  unused after the migration but stays for the parity test.
- Before renaming a key, check it is not used elsewhere by full name
  (`rg -n '<key>' packages`), including template strings with `${I18N_PREFIX}`.

Glossary (starting point; extend in the PR):

| en                                                                        | uk                                                                  |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| workspace                                                                 | робочий простір                                                     |
| task / session                                                            | завдання / сеанс                                                    |
| conversation                                                              | розмова                                                             |
| agent / subagent                                                          | агент / субагент                                                    |
| skill                                                                     | навичка                                                             |
| plugin / marketplace                                                      | плагін / маркетплейс                                                |
| automation / workflow                                                     | автоматизація / робочий процес                                      |
| memory                                                                    | пам'ять                                                             |
| commit / branch / diff                                                    | коміт / гілка / diff                                                |
| settings                                                                  | налаштування                                                        |
| Official Marketplace, Personal Source, Featured, Installed (`CONTEXT.md`) | Офіційний маркетплейс, Особисте джерело, Рекомендоване, Встановлені |

### 7.1 Agent translation review (D5)

The review is a separate agent pass (new session or subagent, not the context that produced the
translation), run on every batch before merge.

1. Automated: `i18nCatalogParity` green (placeholders, HTML, `**`, plural forms).
2. The agent checks every string of the batch (en → uk):
   - meaning matches en (consult zh when in doubt);
   - terms follow the glossary; identical en strings are translated identically;
   - no Russian-isms or calques (for example «на протязі», «приймати участь», «слідуючий»,
     «співпадати»), no Russian letters `ы э ъ ё`; consistent apostrophe (`'`);
   - «ви» address, imperative mood for buttons;
   - plural families: `one/few/many/other` grammatically correct for 1, 2, 5, 21, 1,5;
   - length: strings longer than 1.5× en for buttons, tabs and menu items (keys containing `button`,
     `tab`, `menu`, `action`, `title`) go on the visual-check list or are shortened.
3. The mechanical parts of step 2 (Russian letters, apostrophe, length) are encoded in
   `i18nCatalogParity` checks over `uk-UA`: forbidden characters fail the test, length only reports.
4. The review outcome goes into the PR description: strings checked, strings fixed (key, was → now),
   long-string list for visual QA.

## 8. Version skew

| Combination                                                | Behavior                                                                  |
| ---------------------------------------------------------- | ------------------------------------------------------------------------- |
| New desktop writes `uk-UA`, then rollback to a build without I0 | all settings wiped on the next write. This is why D6 exists        |
| Rollback to a build with I0 but without I3                 | language → `zh-CN`/`system`, other settings preserved                     |
| New desktop + web from the same host                       | assets come from the same process — versions match                        |
| Remote workspace host of an older version                  | reads its own `setting.json`; `uk-UA` is not written there until the host updates |
| External sites (share, coding plan, community, feedback)   | receive `toServiceLocale` → `en-US`                                       |
| CLI before I8 with `LANG=uk_UA.UTF-8`                      | `en-US` (unchanged)                                                       |

## 9. Acceptance scenarios

| #   | Setup                                                | Action                                                      | Expected                                                                                                                                              | Evidence                         |
| --- | ---------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| 1   | language zh                                          | Settings → «Українська»                                       | UI in Ukrainian immediately; persists across restart; `setting.json`: `locale` and `localePreference` = `"uk-UA"`                                     | manual + file                    |
| 2   | two desktop windows                                  | change the language in the first                              | the second window switches; no broadcast loop                                                                                                        | manual, logs                     |
| 3   | OS in Ukrainian, `localePreference: system`          | launch                                                       | UI, application menu, tray in Ukrainian                                                                                                              | manual (macOS/Windows)           |
| 4   | web (`pnpm dev:web`)                                 | pick «Українська» in the footer                               | language applies, persists across reload (localStorage)                                                                                              | manual                           |
| 5   | `uk-UA`, key missing in uk                           | open a screen                                                 | English text, never Chinese and never the raw `id`                                                                                                    | `intlPlural.test.ts` + manual    |
| 6   | `uk-UA`                                              | 1 / 2 / 5 / 21 files in the change summary                    | «1 файл / 2 файли / 5 файлів / 21 файл»                                                                                                              | `intlPlural.test.ts`             |
| 7   | `uk-UA`                                              | ErrorBoundary, share errors, bot messages, release notes      | Ukrainian or English, never Chinese                                                                                                                  | manual + I1 tests                |
| 8   | `setting.json` with `"locale":"xx-XX"` plus other settings | launch, then change any setting                            | other settings preserved, default language                                                                                                           | `localeSettingsSchema.test.ts`   |
| 9   | `uk-UA` (desktop and web)                            | share a conversation; open community                          | links go to the English version (except community in web — D13); the community button is visible                                                     | manual                           |
| 10  | `uk-UA`, narrow window and 375 px web                 | walk the main screens                                         | long labels do not break the layout                                                                                                                  | manual                           |
| 11  | `zh-CN` and `en-US`                                  | walk the plural call sites                                    | texts unchanged                                                                                                                                       | `intlPlural.test.ts` (equivalence) |

## 10. Out of scope

- Changing `DEFAULT_LOCALE` (D9); other languages, including `ru`.
- Lazy-load of catalogs (D7).
- Cleaning the dead code (D11): Zustand `locale`, `LocaleSwitcher`, `preferSettingServiceLocale`,
  `settings.memory.viewer.disabled`.
- `toLocaleString()` calls without an explicit locale (27 spots; they follow the OS, not the app).
- Ukrainian versions of the external sites (share, coding plan, community, server-side release
  notes).
- Fixing the community locale choice in web (`web/src/main.tsx:245`, D13): currently always `zh-CN`,
  also for uk.
- Ukrainian bot command aliases (D10).

## 11. Divergence from the seed graph

`graph-drift-candidate`: `.agents/skills/feature-boundary-planner/references/zcode-feature-graph.yaml`
has no node for i18n/locale. Proposed node `capability.ui-locale`: owner `ZCodeIntlProvider`
(`packages/ui/src/i18n/IntlProvider.tsx`), persistence `setting.json` `locale`/`localePreference`
(`appSettingsSchema`), channel `state:locale`, main `applyApplicationLocale` +
`ApplicationLocaleChanged`; a separate node for the CLI `@zcode/i18n`. The graph was not edited: the
contract `docs/skills/feature-boundary-graph.md` it references is absent from the checkout.
