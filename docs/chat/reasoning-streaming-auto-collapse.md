# Reasoning Inline Streaming Summary

An assistant thought / reasoning block already expresses "the model is thinking". While streaming it stays collapsed by default; the trigger shows the raw streamed content right after `Thinking ·`. The summary follows the label, grows with content and uses at most the remaining width of the line. The user can still expand to see the full content.

## Rules

- While `isStreaming=true` the thought block stays collapsed by default. The `Thinking` label keeps `animated-gradient-text` (a light text gradient, no new color token).
- Collapsed format: `Thinking · <streamed content>`. The Chinese running label is "正在思考" (thinking) and the completed label "思考" (thought); English stays `Thinking` / `Thought`.
- The summary snapshot derives from line boundaries, but newlines are not converted to `<br>`: new tokens within the same line update in place; when the next non-empty line appears, the old line exits upward and the new line enters from below. The vertical switch reuses the tool summary's queue and rhythm (300ms animation, 500ms dwell, at most the current item plus two pending items); on main-thread jank or reduced motion it converges straight to the latest line.
- The current-line summary viewport follows the separator dot directly, without `ml-auto` or `text-right`. It grows left to right when content does not fill it; once it reaches the remaining width beyond label and arrow it stays single line and scrolls to the end after each streamed update, so old content moves left and the newest token stays visible.
- When the summary overflows horizontally, both sides of the viewport fade with a 16px mask; with no overflow no mask is applied, so short content edges do not fade. Overflow must be re-measured when container or content width changes.
- Streaming summary text uses the secondary color `text-foreground-subtle`; the icon, separator dot and arrow keep the weaker `text-foreground-subtlest`.
- When a thought is expanded while running, the header switches to `icon + **Thought** + · + duration`, hiding the single-line streaming summary and its horizontal mask; duration counts from the start of thinking and updates every second, and the full thought keeps streaming below.
- Completed state: `icon + **Thought** + · + duration`; the three text nodes use `gap-2`; in Chinese a bold "思考", a regular-weight separator dot and a regular-weight "持续了 N 秒". English duration is `N seconds` with no `for` or `took` (for example `Thought · 2 seconds`).
- Same-line tokens update the current text node directly; only non-empty line boundaries use the same vertical roll and summary queue as Explore. When reasoning completes it switches immediately to the existing `Thought · duration` summary and clears pending content.
- After the user expands, the full thought keeps streaming under the existing newline, wrapping and stick-to-bottom rules; the collapsed state's `whitespace-nowrap` must not affect expanded content. A completed thought can still be expanded manually.
- Expanded thought content shows edge masks only when it actually scrolls vertically: at the top only the bottom fade, in the middle both, at the bottom only the top fade.
- Expanded thought content follows the bottom by default; scrolling up away from the bottom pauses sticking, and returning to the bottom resumes it.
- When `open` is controlled, the externally passed state is respected; the component only syncs duration and delayed content unmount.

## Compatibility

UI-layer thought / reasoning display only: no change to ZCode Protocol, message snapshots, or desktop continuous / mobile replayable semantics. Mobile Web and desktop consume the same message parts and share the default-collapsed, single-line in-place streaming summary rules.
