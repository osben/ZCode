# Mobile Remote Control Theme Control

Mobile remote control theme is handled in two stages:

1. The QR code link no longer appends a `theme` query parameter, avoiding the desktop theme from continuing to couple the mobile client's first-entry path.
2. When the mobile client opens `/remote` for the first time, if the local browser does not have `localStorage["zcode-theme"]`, it uses the default `zai-dark` as the initial theme; subsequent theme changes only use the mobile client's local preference.

This ensures that the two ends no longer affect each other: switching the theme on the mobile client only changes the mobile browser's local storage, while switching the theme on the desktop only changes the desktop renderer's local storage.

The task list page and the top header of the chat page on the mobile client both render `WebRemoteControlThemeMenu` on the right side. The menu only exposes `system`, `zai-dark`, and `zai-light`, where `zai-dark` / `zai-light` are displayed as Dark Theme / Light Theme respectively.

## Browser Surface Synchronization

The mobile remote control runs in a standard browser page; theme switching cannot only change the React subtree. The web entry point must synchronize the same resolved theme to the following browser-level surfaces:

- `html`, `body`, and `#root` use the current theme's `--color-background`; they must not inherit the transparent root background required by Electron vibrancy.
- `color-scheme` declares the light/dark scheme used by the current page, so that native controls and browser default surfaces use a consistent scheme.
- `meta[name="theme-color"]` uses the current theme's page background color, for browsers that support this standard to color their own UI.

This synchronization is a browser capability boundary, branching by neither Safari, Chrome, Firefox, nor specific system versions. The initial load is completed by `index.html` before the business bundle executes, based on the mobile client's local preference; runtime switching and `system` mode system theme changes continue to be updated by the shared `applyTheme()` using the same resolved theme. Desktop Electron does not declare browser surface opt-in and continues to retain the transparent root background and native window vibrancy.

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
