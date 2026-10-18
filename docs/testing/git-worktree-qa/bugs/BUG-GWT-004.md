# BUG-GWT-004: Worktree setup failure/recovery UI renders raw i18n keys instead of text

- Severity: S3 (recovery works and Retry creates the worktree, but the failure step, Retry/Discard buttons and queued-message label are unreadable raw keys; the user cannot tell what failed — workaround: the translated recovery card "Unsent message saved / Restore / Dismiss saved message" and sidebar entry)
- Кейсы: C5 (forced EACCES failure), C8 (empty repo / unborn HEAD; the step text also never mentions the actual cause — permission denied / unborn HEAD)
- Окружение: macOS 27.2, commit bd6a05b3b7dd045d10a47bc7a193a27f86e8f355, изолированный QA-инстанс (production build)

## Воспроизведение с нуля

Variant A (C5, forced failure):

1. Fixture R1 (`basic`) per QA-PROMPT §4; pre-create `$QA_ROOT/repos/basic-worktrees` and `chmod 555` it.
2. Open `basic` in the QA app; composer → destination chip → toggle Worktree ON.
3. Send any message. Wait ~4s for the failed step.

Variant B (C8, empty repo):

1. Fixture R2 (`empty`): `git init -b main`, no commits.
2. Open `empty`; toggle Worktree ON; send any message. Step fails in ~1–2s.

Observed in both: `data-worktree-setup-step="failed"` shows the literal string `worktreeSetup.stepFailed`; buttons read `worktreeSetup.retry` and `worktreeSetup.discard`; queued-message card header reads `worktreeSetup.queuedMessageLabel`; during creation/retry the step reads `worktreeSetup.stepCreating`, and after a successful retry `worktreeSetup.stepReady`.

## Ожидание

specs/composer-worktree-setup-steps.md#Preparation states: "`failed` preserves the same session identity and a recoverable error." A recoverable error must be presented as human-readable text (with the failure reason and actionable Retry/Discard), per the same spec's §Timeline presentation (creation status rows rendered in the message column).

## Факт

- Raw untranslated keys instead of text on the failed step and its buttons (C5: `worktreeSetup.stepFailed`, `worktreeSetup.retry` (Retry button), `worktreeSetup.discard` (Discard button), `worktreeSetup.queuedMessageLabel`; after Retry `worktreeSetup.stepReady`; C8 also showed `worktreeSetup.stepCreating` live). Screenshot C5-1-failed-rawkeys.png.
- No failure-cause text at all: nothing about permission denied (C5) or empty repo/unborn HEAD (C8). The `{ reason }` placeholder of `stepFailed` never renders because the id itself is missing; the underlying service failure message is tracked separately (git.createWorktree returned OK on EACCES/unborn — bug class C5-(б)).
- Functional recovery parts ARE present and translated: `composer-worktree-recovery` card ("Unsent message saved", Restore, "Dismiss saved message"), frozen text preserved; after `chmod 755` Retry created the worktree successfully.

Git: no new garbage caused by this bug (C5 orphan branch / stuck-ready are separate bugs C5-(б)/(в)).

## Доказательства

- `$QA_ROOT/evidence/C5-1-failed-rawkeys.png` — failed step with raw keys
- `$QA_ROOT/evidence/C8-1-failed-rawkeys.png`, `$QA_ROOT/evidence/C8-2-after-retry.png` — empty-repo failure, Retry loop
- Cases: `$QA_ROOT/cases/C5.md`, `$QA_ROOT/cases/C8.md`

## Причина

- Подтверждено: `packages/ui/src/v4/ConversationWorktreeSetupSteps.tsx` uses 11 unique `worktreeSetup.*` ids in `intl.formatMessage` calls, but the locale catalogs define only 5. Missing from ALL of `packages/ui/src/i18n/locales/en-US.ts`, `zh-CN.ts`, `uk-UA.ts` (verified by grep and by the test below):
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

- Подтверждено (rendering mechanism): `packages/ui/src/i18n/createIntl.ts` — `formatMessage` returns `interpolate(lookup(id) ?? id, values)`: when both the current locale and the `FALLBACK_UI_LOCALE` ("en-US", `packages/shared/src/locale.ts:8`) lack the id, the raw id string is rendered verbatim. No missing-key warning exists, so the gap is silent.
- Checked same-family files for the same defect: `packages/ui/src/v4/composer/composerWorktreePipeline.ts` uses only the existing `reconcile.*` ids; `packages/ui/src/v4/composer/ComposerDestinationControl.tsx` uses only the existing `connectionUnavailable`. The gap is confined to `ConversationWorktreeSetupSteps.tsx`.
- Coverage gap (why existing tests missed it): `packages/ui/test/i18nCatalogParity.test.ts` only checks locale-vs-locale parity using en-US as reference — a key missing from every locale passes parity.
- Гипотеза: нет (причина подтверждена на уровне кода и каталогов). Отдельные составляющие наблюдений C5/C8 — RPC `git.createWorktree OK` при фактическом отказе (нет причины для `{ reason }`) и отсутствие авто-активации после Retry-ready — гипотезы/баги других номеров, не этого файла.

## Предлагаемое исправление

i18n-слой: добавить 9 отсутствующих `worktreeSetup.*` записей (с плейсхолдерами `{branch}`, `{path}`, `{reason}` по фактическим вызовам) в `en-US.ts`, `zh-CN.ts`, `uk-UA.ts`; продукта код менять не нужно. Чтобы класс дефекта не повторялся, можно расширить проверку каталогов тестом «все formatMessage-id из исходников присутствуют в en-US» (уже делает новый тест ниже для этого компонента). Текст причины отказа (EACCES/unborn) требует дополнительно починки сервиса createWorktree (отдельный баг), иначе `{reason}` останется пустым/общим.

## Тест

- `packages/ui/test/worktreeSetupI18n.test.ts` (unit, vitest): парсит исходник `ConversationWorktreeSetupSteps.tsx` регэкспом `formatMessage({ id: "…" })`, сверяет каждый id с каталогами en-US/zh-CN/uk-UA; без моков, без sleep, самодостаточен.
- Красный без маркера (список отсутствующих, все 3 локали):

```
AssertionError: expected { 'en-US': [ …(9) ], …(2) } to deeply equal { 'en-US': [], 'zh-CN': [], …(1) }
- Expected / + Received
  { "en-US": [
+     "worktreeSetup.discard", "worktreeSetup.orphanedNote", "worktreeSetup.queuedMessageLabel",
+     "worktreeSetup.retry", "worktreeSetup.stepCreating", "worktreeSetup.stepCreating.baseHead",
+     "worktreeSetup.stepExisting", "worktreeSetup.stepFailed", "worktreeSetup.stepReady",
  ], "uk-UA": [ …те же 9 ], "zh-CN": [ …те же 9 ] }
 Test Files  1 failed (1)
      Tests  1 failed | 1 passed (2)
```

- С маркером `it.fails("BUG-GWT-004: …")`:

```
 ✓  unit  packages/ui/test/worktreeSetupI18n.test.ts (2 tests) 4ms
 Test Files  1 passed (1)
      Tests  1 passed | 1 expected fail (2)
```

- Команда: `"$QA_ROOT/bin/real-run.sh" "$NODE_BIN" scripts/run-vitest.mjs run packages/ui/test/worktreeSetupI18n.test.ts`
