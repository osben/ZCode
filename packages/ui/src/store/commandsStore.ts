import { create } from "zustand";
import type {
  CommandCreateParams,
  CommandDeleteParams,
  CommandSetEnabledParams,
  CommandUpdateParams,
  UserCommand,
  ZCodeCommand,
} from "@zcode/shared";
import type { ICommandsService } from "@zcode/services";

interface CommandsStoreState {
  workspacePath: string | null;
  workspaceIdentity: string | null;
  /** cacheAuthorityKey of a remote "User" (`source-settings:<id>`); null for project and local machine. */
  authorityKey: string | null;
  loadedWorkspacePath: string | null;
  loadedWorkspaceIdentity: string | null;
  loadedAuthorityKey: string | null;
  commands: ZCodeCommand[];
  userCommands: UserCommand[];
  pluginCommands: ZCodeCommand[];
  capability: { userScopeAvailable: boolean };
  loading: boolean;
  error: string | null;
  operatingCommandId: string | null;
  initialize: (
    workspacePath: string | undefined,
    commandsService: ICommandsService,
    workspaceIdentity?: string,
    authorityKey?: string,
  ) => Promise<void>;
  refresh: (commandsService: ICommandsService) => Promise<void>;
  createCommand: (
    params: CommandCreateParams,
    commandsService: ICommandsService,
  ) => Promise<UserCommand | null>;
  updateCommand: (
    params: CommandUpdateParams,
    commandsService: ICommandsService,
  ) => Promise<UserCommand | null>;
  deleteCommand: (
    params: CommandDeleteParams,
    commandsService: ICommandsService,
  ) => Promise<boolean>;
  toggleCommand: (
    params: CommandSetEnabledParams,
    commandsService: ICommandsService,
  ) => Promise<void>;
}

const inflightLists = new Map<string, Promise<void>>();

type StoreGet = () => CommandsStoreState;

// Bug cause: the request key only looked at identity / path. Two remote "Users" with the same home have no identity
// and identical paths, so B reused A's inflight request, A's late result passed B's checks, B displayed A's commands,
// and toggles were submitted to A's commands through B's service.
// Fix: authority joined the request key, the late-result check, and the loaded projection; the whole Scope target group is compared.
function listKey(
  workspacePath: string | undefined,
  workspaceIdentity?: string,
  authorityKey?: string | null,
): string {
  return `${authorityKey?.trim() || "workspace"}\0${workspaceIdentity?.trim() || workspacePath || "__no_workspace__"}`;
}

// The store is a singleton, and the Scope menu can switch targets on the same page. Before writing any async result, compare it with
// the target key from when the request started; otherwise, a slow target's list can overwrite the current projection, and delete/toggle will use an old host
// to execute filePath on the current target's host.
function currentListKey(get: StoreGet): string {
  const { workspacePath, workspaceIdentity, authorityKey } = get();
  return listKey(workspacePath ?? undefined, workspaceIdentity ?? undefined, authorityKey);
}

