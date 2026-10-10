import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Plus } from "lucide-react";
import {
  TID_WORKFLOWS_CREATE_VIA_CHAT,
  TID_WORKFLOWS_EMPTY,
  TID_WORKFLOWS_REFRESH,
  resolveWorkspaceKey,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Spinner } from "@/components/ui/spinner.js";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import {
  buildAutomationWorkspaceOptions,
  type AutomationWorkspaceOption,
} from "@/settings/automationWorkspaceOptions.js";
import { AutomationRefreshIcon } from "@/settings/AutomationDesignPrimitives.js";
import { SETTINGS_FRAME_CONTENT_CLASSNAME } from "@/settings/SettingsPageParts.js";
import { buildSavedWorkflowCreatePrompt } from "@/settings/saved-workflows/savedWorkflowLaunchPrompt.js";
import { SavedWorkflowProjectGroup } from "@/settings/saved-workflows/SavedWorkflowProjectGroup.js";
import { SavedWorkflowGlobalGroup } from "@/settings/saved-workflows/SavedWorkflowGlobalGroup.js";
import type { SavedWorkflowLaunchTarget } from "@/settings/saved-workflows/useSavedWorkflowLauncher.js";
import type {
  SavedWorkflowGroupState,
  SavedWorkflowProjectTarget,
  SavedWorkflowsOpenArtifactParams,
  SavedWorkflowsOpenRunParams,
} from "@/settings/saved-workflows/savedWorkflowContract.js";

export type {
  SavedWorkflowProjectTarget,
  SavedWorkflowsOpenArtifactParams,
  SavedWorkflowsOpenRunParams,
  SavedWorkflowLaunchTarget,
};

/** Deep-link target: project by default (scope may be omitted by older callers), or global (no workspaceKey). */
export type SavedWorkflowsOpenTarget =
  | { scope?: "project"; workspaceKey: string; name: string }
  | { scope: "global"; name: string };

interface SavedWorkflowsSectionProps {
  /** Page header (title switch + subtitle); rendered only in list mode, while detail and scheduled-task editing each occupy the full page. */
  header?: ReactNode;
  /** Active workspace: used only for the "Current" marker and as the create target in the global empty state. */
  workspacePath?: string | null;
  workspaceIdentity?: string;
  /** "Run" = launch directly from the GUI; switch to the new session after acceptance. */
  onNavigateToLaunchedRun?: (target: SavedWorkflowLaunchTarget, sessionId: string) => void;
  /** "Create through chat" / "Revise in chat": prefill a draft only, without sending; target is the owning project (the empty-state card uses the active project). */
  onCreateViaChat?: (prompt: string, target: SavedWorkflowProjectTarget) => void;
  /** "View instance" in run history: switch to the session that started it and open the instance detail page. */
  onOpenWorkflowRun?: (params: SavedWorkflowsOpenRunParams) => void;
  /** Artifact chip → `workflow-artifact` tab. */
  onOpenWorkflowArtifact?: (params: SavedWorkflowsOpenArtifactParams) => void;
  /** Deep links open directly to the detail page and are cleared by the caller after resolution. A project requires workspaceKey; global requires only name. */
  openWorkflow?: SavedWorkflowsOpenTarget | null;
  onOpenWorkflowConsumed?: () => void;
}

type SavedWorkflowsView =
  | { mode: "list" }
  | { mode: "detail"; scope: "project"; workspaceKey: string; name: string }
  | { mode: "detail"; scope: "global"; name: string };

/** The global group uses the fixed readiness key `"global"`, stored in the same table as project workspaceKeys. */
const GLOBAL_READINESS_KEY = "global";

function resolveOptionKey(option: AutomationWorkspaceOption): string {
  return resolveWorkspaceKey({
    workspacePath: option.workspacePath,
    ...(option.workspaceIdentity ? { workspaceIdentity: option.workspaceIdentity } : {}),
  });
}

