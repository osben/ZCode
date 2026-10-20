// The two shell-level landing points on the completion card
// (docs/dynamic-workflow/transcript-and-notifications.md,
// "Saving the run, and running it again"):
//
//   openWorkflow  ── "Saved" chip → that workflow's page in the hub;
//   navigateToRun ── "Run again" launch success → switch to the newly created session.
//
// Same rationale as WorkflowRunOpenProvider for using context instead of layer-by-layer
// props: only the shell knows how to do these two things, while the card lives in both the
// conversation timeline and the run side panel, separated by several pane / row context
// layers that should not need to know "where the hub is". Without a provider (mobile remote
// shell, unit tests, static replay) the chip is just text and a launch does not switch pages
// — the mobile remote shell does not provide a hub in the first place.
import { createContext, useContext, useMemo, useRef, type ReactNode } from "react";
import type { ZCodeSavedWorkflowScope } from "@zcode/shared";
import type { SavedWorkflowLaunchTarget } from "@/settings/saved-workflows/useSavedWorkflowLauncher.js";

export interface SavedWorkflowHubTarget {
  name: string;
  scope: ZCodeSavedWorkflowScope;
  /** Project a project-scoped entry belongs to; ignored for global entries (the hub's global group is not split by project). */
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface SavedWorkflowHubHandlers {
  openWorkflow: (target: SavedWorkflowHubTarget) => void;
  navigateToRun: (target: SavedWorkflowLaunchTarget, sessionId: string) => void;
}

const SavedWorkflowHubContext = createContext<SavedWorkflowHubHandlers | null>(null);

export function SavedWorkflowHubProvider({
  children,
  navigateToRun,
  openWorkflow,
}: SavedWorkflowHubHandlers & { children: ReactNode }) {
  const ref = useRef({ openWorkflow, navigateToRun });
  ref.current = { openWorkflow, navigateToRun };
  // Stable reference: the chip sits on cards inside a virtualized list; changing the callback
  // identity would re-render the whole list.
  const stable = useMemo<SavedWorkflowHubHandlers>(
    () => ({
      openWorkflow: (target) => ref.current.openWorkflow(target),
      navigateToRun: (target, sessionId) => ref.current.navigateToRun(target, sessionId),
    }),
    [],
  );
  return (
    <SavedWorkflowHubContext.Provider value={stable}>{children}</SavedWorkflowHubContext.Provider>
  );
}

export function useSavedWorkflowHub(): SavedWorkflowHubHandlers | null {
  return useContext(SavedWorkflowHubContext);
}
