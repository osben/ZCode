/* eslint-disable max-lines -- The settings-sync flow aggregates discovery, selection, and import state machines; keeping it together aids troubleshooting. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  SettingsSyncCategory,
  SettingsSyncDiscoveryResult,
  SettingsSyncImportResult,
  SettingsSyncSelection,
} from "@zcode/shared";
import { logger } from "@/logger.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeSessionService } from "@/hooks/useZCodeSessionService.js";
import { invalidateDeferredDraftSessionForSkillChange } from "@/lib/zcodeDraftSkillInvalidation.js";
import type { SettingsSyncUiState, SettingsSyncUiTask } from "@/settings-sync/types.js";

const IMPORTING_TASK_DELAY_MS = 320;
const FORCE_SHOW_ONBOARDING_ON_EVERY_REFRESH = false;

/** First-start detection and manual reopening from Settings handle an empty discovery differently. */
type LoadDiscoveryIntent = "firstRun" | "manual";

function createInitialState(): SettingsSyncUiState {
  return {
    open: false,
    loading: false,
    importing: false,
    step: "selection",
    discovery: null,
    selectedKeys: [],
    tasks: [],
    result: null,
    error: null,
  };
}

function getSelectionKey(agent: string, category: string): string {
  return `${agent}:${category}`;
}

/**
 * First-start onboarding for provider settings: model providers only; do not show or migrate skills and plugins.
 */
function visibleCategoriesForOnboarding(): SettingsSyncCategory[] {
  return ["providers"];
}

function normalizeDiscovery(discovery: SettingsSyncDiscoveryResult): SettingsSyncDiscoveryResult {
  return {
    agents: discovery.agents.map((agent) => {
      const categoryMap = new Map(
        agent.categories.map((category) => [category.category, category]),
      );
      const categories = visibleCategoriesForOnboarding().map((category) => {
        const existing = categoryMap.get(category);
        if (existing) {
          return existing;
        }
        return {
          category,
          discoveredCount: 0,
          importableCount: 0,
          selectedByDefault: false,
        };
      });
      return {
        ...agent,
        categories,
      };
    }),
  };
}

function buildDefaultSelectedKeys(discovery: SettingsSyncDiscoveryResult): string[] {
  return discovery.agents.flatMap((agent) =>
    agent.categories
      .filter((category) => category.selectedByDefault && category.discoveredCount > 0)
      .map((category) => getSelectionKey(agent.agent, category.category)),
  );
}

function buildTasks(
  discovery: SettingsSyncDiscoveryResult,
  selectedKeys: string[],
): SettingsSyncUiTask[] {
  const selected = new Set(selectedKeys);
  return discovery.agents.flatMap((agent) =>
    agent.categories
      .filter((category) => selected.has(getSelectionKey(agent.agent, category.category)))
      .map((category) => ({
        id: getSelectionKey(agent.agent, category.category),
        agent: agent.agent,
        category: category.category,
        discoveredCount: category.discoveredCount,
        status: "pending" as const,
      })),
  );
}

function buildStateSelections(selectedKeys: string[]): SettingsSyncSelection[] {
  return selectedKeys.map((key) => {
    const [agent, category] = key.split(":");
    return {
      agent: agent as SettingsSyncSelection["agent"],
      category: category as SettingsSyncSelection["category"],
    };
  });
}

function buildTasksFromSelections(selections: SettingsSyncSelection[]): SettingsSyncUiTask[] {
  return selections.map((selection, index) => ({
    id: `${selection.agent}:${selection.category}:${selection.sourceScope ?? "all"}:${selection.targetScope ?? "auto"}:${index}`,
    agent: selection.agent,
    category: selection.category,
    discoveredCount:
      selection.skillPaths?.length ??
      selection.commandPaths?.length ??
      selection.pluginPaths?.length ??
      selection.mcpServerPaths?.length ??
      1,
    status: "pending" as const,
  }));
}

function normalizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function applyTaskResults(
  tasks: SettingsSyncUiTask[],
  result: SettingsSyncImportResult,
): SettingsSyncUiTask[] {
  const taskResultQueues = new Map<string, SettingsSyncImportResult["taskResults"]>();
  for (const task of result.taskResults) {
    const key = `${task.agent}:${task.category}`;
    taskResultQueues.set(key, [...(taskResultQueues.get(key) ?? []), task]);
  }
  return tasks.map((task) => {
    const matched = taskResultQueues.get(`${task.agent}:${task.category}`)?.shift();
    return matched ? { ...task, status: matched.status } : { ...task, status: "skipped" };
  });
}

