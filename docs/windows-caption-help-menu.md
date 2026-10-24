# Desktop help menu (top-right question-mark menu)

## Background

The Windows/Linux desktop once had a self-drawn arrow merged menu in the title bar's top right, carrying
window-level and help entries; together with the workspace header's question-mark menu the top-right
entries were duplicated. Since 2026-09 (`ab48cad0bd` etc.), Windows/Linux settings page, task page and
draft state all switched back to the shared question-mark help menu `WorkspaceHelpMenuButton`, and the
arrow menu `WindowsCaptionMenuButton` is no longer mounted.

This left a gap: the "Resource Manager" in the old arrow menu was left with only the macOS native Help
menu path, and Windows/Linux have no native menu bar, so there was no entry at all.

## Product semantics

- On all three desktop platforms and on Web, the top right shows only the question-mark help menu; the
  mount position of the question-mark button is controlled by `WorkspaceHeaderActionSection` / `SettingsPage`.
- First group: product docs, user community, issue report, product request.
- After one divider comes the desktop-only group: export logs, Resource Manager, check for updates, About
  ZCode. Check for updates shows only in production and is hidden in Preview; About is the last item. Existing
  commands are reused; when a download completes, "重启更新" / "Restart to update" and a standalone version pill show.
- Export logs reuses the system menu's main-process export implementation, and the UI shows exporting and
  failure prompts through the shared help action; issue report keeps `includeLogs=true`. Web has no desktop group and no divider.

## Implementation constraints

- Issue feedback, product docs and export logs reuse `createHelpMenuActionHandlers`; no desktop command is added.
- Platform detection does not sniff `window` or the UA inside `WorkspaceHelpMenuButton`; the mount site
  injects `isDesktop` (`WorkspaceHeaderActionSection` and `SettingsPage` already hold this value), so Web is
  not affected by mistake. The Web `IPlatformService` stub also implements `executeDesktopCommand` (no-op),
  so it cannot be used as a desktop check.
- test ids: trigger button `TID_WORKSPACE_HELP_MENU_TRIGGER`, Resource Manager item `TID_WORKSPACE_HELP_MENU_RESOURCE_MANAGER`.

## Tests

- Unit test: `packages/ui/test/workspaceHelpMenuButton.test.ts` — when `isDesktop` is true the Resource
  Manager item renders and calls `OpenResourceManager`; when false it does not render.
- E2E: `packages/desktop/test/e2e/resource-manager.test.ts` — open the Resource Manager window from the question-mark menu.
- Formal About-entry E2E: `packages/desktop/test/e2e/help-menu-about.test.ts` — a real click on the
  question-mark menu verifies the About window is visible and contains the app name and version; the
  check-update item shows per product identity, and under production a click is verified to forward the
  existing IPC command without downloading or installing. No model request needed; confirmed for promotion
  by the user and added to the default desktop E2E collection.

### E2E scenarios

| Scenario | Acceptance |
| --- | --- |
| English draft state, Chinese settings page | About menu copy and order are correct; a real click opens the About window with the version |
| English draft state, Chinese settings page, export logs | The desktop group's first item is export logs; a real click generates a ZIP, requests system reveal and ends the export prompt; the original export implementation is reused |
| production initial state | Check for updates shows; a real click receives a development-build `dev-skipped` receipt through the existing command |
| production state events | checking is disabled; available version and download progress show the matching copy; on download complete the action copy and the version pill are asserted separately (not depending on parentheses or child-node whitespace concatenation); after close and reopen the version pill keeps the latest state |
| Preview | Neither draft state nor the settings page has an update item, and an injected update event does not make it appear |

State events use a case-local synthetic `UpdateStatePayload` and verify only main→preload→menu display; the
real updater is not modified and nothing is downloaded or installed. The tests no longer depend on the
Node-side `ZCODE_PRODUCT_FLAVOR` (which falls back fixedly to preview when the define is not compiled in);
the default expectation is Preview; production must explicitly pass the expected identity and assert on the real menu.

```bash
ZCODE_ENV=production ZCODE_PREVIEW_IDENTITY=0 ZCODE_E2E_HELP_MENU_FLAVOR=production pnpm --filter @zcode/desktop test:e2e -- --spec ./test/e2e/help-menu-about.test.ts
ZCODE_ENV=test ZCODE_PREVIEW_IDENTITY=1 ZCODE_E2E_HELP_MENU_FLAVOR=preview pnpm --filter @zcode/desktop test:e2e -- --spec ./test/e2e/help-menu-about.test.ts
```

The two identity switches must rebuild; do not set skip build. Hiding the entry on mobile Web is still
covered by existing component unit tests; no new mobile-browser E2E is claimed.

Verification (2026-09-16, macOS arm64): production and Preview each 4/4 passed; the formal path without
manual-review or expected-identity parameters passed 4/4 on the default Preview. `pnpm typecheck`,
`pnpm --filter @zcode/desktop typecheck:e2e`, `pnpm lint` and `pnpm architecture:check --changed` passed
(lint keeps 43 pre-existing warnings, 0 errors). Not verified: Windows/Linux real machines, mobile browser,
and formal installer download/install; Docker suite admission is out of scope. The case is promoted.
