import { applyComposerPermissionGrant } from "@/v4/composer/composerPermissionGrant.js";
/* eslint-disable max-lines -- The Composer draft owner coordinates selection, body, and submission lifecycles, keeping one state boundary. */
// Composer mode/model selection and body text use the same scoped draft; Session provides only the one-time initialization seed.
// Menu clicks immediately save Renderer intent; Prewarm and Submission consume it and never overwrite it.
//
// Workspace presentation hydration provides mode and slash commands only; model candidates, capabilities, and preferred values
// all come from the target Host ModelSelectionView.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ZCODE_AGENT_PROVIDER, resolveExecutionState } from "@zcode/shared";
import { applyComposerPlanTransition } from "@/v4/composer/composerPlanTransition.js";
import type {
  ZCodeConfigOption,
  ModelSelection,
  ZCodeProvider,
  ZCodeSlashCommand,
} from "@zcode/shared";
import type { SessionConfigState } from "@zcode/shared/zcode-protocol-v4";
import type { IModelSelectionService } from "@zcode/services";
import { completeNewModelSelection } from "@zcode/provider";
import {
  useModelSelectionServiceView,
  type ModelSelectionRead,
} from "@/hooks/useModelSelectionView.js";
import { submissionModeSchema } from "@zcode/shared/zcode-protocol-v4";
import { prepareWorkspaceWithZCodeSessionService } from "@/hooks/useWorkspacePrepare.js";
import { useZCodeSessionService } from "@/hooks/useZCodeSessionService.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { parseModelPickerValue } from "@/lib/zcodeSessionProjection.js";
import { initializeNewTaskDraft } from "@/v4/composer/newTaskDraft.js";
import {
  clearV4ComposerDraft,
  persistV4ComposerDraft,
  readV4ComposerDraft,
  V4_DRAFT_SCOPE_ROOT,
  type V4ComposerDraft,
} from "@/v4/composer/composerDraftStore.js";
import { resolveAppFollowupMode } from "@/v4/composer/followupModeSettings.js";
import { logger } from "@/logger.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

/** Single-flight directory hydration per workspaceKey; drafts, existing sessions, and strict-mode double mounts share one RPC. */
const workspaceCatalogHydrationFlights = new Map<string, Promise<void>>();

function applyDraftModelSelection(
  current: Partial<SessionConfigState>,
  model: ModelSelection,
): Partial<SessionConfigState> {
  const next = {
    ...current,
    modelSelection: {
      providerId: model.providerId,
      modelId: model.modelId,
      ...(model.options ? { options: { ...model.options } } : {}),
    },
    provider: model.providerId,
    model: model.modelId,
  };
  // thought is a model-specific setting. After switching models, keeping the source thought would make the pre-send config barrier
  // treat it as an explicit thought change on the target model and write it again; clear it first.
  delete next.thought;
  return next;
}

function shouldHydrateWorkspaceCatalog(params: {
  configOptions: readonly ZCodeConfigOption[];
  sessionId: string | null;
  slashCommands: readonly ZCodeSlashCommand[];
}): boolean {
  const hasModePresentation = params.configOptions.some(
    (option) => option.category === "mode" && option.type === "select",
  );
  // slashCommands belong to workspace identity and are not restored from an existing session projection.
  // Therefore an existing session must hydrate them independently when its directory is empty; mode hydration no longer comes indirectly from the model directory.
  return params.slashCommands.length === 0 || !hasModePresentation;
}

interface DraftConfigControl {
  modelSelectionRead: ModelSelectionRead;
  /** Configuration for the Renderer’s next submission; Session provides a seed only when a scope is initialized for the first time. */
  draftConfig: Partial<SessionConfigState>;
  /** Config selected in the draft (partial); included in createSession through buildDraftCreateConfigPayload. */
  draftConfigRef: React.RefObject<Partial<SessionConfigState>>;
  /** Initialization config frozen for the current draft lifecycle; used only when creating/prewarming the session. */
  resolveInitialDraftConfig: () => Partial<SessionConfigState> | undefined;
  composerDraft: V4ComposerDraft;
  updateComposerContent: (
    content: Pick<V4ComposerDraft, "text" | "editorStateJson" | "mention">,
  ) => void;
  replaceComposerDraft: (draft: Omit<V4ComposerDraft, "updatedAt">) => void;
  /** Atomically transfer the complete Root Draft to the real Session scope after a new task is accepted. */
  promoteComposerDraft: (createdSessionId: string) => void;
  /** Capture the original intent before submission; call the returned function only after authoritative acceptance. */
  captureAcceptedModelSelection: (
    selection: ModelSelection,
    expectedSelection?: ModelSelection,
  ) => () => void;
  handleDraftSelectModel: (modelProvider: string, model: string) => void;
  handleDraftSelectThought: (thought: string) => void;
  handleDraftSwitchMode: (mode: string) => void;
}

