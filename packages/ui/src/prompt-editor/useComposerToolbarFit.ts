import { useLayoutEffect, useRef } from "react";

/** Owns only the DOM layout projection; permission, Plan, and CUA business state remain managed by their existing hooks. */
function fitComposerToolbar(root: HTMLElement) {
  const available = root.querySelector<HTMLElement>("[data-composer-leading-actions]");
  const content = root.querySelector<HTMLElement>("[data-composer-leading-content]");
  if (!available || !content) return;
  const controls = root.querySelectorAll<HTMLElement>("[data-composer-collapse-priority]");
  // Measure from the full layout each time to avoid per-button observers competing for space and to cover locale and asynchronous-entry changes.
  delete root.dataset.composerModelIcon;
  delete root.dataset.composerProviderCompact;
  for (const control of controls) delete control.dataset.composerCompact;
  const trailing = root.querySelector<HTMLElement>("[data-composer-trailing-actions]");
  const gap = Number.parseFloat(getComputedStyle(root).columnGap) || 12;
  const overflow = () =>
    Math.max(
      0,
      content.getBoundingClientRect().width - available.getBoundingClientRect().width,
      trailing
        ? content.getBoundingClientRect().width +
            trailing.getBoundingClientRect().width +
            gap -
            root.getBoundingClientRect().width
        : 0,
    );
  // The first four levels collapse the Computer, mode, Plan, and think labels in order; their decisions cannot be combined.
  for (const priority of ["0", "1", "2", "3"]) {
    if (overflow() <= 0) return;
    for (const control of controls) {
      if (control.dataset.composerCollapsePriority === priority) {
        control.dataset.composerCompact = "true";
      }
    }
  }
  if (overflow() <= 0) return;
  if (root.querySelector(".composer-provider-prefix")) {
    root.dataset.composerProviderCompact = "true";
  }
  if (overflow() <= 0) return;
  const thought = root.querySelector<HTMLElement>("[data-composer-thought-control]");
  if (thought) thought.dataset.composerCompact = "icon";
  // Remeasure after removing the green bar from think; if this is the only width difference, keep the full model name.
  if (overflow() <= 0) return;
  root.dataset.composerModelIcon = "true";
}

export function useComposerToolbarFit() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const update = () => {
      if (!root.parentElement || root.getBoundingClientRect().width <= 0) return;
      // Try expanding on an invisible copy to avoid moving real buttons back and forth during measurement, losing hover, or closing a Tooltip.
      const probe = root.cloneNode(true) as HTMLElement;
      probe.setAttribute("aria-hidden", "true");
      probe.inert = true;
      Object.assign(probe.style, {
        position: "absolute",
        visibility: "hidden",
        pointerEvents: "none",
        width: `${root.getBoundingClientRect().width}px`,
        left: "0",
        top: "0",
      });
      root.parentElement.append(probe);
      try {
        fitComposerToolbar(probe);
        for (const key of ["composerModelIcon", "composerProviderCompact"]) {
          if (probe.dataset[key]) root.dataset[key] = probe.dataset[key];
          else delete root.dataset[key];
        }
        const live = root.querySelectorAll<HTMLElement>("[data-composer-collapse-priority]");
        const measured = probe.querySelectorAll<HTMLElement>("[data-composer-collapse-priority]");
        live.forEach((control, index) => {
          if (measured[index]?.dataset.composerCompact) {
            control.dataset.composerCompact = measured[index].dataset.composerCompact;
          } else delete control.dataset.composerCompact;
        });
      } finally {
        probe.remove();
      }
    };
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    const observe = () => {
      resize?.disconnect();
      resize?.observe(root);
      for (const element of root.querySelectorAll<HTMLElement>(
        "[data-composer-leading-actions], [data-composer-leading-content], [data-composer-trailing-actions]",
      ))
        resize?.observe(element);
      update();
    };
    // Do not observe layout attributes themselves, which would cause recursive measurement when writing data-composer-compact.
    const mutations = new MutationObserver(observe);
    mutations.observe(root, { childList: true, subtree: true, characterData: true });
    observe();
    return () => {
      resize?.disconnect();
      mutations.disconnect();
    };
  }, []);
  return ref;
}
