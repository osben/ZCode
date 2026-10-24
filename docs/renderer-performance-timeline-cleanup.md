# Renderer Performance Timeline Cleanup

## Cause

The project uses the React 19.2 development build. React 19.2 enables React Performance Tracks in dev mode and records component render/scheduling traces via `performance.measure(...)`. In a long-lived unrefreshed dev window these entries keep accumulating in the browser Performance timeline — an earlier heap snapshot showed ~10.6M `native:PerformanceMeasure` entries (~1.2 GB) retained by `window.performance`, not by business arrays, React Fiber, or monitoring SDK span caches.

## Handling

At renderer startup, a periodic cleanup runs only in Vite dev mode:

- `performance.clearMeasures()` every 10 seconds
- plus `performance.clearMarks()`
- Not enabled in production builds, to keep production diagnostic data intact

This preserves React dev-build behavior and does not monkey patch `performance.measure`; the cost is that the DevTools Performance panel only shows measures/marks from the recent interval.

## Verification

After a long dev-mode run, check in the DevTools Console:

```js
performance.getEntriesByType("measure").length
```

The count must stay in a low range and not grow unboundedly with runtime.
