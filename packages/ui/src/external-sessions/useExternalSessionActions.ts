import { useCallback, useMemo } from "react";
import { useOptionalBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import type {
  ExternalSessionSummary,
  ExternalSessionTranscript,
  IExternalSessionsService,
} from "./contract.js";

export interface ExternalSessionImportOutcome {
  imported?: { workspacePath: string; taskId: string };
  /** Reason reported by the upstream import when nothing was imported. */
  failureReason?: string;
}

export interface ExternalSessionActions {
  /** The upstream Claude import is available (local task service present). */
  canImport: boolean;
  /** A local project can be resolved for the session folder (project service present). */
  canResolveProject: boolean;
  openInTerminal(summary: ExternalSessionSummary): Promise<{ opened: boolean; command: string }>;
  readTranscript(summary: ExternalSessionSummary): Promise<ExternalSessionTranscript>;
  /** Claude Code only; never attaches a scope identity to the scanned (local) session. */
  importClaudeSession(summary: ExternalSessionSummary): Promise<ExternalSessionImportOutcome>;
  /**
   * Resolves the folder's local project the way "Open folder" does (idempotent per root), so a draft created with
   * this project id lands in the source repository instead of a managed directory.
   */
  resolveContinuationProjectId(workspacePath: string): Promise<string>;
}

/** Service orchestration for the panel (packages/ui/AGENTS.md: components reach services through hooks). */
export function useExternalSessionActions(
  service: IExternalSessionsService | null,
): ExternalSessionActions {
  const baseServices = useOptionalBaseWorkspaceServices();
  const taskService = baseServices?.zcodeTaskService ?? null;
  const projectService = baseServices?.projectService ?? null;

  const openInTerminal = useCallback(
    async (summary: ExternalSessionSummary) => {
      if (!service) throw new Error("external sessions service unavailable");
      return service.openExternalSessionInTerminal({
        source: summary.source,
        sessionId: summary.sessionId,
      });
    },
    [service],
  );

  const readTranscript = useCallback(
    async (summary: ExternalSessionSummary) => {
      if (!service) throw new Error("external sessions service unavailable");
      return service.readExternalSessionTranscript({
        source: summary.source,
        sessionId: summary.sessionId,
      });
    },
    [service],
  );

  const importClaudeSession = useCallback(
    async (summary: ExternalSessionSummary): Promise<ExternalSessionImportOutcome> => {
      if (!taskService || summary.source !== "claude" || !summary.importable) {
        return { failureReason: "unsupported" };
      }
      const result = await taskService.importClaudeSessions({
        workspacePath: summary.workspacePath,
        sessionIds: [summary.sessionId],
      });
      const imported = result.imported[0];
      if (imported) {
        return { imported: { workspacePath: imported.workspacePath, taskId: imported.taskId } };
      }
      const issue = result.failed[0] ?? result.skipped[0];
      return { failureReason: issue?.reason ?? "unknown" };
    },
    [taskService],
  );

  const resolveContinuationProjectId = useCallback(
    async (workspacePath: string) => {
      if (!projectService) throw new Error("project service unavailable");
      const project = await projectService.saveProject({
        roots: [workspacePath],
        reuseExistingRoot: true,
      });
      return project.id;
    },
    [projectService],
  );

  return useMemo(
    () => ({
      canImport: taskService !== null,
      canResolveProject: projectService !== null,
      openInTerminal,
      readTranscript,
      importClaudeSession,
      resolveContinuationProjectId,
    }),
    [
      taskService,
      projectService,
      openInTerminal,
      readTranscript,
      importClaudeSession,
      resolveContinuationProjectId,
    ],
  );
}
