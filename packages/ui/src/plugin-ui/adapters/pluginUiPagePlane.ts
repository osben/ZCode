import { autoUpdate } from "@floating-ui/dom";
import type { PluginSandboxHandle } from "@zcode/shared/mcp-apps";
import type { SandboxPagePlacement } from "../contract.js";

/**
 * Whether a non-main-frame navigation targets the sandbox document (the plugin frame reloading
 * itself). The webview's did-start-navigation carries no frame hierarchy; child frames inside the
 * plugin document (srcdoc / about:blank previews, declared frameDomains) are not reloads — the
 * hierarchy decision belongs to Main. Missing URL counts as a reload.
 */
export function isSandboxDocumentNavigation(url: string | undefined): boolean {
  return !url || url.startsWith("zcode-sandbox:");
}

function parkingRoot(): HTMLElement {
  const existing = document.querySelector<HTMLElement>("[data-sandbox-page-parking]");
  if (existing) return existing;
  const root = document.createElement("div");
  root.dataset.sandboxPageParking = "true";
  root.style.cssText = "position:fixed;inset:0;pointer-events:none;overflow:visible";
  document.body.append(root);
  return root;
}

/** Instances are decoupled from anchors; plain inline pages share the scroll tree with the body, so screen coordinates are not needed to chase scrolling. */
export function createPluginUiPagePlane(events: {
  onVisibility(visible: boolean): void;
  onCrash(): void;
}) {
  const anchors = new Map<symbol, { placement: SandboxPagePlacement; visible: boolean }>();
  const root = document.createElement("div");
  root.dataset.sandboxPageRoot = "true";
  root.style.display = "none";
  parkingRoot().append(root);
  let frame: HTMLElement | null = null;
  let handleId: string | null = null;
  let current: symbol | undefined;
  let stopLayout: (() => void) | undefined;
  let stopPreview: (() => void) | undefined;
  let preview: HTMLElement | null = null;
  let executionActive = false;
  let allowedDisplayModes: readonly string[] = ["inline", "fullscreen"];
  let backgroundSize = { width: 640, height: 480 };
  let disposed = false,
    loaded = false,
    pluginLoaded = false,
    visible = false;
  const visibility = (next: boolean) => {
    if (next === visible) return;
    visible = next;
    events.onVisibility(next);
  };
  const move = (parent: HTMLElement) => {
    if (root.parentElement === parent) return;
    if (!frame) parent.append(root);
    else {
      // appendChild triggers a disconnect-rebuild of the Electron guest. Migration is allowed only after preload registers the move callback for the sandbox.
      if (
        typeof parent.moveBefore !== "function" ||
        typeof (frame as HTMLElement & { connectedMoveCallback?: unknown })
          .connectedMoveCallback !== "function"
      )
        throw new Error("Sandbox retained moves are unavailable; restart the desktop app");
      parent.moveBefore(root, null);
    }
  };
  const resetStyle = () => {
    // After the webview is released the container may still cover the error-state button; the container only positions, clicks are received explicitly by the webview.
    root.style.cssText =
      "display:flow-root;position:relative;width:100%;height:100%;margin:0;border:0;padding:0;overflow:hidden;pointer-events:none";
  };
  const position = (node: HTMLElement, container: HTMLElement, fixed: boolean, layer: number) => {
    const rect = node.getBoundingClientRect();
    const parent = container.getBoundingClientRect();
    const zoom = (container as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom || 1;
    Object.assign(root.style, {
      position: fixed ? "fixed" : "absolute",
      inset: "auto",
      zIndex: String(layer),
      top: `${fixed ? rect.top : (rect.top - parent.top) / zoom + container.scrollTop - container.clientTop}px`,
      left: `${fixed ? rect.left : (rect.left - parent.left) / zoom + container.scrollLeft - container.clientLeft}px`,
      width: `${rect.width / (fixed ? 1 : zoom)}px`,
      height: `${rect.height / (fixed ? 1 : zoom)}px`,
      borderRadius: getComputedStyle(node).borderRadius,
    });
  };
  const endPreview = () => {
    stopPreview?.();
    stopPreview = undefined;
    if (root.matches(":popover-open")) root.hidePopover();
    root.removeAttribute("popover");
    preview = null;
  };
  const track = (node: HTMLElement, update: () => void) => {
    // The carrier's size is fully determined by the anchor; observing the carrier back would form a ResizeObserver loop on popover switches.
    const stop = autoUpdate(node, root, update, { elementResize: false });
    const resize = new ResizeObserver(update);
    resize.observe(node);
    return () => {
      resize.disconnect();
      stop();
    };
  };
  const hasVisibleBounds = (node: HTMLElement) => {
    const rect = node.getBoundingClientRect();
    return (
      node.isConnected &&
      node.checkVisibility({ visibilityProperty: true }) &&
      rect.width > 0 &&
      rect.height > 0
    );
  };
  const layout = () => {
    if (disposed) return;
    // A forceMount hidden tab is still in the DOM but has zero size; it must not steal the hosting surface from background initialization.
    const candidates = [...anchors].filter(([, a]) => {
      return (
        allowedDisplayModes.includes(a.placement.kind === "sidebar" ? "fullscreen" : "inline") &&
        hasVisibleBounds(a.placement.node)
      );
    });
    const chosen = candidates.find(([, a]) => a.placement.kind === "sidebar") ?? candidates.at(-1);
    visibility(Boolean(chosen && (chosen[1].visible || preview)));
    if (chosen && chosen[0] === current) return;
    const bounds = root.getBoundingClientRect();
    if (bounds.width > 0 && bounds.height > 0)
      backgroundSize = { width: bounds.width, height: bounds.height };
    current = chosen?.[0];
    stopLayout?.();
    stopLayout = undefined;
    endPreview();
    resetStyle();
    if (!chosen) {
      move(parkingRoot());
      root.style.display = "none";
      root.inert = true;
      if (executionActive) {
        // display:none stops the rAF the editor depends on; a retained MCP page always needs an executable, input-blocking surface.
        Object.assign(root.style, {
          display: "block",
          position: "fixed",
          top: "0",
          left: "0",
          width: `${backgroundSize.width}px`,
          height: `${backgroundSize.height}px`,
          opacity: "0.001",
        });
      }
      return;
    }
    root.inert = false;
    const { node, kind, container, layer = 10 } = chosen[1].placement;
    const parent = kind === "sidebar" ? parkingRoot() : (container ?? node);
    move(parent);
    if (kind !== "flow" && parent !== node)
      stopLayout = track(node, () => {
        const rect = node.getBoundingClientRect();
        if (!node.checkVisibility({ visibilityProperty: true }) || !rect.width || !rect.height) {
          layout();
          return;
        }
        position(node, parent, kind === "sidebar", layer);
      });
  };
  const intersection = new IntersectionObserver((entries) => {
    for (const entry of entries)
      for (const a of anchors.values())
        if (a.placement.node === entry.target) a.visible = entry.isIntersecting;
    layout();
  });
  const ready = () => {
    loaded = true;
  };
  const frameReady = (event: Event) => {
    if (!(event as Event & { isMainFrame?: boolean }).isMainFrame) pluginLoaded = true;
  };
  const navigation = (event: Event) => {
    const nav = event as Event & { isMainFrame?: boolean; isInPlace?: boolean; url?: string };
    if (
      !nav.isInPlace &&
      ((loaded && nav.isMainFrame) ||
        (pluginLoaded && !nav.isMainFrame && isSandboxDocumentNavigation(nav.url)))
    )
      events.onCrash();
  };
  const prepareUnmount = (expectedId?: string) => {
    if (expectedId && expectedId !== handleId) return;
    frame?.removeEventListener("render-process-gone", events.onCrash);
    frame?.removeEventListener("dom-ready", ready);
    frame?.removeEventListener("did-start-navigation", navigation);
    frame?.removeEventListener("did-frame-finish-load", frameReady);
    loaded = false;
    pluginLoaded = false;
  };
  const unmount = (expectedId?: string) => {
    if (expectedId && expectedId !== handleId) return;
    prepareUnmount(expectedId);
    frame?.remove();
    frame = null;
    handleId = null;
  };
  return {
    hasVisibleAnchor() {
      // After recycling or hiding, the restore intent still follows the presentation anchor; do not infer it from the old guest's visibility.
      return [...anchors.values()].some(
        ({ placement, visible }) => visible && hasVisibleBounds(placement.node),
      );
    },
    setAllowedDisplayModes(modes: readonly string[]) {
      allowedDisplayModes = modes;
      layout();
    },
    setExecutionActive(active: boolean) {
      if (executionActive === active) return;
      executionActive = active;
      layout();
    },
    bind(placement: SandboxPagePlacement) {
      const token = Symbol();
      anchors.set(token, { placement, visible: true });
      intersection.observe(placement.node);
      layout();
      return () => {
        anchors.delete(token);
        if (![...anchors.values()].some((a) => a.placement.node === placement.node))
          intersection.unobserve(placement.node);
        // Must migrate synchronously before React removes the anchor; this cannot be deferred to RAF / passive effects.
        layout();
      };
    },
    preview(node: HTMLElement | null) {
      endPreview();
      resetStyle();
      if (!node) {
        current = undefined;
        layout();
        return;
      }
      preview = node;
      root.setAttribute("popover", "manual");
      root.showPopover();
      const update = () => position(node, document.documentElement, true, 45);
      stopPreview = track(node, update);
      visibility(true);
    },
    captureBounds(gutter = 0) {
      if (!frame || !visible) throw new Error("Sandbox is not visible");
      const rect = frame.getBoundingClientRect();
      return {
        viewportSize: { width: rect.width, height: rect.height },
        captureRect: {
          x: gutter,
          y: gutter,
          width: rect.width - gutter * 2,
          height: rect.height - gutter * 2,
        },
      };
    },
    focus() {
      frame?.focus();
    },
    mount(handle: PluginSandboxHandle) {
      if (handleId === handle.sandboxId) return;
      unmount();
      handleId = handle.sandboxId;
      frame = document.createElement("webview");
      frame.setAttribute("data-zcode-retained-sandbox", "");
      frame.setAttribute("src", handle.shellUrl);
      frame.setAttribute("partition", handle.partition);
      frame.setAttribute("data-testid", "plugin-ui-webview");
      frame.style.cssText =
        "display:flex;width:100%;height:100%;border:0;background:transparent;pointer-events:auto";
      frame.addEventListener("render-process-gone", events.onCrash);
      frame.addEventListener("dom-ready", ready);
      frame.addEventListener("did-frame-finish-load", frameReady);
      frame.addEventListener("did-start-navigation", navigation);
      root.append(frame);
    },
    prepareUnmount,
    unmount,
    dispose() {
      disposed = true;
      endPreview();
      stopLayout?.();
      unmount();
      intersection.disconnect();
      anchors.clear();
      root.remove();
    },
  };
}
