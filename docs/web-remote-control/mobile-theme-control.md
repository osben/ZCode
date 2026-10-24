# Mobile Remote Control Theme Control

Mobile remote control theme works in two parts:

1. The QR code link no longer appends a `theme` query parameter, so the desktop theme does not couple to the
   mobile client's first-entry path.
2. When the mobile client first opens `/remote` and the browser has no `localStorage["zcode-theme"]`, it uses
   the default `zai-dark`; later theme changes use only the mobile client's local preference.

The two ends do not affect each other: switching the theme on mobile only changes the mobile browser's local
storage, and switching it on the desktop only changes the desktop renderer's local storage.

The task list page and the chat page header on mobile both render `WebRemoteControlThemeMenu` on the right.
The menu exposes only `system`, `zai-dark` and `zai-light`, shown as Dark Theme / Light Theme for the latter two.

## Browser surface synchronization

Mobile remote control runs in a standard browser page, so theme switching cannot only change the React subtree.
The web entry synchronizes the same resolved theme to these browser-level surfaces:

- `html`, `body` and `#root` use the current theme's `--color-background`; they must not inherit the
  transparent root background that Electron vibrancy requires.
- `color-scheme` declares the page's light/dark scheme so native controls and browser default surfaces agree.
- `meta[name="theme-color"]` uses the current theme's page background color, for browsers that color their own UI from it.

This is a browser capability boundary and does not branch on Safari, Chrome, Firefox or system versions. Initial
load is done by `index.html` before the business bundle runs, from the mobile client's local preference;
runtime switching and `system` mode system-theme changes keep being updated by the shared `applyTheme()` with
the same resolved theme. Desktop Electron does not opt in to browser surfaces and keeps the transparent root
background and native window vibrancy.

```text
localStorage / system preference
              |
              v
       resolved light/dark
              |
      +-------+-------------------+
      |                           |
      v                           v
React theme classes       browser theme surface (Web only)
dark / theme-zai-*        root background + color-scheme + theme-color
```
