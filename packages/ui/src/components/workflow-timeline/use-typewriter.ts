import { useEffect, useRef, useState } from "react";

/**
 * Draft typewriter.
 *
 * Model scripts arrive in chunks, so the scanner sees jumps: an entire `phase("implement")` may arrive in one delta, sometimes
 * with two phases at once. The typewriter turns those jumps into writing: reveal one station at a time, one character every `PEN_MS`,
 * then pause for `PEN_GAP_MS` before revealing the next. A station the pen has not reached is not on the track, even if the scanner knows it.
 * If a name grows while it is being written (more characters arrive for an unfinished `phase("ver`), continue; if it shrinks or its prefix changes
 * (unexpected, but possible in a stream), rewind to the common prefix.
 *
 * `names` is the scanner's current station-name sequence; undefined means this is not a draft and the hook is silent.
 * Timers respond only to **content** changes (keyed by content), so a new array on every script chunk does not interrupt the typewriter.
 * Under `prefers-reduced-motion: reduce`, reveal each station immediately (still one at a time, but not character by character).
 *
 * Revision (root cause of GUI crash React #185):
 * The typewriter reveals only when there is a station to reveal. If it reveals immediately when there are no stations without checking
 * the count, an empty draft (the opening `meta` has not reached the first `phase(`) reveals a nonexistent station, gets trimmed back to 0,
 * then reveals again, causing an infinite setState loop in the effect.
 * The loop itself only burns CPU, but it leaves React with a pending update. If projection frames backlog into dozens of synchronous commits,
 * nested updates exceed 50, React throws #185, and the error boundary takes over the entire chat area.
 */
export const PEN_MS = 24;
export const PEN_GAP_MS = 120;

export interface TypewriterState {
  /** Number of revealed stations (those the pen has reached); later stations are not on the track yet. */
  visible: number;
  /** Number of characters written for each revealed station. */
  shown: readonly number[];
  /** The pen has caught up with the stream (no characters to write and no stations to reveal); blink the cursor. */
  idle: boolean;
}

interface PenState {
  visible: number;
  shown: number[];
}

const SILENT: TypewriterState = { idle: false, shown: [], visible: 0 };

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
}

/** When station names change (shorter names, changed prefixes, or fewer stations), rewind the pen to the still-valid position; otherwise return the state unchanged. */
function reconcile(
  state: PenState,
  names: readonly string[],
  previous: readonly string[],
): PenState {
  const visible = Math.min(state.visible, names.length);
  let changed = visible !== state.visible;
  const shown = state.shown.slice(0, visible).map((count, i) => {
    const next = Math.min(count, commonPrefix(previous[i] ?? "", names[i]!));
    if (next !== count) changed = true;
    return next;
  });
  return changed ? { shown, visible } : state;
}

/**
 * Characters written per revealed station. Under reduced motion, treat each station as fully written and **derive during render**
 * rather than calling setState from an effect: station names grow on every delta, and the effect's setState lands in the projection frame's
 * synchronous commit, adding one to the nested-update count on every frame.
 */
function shownOf(state: PenState, names: readonly string[], reduced: boolean): readonly number[] {
  return reduced ? state.shown.map((_, i) => names[i]?.length ?? 0) : state.shown;
}

export function useTypewriter(names: readonly string[] | undefined): TypewriterState {
  const [state, setState] = useState<PenState>({ shown: [], visible: 0 });
  // NUL is the separator (station names cannot contain it), so ["a b"] and ["a", "b"] do not collide as keys.
  // A literal NUL byte makes git treat the file as binary; use the escaped form without changing the value.
  const key = names?.join("\u0000");
  const namesRef = useRef<readonly string[]>([]);
  const lastRef = useRef<readonly string[]>([]);
  if (names !== undefined) namesRef.current = names;

  useEffect(() => {
    if (key === undefined) return undefined;
    const current = namesRef.current;
    const previous = lastRef.current;
    lastRef.current = current;
    const pen = reconcile(state, current, previous);
    if (pen !== state) {
      setState(pen);
      return undefined;
    }
    const reduced = prefersReducedMotion();
    const at = pen.visible - 1;
    const target = at >= 0 ? current[at]! : undefined;
    const written = target === undefined ? 0 : (shownOf(pen, current, reduced)[at] ?? 0);
    if (target !== undefined && written < target.length) {
      // Write the current station character by character (under reduced motion, written is already complete, so this branch is not reached).
      const timer = setTimeout(() => {
        const shown = pen.shown.slice();
        shown[at] = written + 1;
        setState({ shown, visible: pen.visible });
      }, PEN_MS);
      return () => clearTimeout(timer);
    }
    // The current station is complete (or there are no stations): reveal only if there is a next station; an empty draft does nothing.
    if (current.length <= pen.visible) return undefined;
    const reveal = () => setState({ shown: [...pen.shown, 0], visible: pen.visible + 1 });
    if (target === undefined) {
      reveal();
      return undefined;
    }
    const timer = setTimeout(reveal, PEN_GAP_MS);
    return () => clearTimeout(timer);
  }, [key, state]);

  if (names === undefined) return SILENT;
  const shown = shownOf(state, names, prefersReducedMotion());
  const at = state.visible - 1;
  const idle = at >= 0 && state.visible === names.length && (shown[at] ?? 0) >= names[at]!.length;
  return { idle, shown, visible: state.visible };
}
