# Page visibility and CSS animations

2026-11-03: the policy of globally disabling CSS animations and transitions while the page is in the background is revoked.

- Removed the visibility animation listener, the shared utility and its exports at the desktop and Web (including mobile `/remote`) entries.
- Removed the animation and transition override on all elements and pseudo-elements under `html[data-document-hidden]`.
- `animation: none` / `transition: none` cancels animations, and they may be rebuilt when the page returns to the foreground, which interferes with component lifecycles. Users reported clear side effects, so the global policy is deleted outright and no restore logic is added.
- Component-level visibility handling, the reduced-motion preference and browser background throttling keep their existing behavior.

```text
visible -> hidden -> visible
             `- the browser manages scheduling; components manage animation; the App does not override animation styles globally
```

Acceptance passed: macOS Electron start page and the 390px Web login page, real hide and restore, in light and dark themes. The entry-level CSS probe kept the original objects for element and pseudo-element animations, with no cancel events and the transition declarations kept; the old build in the same scenario showed 3 animation cancels and object rebuilds. Run record: `desktop-e2e-20261103120018850-p11234-98dc3116b27be36f` (2 items passed). Not covered: the full business UI, Windows/Linux native windows, real mobile devices and background memory stress.

The original policy was meant to mitigate background animations holding unmounted DOM. In the historical stress record of 2026-09-29, 235,382 DOM nodes remained after GC while hidden and dropped to 45,297 one second after becoming visible. That is not a measurement of the current baseline; revoking the policy does not mean that memory issue is solved, and later work should retest per concrete component.
