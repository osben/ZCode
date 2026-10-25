# Todo 30: Provider Settings Page Scroll Edge Affordance

> Status: Completed
>
> Date: 2026-08-27
>
> Source: Provider settings page real experience feedback

## 1. Problem

The Provider settings page has independently scrolling left Provider navigation and right detail panel, but macOS may
hide system scrollbars. Fixed-height containers that cut exactly at full-row boundaries make users misjudge that no
more content is below. This Todo only adds a conditional scroll edge affordance; scroll areas, container heights,
Provider/Model ordering and config saving are unchanged.

## 2. Interaction

```text
No overflow                  -> no affordance
At top with content below    -> bottom gradient only
In middle                    -> top and bottom gradients
At bottom                    -> top gradient only
```

- Left and right columns measure and update separately, with no shared scroll state.
- System scrollbar behavior stays; no forced persistent scrollbar, text or arrows.
- The gradient layer does not receive pointer events (`pointer-events-none`), so it never blocks model actions,
  dragging or Provider selection; the detail feedback banner stays on a higher layer.
- Semantic Card colors, consistent under Zai Light / Zai Dark.
- Content changes, container scaling and window resizing trigger re-measurement (`ResizeObserver` on
  viewport/content).
- Scroll listening is passive; an unchanged `top/bottom` state keeps the original object so scrolling causes no
  meaningless React render.

## 3. Implementation and verification

`ScrollEdgeShadowViewport` is shared by the left and right columns. Verification: a pure function covering no
overflow, top, middle, bottom and 1px error; a component test for `top/bottom` state after scrolling; a layout test
that Provider navigation and detail use the same component; regression of Provider/Model dragging, left-right
independent scrolling, detail feedback banner and narrow-screen layout. 322 Provider settings-related tests,
workspace-wide typecheck and lint passed (lint keeps only pre-existing warnings).
