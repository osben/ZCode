// sidePaneTerminalSessionRegistry — module-level singleton that keeps side-pane terminal sessions alive across workspace changes.
//
// If the TerminalSession component owned xterm, the PTY, and subscriptions, switching workspaces would unmount it
// and close the process and lose history. Let the module-level registry own these resources; the component only mounts and displays them,
// so terminal sessions survive workspace switches.
//
// Fix approach (similar in intent to the bottom terminal, but different in form):
//   Move **ownership of the side-pane terminal xterm instance and PTY association into this module-level singleton**,
//   outside the TerminalSession component effect lifecycle. Component unmounts/remounts do not affect xterm/PTY,
//   and on remount the entry is retrieved by persistentKey (= tab.id) and its hostEl is moved back into the container.
//
// Do not share sessions with the bottom terminal.
// Only SidePaneTerminalPane connects through the TerminalSession persistentKey prop; the bottom terminal does not pass persistentKey,
// and follows the original TerminalSession effect path, entirely separate from this registry.

import type { FitAddon } from "@xterm/addon-fit";
import type { ITheme, Terminal as XTerm } from "@xterm/xterm";
import type { ITerminalService } from "@zcode/services";
import type { IDisposable } from "@zcode/rpc";
import { uiMemoryDiagnosticsRegistry } from "@/lib/memoryDiagnostics.js";

/** The connection binding of one PTY stays with its keep-alive entry; a proxy generation change does not recreate the terminal. */
export function createSidePaneTerminalConnection(options: {
  id: string;
  service: ITerminalService;
  onData: (data: string) => void;
  onExit: (exitCode: number) => void;
}) {
  let binding: { service: ITerminalService } | undefined;
  let subscriptions: IDisposable[] = [];
  let disposed = false;
  const clearSubscriptions = () => {
    for (const subscription of subscriptions.splice(0)) subscription.dispose();
  };
  const rebind = (service: ITerminalService) => {
    if (disposed || binding?.service === service) return;
    // A mobile bridge generation change releases the old RPC. Revoke the old callbacks' generation identity before unbinding, so late output cannot leak in.
    binding = undefined;
    clearSubscriptions();
    const current = { service };
    binding = current;
    subscriptions = [
      service.onDynamicData(options.id)((data) => {
        if (binding === current) options.onData(data);
      }),
      service.onDynamicExit(options.id)((exitCode) => {
        if (binding === current) options.onExit(exitCode);
      }),
    ];
  };
  rebind(options.service);
  return {
    rebind,
    write(data: string): Promise<void> {
      return binding?.service.write({ id: options.id, data }) ?? Promise.resolve();
    },
    dispose(): Promise<void> {
      if (disposed) return Promise.resolve();
      disposed = true;
      const current = binding;
      binding = undefined;
      clearSubscriptions();
      return current?.service.dispose({ id: options.id }) ?? Promise.resolve();
    },
  };
}

/**
 * Persistent resources for one side-pane terminal session.
 *
 * - term/fitAddon：xterm instance (including scrollback history) and fit plugin; reuse the same instance across workspaces.
 * - terminalId：PTY id assigned by terminalService (a root-level shared service; local workspaces share baseServices).
 * - hostEl：Persistent container passed to term.open. It moves between stashDiv (hidden storage) and the actual render container;
 *           the xterm DOM subtree moves with it while the term instance and scrollback remain unchanged.
 * - dispose：Full disposal (called when closing the tab) — kill the PTY, dispose xterm, and release subscriptions. Injected by the TerminalSession creator;
 *            the registry itself does not depend on terminalService (the service is injected, not hard-coded here).
 */
export interface SidePaneTerminalSessionEntry {
  key: string;
  term: XTerm;
  fitAddon: FitAddon;
  terminalId: string;
  profileFontFamily: string | undefined;
  profileFontIsCustom: boolean;
  profileFontIsFallback: boolean;
  /** Holds the current connection once PTY creation completes; input, subscription and close do not capture the service proxy of a stale React effect. */
  connection?: ReturnType<typeof createSidePaneTerminalConnection>;
  cwd: string;
  /**
   * workspaceKey for the terminal (workspaceIdentity?.trim() || workspacePath).
   * Used only to dispose sessions by workspaceKey when a workspace tab is actually closed (matching the bottom terminal openWorkspaceKeys cleanup).
   * Switching workspaces does not dispose sessions; disposal occurs only when that workspace is removed from openWorkspaceKeys.
   */
  workspaceKey: string;
  /** Reuses the existing client namespace, distinguishing same-named local directories on different devices of the mobile connection. */
  clientNamespace: string;
  terminalOwnerId?: string;
  hostEl: HTMLDivElement;
  /**
   * Terminal profile theme returned by terminalService.create() (the colors configured by the user).
   * Bug background: the original implementation stored this only in the component-local terminalProfileThemeRef, which was destroyed when the component unmounted;
   * on remount the new component ref reset to undefined, and the reused observer merged undefined into the base theme, losing the profile theme.
   * Move ownership to the entry so the profile theme shares the persistent owner of term/PTY and survives reuse across component lifecycles.
   */
  profileTheme?: ITheme;
  /** Full disposal: kill the PTY, dispose xterm, release subscriptions, and remove hostEl. Injected by the creator (TerminalSession persistentKey path). */
  dispose: () => void;
}

