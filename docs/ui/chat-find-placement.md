# Chat Find Placement

The in-task find box opened with `Cmd/Ctrl+F` belongs to the current chat area, not to a global window title-area control.

The find box renders inside the visual bounds of the workspace conversation panel, above the chat content and horizontally centered. On desktop it mounts directly on the conversation panel; mobile Web remote control mounts it through the shell's separate chat overlay slot, so the overlay still follows the chat content area without being a descendant of the chat body DOM. Thus on desktop it follows the chat column when the sidebar, Git/Browser side pane or terminal split is open, and on mobile it takes no global navigation or window-button area.

Find state is still owned by `App` and keeps driving chat-body highlight and file-change highlight. `TaskFindDialog` handles only input, scope switching and result navigation; it adds no cross-platform runtime state and does not change the desktop continuous and web remote replayable message chains.

Icon buttons inside the find box must provide a tooltip. Result navigation buttons must show their tooltip even when disabled for no results, so icon-only controls are never unexplained. The scope toggle tooltip uses the fixed copy "切换搜索范围会话/文件" (switch search scope conversation/files), while the button's own `aria-label` still states the scope the next click will switch to.

## Mobile Web overlay drawer layering

When mobile Web opens the Git/Browser side pane, the overlay drawer sets the underlying chat surface to `inert` and `aria-hidden`. This isolation is the existing safety boundary that stops the composer, model selection and other controls under the scrim from responding to clicks; it must not be removed or relaxed for find.

`TaskFindDialog` must be hosted by the separate `chatOverlay` slot of `WebRemoteControlMobileShell`. That slot is a sibling of the chat surface and the side pane overlay, does not inherit the chat surface's `inert` / `aria-hidden`, and uses a layer above the drawer scrim. After switching to the file-change scope, the input, previous/next, scope toggle and close button must stay focusable and clickable; switching back to the conversation scope reuses the same component instance and local query/scope state, with no remount caused by moving the component between the chat tree and the drawer tree.

Rejected alternatives:

- Removing `inert` from the chat surface: restores click-through of controls under the scrim and breaks the existing mobile interaction isolation.
- Moving the component between the chat tree and the side pane tree by find scope: externalizes scope and remounts the component, raising the risk of losing query, focus and navigation version.

The mobile DOM regression must prove the find overlay sits outside the `inert` chat surface and keeps interactive controls after the side pane opens. The desktop pending E2E continues to prove real conversation/Git scroll re-centering; until a separate mobile replayable E2E infrastructure exists, the desktop case is not presented as end-to-end proof for mobile.

## Escape priority

Chat placement uses a window bubble-phase listener to complete Escape-to-close semantics. The listener must check `event.defaultPrevented` first: when an active nested overlay or control has already consumed Escape, the find box stays open; only an unhandled Escape makes the find box call `preventDefault()` and close. Tests must cover both the handled and the unhandled path.

## Result navigation semantics

Find state must distinguish "which hit is currently selected" from "the user just issued a navigation". The query and hit index describe the current selection; an independent, monotonically increasing navigation request version describes whether the user asked for locating again. Scrolling cannot be decided from `(query, activeIndex)` alone, because with a single hit previous, next, `Enter` and `Shift+Enter` all wrap to the same index.

These entries must use consistent semantics:

- Clicking previous or next result.
- Pressing `ArrowUp`, `ArrowDown`, `Enter` or `Shift+Enter` in the search input.
- Both the conversation body and file-change search scopes.

After the user scrolls away from the current hit, any result navigation entry must scroll that hit back to the viewport center even if the target index is unchanged. With several hits the existing wrap order continues; with zero hits both buttons and keyboard navigation stay disabled and produce no new navigation request version.

The navigation request version is Renderer-local UI state only and does not enter session/task runtime, protocol, snapshot, queue or persistence. The conversation body and file changes keep independent versions, so switching scope does not trigger scrolling in the other. The text-highlight hook keeps DOM-mutation de-dup, but a new user navigation version must break the scroll de-dup of the same `(query, activeIndex, matchCount)`.

Desktop and mobile Web reuse the same `TaskFindDialog` and highlight hook, so interaction semantics are consistent; this does not touch the message recovery boundary of `desktop-continuous` and `web-remote-replayable`.
