# Web Remote Control Browser Tab Favicon Design

## Background

Opening the Web Remote Control page in a mobile browser showed the default tab icon: `packages/web/index.html` set only the page title, declared no favicon, and `packages/web/public` had no ZCode brand favicon. Additionally, Chrome in some dev scenarios never issues a separate favicon network request and relies only on icon metadata already in the entry HTML — a static `/favicon.ico` or `/remote/favicon.ico` alone cannot cover that.

## Goals

- The Web Remote Control page shows the same ZCode icon as the desktop app in common desktop and mobile browser tabs.
- Reuse the existing desktop app icon; no new brand assets.
- No change to the desktop continuous link, the mobile replayable link, or any remote-control business state.

## Non-goals

- No PWA manifest.
- No "add to home screen" Apple Touch Icon or Android icons.
- No page title, splash, theme, or other UI changes.

## Design

Copy the desktop multi-size icon `packages/desktop/build/icon.ico` verbatim to `packages/web/public/favicon.ico` for the legacy favicon path and build output. Also embed the existing small-size app PNG icon in `packages/web/index.html` `<head>`:

```html
<link rel="icon" type="image/png" href="data:image/png;base64,..." sizes="32x32" />
```

The ICO keeps multiple sizes so browsers pick the right layer per tab density; the web `public` copy lets Vite serve it in dev and production. The entry-HTML data URL covers the Chrome dev case where no favicon network request happens — the browser gets the icon while parsing HTML. The data URL comes from `public/logo/icons/32x32.png`; that set's `icon.ico` is binary-identical to `packages/desktop/build/icon.ico`.

`dev:web-remote-control` keeps the Vite root base to preserve existing `/remote` SPA routing; otherwise Vite would intercept `/remote` as a base-URL prompt page.

## Verification

- Regression assertions in `packages/web/test/webRemoteControlBootstrapShell.test.ts`: the entry HTML embeds the data URL favicon of `public/logo/icons/32x32.png`.
- Assert the web favicon is binary-identical to the desktop app ICO, guarding against the same-named generic Material Icons file icon.
- In root build scripts tests, assert `dev:web-remote-control` still starts Vite with the root base (covers the local copy-link scenario).
- Run targeted web tests, `pnpm typecheck`, `pnpm lint`.
- A non-root-base web build must keep the base-independent data URL favicon in the output HTML, and the legacy `favicon.ico` must land in the build output.

## Compatibility and risk

Only web static assets and HTML metadata change — no React components, services, protocol, workspace identity, or remote-control message flow. Desktop and mobile business behavior is unchanged. Browsers may cache the old favicon; verify a release first with an incognito window or a forced refresh.
