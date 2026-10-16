# Todo 30: Provider Settings Page Scroll Edge Affordance

> Status: Completed
>
> Date: 2026-08-27
>
> Source: Provider settings page real experience feedback

## 1. Problem

Provider settings page has left Provider navigation and right detail panel independently scrolling, but macOS default may hide system scrollbars. Fixed-height containers cutting off exactly at full-row boundaries, users easily misjudge no more content below.

This Todo does not change scroll areas, container heights, Provider/Model ordering, or config saving, only adds conditional scroll edge affordance.

## 2. Interaction

```text
No overflow
└─ No affordance displayed

At top with content below
└─ Only bottom gradient displayed

In middle
├─ Top gradient displayed
└─ Bottom gradient displayed

At bottom
└─ Only top gradient displayed
```

- Left and right columns measure separately, update separately, do not share scroll state;
- Retain system scrollbar behavior, do not force persistent, do not add text or arrows;
- Gradient layer does not receive pointer events, does not block model actions, dragging, or Provider selection;
- Use semantic Card colors, consistent under Zai Light / Zai Dark;
- Content changes, container scaling, and window resizing trigger re-measurement;
- Scroll listening uses passive listener, avoiding same-boundary-state causing duplicate React render.

## 3. Verification

- Pure function covering no overflow, top, middle, bottom, and 1px error;
- Component test covers `top/bottom` affordance state after scrolling;
- Layout test proves Provider navigation and detail both use same component;
- Regression Provider/Model dragging, left-right independent scrolling, detail feedback banner, and narrow-screen layout;
- Execute UI directed tests, typecheck, lint, format check, and `git diff --check`.

## 4. Implementation Results

- Added `ScrollEdgeShadowViewport`, left and right columns reuse same boundary measurement and semantic color gradient;
- Listens to passive scroll of current viewport, uses `ResizeObserver` to observe viewport/content dimension changes;
- Same `top/bottom` state keeps original object, avoiding meaningless React render during scrolling;
- Gradient layer uses `pointer-events-none`, detail feedback banner stays at higher layer;
- 322 Provider settings-related tests, workspace-wide typecheck and lint passed; lint retains only pre-existing warnings before this round.
