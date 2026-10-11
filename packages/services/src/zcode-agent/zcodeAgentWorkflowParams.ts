import type {
  ZCodeSavedWorkflowMeta,
  ZCodeSavedWorkflowScope,
  ZCodeWorkflowsForRunCandidate,
} from "@zcode/shared";
import type { ZCodeAgentWorkspaceTarget } from "./zcodeAgentPluginParams.js";

// GUI entry point for saved workflows: five workspace-scoped methods that do not require a session.
// Uses the same path as the Skill catalog (workspace agent client), not a separate plugin manager process. Files live in the
// workspace, so remote workspaces scan their remote directories in the remote agent process.
//
// For global workflows (`scope: "global"`), files are stored on the agent machine under
// `~/.zcode/workflows/`. Callers may omit the workspace; in that case, the services layer chooses the carrier runtime
// (active local runtime → management-plane workspace), and the protocol handler does not read a workspace path for global workflows.
// Project-scoped operations still include their workspace (both the target and carrier), so the union below allows either:
// include a workspace (scope optional, defaults to project) or provide only `scope: "global"` (workspace optional).
export type ZCodeAgentSavedWorkflowTarget =
  | (ZCodeAgentWorkspaceTarget & { scope?: ZCodeSavedWorkflowScope })
  | ({ scope: "global" } & Partial<ZCodeAgentWorkspaceTarget>);

export type ZCodeAgentListSavedWorkflowsParams = ZCodeAgentSavedWorkflowTarget;

export type ZCodeAgentGetSavedWorkflowParams = ZCodeAgentSavedWorkflowTarget & {
  name: string;
};

export type ZCodeAgentUpdateSavedWorkflowMetaParams = ZCodeAgentSavedWorkflowTarget & {
  name: string;
  meta: ZCodeSavedWorkflowMeta;
};

export type ZCodeAgentDeleteSavedWorkflowParams = ZCodeAgentSavedWorkflowTarget & {
  name: string;
};

export type ZCodeAgentListSavedWorkflowRunsParams = ZCodeAgentSavedWorkflowTarget & {
  /** Return only runs belonging to this workflow; by default, return all runs in the scope. */
  name?: string;
  /** [1, 50]; clamped by the server. */
  limit: number;
};

// workflows/move: move a global workflow into a project scope,
// **in this direction only**. `workspace` is
// required; it is both the carrier and the target project selected by “Move to project...”. It must be on the same machine and under the same user, and an existing target is not overwritten.
export type ZCodeAgentMoveSavedWorkflowParams = ZCodeAgentWorkspaceTarget & {
  name: string;
};

// Completion-card "Save directly" and "already saved" resolution (docs/dynamic-workflow/transcript-and-notifications.md
// "Saving the run, and running it again"). Both **require a workspace**, global scope included: the
// script to save lives in that agent's journal, so the carrier cannot be another local runtime
// chosen by services.
export type ZCodeAgentSaveSavedWorkflowFromRunParams = ZCodeAgentWorkspaceTarget & {
  /** The run to save; the script is taken from the copy it actually executed. */
  runId: string;
  name: string;
  meta: ZCodeSavedWorkflowMeta;
  /** Defaults to `project`. */
  scope?: ZCodeSavedWorkflowScope;
  /** Pass true only after the overwrite warning has been shown to the user. */
  overwrite?: boolean;
};

export type ZCodeAgentFindSavedWorkflowForRunParams = ZCodeAgentWorkspaceTarget & {
  runId: string;
  /** Candidates transcribed from the conversation (saved and claimed by the model for this run); at most 8, re-resolved by the agent. */
  candidates?: readonly ZCodeWorkflowsForRunCandidate[];
};
