import { useCallback } from "react";
import type { ZCodeSavedWorkflowRun } from "@zcode/shared";
import type {
  SavedWorkflowsOpenArtifactParams,
  SavedWorkflowsOpenRunParams,
} from "@/settings/saved-workflows/savedWorkflowContract.js";

/** Project owning a run-history row (fixed for project workflows; global workflows resolve it from `run.cwd`). */
interface SavedWorkflowRunOpenTarget {
  workspacePath: string;
  workspaceIdentity?: string;
}

/**
 * The two “Open” gates and argument construction for a run-history row in the hub.
 *
 * ⚠ Terminology: artifact here means output a script publishes for users through `artifact.*`, not the script's top-level return value.
 *
 * Keep this in one hook instead of duplicating it in both groups: the only difference between project and global workflows is **how the target project is resolved**
 * (fixed for the former, looked up from `run.cwd` among open projects for the latter), while both gates must use the same criteria — if duplicated,
 * the rule “artifacts do not need toolCallId” could easily become “same as View instance” in one of them.
 *
 * ```
 *                       parentSessionId?   toolCallId?   project openable?
 * “View instance”            required         required        required
 * Artifact chip              required         —               required
 * ```
 *
 * `toolCallId` is used only for the static causal graph on the run detail page (it is attached to the CreateWorkflow tool row's
 * display). Artifact tabs do not show the graph, so artifacts can still open for legacy rows without `toolCallId`.
 */
export function useSavedWorkflowRunOpeners(options: {
  /** Project owning this row; returning null disables both entry points (the project for cwd is not open for a global workflow). */
  resolveTarget: (run: ZCodeSavedWorkflowRun) => SavedWorkflowRunOpenTarget | null;
  onOpenWorkflowRun?: (params: SavedWorkflowsOpenRunParams) => void;
  onOpenWorkflowArtifact?: (params: SavedWorkflowsOpenArtifactParams) => void;
}): {
  handleOpenRun: (run: ZCodeSavedWorkflowRun, workflowName: string) => void;
  handleOpenArtifact: (run: ZCodeSavedWorkflowRun, artifactId: string) => void;
} {
  const { onOpenWorkflowArtifact, onOpenWorkflowRun, resolveTarget } = options;

  const handleOpenRun = useCallback(
    (run: ZCodeSavedWorkflowRun, workflowName: string) => {
      if (!run.parentSessionId || !run.toolCallId) return;
      const target = resolveTarget(run);
      if (!target) return;
      onOpenWorkflowRun?.({
        sessionId: run.parentSessionId,
        runId: run.runId,
        toolCallId: run.toolCallId,
        workflowName,
        workspacePath: target.workspacePath,
        ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
      });
    },
    [onOpenWorkflowRun, resolveTarget],
  );

  const handleOpenArtifact = useCallback(
    (run: ZCodeSavedWorkflowRun, artifactId: string) => {
      if (!run.parentSessionId) return;
      const target = resolveTarget(run);
      if (!target) return;
      // The row's chip payload (`ZCodeSavedWorkflowRun.artifacts`) includes the latest `contentType`:
      // the destination uses it to open HTML artifacts directly in a browser tab. Legacy rows may omit all of `artifacts`; a missing key is a degradation, not an error.
      const artifact = run.artifacts?.find((candidate) => candidate.id === artifactId);
      onOpenWorkflowArtifact?.({
        sessionId: run.parentSessionId,
        runId: run.runId,
        artifactId,
        ...(artifact?.title === undefined ? {} : { title: artifact.title }),
        ...(artifact?.contentType === undefined ? {} : { contentType: artifact.contentType }),
        workspacePath: target.workspacePath,
        ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
      });
    },
    [onOpenWorkflowArtifact, resolveTarget],
  );

  return { handleOpenArtifact, handleOpenRun };
}
