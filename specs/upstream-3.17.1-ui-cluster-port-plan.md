# Порт UI-кластера 3.17.1 — план (разведка 2026-10-30)

Status: ready-for-implementation. Уточняет каталог `upstream-3.17.1-sync-catalog.md` (п.5 частично опровергнут разведкой).

## Опровергнуто разведкой — НЕ портировать

- **Wizard UX #71/#72** (rcux/05, rcux/27): оба фикса УЖЕ в базовой v3.16.2 (доки завершены 2026-10-14, база от 2026-10-20). Верифицировано кодом: `parseUserHostPort` с bugfix-комментарием, `collectRemoteFormFieldErrors` (port trim), `RemoteConnectionFields.tsx:480` (Docker dropdown), `ConfirmDialog.tsx:70/204` (Enter-guard на destructive), `settings.source.lastOnline`. Каталог п.5.4 снят.
- **Personalization (A1)**: в форке уже есть собственная фича `instructions` (`UserInstructionsSettingsSection.tsx` + `userInstructionsService.ts`, спека `specs/global-instructions.md`), богаче апстримовской (таргет хоста активного workspace, preview, импорт из CLAUDE.md). Порт создал бы вторую секцию, редактирующую тот же `~/.zcode/AGENTS.md`. Опционально: S-hardening форкового сервиса записей (lock+0600+FIFO — сейчас голый `atomicWriteFile` в `userInstructionsService.ts:320`) — отдельная задача, не порт.

## К порту: A3 → A2 (один PR), затем C (отдельный PR)

Статус: A3+A2 — в #370; C — сделан в ветке `port/3.17.1-reinstall-button` (спека RDRI-01 добавлена в `docs/architecture/remote-device-connection-ux-spec.md`; lifecycle/downgrade-части апстрим-диффа не портированы).

### A3: контекстное меню ссылок (S)

- `packages/ui/src/components/ai-elements/message.tsx` — только `MessageExternalLink`-хунки (~40 строк: `handleCopyLink`, перекомпоновка меню, `PanelRightIcon`); дивергенция региона — только переводы комментариев. НЕ брать из того же диффа file-menu фичу (`FileApplicationChoices`, `ScopedMessageFileLink`, `useWorkspaceServices`).
- i18n: 1 ключ `chat.message.link.openInZCode` × en/zh/uk; «Open in browser»/«Copy link» переиспользуют `chat.previewCards.openExternal`/`copyLink`.

### A2: YOLO-подтверждение (S+/M−)

- NEW `packages/ui/src/hooks/useConfirmDialog.ts` (44 строки, `useYoloModeConfirmation`).
- `packages/ui/src/store/confirmDialogStore.ts` (+29/−10: AbortSignal + presentation `yolo-confirmation`); из того же апстрим-диффа чужие `codeBlock`/`scrollableDescription` — пропустить.
- `packages/ui/src/ConfirmDialog.tsx` (+~90 YOLO-AlertDialog presentation) — **hand-merge 1**: форковый guard `ui-accidental-action-guards #1` (`CONFIRM_DIALOG_OWN_ENTER_SELECTOR`) на той же keydown-строке; добавить `|| isYoloConfirmation`.
- `packages/ui/src/v4/composer/V4ComposerModeControls.tsx` (+14/−4) — **hand-merge 2**: форковый `restoreComposerInputFocusAfterPickerClose` в `onCloseAutoFocus`; объединить условие с `useConfirmDialogStore.getState().pendingRequest`.
- `packages/ui/src/v4/composer/toolbarShortcuts.ts` (+9/−2 guard) — чисто (только переводы).
- `packages/ui/src/settings/AutomationEditView.tsx` (+12/−6, `confirmMode`), `OffPeakEditView.tsx` (+6/−2), `PermissionDialog.tsx` (+22/−5 fullAccess-обёртка; форковые цифровые хоткеи в другом регионе).
- i18n `mode.yoloConfirmation.*` — 11 ключей × en/zh/uk.
- Зависимости в базе есть (AlertDialog variant, Checkbox, confirmDialogStore). Финальное состояние включает все 5+ раундов ревью из дока.

### C: G-UI кнопка «Переустановить удалённый сервис» (#51 UI, M) — выполнено

- `sourceServerUpdateAction.ts` (дивергенция 0): взять `resolveSourceServerReinstallAvailability`, `getSourceServerReinstallConfirmation`, `isSourceServerCredentialsRequiredError`; ПРОПУСТИТЬ lifecycle (`resolveSourceServerLifecycleActionAvailability`, `SOURCE_SERVER_LIFECYCLE_CONTROL_MIN_VERSION`) и `allowDowngrade` (reinstall не нужен — кнопка прячется при remote>local).
- `remote-connection-flow/index.ts` (+93, hand рядом с host-key хунками 1097–1234): `reinstallProfile`, `reinstallDeviceBusy`, `handleReinstallServer`, проп `onReinstall`; зависимости в форке есть (`updateRequiredServer`:603, `getRemoteDevicePresentationInput`, `ZCODE_VERSION`).
- `RemoteConnectionConnectingStep.tsx`: только проп `onReinstall` + failed-блок (~30 строк); downgrade/lifecycle-пропсы не брать; регионы разошлись (~461 форк vs ~628 апстрим), 4 общих малых хунка слить вручную.
- `SourceServerManagementPanel.tsx` (форк = база, 1739 строк): вшить в существующий DropdownMenu карточки (строка ~1174) пункт + availability + callback (~60–80 строк).
- i18n `settings.source.reinstallRemoteService*` — 5 ключей × 3 локали.
- CLI-половина уже в #365; зависимости (`installState` contracts:190, `lastSeenVersion`:179) в форке есть.