export function useDraftConfigControl(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  provider?: ZCodeProvider;
  /** Read the corresponding scope when switching sessions; preserve an existing empty selection too. */
  sessionId: string | null;
  /** Only the first projection for the current Session can initialize state; null means recovery is not complete yet. */
  sessionConfig?: Partial<SessionConfigState> | null;
  /** Start the Agent only after the provider registry passes the renderer readiness gate. */
  agentStartupAllowed?: boolean;
  modelSelectionService: IModelSelectionService | null;
}): DraftConfigControl {
  const {
    workspacePath,
    workspaceIdentity,
    provider,
    sessionId,
    sessionConfig,
    agentStartupAllowed = true,
    modelSelectionService,
  } = params;
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const displayProvider = provider ?? ZCODE_AGENT_PROVIDER;
  const zcodeSessionService = useZCodeSessionService(workspacePath, null, workspaceIdentity);
  const { settings: sharedSettings } = useSettings();
  const appFollowupMode = resolveAppFollowupMode(sharedSettings);
  const scopeId = sessionId ?? V4_DRAFT_SCOPE_ROOT;
  const scopeKey = JSON.stringify([workspaceKey, scopeId]);
  const loadedScope = useMemo(
    () => ({
      scopeKey,
      draft: readV4ComposerDraft(workspacePath, workspaceIdentity, scopeId) ?? {
        text: "",
        updatedAt: 0,
      },
    }),
    [scopeKey],
  );
  const [storedState, setStoredState] = useState(loadedScope);
  let currentState = storedState.scopeKey === scopeKey ? storedState : loadedScope;
  let draft = currentState.draft;
  const modelSelectionRead = useModelSelectionServiceView(
    modelSelectionService,
    true,
    "remote-waiting",
    {
      selection: draft.modelSelection ?? null,
    },
  );
  const modelSelectionView =
    modelSelectionRead.state.status === "ready" ? modelSelectionRead.state.view : null;
  const initializeAsNewTask = sessionId === null || draft.initializeFromNewTask === true;
  if (!draft.mode && (initializeAsNewTask ? modelSelectionView !== null : sessionConfig != null)) {
    const mode = submissionModeSchema.safeParse(sessionConfig?.mode);
    // Recent is the initial intent; do not discard it early based on whether the old provider remains a candidate. On the next input,
    // the same resolver will map it to the current account or leave it empty; otherwise cold startup bypasses shared account resolution.
    // mode is an initialization marker: an empty selection from history is still definitive, so later snapshots must not fill it in.
    draft =
      initializeAsNewTask && modelSelectionView
        ? initializeNewTaskDraft(draft, workspacePath, workspaceIdentity, modelSelectionView)
        : {
            ...draft,
            mode: mode.success && mode.data !== "plan" ? mode.data : "build",
            planEnabled: resolveExecutionState(sessionConfig ?? {}).planEnabled,
            modelSelection: sessionConfig?.modelSelection,
          };
  }
  if (sessionConfig) {
    draft = applyComposerPlanTransition(draft, sessionConfig.planTransition);
    draft = applyComposerPermissionGrant(draft, sessionConfig.permissionGrant);
  }
  if (draft !== currentState.draft) currentState = { ...currentState, draft };
  if (currentState !== storedState) setStoredState(currentState);
  const stateRef = useRef(currentState);
  stateRef.current = currentState;
  // Reason: clearing a draft by revision could turn temporary unavailability into a permanently empty selection. Derive only the current result here;
  // body/mode autosave continues to preserve draft intent. If reads are not ready, keep displaying the draft; the View gate blocks submission.
  const effectiveSelection = modelSelectionView
    ? (modelSelectionView.effectiveSelection ?? undefined)
    : draft.modelSelection;
  const draftConfig = useMemo<Partial<SessionConfigState>>(
    () => ({
      mode: draft.mode,
      planEnabled: draft.planEnabled ?? false,
      modelSelection: effectiveSelection,
      provider: effectiveSelection?.providerId ?? "",
      model: effectiveSelection?.modelId ?? "",
      thought: effectiveSelection?.options?.reasoningLevel ?? "",
    }),
    [draft.mode, draft.planEnabled, effectiveSelection],
  );
  const draftConfigRef = useRef(draftConfig);
  draftConfigRef.current = draftConfig;
  const lastPersistedDraftRef = useRef<V4ComposerDraft | null>(null);
  useEffect(() => {
    if (
      (draft.mode || draft.initializeFromNewTask) &&
      draft !== lastPersistedDraftRef.current &&
      stateRef.current.draft === draft &&
      stateRef.current.scopeKey === scopeKey
    ) {
      persistV4ComposerDraft(workspacePath, workspaceIdentity, scopeId, draft);
      lastPersistedDraftRef.current = draft;
    }
  }, [draft, scopeKey]);
  const updateComposerDraft = useCallback(
    (update: (current: V4ComposerDraft) => V4ComposerDraft) => {
      // A delayed editor callback from an old scope must not write into the session selected after switching.
      if (stateRef.current.scopeKey !== scopeKey) return;
      const previous = stateRef.current.draft;
      const next = update(previous);
      const nextState = { ...stateRef.current, draft: next };
      stateRef.current = nextState;
      const selection =
        next.modelSelection === previous.modelSelection
          ? draftConfigRef.current.modelSelection
          : next.modelSelection;
      draftConfigRef.current = {
        mode: next.mode,
        planEnabled: next.planEnabled ?? false,
        modelSelection: selection,
        provider: selection?.providerId ?? "",
        model: selection?.modelId ?? "",
        thought: selection?.options?.reasoningLevel ?? "",
      };
      setStoredState(nextState);
      persistV4ComposerDraft(workspacePath, workspaceIdentity, scopeId, next);
      lastPersistedDraftRef.current = next;
    },
    [scopeKey, workspacePath, workspaceIdentity, scopeId],
  );
  const updateDraftConfig = useCallback(
    (update: (current: Partial<SessionConfigState>) => Partial<SessionConfigState>) => {
      const next = update(draftConfigRef.current);
      const mode = submissionModeSchema.safeParse(next.mode);
      updateComposerDraft((current) => ({
        ...current,
        mode: mode.success ? mode.data : current.mode,
        modelSelection: next.modelSelection,
        // The user explicitly chose a new value; do not let the default initializer waiting during import overwrite it.
        ...(current.initializeFromNewTask
          ? { mode: mode.success ? mode.data : "build", initializeFromNewTask: undefined }
          : {}),
      }));
    },
    [updateComposerDraft],
  );
  const captureAcceptedModelSelection = useCallback(
    (selection: ModelSelection, expectedSelection: ModelSelection = selection): (() => void) => {
      const original = stateRef.current.draft.modelSelection;
      const effective = draftConfigRef.current.modelSelection;
      // Object-key order does not define selection identity; rebuilding an equivalent protocol value must not discard an accepted writeback.
      if (
        effective?.providerId !== expectedSelection.providerId ||
        effective.modelId !== expectedSelection.modelId ||
        effective.options?.reasoningLevel !== expectedSelection.options?.reasoningLevel
      )
        return () => {};
      return () => {
        // Lock auto-matching only after this submission is accepted; an old ACK must not overwrite new intent or a new scope.
        if (
          stateRef.current.scopeKey !== scopeKey ||
          stateRef.current.draft.modelSelection !== original
        )
          return;
        updateComposerDraft((current) => ({ ...current, modelSelection: selection }));
      };
    },
    [scopeKey, updateComposerDraft],
  );
  const resolveInitialDraftConfig = useCallback((): Partial<SessionConfigState> | undefined => {
    if (!draftConfigRef.current.mode) return undefined;
    const config = { ...draftConfigRef.current };
    if (appFollowupMode) {
      config.followupMode = appFollowupMode;
    }
    return config;
  }, [appFollowupMode]);

  const updateComposerContent = useCallback(
    (content: Pick<V4ComposerDraft, "text" | "editorStateJson" | "mention">) => {
      updateComposerDraft((current) => ({
        ...current,
        editorStateJson: undefined,
        mention: undefined,
        ...content,
      }));
    },
    [updateComposerDraft],
  );
  const replaceComposerDraft = useCallback(
    (replacement: Omit<V4ComposerDraft, "updatedAt">) => {
      // Reverting an edit restores the body/config but must not forget authorization already consumed, or an old snapshot could overwrite the new selection again.
      updateComposerDraft((current) => ({
        ...replacement,
        lastPermissionGrantId: current.lastPermissionGrantId,
        updatedAt: Date.now(),
      }));
    },
    [updateComposerDraft],
  );

  const promoteComposerDraft = useCallback(
    (createdSessionId: string) => {
      if (stateRef.current.scopeKey !== scopeKey || scopeId !== V4_DRAFT_SCOPE_ROOT) return;
      const targetSessionId = createdSessionId.trim();
      if (!targetSessionId) return;
      // The first successful send used to delete the Root scope directly, so the real Session had no Composer Draft
      // and reinitialized from its Snapshot on remount. Write the target first, then delete the source, preserving body/mode/selection.
      const written = persistV4ComposerDraft(
        workspacePath,
        workspaceIdentity,
        targetSessionId,
        stateRef.current.draft,
      );
      if (!written) return;
      clearV4ComposerDraft(workspacePath, workspaceIdentity, V4_DRAFT_SCOPE_ROOT);
    },
    [scopeId, scopeKey, workspaceIdentity, workspacePath],
  );

  // ── Workspace directory hydration (see file header) ──
  // Skip when the directory is already ready (reload/broadcast/previous hydration wrote it); otherwise read the minimal workspace presentation.
  useEffect(() => {
    const isDraft = sessionId === null;
    const store = useZCodeSessionStore.getState();
    const workspaceState = store.getWorkspaceState(workspacePath, workspaceIdentity);
    if (!agentStartupAllowed) {
      // V4 directory hydration used to call RPC with no model. Although the Host would not start the CLI,
      // the renderer still recorded the normal waiting state as a hydration error. Stay idle until readiness passes;
      // changes after the registry is ready will automatically rerun this effect.
      store.setConfigOptionsStatus(workspacePath, "idle", workspaceIdentity);
      return;
    }
    const configOptions = workspaceState.configOptions ?? [];
    const hasModePresentation = configOptions.some(
      (option) => option.category === "mode" && option.type === "select",
    );
    const hasSlashCommandCatalog = workspaceState.slashCommands.length > 0;
    const shouldHydrateCatalog = shouldHydrateWorkspaceCatalog({
      configOptions,
      sessionId,
      slashCommands: workspaceState.slashCommands,
    });
    logger.debug("[v4-workspace-catalog] hydration check", {
      catalogScope: isDraft ? "draft" : "known-session",
      hasModePresentation,
      hasSlashCommandCatalog,
      flightInProgress: workspaceCatalogHydrationFlights.has(workspaceKey),
      configOptionsStatus: workspaceState.configOptionsStatus,
      workspaceKey,
    });
    const existingFlight = workspaceCatalogHydrationFlights.get(workspaceKey);
    if (existingFlight) {
      return;
    }
    if (!shouldHydrateCatalog) {
      return;
    }

    store.setConfigOptionsStatus(workspacePath, "loading", workspaceIdentity);
    const flight = prepareWorkspaceWithZCodeSessionService({
      workspacePath,
      workspaceIdentity,
      provider: displayProvider,
      zcodeSessionService,
    })
      .then((prepareResult) => {
        const baseOptions = prepareResult.configOptions ?? [];
        logger.debug("[v4-workspace-catalog] hydration done", {
          catalogScope: isDraft ? "draft" : "known-session",
          optionCount: baseOptions.length,
          slashCommandCount: prepareResult.slashCommands?.length ?? 0,
          modeCurrentValue: String(
            baseOptions.find((option) => option.category === "mode" && option.type === "select")
              ?.currentValue ?? "",
          ),
          workspaceKey,
        });
        const latest = useZCodeSessionStore.getState();
        latest.setConfigOptions(workspacePath, baseOptions, workspaceIdentity);
        latest.setConfigOptionsStatus(workspacePath, "ready", workspaceIdentity);
        latest.setSlashCommands(
          workspacePath,
          prepareResult.slashCommands ?? [],
          workspaceIdentity,
        );
      })
      .catch((error) => {
        useZCodeSessionStore
          .getState()
          .setConfigOptionsStatus(workspacePath, "error", workspaceIdentity);
        logger.warn(`[v4-workspace-catalog] workspace 目录水合失败: ${String(error)}`);
      })
      .finally(() => {
        workspaceCatalogHydrationFlights.delete(workspaceKey);
      });
    workspaceCatalogHydrationFlights.set(workspaceKey, flight);
  }, [
    agentStartupAllowed,
    displayProvider,
    sessionId,
    workspaceIdentity,
    workspaceKey,
    workspacePath,
    zcodeSessionService,
  ]);

  const handleDraftSelectModel = useCallback(
    (modelProvider: string, model: string) => {
      const modelId = modelProvider ? `${modelProvider}/${model}` : model;
      const parsedSelection = parseModelPickerValue(modelId);
      // Clicking a model determines only its identity; Reasoning has no default, so leave it empty until the user chooses.
      const modelSelection = modelSelectionView
        ? (completeNewModelSelection(modelSelectionView, parsedSelection) ?? parsedSelection)
        : parsedSelection;
      logger.debug("[v4-draft-config] select model", {
        modelProvider,
        model,
        modelId,
        modelSelectionProviderId: modelSelection.providerId,
        modelSelectionModelId: modelSelection.modelId,
        workspacePath,
        workspaceIdentity: workspaceIdentity ?? null,
      });
      updateDraftConfig((current) => applyDraftModelSelection(current, modelSelection));
    },
    [modelSelectionView, updateDraftConfig, workspaceIdentity, workspacePath],
  );

  const handleDraftSelectThought = useCallback(
    (thought: string) => {
      updateDraftConfig((current) => {
        const providerId = current.modelSelection?.providerId ?? current.provider?.trim();
        const modelId = current.modelSelection?.modelId ?? current.model?.trim();
        if (!providerId || !modelId) return { ...current, thought };
        const reasoningLevel = thought.trim();
        return {
          ...current,
          modelSelection: {
            providerId,
            modelId,
            ...(reasoningLevel
              ? {
                  options: {
                    ...current.modelSelection?.options,
                    reasoningLevel,
                  },
                }
              : {}),
          },
          thought,
        };
      });
    },
    [updateDraftConfig],
  );

  const handleDraftSwitchMode = useCallback(
    (mode: string) => {
      if (mode === "plan" || mode === "plan-off") {
        updateComposerDraft((current) => ({
          ...current,
          mode: current.mode === "plan" ? "build" : (current.mode ?? "build"),
          planEnabled: mode === "plan",
          initializeFromNewTask: undefined,
        }));
        return;
      }
      // Mode and model belong to the current scope; do not write a global preference that another task could overwrite.
      const parsed = submissionModeSchema.safeParse(mode);
      if (parsed.success)
        updateComposerDraft((current) => ({
          ...current,
          mode: parsed.data,
          initializeFromNewTask: undefined,
        }));
    },
    [updateComposerDraft],
  );

  return {
    modelSelectionRead,
    draftConfig,
    draftConfigRef,
    resolveInitialDraftConfig,
    composerDraft: draft,
    updateComposerContent,
    replaceComposerDraft,
    promoteComposerDraft,
    captureAcceptedModelSelection,
    handleDraftSelectModel,
    handleDraftSelectThought,
    handleDraftSwitchMode,
  };
}

/** Draft config fragment for the createSession payload (returns an empty object with no config key when nothing is selected). */
export function buildDraftCreateConfigPayload(
  draftConfig: Partial<SessionConfigState>,
  appFollowupMode?: SessionConfigState["followupMode"] | null,
): { config?: Partial<SessionConfigState> } {
  const config: Partial<SessionConfigState> = { ...draftConfig };
  if (appFollowupMode) {
    config.followupMode = appFollowupMode;
  }
  return Object.keys(config).length > 0 ? { config } : {};
}
