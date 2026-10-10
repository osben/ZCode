// Availability switch for the sidebar session entry points “Open in split view / Drag to split view.”
// Session workbench groups are supported on desktop and regular web apps, but not on mobile or /remote web-remote.
// Use context instead of threading props through each layer: session context menus and drag sources are shared by multiple
// sidebar sections, so keep the decision source in WorkspaceShellLayout.
import { createContext, useContext, useMemo, useRef, type ReactNode } from "react";
import type { WorkbenchSessionTarget } from "@/v4/workbenchSessionPlacement.js";

export type V4SplitPaneSessionTarget = WorkbenchSessionTarget;

interface V4SplitPaneEntryContextValue {
  readonly enabled: boolean;
  readonly canOpenSession: (target: V4SplitPaneSessionTarget) => boolean;
  readonly openSession: (target: V4SplitPaneSessionTarget) => void;
}

const DEFAULT_SPLIT_PANE_ENTRY_CONTEXT: V4SplitPaneEntryContextValue = {
  enabled: false,
  canOpenSession: () => false,
  openSession: () => {},
};

const V4SplitPaneEntryContext = createContext<V4SplitPaneEntryContextValue>(
  DEFAULT_SPLIT_PANE_ENTRY_CONTEXT,
);

export function V4SplitPaneEntryProvider({
  enabled,
  canOpenSession,
  onOpenSession,
  children,
}: {
  enabled: boolean;
  canOpenSession: (target: V4SplitPaneSessionTarget) => boolean;
  onOpenSession: (target: V4SplitPaneSessionTarget) => void;
  children: ReactNode;
}) {
  const controllerRef = useRef({ canOpenSession, onOpenSession });
  controllerRef.current = { canOpenSession, onOpenSession };
  const value = useMemo<V4SplitPaneEntryContextValue>(
    () => ({
      enabled,
      canOpenSession: (target) => enabled && controllerRef.current.canOpenSession(target),
      openSession: (target) => {
        if (enabled) controllerRef.current.onOpenSession(target);
      },
    }),
    [enabled],
  );
  return (
    <V4SplitPaneEntryContext.Provider value={value}>{children}</V4SplitPaneEntryContext.Provider>
  );
}

/** The shell makes the right-click entry decision so task rows cannot bypass the active group/draft pane owner. */
export function useV4SplitPaneEntry(): V4SplitPaneEntryContextValue {
  return useContext(V4SplitPaneEntryContext);
}
