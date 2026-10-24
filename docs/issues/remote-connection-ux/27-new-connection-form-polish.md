# 27: New Connection Form Layout and Colors

Status: done

**Parent:** [#01 — Remote Connection Interaction and Visual Experience Optimization](01-remote-connection-ux-optimization.md)

**Spec:** [Remote device connection UX spec · RDUX-27](../../architecture/remote-device-connection-ux-spec.md#新建连接表单rdux-272026-10-14)

**What to build:** The form shared by the Settings entry "新建连接" and the project/chat entry "新建 SSH 连接": adjust the header, type switch, SSH config import, field layout, paste splitting, inline validation, Docker/WSL hints, colors and footer per the spec. UI layer only; the connection flow, protocol and the state semantics of `useRemoteConnectionForm` do not change.

**Blocked by:** None. Reuses the typed form of the Settings entry from [#17](17-typed-remote-device-addition.md).

## Acceptance criteria

- [x] The Settings entry shows no step bar and no explanatory sentence, the title is "新建连接" with a live preview of the connection target below; the project/chat entry keeps the three-step bar and shows a type tag beside the title.
- [x] The type switch is a segmented control with icons, the selected item uses the corresponding type color; authentication method and Docker input method stay neutral.
- [x] The Settings entry "从 SSH config 导入" (import from SSH config) opens a searchable popover, and after selection shows an association tag; × only removes the association and keeps filled values; disabled when there is no Host; a read failure shows a warning and manual entry is possible. The project/chat entry shows no alias entry.
- [x] Host and port on one row; username on its own row; advanced options have no dashed separator.
- [x] Pasting `user@host`, `user@host:port`, `ssh user@host -p N` into the host field splits automatically and shows an "已识别" (recognized) hint; other content pastes unchanged; pasting removes the alias association.
- [x] On open, focus is on the host; after an import, focus goes to the first empty required field.
- [x] Validation errors show under the field and are associated with `aria-describedby`, focus goes to the first erroring field, and the footer has no validation text; the edit-connection dialog reuses the same validation function and inline errors.
- [x] Docker / WSL drop the top explanatory paragraph; Docker unavailable shows a warning card, no running containers shows a neutral hint.
- [x] The Settings entry footer is right-aligned; the project/chat entry has back on the left and connect on the right.
- [x] The dialog's top edge is fixed at 10% of the viewport, and switching authentication method or type does not move the top edge.
- [x] Fully visible in Chinese/English, dark/light themes and 1440 / 480px; all existing testids are kept, and `remote-ssh-config-import`, `remote-ssh-config-alias-chip`, `remote-new-connection-preview` are added.

## Verification

- UI unit tests: table test for `parseSshPasteTarget`; `collectRemoteFormFieldErrors` rules; form header, type switch, import / association tag, paste, focus, inline validation, both entries' footers and the edit dialog.
- Desktop E2E: update the affected assertions in `conversation-session-settings-connection-completion`, `conversation-session-ssh-remote-three-screen` and `conversation-session-remote-accessibility`; cases stay pending.
- Type check, lint, the architecture gate, affected unit tests.

## Deferred verification

- [ ] Real WSL discovery and manual add on Windows.
- [ ] Real end-to-end regression of the Web/mobile remote-control entry.

## Completion evidence (2026-10-14)

- Implementation: header preview and step bar in `RemoteConnectionWizardChrome.tsx`; type switch, import and footer in `RemoteConnectionDialogContent.tsx`; field layout, segmented control, alias popover, paste splitting and inline errors in `RemoteConnectionFields.tsx`; the single validation source `collectRemoteFormFieldErrors`, the preview `formatRemoteDraftPreview` and paste parsing `parseSshPasteTarget` in `lib/remoteConnectionWizard.ts`; type color source `REMOTE_KIND_PRESENTATION`. The edit-connection dialog deleted its own field validation and uses the same function.
- Unselected segmented-control items hint keyboard focus with `focus-visible:bg-hover`: global styles have disabled focus outline / box-shadow since `2bb283f474`. The old outline assertion in `settings-connection-completion` necessarily fails after that commit and now asserts `:focus-visible`.
- Verification: `pnpm typecheck`, `pnpm lint` (0 errors), `pnpm architecture:check --changed` (0 violations), new and affected UI unit tests pass. Local macOS Desktop + an exclusive Linux SSH container ran `conversation-session-settings-connection-completion.test.ts`, 2 tests all pass, including empty-form inline validation and focus, import association tag and focus, header preview, the top edge not moving when switching authentication method, paste splitting, Docker type color and removal of the explanatory paragraph, with screenshots covering Chinese/English, dark/light, 1440 / 480px.
- `conversation-session-ssh-remote-three-screen.test.ts`: import button, first-install confirmation and add device pass; it was then blocked by the E2E environment's "登录已过期" (login expired) popup, and the offline reconnect and collapsed-failure sections did not complete.
- `conversation-session-remote-accessibility.test.ts`: the form keyboard section (including segmented-control `:focus-visible`) passes; later cases still wait for the Settings entry to enter the directory screen, which conflicts with the in-Settings completion semantics of #16/#17 (connection log shows `remote-connected`); these are existing stale assertions, and this ticket did not rewrite the second half of that case. The new "focus on host when opened" assertion sits in the second half and was not reached.
- Root affected unit tests (`--base f67f7570ba`) 1393/1395 files pass; 3 plan endpoint assertions in `packages/services` (`z.ai` vs `z.ai`) also fail on baseline `f67f7570ba`, unrelated to this ticket.

## Follow-up fixes (2026-10-14)

Four fixes after the review of `870fc0e012`: a whitespace-only port produced `port: 0` (construction now reads the same trimmed value as validation); paste parsing split `ssh://user@host` and `user:password@host` into a wrong username (the username excludes `:` and `/`, pasting unchanged); an empty Docker dropdown always shows "选择正在运行的容器" (restoring the reason copy); when the edit dialog is opened from "修改主机" the validation focus lands on the hinted host (only fields with an error description are focused). UI unit tests cover the four; desktop E2E adds RDUX27-1.
