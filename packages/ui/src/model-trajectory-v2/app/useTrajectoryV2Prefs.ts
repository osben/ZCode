import { useCallback, useEffect, useState } from "react";
import {
  parseTrajectoryV2Prefs,
  TRAJECTORY_V2_VIEW_STORAGE_KEY,
  type TrajectoryV2Prefs,
} from "../domain/viewState.js";

function readPrefs(): TrajectoryV2Prefs {
  try {
    return parseTrajectoryV2Prefs(window.localStorage.getItem(TRAJECTORY_V2_VIEW_STORAGE_KEY));
  } catch {
    return parseTrajectoryV2Prefs(null);
  }
}

/** Per-device view preferences in localStorage; unavailable storage falls back to defaults. */
export function useTrajectoryV2Prefs(): [
  TrajectoryV2Prefs,
  (patch: Partial<TrajectoryV2Prefs>) => void,
] {
  const [prefs, setPrefs] = useState<TrajectoryV2Prefs>(readPrefs);
  useEffect(() => {
    try {
      window.localStorage.setItem(TRAJECTORY_V2_VIEW_STORAGE_KEY, JSON.stringify(prefs));
    } catch {
      // Storage can be unavailable (private mode, quota); preferences then last for this pane only.
    }
  }, [prefs]);
  const update = useCallback(
    (patch: Partial<TrajectoryV2Prefs>) => setPrefs((previous) => ({ ...previous, ...patch })),
    [],
  );
  return [prefs, update];
}

/** Width of an element, tracked with ResizeObserver; 0 before the first measurement. */
export function useElementWidth(element: HTMLElement | null): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!element) return;
    setWidth(element.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width;
      if (next !== undefined) setWidth(next);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return width;
}
