# Windows Caption Menu Button

- Render a custom menu button only on Windows desktop, to the left of the native minimize/maximize/close buttons.
- The custom button supplements app-level shortcuts; it does not replace the native caption buttons.
- Treat the `titlebar-area-x` / `titlebar-area-width` CSS environment variables exposed by Window Controls Overlay as the source of truth for the horizontal boundary between the custom button and native caption buttons. The window width minus the available titlebar area gives the safety margin for the native controls on the right. Use `136px / zoomFactor` only as a compatibility fallback for older Electron versions, test environments, or when environment variables are unavailable; it must not override actual system/DPI geometry.
- Derive the width of the custom Windows Terminal, sidebar, and dropdown-menu buttons by dividing the total width of the native controls on the right by three. This keeps them in the same columns as the native minimize, maximize, and close buttons after page zoom. Do not treat a fixed `46px` as the final visual width after zoom.
- The workspace task header, new-task draft title bar, and Settings title bar must reuse the same safe-area calculation. At the default zoom, the minimum `-3` level, the maximum `+5` level, and different Windows DPI settings, the dropdown button's hit area must not enter the native minimize-button region.
- Prefer reusing existing platform commands and workspace actions for menu items; avoid maintaining a parallel set of logic.
- Group menu items in this order: workspace actions, help actions, developer diagnostics, and window actions. In the Help group, add a divider between “Check for updates” and “Report a problem” to distinguish system updates from user support.
- Reuse `DesktopCommandIds` for help and diagnostic entries so the Windows caption menu and desktop main menu do not drift in capabilities.
