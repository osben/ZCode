/**
 * Settings → Quick prompts (specs/composer-quick-prompts.md rule 20). A project picker (the window's project is
 * preselected when known) above two lists: the selected project's quick prompts and the global ones. All decisions
 * come from the shared model; this file only wires the snapshot, the actions and the editor dialog together.
 */
import { useMemo, useState } from "react";
import type { QuickPrompt, QuickPromptProjectRef, QuickPromptSnapshot } from "./contract.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useOptionalProjectDirectory } from "@/project-sidebar/index.js";
import {
  buildQuickPromptProjectOptions,
  quickPromptScopeBlocks,
  quickPromptBlockMessageId,
  type QuickPromptScopeBlock,
} from "@/quick-prompts/model.js";
import {
  QuickPromptEditorDialog,
  type QuickPromptEditorTarget,
} from "@/quick-prompts/QuickPromptEditorDialog.js";
import {
  QuickPromptSettingsList,
  type QuickPromptListItem,
} from "@/quick-prompts/QuickPromptSettingsList.js";
import { quickPromptProjectKey, parseQuickPromptProjectKey } from "@/quick-prompts/reader.js";
import { useQuickPromptProject } from "@/quick-prompts/useQuickPromptProject.js";
import { useQuickPromptProjectRefs } from "@/quick-prompts/useQuickPromptProjectRefs.js";
import { useQuickPromptSettingsActions } from "@/quick-prompts/useQuickPromptSettingsActions.js";
import { useQuickPrompts } from "@/quick-prompts/useQuickPrompts.js";

const NO_PROJECT_VALUE = "__no-project__";

export interface QuickPromptsSettingsSectionProps {
  /** The window's workspace: preselects its project and is the mention root when no other project is picked. */
  workspacePath?: string;
  workspaceIdentity?: string;
  /** Web remote control (mobile): the service is a read-only scope, so the lists render without controls. */
  readOnly?: boolean;
}

interface PendingOrder {
  listKey: string;
  ids: string[];
  /** The snapshot the order was made against; a newer read (the committed write or a rejection) supersedes it. */
  snapshot: QuickPromptSnapshot;
}

