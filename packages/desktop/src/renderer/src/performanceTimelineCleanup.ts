const PERFORMANCE_TIMELINE_CLEANUP_INTERVAL_MS = 10_000;

let cleanupTimer: ReturnType<typeof window.setInterval> | undefined;

export function startPerformanceTimelineCleanup(): void {
  if (!import.meta.env.DEV || cleanupTimer != null) {
    return;
  }

  // React 19.2's development build records component renders in the Performance timeline.
  // The native window.performance list strongly retains these PerformanceMeasure entries, which can grow
  // to gigabytes during long development sessions. Periodic cleanup affects only the DevTools timeline,
  // not application logic or production packages.
  cleanupTimer = window.setInterval(() => {
    window.performance.clearMeasures();
    window.performance.clearMarks();
  }, PERFORMANCE_TIMELINE_CLEANUP_INTERVAL_MS);
}
