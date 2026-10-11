import type { IDisposable, Terminal as XTerm } from "@xterm/xterm";
import type { WebglAddon } from "@xterm/addon-webgl";
import { logger } from "@/logger.js";

interface WebglRendererHandle {
  addon: WebglAddon | null;
  contextLossSubscription: IDisposable | null;
  /** Dynamic import is in progress; another enable during this time does not reload, and disabling abandons activation. */
  activating: boolean;
  /** Set after WebGL startup failure or context loss to prevent retries on every effect; cleared entirely when the feature is disabled. */
  blocked: boolean;
}

const handles = new WeakMap<XTerm, WebglRendererHandle>();

function releaseAddon(handle: WebglRendererHandle): void {
  handle.contextLossSubscription?.dispose();
  handle.contextLossSubscription = null;
  const addon = handle.addon;
  handle.addon = null;
  if (!addon) return;
  try {
    // WebglAddon.dispose switches the renderer back to DOM; repeated calls are idempotent via xterm's wrapped dispose.
    addon.dispose();
  } catch (error) {
    logger.warn("[Terminal] dispose WebGL addon failed:", error);
  }
}

/**
 * Switch the renderer for one xterm instance according to the feature flag: try WebGL when enabled, and keep/fall back to DOM if startup fails or context is lost.
 * Call only after term.open; repeated calls are idempotent.
 *
 * Dynamically load @xterm/addon-webgl on demand: the feature is off by default, and a static import would make every terminal entry point
 * (main window, side pane, remote) bundle include and evaluate WebGL code.
 */
export function setTerminalWebglRenderer(term: XTerm, enabled: boolean): void {
  const existing = handles.get(term);

  if (!enabled) {
    if (existing) {
      releaseAddon(existing);
      handles.delete(term);
    }
    return;
  }

  if (existing?.addon || existing?.activating || existing?.blocked) return;

  const handle: WebglRendererHandle = existing ?? {
    addon: null,
    contextLossSubscription: null,
    activating: false,
    blocked: false,
  };
  handles.set(term, handle);
  handle.activating = true;

  void import("@xterm/addon-webgl")
    .then(({ WebglAddon: WebglAddonCtor }) => {
      // The flag was disabled while loading: the handle has been removed from WeakMap, so abandon activation instead of reviving a closed renderer.
      if (handles.get(term) !== handle) return;

      const addon = new WebglAddonCtor();
      try {
        term.loadAddon(addon);
      } catch (error) {
        // Without dispose, xterm loadAddon has already registered the addon in _addons,
        // and a later term.dispose would process the inactive addon again. When WebGL2 is unavailable, activate registers the renderer disposable before throwing,
        // so dispose it here to clean up both the registration and renderer.
        try {
          addon.dispose();
        } catch {
          // Cleanup failure affects only this addon's residue; the DOM renderer remains usable, so do not rethrow.
        }
        handle.blocked = true;
        logger.warn("[Terminal] WebGL renderer unavailable, falling back to DOM:", error);
        return;
      }

      handle.addon = addon;
      handle.contextLossSubscription = addon.onContextLoss(() => {
        logger.warn("[Terminal] WebGL context lost, falling back to DOM renderer");
        releaseAddon(handle);
        handle.blocked = true;
      });
    })
    .catch((error) => {
      logger.warn("[Terminal] WebGL renderer unavailable, falling back to DOM:", error);
      if (handles.get(term) === handle) handle.blocked = true;
    })
    .finally(() => {
      if (handles.get(term) === handle) handle.activating = false;
    });
}
