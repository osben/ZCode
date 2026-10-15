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
import { uiMemoryDiagnosticsRegistry } from "@/lib/memoryDiagnostics.js";

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
  cwd: string;
  /**
   * workspaceKey for the terminal (workspaceIdentity?.trim() || workspacePath).
   * Used only to dispose sessions by workspaceKey when a workspace tab is actually closed (matching the bottom terminal openWorkspaceKeys cleanup).
   * Switching workspaces does not dispose sessions; disposal occurs only when that workspace is removed from openWorkspaceKeys.
   */
  workspaceKey: string;
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
 * It does not instantiate XTerm or call terminalService; the TerminalSession persistentKey path creates resources,
 * then registers them here. The registry only handles storage, DOM movement, and disposal, staying decoupled from the service layer.
 */
export const sidePaneTerminalSessionRegistry = {
  has(key: string): boolean {
    return sessions.has(key);
  },

  get(key: string): SidePaneTerminalSessionEntry | undefined {
    return sessions.get(key);
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