export function useSettingsSync(params: { workspacePath?: string; workspaceIdentity?: string }) {
  const { settingsSyncService } = useServices();
  const zcodeSessionService = useZCodeSessionService(
    params.workspacePath,
    undefined,
    params.workspaceIdentity,
  );
  const runningImportRef = useRef(0);
  const [state, setState] = useState<SettingsSyncUiState>(createInitialState);

  const loadDiscovery = useCallback(
    async (intent: LoadDiscoveryIntent = "firstRun") => {
      if (!params.workspacePath) {
        return;
      }

      setState((current) => ({
        ...current,
        loading: true,
        error: null,
      }));

      try {
        const rawDiscovery = await settingsSyncService.detect({
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
        });
        const discovery = normalizeDiscovery(rawDiscovery);
        if (discovery.agents.length === 0) {
          if (intent === "manual") {
            // Clicking "Guide" in Settings reopens onboarding and reruns detect. Reusing first-start behavior for an empty
            // result would reset open to false and make the dialog flash closed. For manual opens, keep the welcome page so
            // users can still access session migration and other flows.
            setState((current) => ({
              ...current,
              open: true,
              loading: false,
              step: "selection",
              discovery,
              selectedKeys: [],
              tasks: [],
              result: null,
              error: null,
            }));
            logger.info("[settings-sync] discovery empty, keep onboarding open (manual)", {
              workspacePath: params.workspacePath,
            });
            return;
          }
          // After third-party agent migration was removed, first-start detection returns an empty result.
          // Do not open an onboarding dialog with nothing to do; mark it handled directly.
          await settingsSyncService.markFirstRunPromptHandled();
          setState(createInitialState());
          logger.info("[settings-sync] discovery empty, prompt handled", {
            workspacePath: params.workspacePath,
          });
          return;
        }
        const selectedKeys = buildDefaultSelectedKeys(discovery);
        setState((current) => ({
          ...current,
          open: true,
          loading: false,
          step: "selection",
          discovery,
          selectedKeys,
          tasks: [],
          result: null,
          error: null,
        }));
        logger.info("[settings-sync] discovery loaded", {
          workspacePath: params.workspacePath,
          agentCount: discovery.agents.length,
          selectedCount: selectedKeys.length,
        });
      } catch (error) {
        const message = normalizeError(error);
        logger.error("[settings-sync] discovery failed", {
          workspacePath: params.workspacePath,
          error: message,
        });
        setState((current) => ({
          ...current,
          open: true,
          loading: false,
          error: message,
        }));
      }
    },
    [params.workspaceIdentity, params.workspacePath, settingsSyncService],
  );

  useEffect(() => {
    if (!params.workspacePath) {
      setState(createInitialState());
      return;
    }

    if (FORCE_SHOW_ONBOARDING_ON_EVERY_REFRESH) {
      void loadDiscovery();
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        // The onboarding dialog is a first-start prompt, not a regular refresh notice.
        // During debugging it appeared every time a workspace opened, repeatedly interrupting users who had skipped it.
        // Read handled state first and detect/show only if the prompt has not been consumed yet.
        const promptState = await settingsSyncService.getFirstRunPromptState();
        if (cancelled) {
          return;
        }

        if (promptState.handled) {
          setState(createInitialState());
          return;
        }

        await loadDiscovery();
      } catch (error) {
        const message = normalizeError(error);
        logger.error("[settings-sync] first run prompt state failed", {
          workspacePath: params.workspacePath,
          error: message,
        });
        if (cancelled) {
          return;
        }

        setState((current) => ({
          ...current,
          open: true,
          loading: false,
          error: message,
        }));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [loadDiscovery, params.workspacePath, settingsSyncService]);

  const selectedCount = state.selectedKeys.length;
  const taskProgress = useMemo(() => {
    if (state.tasks.length === 0) return 0;
    const completedCount = state.tasks.filter(
      (task) => task.status !== "pending" && task.status !== "running",
    ).length;
    return Math.round((completedCount / state.tasks.length) * 100);
  }, [state.tasks]);

  const close = useCallback(() => {
    runningImportRef.current += 1;
    setState((current) => ({ ...current, open: false, importing: false }));
    if (FORCE_SHOW_ONBOARDING_ON_EVERY_REFRESH) {
      return;
    }
    // Closing onboarding itself means the user handled this first-start prompt. Whether they started or skipped migration,
    // persist it immediately so it does not reappear on the next launch.
    void settingsSyncService.markFirstRunPromptHandled().catch((error) => {
      logger.error("[settings-sync] mark first run prompt handled failed", {
        workspacePath: params.workspacePath,
        error: normalizeError(error),
      });
    });
  }, [params.workspacePath, settingsSyncService]);

  const reopen = useCallback(() => {
    setState((current) => {
      if (!current.discovery && !current.loading && params.workspacePath) {
        // "Reopen onboarding" in Settings may happen after the first-start prompt was handled.
        // Local state has returned to its initial state; setting open=true alone would show an empty dialog with no discovery data.
        // Run detection when data is missing so opening from Settings still shows all migratable content.
        void loadDiscovery("manual");
      }
      return { ...current, open: true };
    });
  }, [loadDiscovery, params.workspacePath]);

  const toggleSelection = useCallback((key: string) => {
    setState((current) => {
      const set = new Set(current.selectedKeys);
      if (set.has(key)) {
        set.delete(key);
      } else {
        set.add(key);
      }
      return {
        ...current,
        selectedKeys: [...set],
      };
    });
  }, []);

  const setAgentSelection = useCallback((agent: string, checked: boolean) => {
    setState((current) => {
      if (!current.discovery) {
        return current;
      }
      const next = new Set(current.selectedKeys);
      const targetAgent = current.discovery.agents.find((item) => item.agent === agent);
      if (!targetAgent) {
        return current;
      }
      for (const category of targetAgent.categories) {
        const key = getSelectionKey(agent, category.category);
        if (checked) {
          next.add(key);
        } else {
          next.delete(key);
        }
      }
      return {
        ...current,
        selectedKeys: [...next],
      };
    });
  }, []);

  const setCategorySelectionAllAgents = useCallback(
    (category: SettingsSyncCategory, checked: boolean) => {
      setState((current) => {
        if (!current.discovery) {
          return current;
        }
        const next = new Set(current.selectedKeys);
        for (const agentSummary of current.discovery.agents) {
          if (!agentSummary.categories.some((c) => c.category === category)) {
            continue;
          }
          const key = getSelectionKey(agentSummary.agent, category);
          if (checked) {
            next.add(key);
          } else {
            next.delete(key);
          }
        }
        return {
          ...current,
          selectedKeys: [...next],
        };
      });
    },
    [],
  );

  const startImportWithAdditionalSelections = useCallback(
    async (
      additionalSelections: SettingsSyncSelection[] = [],
      options: { includeCurrentSelections?: boolean } = {},
    ) => {
      if (!params.workspacePath) {
        return;
      }

      const includeCurrentSelections = options.includeCurrentSelections ?? true;
      // The data migration wizard may temporarily hide provider settings; do not silently import the default-selected providers while hidden.
      const stateSelections =
        includeCurrentSelections && state.discovery ? buildStateSelections(state.selectedKeys) : [];
      const selections: SettingsSyncSelection[] = [...stateSelections, ...additionalSelections];
      if (selections.length === 0) {
        return;
      }
      const runId = runningImportRef.current + 1;
      runningImportRef.current = runId;
      const initialTasks =
        state.discovery && includeCurrentSelections
          ? [
              ...buildTasks(state.discovery, state.selectedKeys),
              ...buildTasksFromSelections(additionalSelections),
            ]
          : buildTasksFromSelections(selections);

      setState((current) => ({
        ...current,
        importing: true,
        step: "importing",
        tasks: initialTasks,
        result: null,
        error: null,
      }));

      logger.info("[settings-sync] import started", {
        workspacePath: params.workspacePath,
        selections,
      });

      const importPromise = settingsSyncService.importSelected({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        selections,
      });

      for (let index = 0; index < initialTasks.length; index += 1) {
        if (runningImportRef.current !== runId) {
          return;
        }
        const task = initialTasks[index];
        if (!task) {
          continue;
        }
        setState((current) => ({
          ...current,
          tasks: current.tasks.map((item) =>
            item.id === task.id ? { ...item, status: "running" } : item,
          ),
        }));
        await new Promise((resolve) => setTimeout(resolve, IMPORTING_TASK_DELAY_MS));
      }

      try {
        const result = await importPromise;
        if (runningImportRef.current !== runId) {
          return;
        }

        if (selections.some((selection) => selection.category === "skills")) {
          await invalidateDeferredDraftSessionForSkillChange({
            workspacePath: params.workspacePath,
            workspaceIdentity: params.workspaceIdentity,
            reason: "settings-sync-skill-import",
          });
        }

        setState((current) => ({
          ...current,
          importing: false,
          step: "complete",
          result,
          tasks: applyTaskResults(current.tasks, result),
        }));
        logger.info("[settings-sync] import completed", {
          workspacePath: params.workspacePath,
          result,
        });
      } catch (error) {
        const message = normalizeError(error);
        if (runningImportRef.current !== runId) {
          return;
        }
        logger.error("[settings-sync] import failed", {
          workspacePath: params.workspacePath,
          error: message,
        });
        setState((current) => ({
          ...current,
          importing: false,
          step: "complete",
          error: message,
          tasks: current.tasks.map((task) => ({ ...task, status: "failed" })),
          result: {
            successCount: 0,
            skippedCount: 0,
            failedCount: current.tasks.length,
            taskResults: current.tasks.map((task) => ({
              agent: task.agent,
              category: task.category,
              status: "failed" as const,
              importedCount: 0,
              skippedCount: 0,
              failedCount: 1,
            })),
          },
        }));
      }
    },
    [
      params.workspaceIdentity,
      params.workspacePath,
      settingsSyncService,
      zcodeSessionService,
      state.discovery,
      state.selectedKeys,
    ],
  );

  const startImport = useCallback(async () => {
    await startImportWithAdditionalSelections();
  }, [startImportWithAdditionalSelections]);

  const finish = useCallback(() => {
    close();
  }, [close]);

  return {
    state,
    selectedCount,
    taskProgress,
    actions: {
      close,
      reopen,
      reloadDiscovery: loadDiscovery,
      toggleSelection,
      setAgentSelection,
      setCategorySelectionAllAgents,
      startImport,
      startImportWithAdditionalSelections,
      finish,
    },
  };
}
