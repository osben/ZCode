// The two **shell-level** landing actions on the completion card (docs/dynamic-workflow/transcript-and-notifications.md
// "Saving the run, and running it again"):
//
//   openWorkflow  ── the "Saved" chip → the corresponding page in the workflow hub;
//   navigateToRun ── "Run again" starts successfully → switch to the newly created session.
//
// Same rationale as WorkflowRunOpenProvider for using context instead of layer-by-layer props: only the shell knows how to do these two things,
// while the card appears in two places (the session timeline and the run side panel), separated by several layers of pane / row context; none of those layers needs to know
// "where the hub is". Without a provider (mobile remote-control shell, unit tests, static replay) the chip is just text and a launch does not switch pages —
// the mobile remote-control shell does not provide a hub in the first place.
import { createContext, useContext, useMemo, useRef, type ReactNode } from "react";
import type { ZCodeSavedWorkflowScope } from "@zcode/shared";
import type { SavedWorkflowLaunchTarget } from "@/settings/saved-workflows/useSavedWorkflowLauncher.js";

export interface SavedWorkflowHubTarget {
  name: string;
  scope: ZCodeSavedWorkflowScope;
  /** The project a project-scoped entry belongs to; global entries ignore it (the hub's global group is not split by project). */
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
  // Stable reference: the chip is mounted on cards inside a virtual list; swapping callback references would re-render the whole column.
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
