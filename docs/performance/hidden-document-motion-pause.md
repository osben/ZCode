# Pause CSS Animations While the Page Is Hidden

## Problem

When the window is not visible (minimized, on another desktop, screen locked, mobile browser in the
background), Chromium produces no animation frames and CSS transitions / animations on the
`DocumentTimeline` cannot settle. If an animated element is removed meanwhile (virtual list recycling,
task switch, streaming remount), `HTMLDocument → DocumentTimeline → CSSTransition` still strongly
references the element and, through parent pointers, holds the whole unmounted message subtree until
the page becomes visible again.

Measured (2026-09-29, isolated HOME + mock provider streaming stress, after GC):

| State                      | DOM nodes | JS listeners | renderer footprint |
| -------------------------- | --------- | ------------ | ------------------ |
| while hidden               | 235,382   | 12,071       | 498 MB             |
| 1s after becoming visible  | 45,297    | 1,943        | 379 MB             |

Controlled experiment: triggering a transition while hidden and then removing the element retains 100%
(even after `cancel()` first); without triggering a transition 0 is retained. The main entry is the
markdown table's `transition-[max-width]` / `transition-[width,opacity]` that change with measurement,
but the mechanism applies to all CSS animations.

## Contract

```
visibilitychange ──► document.visibilityState === "hidden"
                        │ yes                        │ no
                        ▼                            ▼
          <html data-document-hidden>        remove data-document-hidden
                        │
                        ▼
   *, ::before, ::after { transition: none; animation: none } (!important)
   → no new CSSTransition / CSSAnimation is created while hidden, removed elements can be GC'd
```

- The only data source is `document.visibilityState`; it syncs once at install time and then reacts
  only to `visibilitychange`, with no timers.
- The desktop renderer and Web (including mobile `/remote`) entries each call
  `installDocumentHiddenMotionPause()` (`packages/ui/src/lib/documentHiddenMotionPause.ts`) before
  `createRoot`.
- While the page is hidden the user sees nothing, so disabling animations has no visible effect; after it
  becomes visible styles return to the final state immediately and later changes transition normally.
- Side benefit: exit animations that wait for `animationend` before unmounting (Radix Presence, etc.)
  read `animation-name: none` while hidden and unmount synchronously, so no overlay lingers.

## Verification result

Same stress script, window minimized (hidden), 15 consecutive rounds, compared after GC:

| Metric                                | Before  | After  |
| ------------------------------------- | ------- | ------ |
| DOM nodes (Memory counters)           | 175,224 | 22,361 |
| JS listeners                          | 12,071  | 1,213  |
| heap snapshot detached nodes          | 109,407 | 3,819  |
| controlled-experiment retention (20,050 nodes) | 100% | ~2% |

The remaining detached nodes are held by TanStack virtual `elementsCache` through a pending rAF closure,
settle after the page becomes visible and are bounded.

## Boundaries

- Covers only CSS transitions / animations; JS-driven (Web Animations API) animations such as `motion`
  are unaffected.
- A transition in progress at the moment of entering hidden is canceled (firing `transitioncancel`
  rather than `transitionend`), so logic that relies on `transitionend` to close out must bring its own
  fallback (the existing `useAnimatedResizablePanel` and `HighspeedActivationVisual` already have
  timeout fallbacks).
