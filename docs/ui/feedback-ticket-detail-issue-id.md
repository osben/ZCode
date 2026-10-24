# My Feedback Detail Issue Number

## Background

After opening a single item in "Feedback / My Feedback", users need to send the issue number to engineering, product or support to locate the problem. The detail page used to show only the title, status, submit time and processing progress, so users could neither see nor copy the number.

## Goals

- Show the number of the current feedback at the top of the "My Feedback" detail page.
- Provide a copy button next to the number that copies the plain number value, for pasting into chat, documents or backend search boxes.
- Keep the interaction identical on desktop and mobile Web, with no dependence on desktop-only APIs.

## Design

- The number comes from `FeedbackTicketDetail.id`; no new field is added to the feedback service protocol.
- The display text is `Issue #<id>`, with `<id>` in a monospace font so long numbers stay readable.
- The copy button sits on the same row as the number, using `Button` with `ghost` + `icon-sm` size and `CopyIcon`, as `DESIGN.md` requires for compact tool buttons.
- The copied content contains only `<id>`, without the `Issue #` prefix.
- After a successful copy the button's accessible label briefly switches to "已复制" (copied); on copy failure a warn is logged through `packages/ui/src/logger.ts`, without calling `console` or `window.zcode` directly.

## Compatibility

- The browser clipboard uses `navigator.clipboard.writeText`; desktop Electron, Web and mobile remote control all use the same Web API.
- When the clipboard is unavailable or the write fails, detail rendering is not blocked and only a diagnosable log is recorded.
- The change does not touch `clientMode`, `deliveryKind`, task realtime, snapshot, queue or the remote-control recovery chain.

## Verification

- A unit test covers the detail page rendering the number and the copy button label.
- Run `pnpm typecheck` and `pnpm lint`.