/** Saved-workflow hub: a fixed "Global" group at the top, with open projects grouped below. The page owns only a refresh counter, each group's loading state, and detail state; "projects" come from `buildAutomationWorkspaceOptions`. */
export function SavedWorkflowsSection({
  header,
  workspacePath,
  workspaceIdentity,
  onNavigateToLaunchedRun,
  onCreateViaChat,
  onOpenWorkflowRun,
  onOpenWorkflowArtifact,
  openWorkflow,
  onOpenWorkflowConsumed,
}: SavedWorkflowsSectionProps) {
  const { intl, locale } = useZCodeIntl();
  const tabs = useTabStore((store) => store.tabs);
  const projects = useMemo(() => buildAutomationWorkspaceOptions(tabs), [tabs]);
  // The global group may run or move workflows only to local projects; filter out remote workspaces.
  const localProjects = useMemo(
    () => projects.filter((project) => !project.remoteSessionId),
    [projects],
  );

  const [view, setView] = useState<SavedWorkflowsView>({ mode: "list" });
  const [refreshSeq, setRefreshSeq] = useState(0);
  const [readiness, setReadiness] = useState<Record<string, SavedWorkflowGroupState>>({});

  // Active workspace (passed by the caller as a prop): used for the "Current" marker, the global group default target, and the global empty-state create target.
  const activeKey = useMemo(
    () =>
      workspacePath
        ? resolveWorkspaceKey({
            workspacePath,
            ...(workspaceIdentity ? { workspaceIdentity } : {}),
          })
        : null,
    [workspaceIdentity, workspacePath],
  );

  const handleStateChange = useCallback((key: string, next: SavedWorkflowGroupState) => {
    setReadiness((current) => {
      const prev = current[key];
      if (
        prev &&
        prev.loaded === next.loaded &&
        prev.empty === next.empty &&
        prev.count === next.count
      ) {
        return current;
      }
      return { ...current, [key]: next };
    });
  }, []);

  // After the global group moves a file to a project, reload both groups. Project groups have no action that changes both groups ("promote to global"
  // only opens a session; the model saves a separate global copy, which appears through the global directory watcher), so only the global group receives this callback.
  const handleMoved = useCallback(() => setRefreshSeq((seq) => seq + 1), []);

  // Deep link: open the matching workflow detail page, then consume it. If the project is not a candidate, consume it without navigating.
  const consumedRef = useRef<SavedWorkflowsOpenTarget | null>(null);
  useEffect(() => {
    if (!openWorkflow) {
      consumedRef.current = null;
      return;
    }
    if (consumedRef.current === openWorkflow) return;
    consumedRef.current = openWorkflow;
    if (openWorkflow.scope === "global") {
      setView({ mode: "detail", scope: "global", name: openWorkflow.name });
    } else if (
      projects.some((project) => resolveOptionKey(project) === openWorkflow.workspaceKey)
    ) {
      setView({
        mode: "detail",
        scope: "project",
        workspaceKey: openWorkflow.workspaceKey,
        name: openWorkflow.name,
      });
    }
    onOpenWorkflowConsumed?.();
  }, [onOpenWorkflowConsumed, openWorkflow, projects]);

  // If a project is closed while its detail page is open, return to the list (using an effect rather than setState during render).
  useEffect(() => {
    if (
      view.mode === "detail" &&
      view.scope === "project" &&
      !projects.some((project) => resolveOptionKey(project) === view.workspaceKey)
    ) {
      setView({ mode: "list" });
    }
  }, [projects, view]);

  // Target for the global empty-state create card: the active project, or the first candidate if the active project is not among them (create a project workflow).
  const emptyCardTarget = useMemo<SavedWorkflowProjectTarget | null>(() => {
    const active = projects.find((project) => resolveOptionKey(project) === activeKey);
    const target = active ?? projects[0];
    if (!target) return null;
    return {
      workspacePath: target.workspacePath,
      ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
    };
  }, [activeKey, projects]);

  const handleCreateFromEmpty = useCallback(() => {
    if (!emptyCardTarget) return;
    onCreateViaChat?.(buildSavedWorkflowCreatePrompt(locale), emptyCardTarget);
  }, [emptyCardTarget, locale, onCreateViaChat]);

  const globalGroupCommonProps = {
    refreshSeq,
    onStateChange: handleStateChange,
    onNavigateToLaunchedRun,
    onCreateViaChat,
    onOpenWorkflowRun,
    onOpenWorkflowArtifact,
    localProjects,
    activeProjectKey: activeKey,
    onMoved: handleMoved,
  };

  // Detail mode renders only the selected group (which renders the full-page detail); omit the page header and toolbar.
  if (view.mode === "detail" && view.scope === "global") {
    return (
      <SavedWorkflowGlobalGroup
        {...globalGroupCommonProps}
        mode={{ kind: "detail", name: view.name }}
        onOpenDetail={(name) => setView({ mode: "detail", scope: "global", name })}
        onBack={() => setView({ mode: "list" })}
      />
    );
  }
  if (view.mode === "detail") {
    const project = projects.find((candidate) => resolveOptionKey(candidate) === view.workspaceKey);
    if (project) {
      return (
        <SavedWorkflowProjectGroup
          key={view.workspaceKey}
          project={project}
          isCurrent={activeKey === view.workspaceKey}
          refreshSeq={refreshSeq}
          mode={{ kind: "detail", name: view.name }}
          onStateChange={handleStateChange}
          onOpenDetail={(name) =>
            setView({ mode: "detail", scope: "project", workspaceKey: view.workspaceKey, name })
          }
          onBack={() => setView({ mode: "list" })}
          onNavigateToLaunchedRun={onNavigateToLaunchedRun}
          onCreateViaChat={onCreateViaChat}
          onOpenWorkflowRun={onOpenWorkflowRun}
          onOpenWorkflowArtifact={onOpenWorkflowArtifact}
        />
      );
    }
    // If the project is closed while its detail page is open, the effect above resets the view to the list; render the list here first.
  }

  const globalReady = readiness[GLOBAL_READINESS_KEY];
  const anyLoaded =
    Boolean(globalReady?.loaded) ||
    projects.some((project) => readiness[resolveOptionKey(project)]?.loaded);
  // The global empty-state card depends only on project groups: show it once all project groups have loaded and are empty, regardless of whether the global group is empty or populated.
  const allProjectsLoaded =
    projects.length > 0 &&
    projects.every((project) => readiness[resolveOptionKey(project)]?.loaded);
  const allProjectsEmpty =
    allProjectsLoaded && projects.every((project) => readiness[resolveOptionKey(project)]?.empty);
  // The total next to the title is the sum of valid workflows in all loaded groups, including the global group.
  const totalCount = projects.reduce(
    (sum, project) => {
      const entry = readiness[resolveOptionKey(project)];
      return sum + (entry?.loaded ? entry.count : 0);
    },
    globalReady?.loaded ? globalReady.count : 0,
  );

  return (
    <div data-automations-content className={cn(SETTINGS_FRAME_CONTENT_CLASSNAME, "flex flex-col")}>
      {header}

      <div className="mt-8 flex items-center justify-between">
        <h2 className="text-ui-base font-medium leading-5 text-foreground-subtle">
          {intl.formatMessage({ id: "workflows.hub.sectionTitle" })}
          {totalCount > 0 ? (
            <span className="ml-1 font-normal text-foreground-subtlest">{totalCount}</span>
          ) : null}
        </h2>
        <ControlHintTooltip title={intl.formatMessage({ id: "workflows.hub.refresh" })}>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={intl.formatMessage({ id: "workflows.hub.refresh" })}
            data-testid={TID_WORKFLOWS_REFRESH}
            onClick={() => setRefreshSeq((seq) => seq + 1)}
          >
            <AutomationRefreshIcon className="size-3.5" aria-hidden="true" />
          </Button>
        </ControlHintTooltip>
      </div>

      {!anyLoaded ? (
        <div className="mt-8 flex h-40 items-center justify-center">
          <Spinner className="size-5" />
        </div>
      ) : null}

      {/* Keep every group mounted so each can load and report its state (an unready/empty project group renders null; an empty global group remains visible). The first-screen spinner overlays content without blocking loading. The global group always stays on top, with project groups below. */}
      <div className={cn("flex flex-col", anyLoaded ? "mt-5" : "hidden")}>
        <SavedWorkflowGlobalGroup
          {...globalGroupCommonProps}
          mode={{ kind: "list" }}
          onOpenDetail={(name) => setView({ mode: "detail", scope: "global", name })}
          onBack={() => setView({ mode: "list" })}
        />

        {projects.length === 0 ? (
          <p className="mt-8 text-ui-base text-foreground-subtlest">
            {intl.formatMessage({ id: "workflows.hub.noWorkspace" })}
          </p>
        ) : allProjectsEmpty ? (
          <div
            data-testid={TID_WORKFLOWS_EMPTY}
            className="mt-8 flex h-[226px] w-full items-center justify-center rounded-2xl border border-card-border bg-background px-4"
          >
            <div className="flex translate-y-2 flex-col items-center gap-5">
              <div className="flex flex-col items-center gap-1.5 text-center">
                <p className="text-ui-base font-medium leading-5 text-foreground-subtlest">
                  {intl.formatMessage({ id: "workflows.hub.empty.title" })}
                </p>
                <p className="max-w-[420px] text-ui-base leading-5 text-foreground-subtlest">
                  {intl.formatMessage({ id: "workflows.hub.empty.hint" })}
                </p>
              </div>
              <Button
                type="button"
                size="lg"
                data-icon="inline-start"
                data-testid={TID_WORKFLOWS_CREATE_VIA_CHAT}
                onClick={handleCreateFromEmpty}
              >
                <Plus className="size-4" aria-hidden="true" />
                {intl.formatMessage({ id: "workflows.hub.createViaChat" })}
              </Button>
            </div>
          </div>
        ) : null}

        {projects.map((project) => {
          const workspaceKey = resolveOptionKey(project);
          return (
            <SavedWorkflowProjectGroup
              key={workspaceKey}
              project={project}
              isCurrent={activeKey === workspaceKey}
              refreshSeq={refreshSeq}
              mode={{ kind: "list" }}
              onStateChange={handleStateChange}
              onOpenDetail={(name) =>
                setView({ mode: "detail", scope: "project", workspaceKey, name })
              }
              onBack={() => setView({ mode: "list" })}
              onNavigateToLaunchedRun={onNavigateToLaunchedRun}
              onCreateViaChat={onCreateViaChat}
              onOpenWorkflowRun={onOpenWorkflowRun}
              onOpenWorkflowArtifact={onOpenWorkflowArtifact}
            />
          );
        })}
      </div>
    </div>
  );
}
