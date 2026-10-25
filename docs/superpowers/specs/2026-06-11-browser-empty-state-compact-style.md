# Browser Empty State Compact Style

The embedded browser's empty state is compact for the dense right-pane workspace:

- Logo `size-16`, icon in `foreground` with `opacity-30`, `mb-6` between icon and title.
- Title `text-sm` (workspace heading level); secondary text fixed `13px` per the design-system helper-text rule.
- Styled in `BrowserEmptyState` inside `packages/ui/src/EmbeddedBrowserPaneParts.tsx`.

## Empty-page guest creation boundary

- A newly created human browser tab with no confirmed navigation renders only the empty state and does not create a `<webview src="about:blank">`. An Electron guest uses its own compositing surface; creating it synchronously paints a white first frame before React's mask/hidden styles apply.
- Address-bar drafts do not trigger guest creation; only Enter-confirmed navigation, an initial URL, or an external navigation request does.
- A human empty state that has not requested a guest shows the Globe icon directly — `isReady=false` must not be read as loading; the spinner shows only after guest creation is requested and not yet ready.
- URLs queued before guest creation stay in `pendingUrlRef` and are consumed by `loadURL` on `dom-ready`. Once created, the guest stays mounted; empty-state or visibility changes never rebuild it.
- agent/browser-use tabs still create and report their guest before first navigation, otherwise main's wait-for-attach and the first browser command deadlock. Residency restore also mounts immediately.

```text
human empty tab -> empty state -> confirmed navigation -> create guest -> dom-ready -> loadURL
agent/restore tab -> create guest -> did-attach -> main takeover/restore
```

Verification: unit tests cover initial no-webview, draft no-webview, create-on-Enter with queued URL consumed, Globe-not-spinner before guest request, and agent-tab guest reporting before first navigation. Electron E2E `browser-empty-state-deferred-guest.test.ts` covers the real lifecycle: new empty tab has no guest in renderer DOM or main `webContents`; typing without Enter stays empty; Enter creates exactly one guest, consumes the pending URL, and shows the page. Navigation results, agent guest handshake, remote-control path, and persisted guest lifecycle are unchanged.
