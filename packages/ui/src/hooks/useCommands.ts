import { useCallback, useEffect, useMemo } from "react";
import type { ICommandsService } from "@zcode/services";
import { useCommandsStore } from "@/store/commandsStore.js";
import type {
  CommandAgentSource,
  CommandConfig,
  CommandCreateParams,
  CommandDeleteParams,
  CommandSetEnabledParams,
  CommandUpdateParams,
} from "@zcode/shared";

interface UseCommandsOptions {
  // The service was implicitly taken from useServices(), while the caller supplied workspacePath for a Scope target,
  // so B's path could be sent to A's remote host. Make it required and have the caller resolve/inject it for the target.
  commandsService: ICommandsService;
  workspacePath?: string;
  workspaceIdentity?: string;
  enabled?: boolean;
}

export function useCommands(options: UseCommandsOptions) {
  const { commandsService, workspacePath, workspaceIdentity, enabled = true } = options;

  const commands = useCommandsStore((state) => state.commands);
  const userCommands = useCommandsStore((state) => state.userCommands);
  const pluginCommands = useCommandsStore((state) => state.pluginCommands);
  const capability = useCommandsStore((state) => state.capability);
  const loading = useCommandsStore((state) => state.loading);
  const error = useCommandsStore((state) => state.error);
  const operatingCommandId = useCommandsStore((state) => state.operatingCommandId);
  const loadedWorkspacePath = useCommandsStore((state) => state.loadedWorkspacePath);
  const loadedWorkspaceIdentity = useCommandsStore((state) => state.loadedWorkspaceIdentity);
  // commandsStore is a singleton, and Scope can switch targets on the same page. Until its projection matches the current
  // target, do not render commands from the previous host: their filePath belongs to another machine, and delete/toggle
  // would execute against the current target's host using that stale path.
  const projectionMatchesTarget =
    (loadedWorkspaceIdentity?.trim() || loadedWorkspacePath || "") ===
    (workspaceIdentity?.trim() || workspacePath || "");
  const initialize = useCommandsStore((state) => state.initialize);
  const refreshStore = useCommandsStore((state) => state.refresh);
  const createStore = useCommandsStore((state) => state.createCommand);
  const updateStore = useCommandsStore((state) => state.updateCommand);
  const deleteStore = useCommandsStore((state) => state.deleteCommand);
  const toggleStore = useCommandsStore((state) => state.toggleCommand);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    void initialize(workspacePath, commandsService, workspaceIdentity);
  }, [enabled, workspacePath, workspaceIdentity, commandsService, initialize]);

  const refresh = useCallback(() => refreshStore(commandsService), [commandsService, refreshStore]);

  const createCommand = useCallback(
    (
      config: CommandConfig,
      agentSource?: CommandAgentSource,
      params?: Omit<CommandCreateParams, "config" | "agentSource">,
    ) => createStore({ agentSource, config, ...params }, commandsService),
    [commandsService, createStore],
  );

  const updateCommand = useCallback(
    (params: CommandUpdateParams) => updateStore(params, commandsService),
    [commandsService, updateStore],
  );

  const deleteCommand = useCallback(
    (params: CommandDeleteParams) => deleteStore(params, commandsService),
    [commandsService, deleteStore],
  );

  const toggleCommand = useCallback(
    (params: CommandSetEnabledParams) => toggleStore(params, commandsService),
    [commandsService, toggleStore],
  );

  return useMemo(
    () => ({
      commands,
      userCommands,
      pluginCommands,
      capability,
      loading,
      error,
      operatingCommandId,
      projectionMatchesTarget,
      refresh,
      createCommand,
      updateCommand,
      deleteCommand,
      toggleCommand,
    }),
    [
      commands,
      userCommands,
      pluginCommands,
      capability,
      loading,
      error,
      operatingCommandId,
      projectionMatchesTarget,
      refresh,
      createCommand,
      updateCommand,
      deleteCommand,
      toggleCommand,
    ],
  );
}
