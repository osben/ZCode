// Availability switch for the sidebar session drag entry point (dragging a session onto a project moves the task). Not enabled on mobile or /remote web-remote.
// Since 2026-10-16 the "Open in split view / drag to split view" entry points are retired; only the drag gate remains.
// Use context instead of threading props through each layer: the session item drag source is shared by several sidebar sections, so the decision stays in WorkspaceShellLayout.
import { createContext, useContext, useMemo, type ReactNode } from "react";

interface V4SplitPaneEntryContextValue {
  readonly enabled: boolean;
}

const V4SplitPaneEntryContext = createContext<V4SplitPaneEntryContextValue>({ enabled: false });

export function V4SplitPaneEntryProvider({
  enabled,
  children,
}: {
  enabled: boolean;
  children: ReactNode;
}) {
  const value = useMemo<V4SplitPaneEntryContextValue>(() => ({ enabled }), [enabled]);
  return (
    <V4SplitPaneEntryContext.Provider value={value}>{children}</V4SplitPaneEntryContext.Provider>
  );
}

export function useV4SplitPaneEntry(): V4SplitPaneEntryContextValue {
  return useContext(V4SplitPaneEntryContext);
}
