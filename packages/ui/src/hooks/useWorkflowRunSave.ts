// Shared "Save / Run again" controller for the completion card and the run side pane
// (docs/dynamic-workflow/transcript-and-notifications.md, "Saving the run, and running it again").
//
// One hook instead of two wirings: the same run must say the same thing and go through the same
// command on both the card and the side pane. It handles:
//   1. which saved workflow this run corresponds to (derived, cached in workflowRunSavedStore);
//   2. "save directly" = `workflows/save` (fetches the script by runId, no model turns);
//   3. "run again" = the hub's launcher (`useSavedWorkflowLauncher`), with the args this run used.
// "Let ZCode distill and save" is not here: it only hands a user message back to the host to send
// (the card sends in its session, the side pane in the parent session); each host has its own
// send path.
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  resolveWorkspaceKey,
  type ZCodeSavedWorkflowEntry,
  type ZCodeSavedWorkflowMeta,
  type ZCodeSavedWorkflowScope,
  type ZCodeWorkflowsForRunCandidate,
  type ZCodeWorkflowsSaveResult,
} from "@zcode/shared";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import {
  selectWorkflowRunSavedState,
  useWorkflowRunSavedStore,
  workflowRunSavedKey,
  type WorkflowRunSavedState,
} from "@/store/workflowRunSavedStore.js";
import {
  useSavedWorkflowLauncher,
  type SavedWorkflowLaunchError,
  type SavedWorkflowLaunchTarget,
} from "@/settings/saved-workflows/useSavedWorkflowLauncher.js";

export interface WorkflowRunSaveTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

export interface WorkflowRunSaveHost extends WorkflowRunSaveTarget {
  runId: string;
  /** Candidates transcribed from the conversation (`buildWorkflowSaveCandidatesByRunId`). */
  candidates?: readonly ZCodeWorkflowsForRunCandidate[];
  /** Switch to the new session after a successful launch; absent means the host does not navigate (mobile remote-control home, static rendering). */
  onNavigateToRun?: (target: SavedWorkflowLaunchTarget, sessionId: string) => void;
}

export interface WorkflowRunSaveSubmit {
  name: string;
  scope: ZCodeSavedWorkflowScope;
  meta: ZCodeSavedWorkflowMeta;
  overwrite?: boolean;
}

export interface WorkflowRunSaveController {
  /** The saved workflow for this run (derived). `undefined` = not fetched yet. */
  saved: WorkflowRunSavedState | undefined;
  /** The saved entry; absent means none. */
  entry: ZCodeSavedWorkflowEntry | undefined;
  /** The args this run executed, used to prefill the "Run again" args form. */
  runArgs: Record<string, unknown> | undefined;
  /** Older agents lack `workflows/save`: the dialog only keeps the ZCode path. */
  directSaveUnsupported: boolean;
  /** Remote projects get no global scope: `~` lives on the agent machine, which the hub never reads. */
  scopeLocked: boolean;
  saving: boolean;
  save: (input: WorkflowRunSaveSubmit) => Promise<ZCodeWorkflowsSaveResult>;
  /** Whether the name is taken (upfront probe while typing in the dialog); treated as "not taken" when the probe fails — the agent has the final say. */
  checkNameTaken: (name: string, scope: ZCodeSavedWorkflowScope) => Promise<boolean>;
  launching: boolean;
  launchError: SavedWorkflowLaunchError | null;
  clearLaunchError: () => void;
  /** "Run again": launch by entry; args default to those this run executed. */
  launch: (
    entry: ZCodeSavedWorkflowEntry,
    args: Record<string, unknown>,
    target?: WorkflowRunSaveTarget,
  ) => Promise<{ ok: true } | { ok: false; error: SavedWorkflowLaunchError }>;
}

