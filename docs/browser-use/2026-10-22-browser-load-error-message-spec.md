# Browser pane: readable load-error message

Status: implemented with QA ISSUE-044 (2026-10-22). Origin: QA round 2026-10-21, S3.

## Problem

The load-error view (`data-testid=browser-load-error`) showed raw Electron IPC text, for example
`Failed to load page: Error invoking remote method 'GUEST_VIEW_MANAGER_CALL': Error: ERR_UNSAFE_PORT (-312) loading 'http://127.0.0.1:9/unreachable'`.

Two writers set `errorMessage` for the same failure:

- `did-fail-load` (main frame) wrote `event.errorDescription` (for example `ERR_UNSAFE_PORT`).
- The `webview.loadURL` rejection catches (pending-URL path and the direct navigation path) wrote the
  raw `error.message` from Electron IPC.

Both writers run for one navigation. Which text is displayed depends on which one lands last. The
reported screen shows the raw IPC text, so the rejection catch is the writer that won in that run.
This ordering is inferred from the reported text and from the code paths, not observed live.

## Contract

- **Single owner of the text.** `describeBrowserLoadFailure` in
  `packages/ui/src/embeddedBrowserHelpers.ts` is the only code that turns a load failure into
  the text shown in `browser.loadFailed`. Every writer calls it.
- **Order-independent.** Given the same failure, every writer must produce the same string. The
  helper reduces input to the Chromium net error token, so the result does not depend on whether
  `did-fail-load` or the rejection arrived first.
- **Precedence.** A valid `errorDescription` (`ERR_*`) wins. Otherwise the first `ERR_*` token in the
  raw message wins, with the Electron IPC wrapper and the `(-NNN) loading '…'` tail ignored.
  Otherwise the cleaned raw message is used, then `net error <code>`, then `unknown error`.
- **URL.** The message does not repeat the URL. The address bar already shows the failing URL
  (set before the navigation in both paths), and a URL taken from different sources could differ by
  normalization and break the order-independence rule.
- **Unchanged.** The Reload/retry button, the certificate hint (driven by `loadErrorCode`), the
  `ERR_ABORTED` (-3) guards, and the renderer-exit and element-picker error paths keep their behavior.
