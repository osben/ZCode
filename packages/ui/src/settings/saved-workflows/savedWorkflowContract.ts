// Cross-component type contracts for the saved-workflows hub.
// Kept in a separate file to avoid a circular import between the page (Section) and project group (Group).

/** Coordinates of the project owning the workflow; use for conversations (run / revise / create) and opening an instance, never the active project. */
export type SavedWorkflowProjectTarget = {
  workspacePath: string;
  workspaceIdentity?: string;
};

/** Run history “View instance”: switch to the session that started it and open the instance detail page; the page lists all projects, so the owning workspace is required. */
export interface SavedWorkflowsOpenRunParams {
  sessionId: string;
  runId: string;
  toolCallId: string;
  workflowName: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

/**
 * Artifact chip in the hub → `workflow-artifact` tab.
 *
 * ⚠ Terminology: artifact = output a script publishes for users through `artifact.*`.
 *
 * **Omits `toolCallId`** compared with {@link SavedWorkflowsOpenRunParams}: artifact tabs do not show the causal graph,
 * so they do not need to return to the CreateWorkflow tool row. The only gate is the presence of `parentSessionId`.
 */
export interface SavedWorkflowsOpenArtifactParams {
  sessionId: string;
  runId: string;
  artifactId: string;
  title?: string;
  /**
   * contentType of the latest version (available in the run-history row's chip payload). The destination `handleOpenWorkflowArtifact`
   * uses it to decide whether HTML artifacts open directly in a browser tab or in an artifact tab; if absent (legacy row has no artifact list), open an artifact tab.
   */
  contentType?: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

/** Group reports its loading state to the page; the page uses it to calculate total count and render empty state / initial spinner. */
export interface SavedWorkflowGroupState {
  loaded: boolean;
  empty: boolean;
  /** Number of valid workflows in this group (0 before loading); the page sums loaded groups for the total beside the heading. */
  count: number;
}

/** The group's two modes: list / single-workflow detail. Shared by project and global groups. */
export type SavedWorkflowGroupMode = { kind: "list" } | { kind: "detail"; name: string };
