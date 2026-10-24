# Browser Guest Crash Recovery — Current Contract

Shipped (2026-07-23). Acceptance criteria: BCP-207/BCP-208 in
`docs/testing/browser-use-codex-parity-coverage-matrix.md`. Implementation:
`packages/ui/src/browser-use/UnifiedBrowserView.tsx`,
`packages/ui/src/embeddedBrowserHelpers.ts` (`isRecoverableBrowserGuestExitReason`),
`packages/desktop/src/main/browserView/browserGuestManager.ts`.

## Recovery contract

- Recoverable guest exit reasons: `abnormal-exit`, `killed`, `crashed`, `oom`,
  `memory-eviction`. Not recoverable: `clean-exit`, `launch-failed`,
  `integrity-failure` (no auto-rebuild loop).
- On a recoverable `render-process-gone`, increment the guest generation so
  `BrowserViewportSurface` replaces only the dead `<webview>` node (generation is the React
  key). Normal A → B → A tab switching must not rebuild, refresh, or unmount a live
  `<webview>`; generation stays unchanged.
- The most recent non-`about:blank` URL is kept in renderer memory keyed by
  `workspaceIdentity?.trim() || workspacePath`, then bucketed by stable side-pane tab id;
  the new guest re-attaches via the existing `browserViewAttachGuest({ key: browserKey,
... })` chain with the same browserKey/tabId/session and the new webContentsId, then
  restores the URL after `dom-ready`.
- User-triggered explicit close of a tab/window and ZCode process exit never auto-recover.
- Main process: old-guest listener cleanup is best-effort (`try/finally`), so cleanup
  errors on an already-destroyed session (`Object has been destroyed`) cannot block the
  replacement guest's CDP attach.

## Guest failure state (unrecoverable or never-first-paint exits)

- The renderer must show a visible failure state with `reason`/`exitCode` and a single
  user-triggered retry entry; never a silent gray screen with only a written-but-unread
  error field. Retry increments the generation and restores the last URL. No background
  auto-retry loop.
- The failure state keeps the address bar editable. Submitting a valid URL counts as one
  user-triggered rebuild: leave the failure state immediately, increment the generation,
  and navigate the new guest to the submitted URL after `dom-ready`. An invalid URL keeps
  the failure state and does not rebuild.
- An external `navigationRequest` is also a trusted explicit navigation intent: while the
  guest is in the failure state, it rebuilds the guest and consumes the target URL the
  same way. Its receipt must not be sent after merely queuing the URL in `pendingUrlRef`;
  acknowledge only after the new guest takes over the queued URL on `dom-ready` and
  `loadURL` succeeds or fails explicitly, so the caller does not clear an unexecuted
  navigation intent.

## Boundaries

- Desktop `desktop-continuous` uses the existing renderer/main attach chain only; mobile
  `web-remote-replayable` adds no snapshot or runtime state; relay and the ZCode session
  protocol gain no state.
- UI logging via `packages/ui/src/logger.ts`; abnormal exits are low-frequency lifecycle
  `warn`, no new production `info` volume.