export function QuickPromptsSettingsSection({
  workspacePath = "",
  workspaceIdentity,
  readOnly = false,
}: QuickPromptsSettingsSectionProps) {
  const { intl } = useZCodeIntl();
  const directory = useOptionalProjectDirectory();
  const windowProject = useQuickPromptProject({
    sessionId: null,
    workspaceKey: workspaceIdentity?.trim() || workspacePath,
    workspaceIdentity,
  });
  const windowKey = quickPromptProjectKey(windowProject);
  const projectRefs = useQuickPromptProjectRefs();
  const options = useMemo(
    () =>
      buildQuickPromptProjectOptions({
        projects: directory?.projects ?? [],
        refs: projectRefs.refs,
      }),
    [directory?.projects, projectRefs.refs],
  );

  const [pickedKey, setPickedKey] = useState<string | null>(null);
  // The picker follows the window's project until the user picks another one.
  const selectedKey = pickedKey ?? windowKey;
  const selectedProject: QuickPromptProjectRef | null = parseQuickPromptProjectKey(selectedKey);
  const selectedOption = options.find((option) => option.key === selectedKey) ?? null;
  const selectedAvailable = selectedOption?.available === true;
  const selectedName = selectedOption?.name ?? null;

  const { snapshot, error: readError, service, refresh } = useQuickPrompts(selectedProject);
  const actions = useQuickPromptSettingsActions({ service, refresh });
  const [editorTarget, setEditorTarget] = useState<QuickPromptEditorTarget | null>(null);
  const [pendingOrder, setPendingOrder] = useState<PendingOrder | null>(null);

  // A project's mention panel needs its own root. The window's own project keeps the window's identity, which is
  // the only place a remote workspace's identity is known.
  const selectedDirectoryProject = selectedProject
    ? directory?.projects.find(
        (candidate) =>
          candidate.id === selectedProject.projectId && candidate.hostId === selectedProject.hostId,
      )
    : undefined;
  const editorWorkspace =
    selectedProject && selectedKey !== windowKey
      ? {
          workspacePath:
            selectedDirectoryProject?.roots.find((root) => root.isPrimary)?.rootPath ??
            selectedDirectoryProject?.roots[0]?.rootPath ??
            "",
          workspaceIdentity: undefined,
        }
      : { workspacePath, workspaceIdentity };

  // The @ panel searches the root the editor was opened with. Only the window's own project (or no project, which
  // falls back to the window) has a root this window can search; another project's root lives elsewhere (rule 19).
  const editorMentionPanelEnabled = !selectedProject || selectedKey === windowKey;

  const listItems = (listKey: string, items: readonly QuickPromptListItem[]) => {
    if (!pendingOrder || !snapshot) return items;
    if (pendingOrder.snapshot !== snapshot || pendingOrder.listKey !== listKey) return items;
    const byId = new Map(items.map((item) => [item.promptId, item]));
    return pendingOrder.ids.flatMap((id) => byId.get(id) ?? []);
  };

  const globalListKey = "global";
  const projectListKey = `project:${selectedKey}`;
  const globalBlocks: QuickPromptScopeBlock[] = snapshot
    ? quickPromptScopeBlocks({
        scope: "global",
        project: selectedProject,
        bodyNodes: null,
        snapshot,
      })
    : [];
  const projectBlocks: QuickPromptScopeBlock[] =
    snapshot && selectedProject
      ? quickPromptScopeBlocks({
          scope: "project",
          project: selectedProject,
          bodyNodes: null,
          snapshot,
        })
      : [];
  const globalLimitReached = globalBlocks.includes("limit");
  const projectLimitReached = projectBlocks.includes("limit");
  const limitMessage = intl.formatMessage({ id: quickPromptBlockMessageId("limit") });
  const unavailableMessage = intl.formatMessage({ id: "quickPrompts.settings.unavailableNewHint" });

  const reorder = (
    listKey: string,
    scope: "global" | "project",
    project: QuickPromptProjectRef | null,
    ids: string[],
  ) => {
    if (!snapshot) return;
    setPendingOrder({ listKey, ids, snapshot });
    void actions.reorder(scope, project, ids);
  };

  const handleEdit = (prompt: QuickPrompt) => setEditorTarget({ mode: "edit", prompt });

  const loadErrorMessage = intl.formatMessage({ id: "quickPrompts.settings.loadError" });

  return (
    <div className="space-y-4" data-testid="quick-prompts-settings-section">
      <p className="text-ui-base leading-6 text-foreground-subtle">
        {intl.formatMessage({ id: "settings.quickPrompts.description" })}
      </p>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "quickPrompts.settings.project" })}
          </div>
          <div className="text-ui-caption text-foreground-subtle">
            {intl.formatMessage({ id: "quickPrompts.settings.projectHint" })}
          </div>
        </div>
        <div className="w-full sm:w-72">
          <Select
            value={selectedKey || NO_PROJECT_VALUE}
            onValueChange={(value) => setPickedKey(value === NO_PROJECT_VALUE ? "" : value)}
          >
            <SelectTrigger
              data-testid="quick-prompts-settings-project"
              aria-label={intl.formatMessage({ id: "quickPrompts.settings.project" })}
              className="w-full"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_PROJECT_VALUE}>
                {intl.formatMessage({ id: "quickPrompts.settings.noProject" })}
              </SelectItem>
              {options.map((option) => (
                <SelectItem key={option.key} value={option.key}>
                  {option.name ?? intl.formatMessage({ id: "quickPrompts.settings.unavailable" })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {readOnly ? (
        <p className="text-ui-caption text-foreground-subtle">
          {intl.formatMessage({ id: "quickPrompts.settings.readOnly" })}
        </p>
      ) : null}
      {!service || readError ? (
        <p role="alert" className="text-ui-base text-destructive">
          {loadErrorMessage}
        </p>
      ) : null}
      {service && !readError && !snapshot ? (
        <p role="status" className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "quickPrompts.settings.loading" })}
        </p>
      ) : null}

      {snapshot && selectedProject ? (
        <QuickPromptSettingsList
          scope="project"
          title={intl.formatMessage(
            { id: "quickPrompts.settings.projectList" },
            {
              project:
                selectedName ?? intl.formatMessage({ id: "quickPrompts.settings.unavailable" }),
            },
          )}
          hint={
            selectedAvailable
              ? undefined
              : intl.formatMessage({ id: "quickPrompts.settings.unavailableHint" })
          }
          emptyMessage={intl.formatMessage({ id: "quickPrompts.settings.emptyProject" })}
          items={listItems(projectListKey, snapshot.projectPrompts)}
          shownInProject={null}
          readOnly={readOnly}
          createDisabled={!service || !selectedAvailable || projectLimitReached}
          createBlockedMessage={
            readOnly
              ? null
              : !selectedAvailable
                ? unavailableMessage
                : projectLimitReached
                  ? limitMessage
                  : null
          }
          duplicateDisabled={!selectedAvailable || projectLimitReached}
          onCreate={() => setEditorTarget({ mode: "create", scope: "project" })}
          onEdit={handleEdit}
          onSetPinned={(prompt, pinned) => void actions.setPinned(prompt, pinned)}
          onSetHidden={() => undefined}
          onDuplicate={(prompt) => void actions.duplicate(prompt)}
          onDelete={(prompt) => void actions.remove(prompt)}
          onReorder={(ids) => reorder(projectListKey, "project", selectedProject, ids)}
        />
      ) : null}

      {snapshot ? (
        <QuickPromptSettingsList
          scope="global"
          title={intl.formatMessage({ id: "quickPrompts.settings.globalList" })}
          hint={intl.formatMessage({ id: "quickPrompts.settings.globalListHint" })}
          emptyMessage={intl.formatMessage({ id: "quickPrompts.settings.emptyGlobal" })}
          items={listItems(globalListKey, snapshot.globals)}
          shownInProject={
            selectedProject
              ? {
                  ref: selectedProject,
                  name:
                    selectedName ?? intl.formatMessage({ id: "quickPrompts.settings.unavailable" }),
                }
              : null
          }
          readOnly={readOnly}
          createDisabled={!service || globalLimitReached}
          createBlockedMessage={readOnly ? null : globalLimitReached ? limitMessage : null}
          duplicateDisabled={globalLimitReached}
          onCreate={() => setEditorTarget({ mode: "create", scope: "global" })}
          onEdit={handleEdit}
          onSetPinned={(prompt, pinned) => void actions.setPinned(prompt, pinned)}
          onSetHidden={(prompt, hidden) => {
            if (selectedProject) void actions.setHidden(prompt, selectedProject, hidden);
          }}
          onDuplicate={(prompt) => void actions.duplicate(prompt)}
          onDelete={(prompt) => void actions.remove(prompt)}
          onReorder={(ids) => reorder(globalListKey, "global", null, ids)}
        />
      ) : null}

      {editorTarget && snapshot && service ? (
        <QuickPromptEditorDialog
          target={editorTarget}
          onClose={() => setEditorTarget(null)}
          project={selectedProject}
          projectName={selectedName ?? undefined}
          snapshot={snapshot}
          service={service}
          refresh={refresh}
          workspacePath={editorWorkspace.workspacePath}
          workspaceIdentity={editorWorkspace.workspaceIdentity}
          mentionPanelEnabled={editorMentionPanelEnabled}
        />
      ) : null}
    </div>
  );
}
