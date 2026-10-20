import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus } from "lucide-react";
import {
  TID_WORKFLOWS_CREATE_VIA_CHAT,
  TID_WORKFLOWS_LIST,
  TID_WORKFLOW_PROJECT_GROUP,
  resolveWorkspaceKey,
  type ZCodeSavedWorkflowEntry,
} from "@zcode/shared";
import { testId } from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";
import type { AutomationWorkspaceOption } from "@/settings/automationWorkspaceOptions.js";
import { useSavedWorkflowsDirectoryWatch } from "@/settings/saved-workflows/useSavedWorkflowsDirectoryWatch.js";
import { SavedWorkflowCard } from "@/settings/saved-workflows/SavedWorkflowCard.js";
import { SavedWorkflowDetailView } from "@/settings/saved-workflows/SavedWorkflowDetailView.js";
import { SavedWorkflowLaunchDialog } from "@/settings/saved-workflows/SavedWorkflowLaunchDialog.js";
import {
  buildSavedWorkflowCreatePrompt,
  buildSavedWorkflowRevisePrompt,
} from "@/settings/saved-workflows/savedWorkflowLaunchPrompt.js";
import {
  useSavedWorkflowLauncher,
  type SavedWorkflowLaunchTarget,
} from "@/settings/saved-workflows/useSavedWorkflowLauncher.js";
import { useSavedWorkflowProjectTargets } from "@/settings/saved-workflows/useSavedWorkflowProjectTargets.js";
import { lastRunByWorkflowName } from "@/settings/saved-workflows/savedWorkflowRunHistory.js";
import { useSavedWorkflowPromote } from "@/settings/saved-workflows/useSavedWorkflowPromote.js";
import { useSavedWorkflowRunOpeners } from "@/settings/saved-workflows/useSavedWorkflowRunOpeners.js";
import type {
  SavedWorkflowGroupMode,
  SavedWorkflowGroupState,
  SavedWorkflowProjectTarget,
  SavedWorkflowsOpenArtifactParams,
  SavedWorkflowsOpenRunParams,
} from "@/settings/saved-workflows/savedWorkflowContract.js";
import { selectSavedWorkflowState, useSavedWorkflowStore } from "@/store/savedWorkflowStore.js";

// The group's loading-state callback type is defined in savedWorkflowContract; re-export it here to preserve the historical import path.
export type {
  SavedWorkflowGroupMode,
  SavedWorkflowGroupState,
} from "@/settings/saved-workflows/savedWorkflowContract.js";

interface SavedWorkflowProjectGroupProps {
  project: AutomationWorkspaceOption;
  /** The active workspace group gets a “Current” badge; this affects only the badge, not any target. */
  isCurrent: boolean;
  /** Page-level refresh counter; when it changes (other than on initial mount), this group bypasses the cache and refetches. */
  refreshSeq: number;
  mode: SavedWorkflowGroupMode;
  onStateChange: (workspaceKey: string, state: SavedWorkflowGroupState) => void;
  onOpenDetail: (name: string) => void;
  onBack: () => void;
  /** “Run” starts directly from the GUI: switch to the new session after acceptance. */
  onNavigateToLaunchedRun?: (target: SavedWorkflowLaunchTarget, sessionId: string) => void;
  onCreateViaChat?: (prompt: string, target: SavedWorkflowProjectTarget) => void;
  onOpenWorkflowRun?: (params: SavedWorkflowsOpenRunParams) => void;
  /** Artifact chip → `workflow-artifact` tab. */
  onOpenWorkflowArtifact?: (params: SavedWorkflowsOpenArtifactParams) => void;
}

/**
 * Workflow group for one project, taking over all
 * responsibilities of the v1 single-project section — use **this project's** agent proxy to fetch lists / run history, watch this project directory, and run / revise / copy / delete /
 * / promote globally / open details, all with this project's target. Header = project name + “Current” badge + count +
 * “Create via conversation.”
 */