// Module-level state persists across workspaces and React component trees.
const sessions = new Map<string, SidePaneTerminalSessionEntry>();
// Memory diagnostic counter: persistent xterm instances are currently unbounded, so log their count first.
uiMemoryDiagnosticsRegistry.register("xterm", () => ({ sessions: sessions.size }));

// Hidden storage container for detached hostEl elements, preventing React from destroying xterm DOM when it unmounts the render container.
let stashDiv: HTMLDivElement | null = null;

function getStashDiv(): HTMLDivElement | null {
  // Compatibility: SSR/Web test environments may not have document.
  if (typeof document === "undefined") return null;
  if (!stashDiv) {
    stashDiv = document.createElement("div");
    stashDiv.style.display = "none";
    stashDiv.setAttribute("data-side-pane-terminal-stash", "");
    document.body.appendChild(stashDiv);
  }
  return stashDiv;
}

function releaseEntry(key: string): void {
  const entry = sessions.get(key);
  if (!entry) return;
  sessions.delete(key);
  try {
    entry.dispose();
  } catch (error) {
    // Bug note: disposing kills the PTY and xterm and should not throw, but even if it does, it must not block tab closure,
    // or one terminal release failure would stall closing the rest or all sessions. Catch and log it, matching the bottom terminal’s fault tolerance.
    // Risk: the PTY may remain; terminalService.disposeAll cleans it up when the host exits.
    if (typeof console !== "undefined") {
      // eslint-disable-next-line no-console
      console.warn("[sidePaneTerminalSessionRegistry] release dispose failed", error);
    }
  }
  entry.hostEl.remove();
}

/**
 * Module-level singleton for side-pane terminal sessions.
 *
 * xterm and the PTY are created and registered by TerminalSession; the entry holds the injected connection binding.
 * The registry handles storage, DOM moves and reclamation; it does not create platform services or choose the workspace execution target.
 */
export const sidePaneTerminalSessionRegistry = {
  has(key: string): boolean {
    return sessions.has(key);
  },

  get(
    key: string,
    scope?: { workspaceKey: string; clientNamespace: string },
  ): SidePaneTerminalSessionEntry | undefined {
    const entry = sessions.get(key);
    if (
      scope &&
      (entry?.workspaceKey !== scope.workspaceKey ||
        entry.clientNamespace !== scope.clientNamespace)
    ) {
      return undefined;
    }
    return entry;
  },

  /** After the TerminalSession persistentKey path creates resources for the first time, store the entry in the registry for reuse. */
  register(key: string, entry: SidePaneTerminalSessionEntry): void {
    sessions.set(key, entry);
  },

  /**
   * Physically move entry.hostEl into the host container (attach).
   * The xterm .xterm DOM subtree moves with hostEl without changing the term instance; the caller must run fitAddon.fit() afterward to restore sizing.
   */
  attachDom(key: string, host: HTMLElement): void {
    const entry = sessions.get(key);
    if (!entry) return;
    if (entry.hostEl.parentElement === host) return;
    host.appendChild(entry.hostEl);
  },

  /**
   * Move entry.hostEl back to stashDiv (detach).
   * Called when the component unmounts — do not dispose term/PTY/subscriptions; resources stay in the registry for the next remount.
   */
  detachDom(key: string): void {
    const entry = sessions.get(key);
    if (!entry) return;
    const stash = getStashDiv();
    if (!stash) return;
    if (entry.hostEl.parentElement === stash) return;
    stash.appendChild(entry.hostEl);
  },

  /** Called when explicitly closing a side-pane terminal tab: fully dispose (kill PTY, dispose xterm, and release subscriptions). */
  release(key: string): void {
    releaseEntry(key);
  },

  /**
   * Bulk disposal (filter by workspaceKey when closing a workspace tab).
   * Matches the openWorkspaceKeys cleanup logic in the bottom Terminal.tsx.
   */
  releaseByPredicate(pred: (entry: SidePaneTerminalSessionEntry) => boolean): void {
    for (const [key, entry] of sessions) {
      if (pred(entry)) {
        releaseEntry(key);
      }
    }
  },

  /** Cleans up the old xterm/id once the Host owner has ended; the owner is unchanged on a same-page bridge generation change, so the entry stays alive. */
  releaseStaleOwner(clientNamespace: string, terminalOwnerId: string | undefined): void {
    for (const [key, entry] of sessions) {
      if (entry.clientNamespace === clientNamespace && entry.terminalOwnerId !== terminalOwnerId) {
        releaseEntry(key);
      }
    }
  },

  /** For tests only: clear all sessions and remove stashDiv. */
  clearForTest(): void {
    for (const key of Array.from(sessions.keys())) {
      releaseEntry(key);
    }
    sessions.clear();
    if (stashDiv && typeof document !== "undefined") {
      stashDiv.remove();
      stashDiv = null;
    }
  },
};