export function useWorkflowRunSave(host: WorkflowRunSaveHost): WorkflowRunSaveController {
  const { candidates, runId, onNavigateToRun } = host;
  const resolution = useWorkspaceServicesResolution(
    host.workspacePath,
    host.remoteSessionId ?? null,
    host.workspaceIdentity,
  );
  const { rpcReady, services } = resolution;
  const agentService = services.zcodeAgentService;
  const isRemote = resolution.isRemoteTarget;

  const target = useMemo<WorkflowRunSaveTarget>(
    () => ({
      workspacePath: host.workspacePath,
      ...(host.workspaceIdentity ? { workspaceIdentity: host.workspaceIdentity } : {}),
      ...(resolution.remoteSessionId ? { remoteSessionId: resolution.remoteSessionId } : {}),
    }),
    [host.workspacePath, host.workspaceIdentity, resolution.remoteSessionId],
  );
  const workspaceKey = useMemo(
    () =>
      resolveWorkspaceKey({
        workspacePath: host.workspacePath,
        ...(host.workspaceIdentity ? { workspaceIdentity: host.workspaceIdentity } : {}),
      }),
    [host.workspacePath, host.workspaceIdentity],
  );
  const key = useMemo(
    () => workflowRunSavedKey(workspaceKey, runId, candidates),
    [candidates, runId, workspaceKey],
  );

  const generation = useWorkflowRunSavedStore((state) => state.generation);
  const load = useWorkflowRunSavedStore((state) => state.load);
  const applySaved = useWorkflowRunSavedStore((state) => state.applySaved);
  const saved = useWorkflowRunSavedStore((state) => selectWorkflowRunSavedState(state, key));

  useEffect(() => {
    if (!rpcReady) return;
    // `generation` is in the deps: one invalidation makes all mounted cards re-query (save,
    // delete, and hub refresh all invalidate).
    void generation;
    void load(key, () =>
      agentService.findSavedWorkflowForRun({
        ...target,
        runId,
        ...(candidates === undefined || candidates.length === 0 ? {} : { candidates }),
      }),
    );
  }, [agentService, candidates, generation, key, load, rpcReady, runId, target]);

  const [saving, setSaving] = useState(false);
  const save = useCallback(
    async (input: WorkflowRunSaveSubmit) => {
      setSaving(true);
      try {
        const result = await agentService.saveSavedWorkflowFromRun({
          ...target,
          runId,
          name: input.name,
          meta: input.meta,
          scope: input.scope,
          ...(input.overwrite === undefined ? {} : { overwrite: input.overwrite }),
        });
        if (result.ok) {
          // Put the just-saved entry in place immediately (the card flips to "Saved / Run again")
          // and invalidate other cards' answers.
          applySaved(key, {
            name: result.name,
            description: input.meta.description,
            ...(input.meta.whenToUse === undefined ? {} : { whenToUse: input.meta.whenToUse }),
            ...(input.meta.args === undefined ? {} : { args: input.meta.args }),
            scope: result.scope,
            path: result.path,
          });
        }
        return result;
      } finally {
        setSaving(false);
      }
    },
    [agentService, applySaved, key, runId, target],
  );

  const checkNameTaken = useCallback(
    async (name: string, scope: ZCodeSavedWorkflowScope) => {
      try {
        const result = await agentService.getSavedWorkflow({ ...target, name, scope });
        return result.ok;
      } catch {
        // A failed probe must not block saving: the agent still gives the final answer via `target_exists`.
        return false;
      }
    },
    [agentService, target],
  );

  const launcher = useSavedWorkflowLauncher({
    agentService,
    ...(onNavigateToRun === undefined ? {} : { onNavigate: onNavigateToRun }),
  });
  const launch = useCallback(
    async (
      entry: ZCodeSavedWorkflowEntry,
      args: Record<string, unknown>,
      launchTarget?: WorkflowRunSaveTarget,
    ) => {
      const destination = launchTarget ?? target;
      const result = await launcher.launch(
        {
          workspacePath: destination.workspacePath,
          ...(destination.workspaceIdentity
            ? { workspaceIdentity: destination.workspaceIdentity }
            : {}),
          ...(destination.remoteSessionId ? { remoteSessionId: destination.remoteSessionId } : {}),
        },
        { name: entry.name, scope: entry.scope, args },
      );
      return result.ok ? { ok: true as const } : { ok: false as const, error: result.error };
    },
    [launcher, target],
  );

  return {
    saved,
    entry: saved?.entry,
    runArgs: saved?.runArgs,
    directSaveUnsupported: saved?.status === "unsupported",
    scopeLocked: isRemote,
    saving,
    save,
    checkNameTaken,
    launching: launcher.pending,
    launchError: launcher.error,
    clearLaunchError: launcher.clearError,
    launch,
  };
}
