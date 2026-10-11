// Zustand wiring for split-view layout/focus.
// The model and pure state machine are in paneLayoutTree.ts, and persistence is in paneLayoutPersistence.ts —
// this file handles only store wiring + persistence subscription and re-exports both (a single consumer entry point).
import { create } from "zustand";
import { isRendererReloadNavigation } from "@/lib/rendererNavigation.js";
import { persistPaneLayout, readPersistedPaneLayout } from "@/v4/paneLayoutPersistence.js";
import {
  bindPaneSession,
  closePane,
  confirmRestoredPaneSession,
  focusPane,
  INITIAL_PANE_LAYOUT,
  openSessionInNewPane,
  replacePaneBinding,
  setSplitNodeRatio,
  splitPaneAt,
  splitPaneAtSide,
  type PaneBinding,
  type PaneLayoutSnapshot,
  type PaneSplitSide,
  type PaneWorkspaceScope,
  type SplitDirection,
} from "@/v4/paneLayoutTree.js";

const persistedPaneLayoutAtModuleLoad = readPersistedPaneLayout();
const restoredPaneLayoutAtModuleLoad = isRendererReloadNavigation()
  ? persistedPaneLayoutAtModuleLoad
  : null;

/** Used on cold startup to detect and clear layouts left by the previous renderer that should not be restored this time. */
export function hadPersistedPaneLayoutAtModuleLoad(): boolean {
  return persistedPaneLayoutAtModuleLoad !== null;
}

export * from "@/v4/paneLayoutTree.js";
export * from "@/v4/paneLayoutPersistence.js";

export interface PaneLayoutStore extends PaneLayoutSnapshot {
  /** Split a draft pane from the anchor pane (bind scope, then bind in place after the first createSession). */
  splitPane: (anchorPaneId: string, direction: SplitDirection, scope: PaneWorkspaceScope) => void;
  /** Split a pane with a bound session around the anchor pane (draft drop / non-group drag entry point). */
  splitPaneWithBinding: (anchorPaneId: string, side: PaneSplitSide, binding: PaneBinding) => void;
  /** Sidebar/drill-down entry point: focus an already-open pane; otherwise split to the right of the focused pane and bind the session. */
  openSessionInNewPane: (scope: PaneWorkspaceScope, sessionId: string) => void;
  /** Temporary draft layout: ordinary sidebar clicks replace only the focused secondary and do not overwrite the primary draft. */
  replacePaneBinding: (paneId: string, binding: PaneBinding) => void;
  closePane: (paneId: string) => void;
  focusPane: (paneId: string) => void;
  bindPaneSession: (paneId: string, sessionId: string) => void;
  setSplitRatio: (splitId: string, ratio: number) => void;
  confirmRestoredPaneSession: (paneId: string) => void;
  /** Exit split view and return to one primary panel when creating a task/draft. */
  resetToPrimaryPane: () => void;
}

/** One per window; action references are stable and can be passed directly to memoized components. */
export const usePaneLayoutStore = create<PaneLayoutStore>()((set) => ({
  // Restore layout from localStorage only on reload of the same renderer; a cold app start begins with a single primary draft.
  ...(restoredPaneLayoutAtModuleLoad ?? INITIAL_PANE_LAYOUT),

  splitPane: (anchorPaneId, direction, scope) => {
    set((state) =>
      splitPaneAt(state, anchorPaneId, direction, {
        workspaceScope: scope,
        sessionId: null,
      }),
    );
  },

  splitPaneWithBinding: (anchorPaneId, side, binding) => {
    set((state) => splitPaneAtSide(state, anchorPaneId, side, binding));
  },

  openSessionInNewPane: (scope, sessionId) => {
    set((state) => openSessionInNewPane(state, scope, sessionId));
  },

  replacePaneBinding: (paneId, binding) => {
    set((state) => replacePaneBinding(state, paneId, binding));
  },

  closePane: (paneId) => {
    set((state) => closePane(state, paneId));
  },

  focusPane: (paneId) => {
    set((state) => focusPane(state, paneId));
  },

  bindPaneSession: (paneId, sessionId) => {
    set((state) => bindPaneSession(state, paneId, sessionId));
  },

  setSplitRatio: (splitId, ratio) => {
    set((state) => setSplitNodeRatio(state, splitId, ratio));
  },

  confirmRestoredPaneSession: (paneId) => {
    set((state) => confirmRestoredPaneSession(state, paneId));
  },

  resetToPrimaryPane: () => {
    set(INITIAL_PANE_LAYOUT);
  },
}));

// Persist every layout change (Zustand does not notify when a transition is a no-op and preserves the same reference, avoiding redundant writes).
usePaneLayoutStore.subscribe((state) => {
  persistPaneLayout(state);
});
