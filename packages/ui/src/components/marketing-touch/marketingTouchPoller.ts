import type { ZCodeEnv } from "@zcode/shared";

export function resolveMarketingTouchPollIntervalMs(
  isProductionBuild: boolean,
  env: ZCodeEnv,
): number {
  return isProductionBuild && env === "production" ? 10 * 60_000 : 30_000;
}

/** The single serial scheduler; a user-triggered refresh arriving mid-flight is merged into one follow-up query. */
export function createMarketingTouchPoller(options: {
  query: () => Promise<void>;
  visible: () => boolean;
  intervalMs: number;
}) {
  let disposed = false;
  let running = false;
  let requested = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  function refresh() {
    if (disposed) return;
    stopTimer();
    if (!options.visible()) return;
    if (running) {
      requested = true;
      return;
    }
    running = true;
    void options
      .query()
      .then(
        () => {
          failures = 0;
        },
        () => {
          failures++;
        },
      )
      .finally(() => {
        running = false;
        if (disposed || !options.visible()) return;
        if (requested) {
          requested = false;
          refresh();
          return;
        }
        const delay = failures
          ? Math.min(600_000, 30_000 * 2 ** Math.min(failures - 1, 5))
          : // The migration once lost the production/test environment frequency; the entry point injects it explicitly, avoiding a uniform random interval.
            options.intervalMs;
        timer = setTimeout(refresh, delay);
      });
  }
  return {
    refresh,
    visibilityChanged() {
      if (options.visible()) refresh();
      else {
        stopTimer();
        requested = false;
      }
    },
    dispose() {
      disposed = true;
      stopTimer();
    },
  };
}