export function SavedWorkflowProjectGroup({
  project,
  isCurrent,
  refreshSeq,
  mode,
  onStateChange,
  onOpenDetail,
  onBack,
  onNavigateToLaunchedRun,
  onCreateViaChat,
  onOpenWorkflowRun,
  onOpenWorkflowArtifact,
}: SavedWorkflowProjectGroupProps) {
  const { intl, locale } = useZCodeIntl();
  const requestConfirmation = useConfirmDialog();
  const resolution = useWorkspaceServicesResolution(
    project.workspacePath,
    project.remoteSessionId ?? null,
    project.workspaceIdentity,
    project.remoteTarget,
  );
  const { services, rpcReady } = resolution;
  const agentService = services.zcodeAgentService;
  const fileWatcherService = services.fileWatcherService;

  const workspaceKey = useMemo(
    () =>
      resolveWorkspaceKey({
        workspacePath: project.workspacePath,
        ...(project.workspaceIdentity ? { workspaceIdentity: project.workspaceIdentity } : {}),
      }),
    [project.workspacePath, project.workspaceIdentity],
  );

  const { target, projectTarget, launchTarget } = useSavedWorkflowProjectTargets(
    project,
    resolution.remoteSessionId,
  );

  const state = useSavedWorkflowStore((store) => selectSavedWorkflowState(store, target));
  const load = useSavedWorkflowStore((store) => store.load);
  const [launchEntry, setLaunchEntry] = useState<ZCodeSavedWorkflowEntry | null>(null);
  const [busyName, setBusyName] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(
    async (options: { bypassCache?: boolean } = {}) => {
      if (!rpcReady) return;
      await load(target, agentService, options);
      setNow(Date.now());
    },
    [agentService, load, rpcReady, target],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Page-level refresh: bypass the cache and refetch when refreshSeq changes (other than on initial mount).
  const lastRefreshSeq = useRef(refreshSeq);
  useEffect(() => {
    if (lastRefreshSeq.current === refreshSeq) return;
    lastRefreshSeq.current = refreshSeq;
    void refresh({ bypassCache: true });
  }, [refresh, refreshSeq]);

  useSavedWorkflowsDirectoryWatch({
    fileWatcherService,
    workspacePath: project.workspacePath,
    enabled: rpcReady,
    refresh,
  });

  // Report loading state to the page; empty = loaded with no valid workflows or malformed files; count = number of valid workflows.
  const empty = state.loaded && state.entries.length === 0 && state.invalid.length === 0;
  const count = state.loaded ? state.entries.length : 0;
  useEffect(() => {
    onStateChange(workspaceKey, { loaded: state.loaded, empty, count });
  }, [count, empty, onStateChange, state.loaded, workspaceKey]);

  const lastRuns = useMemo(() => lastRunByWorkflowName(state.runs), [state.runs]);

  // Direct GUI launcher: use the agent service resolved for this project; switch to the new session after acceptance.
  const launcher = useSavedWorkflowLauncher({
    agentService,
    onNavigate: onNavigateToLaunchedRun,
  });

  const launch = useCallback(
    async (entry: ZCodeSavedWorkflowEntry, args: Record<string, unknown>) => {
      const result = await launcher.launch(launchTarget, {
        name: entry.name,
        scope: "project",
        args,
      });
      if (result.ok) {
        // Success: the launcher has switched to the new session; close the arguments dialog (the no-dialog path never opened it).
        setLaunchEntry(null);
      }
      return result;
    },
    [launchTarget, launcher],
  );
  const handleRun = useCallback(
    (entry: ZCodeSavedWorkflowEntry) => {
      if (entry.args && Object.keys(entry.args).length > 0) {
        launcher.clearError();
        setLaunchEntry(entry);
        return;
      }
      // Project workflow without arguments: start directly without a dialog; show failures in a toast (outside-dialog path).
      void launch(entry, {}).then((result) => {
        if (!result.ok) {
          toast(intl.formatMessage({ id: `workflows.hub.launch.error.${result.error.reason}` }));
        }
      });
    },
    [intl, launch, launcher],
  );
  const handleRevise = useCallback(
    (entry: ZCodeSavedWorkflowEntry) => {
      onCreateViaChat?.(
        buildSavedWorkflowRevisePrompt({ name: entry.name, path: entry.path, locale }),
        projectTarget,
      );
    },
    [locale, onCreateViaChat, projectTarget],
  );
  const handleCopyPath = useCallback(
    (entry: ZCodeSavedWorkflowEntry) => {
      void navigator.clipboard
        ?.writeText(entry.path)
        .then(() => toast(intl.formatMessage({ id: "workflows.hub.copied" })))
        .catch((error: unknown) => {
          logger.warn("[SavedWorkflows] 复制路径失败", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    },
    [intl],
  );
  const handleDelete = useCallback(
    async (entry: ZCodeSavedWorkflowEntry) => {
      const confirmed = await requestConfirmation({
        title: intl.formatMessage({ id: "workflows.hub.delete.title" }, { name: entry.name }),
        description: intl.formatMessage(
          { id: "workflows.hub.delete.description" },
          { path: entry.path },
        ),
        confirmLabel: intl.formatMessage({ id: "workflows.hub.delete.confirm" }),
        confirmVariant: "destructive",
      });
      if (!confirmed) return;
      setBusyName(entry.name);
      try {
        const result = await agentService.deleteSavedWorkflow({ ...target, name: entry.name });
        if (!result.ok) {
          toast(
            intl.formatMessage(
              { id: "workflows.hub.deleteFailed" },
              { reason: intl.formatMessage({ id: `workflows.hub.reason.${result.reason}` }) },
            ),
          );
          return;
        }
        toast(intl.formatMessage({ id: "workflows.hub.deleted" }, { name: entry.name }));
        if (mode.kind === "detail" && mode.name === entry.name) onBack();
      } catch (error) {
        toast(
          intl.formatMessage(
            { id: "workflows.hub.deleteFailed" },
            { reason: error instanceof Error ? error.message : String(error) },
          ),
        );
      } finally {
        setBusyName(null);
        void refresh({ bypassCache: true });
      }
    },
    [agentService, intl, mode, onBack, refresh, requestConfirmation, target],
  );
  const handleCardDelete = useCallback(
    (entry: ZCodeSavedWorkflowEntry) => void handleDelete(entry),
    [handleDelete],
  );
  // “Promote globally”: do not move the file — open a new session in this project,
  // automatically send a summary prompt, and let the model save a global copy through SaveWorkflow; leave the source file untouched. Unavailable for remote projects (the remote
  // home is not indexed centrally, so promoted workflows would not be visible).
  const isLocalProject = !project.remoteSessionId;
  const promoter = useSavedWorkflowPromote({ agentService, onNavigate: onNavigateToLaunchedRun });
  const handlePromote = useCallback(
    async (entry: ZCodeSavedWorkflowEntry) => {
      setBusyName(entry.name);
      try {
        const result = await promoter.promote(launchTarget, {
          name: entry.name,
          path: entry.path,
          locale,
        });
        if (!result.ok) {
          toast(
            intl.formatMessage(
              { id: "workflows.hub.promote.failed" },
              { reason: result.message ?? result.code },
            ),
          );
        }
      } finally {
        setBusyName(null);
      }
    },
    [intl, launchTarget, locale, promoter],
  );
  const handleCardPromote = useCallback(
    (entry: ZCodeSavedWorkflowEntry) => void handlePromote(entry),
    [handlePromote],
  );
  const handleOpen = useCallback(
    (entry: ZCodeSavedWorkflowEntry) => onOpenDetail(entry.name),
    [onOpenDetail],
  );
  // The two “Open” gates and argument construction are shared with global workflows (see the hook comment: artifacts do not need toolCallId).
  const resolveRunTarget = useCallback(() => projectTarget, [projectTarget]);
  const { handleOpenArtifact, handleOpenRun } = useSavedWorkflowRunOpeners({
    resolveTarget: resolveRunTarget,
    ...(onOpenWorkflowRun === undefined ? {} : { onOpenWorkflowRun }),
    ...(onOpenWorkflowArtifact === undefined ? {} : { onOpenWorkflowArtifact }),
  });
  const handleCreateViaChat = useCallback(() => {
    onCreateViaChat?.(buildSavedWorkflowCreatePrompt(locale), projectTarget);
  }, [locale, onCreateViaChat, projectTarget]);
  const handleMetaSaved = useCallback(() => {
    void refresh({ bypassCache: true });
  }, [refresh]);

  const launchDialog = (
    <SavedWorkflowLaunchDialog
      entry={launchEntry}
      scope="project"
      projectLabel={project.label}
      pending={launcher.pending}
      error={launcher.error}
      onOpenChange={(open) => (open ? undefined : setLaunchEntry(null))}
      onSubmit={(entry, args) => void launch(entry, args)}
    />
  );

  if (mode.kind === "detail") {
    const entry = state.entries.find((candidate) => candidate.name === mode.name);
    return (
      <SavedWorkflowDetailView
        target={target}
        agentService={agentService}
        name={mode.name}
        projectLabel={project.label}
        entry={entry}
        runs={state.runs.filter((run) => run.name === mode.name)}
        now={now}
        busy={busyName === mode.name}
        canOpenRun={Boolean(onOpenWorkflowRun)}
        onBack={onBack}
        onRun={() => (entry ? handleRun(entry) : undefined)}
        onRevise={() => (entry ? handleRevise(entry) : undefined)}
        onCopyPath={() => (entry ? handleCopyPath(entry) : undefined)}
        onMove={isLocalProject ? () => (entry ? void handlePromote(entry) : undefined) : undefined}
        onDelete={() => (entry ? void handleDelete(entry) : undefined)}
        onOpenRun={(run) => handleOpenRun(run, mode.name)}
        {...(onOpenWorkflowArtifact === undefined ? {} : { onOpenArtifact: handleOpenArtifact })}
        onMetaSaved={handleMetaSaved}
        launchDialog={launchDialog}
      />
    );
  }

  // List state: hide a group once loaded if it has neither valid workflows nor malformed files (empty groups stay hidden), while still reporting its state to the page.
  if (empty) return null;
  if (!state.loaded && state.entries.length === 0 && state.invalid.length === 0) return null;

  const invalidCount = state.invalid.length;

  return (
    <div
      data-testid={testId(TID_WORKFLOW_PROJECT_GROUP, workspaceKey)}
      data-workflow-project-current={isCurrent ? "true" : undefined}
      className="mt-8 first:mt-0"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-ui-base font-medium leading-5 text-foreground">
          <span className="truncate">{project.label}</span>
          {isCurrent ? (
            <span className="rounded-sm border border-border px-1.5 py-0.5 text-ui-xs leading-none text-foreground-subtlest">
              {intl.formatMessage({ id: "workflows.hub.group.current" })}
            </span>
          ) : null}
          {state.entries.length > 0 ? (
            <span className="font-normal text-foreground-subtlest">{state.entries.length}</span>
          ) : null}
        </h3>
        <Button
          type="button"
          size="lg"
          data-icon="inline-start"
          data-testid={testId(TID_WORKFLOWS_CREATE_VIA_CHAT, workspaceKey)}
          onClick={handleCreateViaChat}
        >
          <Plus className="size-4" aria-hidden="true" />
          {intl.formatMessage({ id: "workflows.hub.createViaChat" })}
        </Button>
      </div>

      {state.entries.length > 0 ? (
        <div
          data-testid={testId(TID_WORKFLOWS_LIST, workspaceKey)}
          className="mt-5 grid grid-cols-1 auto-rows-[132px] gap-x-4 gap-y-4 lg:grid-cols-2"
        >
          {state.entries.map((entry) => (
            <SavedWorkflowCard
              key={entry.path}
              entry={entry}
              lastRun={lastRuns.get(entry.name)}
              now={now}
              busy={busyName === entry.name}
              onOpen={handleOpen}
              onRun={handleRun}
              onRevise={handleRevise}
              onCopyPath={handleCopyPath}
              onMove={isLocalProject ? handleCardPromote : undefined}
              onDelete={handleCardDelete}
            />
          ))}
        </div>
      ) : null}

      {state.error ? (
        <p className="mt-4 text-ui-sm text-destructive">
          {intl.formatMessage({ id: "workflows.hub.loadError" }, { error: state.error })}
        </p>
      ) : null}

      {invalidCount === 0 ? null : (
        <div
          data-workflows-invalid="true"
          className="mt-4 space-y-0.5 rounded-lg border border-warning/40 px-2.5 py-2"
        >
          <p className="text-ui-sm text-warning">
            {intl.formatPlural({ id: "workflows.hub.invalid" }, invalidCount)}
          </p>
          {state.invalid.map((entry) => (
            <p
              key={entry.path}
              className="min-w-0 truncate font-mono text-ui-xs text-foreground-subtlest"
              title={entry.reason}
            >
              {entry.path} — {entry.reason}
            </p>
          ))}
        </div>
      )}

      {launchDialog}
    </div>
  );
}
