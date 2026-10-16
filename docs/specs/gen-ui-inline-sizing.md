# Gen UI Inline Content Sizing and Scrollbars

## Behavior

Hide the native scrollbar on the Gen UI root document, without reserving scrollbar width. Apply only to `html` and `body`; do not change scroll areas inside author components or disable page scrolling with `overflow: hidden`. Ordinary inline content expands to its actual content height, with scrolling handled by the outer conversation. At the existing 10000px limit or in an enlarged viewport, preserve existing content access; do not add a notice or display mode.

## Measurement and Ownership

```text
Content size / root children / viewport width change
  → guest batches to the next animation frame and reads content geometry (does not write root height)
  → existing ui/notifications/size-changed
  → Gen UI page owner updates inline height
  → browser layout; equal changes driven only by viewport height are not reported again
```

- The guest is the sole source of content measurements; replace SDK automatic sizing rather than keeping two parallel observer systems.
- Exclude root-level scripts, styles, and tooltips. For one content root, use its bounds and `scrollHeight`; for multiple roots, use the lowest content bound; use `Range` for plain text. Count body top/bottom padding only once.
- `ResizeObserver` watches `body` and content roots; `MutationObserver` updates the set of observed roots; resize handles viewport changes. Stop observing removed nodes, and disconnect observers and cancel pending frames when the page unloads.
- At the same width, do not report a content-height increase equal to the viewport-height increase. This prevents `vh` / percentage-height content from growing continuously as the host resizes. During enlargement, the host continues to reserve body space; remeasure after collapse.
- Inject the root scrollbar-hiding style when assembling the sandbox document; author snippets require no changes. MCP Apps and standalone HTML exports are unaffected.

## Evidence and Boundaries

When switching from a short-content tab to a chart, the guest initially overflows and the host then expands. Even when actual `scrollHeight` equals `clientHeight` and scroll distance is zero, the root scrollbar may still occupy 15px. Temporarily hiding and restoring overflow clears the condition, but switching tabs can reproduce it. The old SDK measurement temporarily set the `html` height to `max-content`; the new measurement reads content geometry only, avoiding layout changes caused by measurement itself.

Implementation is limited to the desktop plugin-sandbox presentation layer; keep the existing size protocol, host height limit, and enlargement behavior. Gen UI registration currently requires a desktop sandbox; do not add a Web/mobile render path. Narrow-screen reflow uses the same measurement logic. Do not change theme colors, copy, platform branches, or session message flow. Keep existing boundaries for desktop continuous, mobile replayable, and remote-workspace routing.

## Regression Matrix

Add real Electron cases to the existing `node packages/desktop/scripts/gen-ui-e2e.mjs` suite:

| Scenario | Assertion |
| --- | --- |
| Repeatedly switch between a short tab and an SVG chart with fractional-pixel height | Container promptly grows/shrinks, content remains complete, and the root scrollbar takes no width |
| Desktop width and 390px narrow screen, light/dark themes | Height is correct after reflow; no horizontal overflow |
| Add/remove nested content and root-level tooltips | Content changes update height; tooltips do not increase body height |
| Send a real wheel event with the pointer inside the chart | Outer conversation scrolls; guest `scrollY` remains 0 |
| Expand/collapse | Same guest is retained; body space and post-collapse measurement are correct |
| Root-node measurement | Do not modify `html.style.height`; no continuous size feedback |
| `vh`-dependent height | Host size updates do not cause unbounded growth |
| Height exceeds 10000px | Existing limit and scroll access remain; the view can shrink after content is removed |

Protocol-assembly unit tests verify that the root scrollbar style appears after author content and is not injected into MCP documents.
