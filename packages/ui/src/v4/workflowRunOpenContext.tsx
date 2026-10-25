// Entry point for clicking a sidebar run row to select a session and open the run pane. It uses the same navigation as the composer badge, decided centrally by WorkspaceShellLayout.
// Use context instead of passing props through every layer: run rows appear in five task-row variants (default / timeline / pinned / archived / grouped).
// Without a provider (mobile remote-control home or unit test), the run row is text rather than a button.
import { createContext, useContext, useMemo, useRef, type ReactNode } from "react";
import type { SessionWorkflowRunSummary } from "@zcode/shared/zcode-protocol-v4";

export interface WorkflowRunOpenTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string;
  run: SessionWorkflowRunSummary;
}

type WorkflowRunOpenHandler = (target: WorkflowRunOpenTarget) => void;

const WorkflowRunOpenContext = createContext<WorkflowRunOpenHandler | null>(null);

export function WorkflowRunOpenProvider({
  onOpenRun,
  children,
}: {
  onOpenRun: WorkflowRunOpenHandler;
  children: ReactNode;
}) {
  const handlerRef = useRef(onOpenRun);
  handlerRef.current = onOpenRun;
  const stable = useMemo<WorkflowRunOpenHandler>(() => (target) => handlerRef.current(target), []);
  return (
    <WorkflowRunOpenContext.Provider value={stable}>{children}</WorkflowRunOpenContext.Provider>
  );
}

export function useWorkflowRunOpen(): WorkflowRunOpenHandler | null {
  return useContext(WorkflowRunOpenContext);
}