export const useCommandsStore = create<CommandsStoreState>((set, get) => ({
  workspacePath: null,
  workspaceIdentity: null,
  authorityKey: null,
  loadedWorkspacePath: null,
  loadedWorkspaceIdentity: null,
  loadedAuthorityKey: null,
  commands: [],
  userCommands: [],
  pluginCommands: [],
  capability: { userScopeAvailable: true },
  loading: false,
  error: null,
  operatingCommandId: null,

  initialize: async (workspacePath, commandsService, workspaceIdentity, authorityKey) => {
    const normalizedWorkspaceIdentity = workspaceIdentity?.trim() || null;
    const normalizedAuthorityKey = authorityKey?.trim() || null;
    set({
      workspacePath: workspacePath ?? null,
      workspaceIdentity: normalizedWorkspaceIdentity,
      authorityKey: normalizedAuthorityKey,
    });
    const key = listKey(
      workspacePath,
      normalizedWorkspaceIdentity ?? undefined,
      normalizedAuthorityKey,
    );
    const existing = inflightLists.get(key);
    if (existing) {
      await existing;
      return;
    }
    const promise = (async () => {
      set({ loading: true, error: null });
      try {
        const result = await commandsService.list({
          workspacePath,
          ...(normalizedWorkspaceIdentity
            ? { workspaceIdentity: normalizedWorkspaceIdentity }
            : {}),
        });
        if (currentListKey(get) !== key) return;
        set({
          commands: result.commands,
          userCommands: result.userCommands,
          pluginCommands: result.pluginCommands,
          capability: result.capability,
          loadedWorkspacePath: workspacePath ?? null,
          loadedWorkspaceIdentity: normalizedWorkspaceIdentity,
          loadedAuthorityKey: normalizedAuthorityKey,
          loading: false,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (currentListKey(get) !== key) return;
        set({ loading: false, error: message });
      } finally {
        inflightLists.delete(key);
      }
    })();
    inflightLists.set(key, promise);
    await promise;
  },

  refresh: async (commandsService) => {
    const { workspacePath, workspaceIdentity, authorityKey } = get();
    const key = currentListKey(get);
    set({ loading: true, error: null });
    try {
      const result = await commandsService.list({
        workspacePath: workspacePath ?? undefined,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      });
      if (currentListKey(get) !== key) return;
      set({
        commands: result.commands,
        userCommands: result.userCommands,
        pluginCommands: result.pluginCommands,
        capability: result.capability,
        loadedWorkspacePath: workspacePath,
        loadedWorkspaceIdentity: workspaceIdentity,
        loadedAuthorityKey: authorityKey,
        loading: false,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (currentListKey(get) !== key) return;
      set({ loading: false, error: message });
    }
  },

  createCommand: async (params, commandsService) => {
    const key = currentListKey(get);
    set({ error: null });
    try {
      const { command } = await commandsService.writeCommandFile(params);
      // The write completed on the target host captured at request time, but if Scope changed in the meantime,
      // do not merge the result into the current target's projection, or its list will contain commands from another host.
      if (currentListKey(get) !== key) return command;
      const { commands, userCommands } = get();
      set({
        commands: [...commands, command],
        userCommands: [...userCommands, command],
      });
      return command;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (currentListKey(get) !== key) throw err;
      set({ error: message });
      throw err;
    }
  },

  updateCommand: async (params, commandsService) => {
    const key = currentListKey(get);
    set({ operatingCommandId: params.commandId, error: null });
    try {
      const { command } = await commandsService.updateCommandFile(params);
      if (currentListKey(get) !== key) {
        set({ operatingCommandId: null });
        return command;
      }
      const { commands, userCommands } = get();
      set({
        commands: commands.map((c) => (c.id === params.commandId ? command : c)),
        userCommands: userCommands.map((c) => (c.id === params.commandId ? command : c)),
        operatingCommandId: null,
      });
      return command;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set(
        currentListKey(get) === key
          ? { operatingCommandId: null, error: message }
          : { operatingCommandId: null },
      );
      throw err;
    }
  },

  deleteCommand: async (params, commandsService) => {
    const key = currentListKey(get);
    set({ operatingCommandId: params.commandId, error: null });
    try {
      await commandsService.deleteCommandFile(params);
      if (currentListKey(get) !== key) {
        set({ operatingCommandId: null });
        return true;
      }
      const { commands, userCommands } = get();
      set({
        commands: commands.filter((c) => c.id !== params.commandId),
        userCommands: userCommands.filter((c) => c.id !== params.commandId),
        operatingCommandId: null,
      });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set(
        currentListKey(get) === key
          ? { operatingCommandId: null, error: message }
          : { operatingCommandId: null },
      );
      throw err;
    }
  },

  toggleCommand: async (params, commandsService) => {
    const key = currentListKey(get);
    set({ operatingCommandId: params.commandId, error: null });
    try {
      await commandsService.setCommandEnabled(params);
      if (currentListKey(get) !== key) {
        set({ operatingCommandId: null });
        return;
      }
      const { commands, userCommands } = get();
      set({
        commands: commands.map((command) =>
          command.id === params.commandId ? { ...command, enabled: params.enabled } : command,
        ),
        userCommands: userCommands.map((command) =>
          command.id === params.commandId ? { ...command, enabled: params.enabled } : command,
        ),
        operatingCommandId: null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set(
        currentListKey(get) === key
          ? { operatingCommandId: null, error: message }
          : { operatingCommandId: null },
      );
      throw err;
    }
  },
}));
