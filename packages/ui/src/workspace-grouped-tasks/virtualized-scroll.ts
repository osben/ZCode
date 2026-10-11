import type { Virtualizer } from "@tanstack/react-virtual";

type GroupedTaskVirtualizerScrollOptions = {
  adjustments?: number;
  behavior?: ScrollBehavior;
};

function isPotentialVerticalScrollContainer(overflowY: string): boolean {
  return /(auto|scroll|overlay)/.test(overflowY);
}

function scrollGroupedTaskVirtualizerToOffset<TScrollElement extends Element>(
  offset: number,
  { adjustments = 0, behavior }: GroupedTaskVirtualizerScrollOptions,
  instance: Virtualizer<TScrollElement, Element>,
) {
  const scrollElement = instance.scrollElement;
  if (!scrollElement) {
    return;
  }
  const toOffset = offset + adjustments;
  const isStaleInitialZeroSync =
    !instance.options.horizontal &&
    offset === 0 &&
    adjustments === 0 &&
    behavior === undefined &&
    scrollElement.scrollTop > 0 &&
    instance.scrollOffset === 0;
  if (isStaleInitialZeroSync) {
    // When a group virtual list remounts midway through the outer scroll container, react-virtual
    // may have cached the default scrollOffset=0 in the first layout effect, then _willUpdate
    // may apply that stale value with scrollTo(0) to the shared container, occasionally jumping the list to the top.
    return;
  }
  if (instance.options.horizontal) {
    scrollElement.scrollTo({ left: toOffset, behavior });
    return;
  }
  scrollElement.scrollTo({ top: toOffset, behavior });
}

export { isPotentialVerticalScrollContainer, scrollGroupedTaskVirtualizerToOffset };
