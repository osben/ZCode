# Workspace Resize Auto Collapse

## Background

The Workspace main view contains the left sidebar, the chat conversation, the bottom terminal and the right side pane. When the user shrinks the desktop window, the conversation is the first core area to be squeezed, so the auto-collapse policy keys off the actual width of `ResizablePanel(id="conversation")`.

## Policy

1. React only to user-triggered `window.resize`. Do not observe the conversation panel with `ResizeObserver`, otherwise a panel the user just opened would be closed again immediately.
2. After each window resize, read the actual width of the conversation panel; do not use `window.innerWidth`.
3. If the side pane is open and the conversation width is below `480px`, collapse the side pane.
4. If the sidebar is open and the conversation width is below `360px`, collapse the sidebar.
5. Auto-collapse fires only when the window narrows. Enlarging the window does not restore anything; the user reopens panels with the existing buttons or shortcuts.
6. Side pane auto-collapse only hides the container and does not close tabs, so browser, Git and preview content is preserved.

## Compatibility Boundaries

- Desktop and Web desktop share the same conversation panel listener.
- Mobile remote control uses a separate overlay / mobile shell and does not depend on this desktop split policy.
- The policy does not change the ZCode session / task realtime message flow and does not touch the `desktop-continuous` / `web-remote-replayable` transport boundary.
