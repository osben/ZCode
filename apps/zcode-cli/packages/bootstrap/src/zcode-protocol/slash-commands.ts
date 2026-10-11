import { BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES, type ZCodeSlashCommand } from "@zcode/shared";
import { BUILTIN_WORKFLOW_COMMAND_NAME } from "../builtin-workflow-command.js";
import {
  listZCodeCustomCommands,
  type ListZCodeCustomCommandsOptions,
} from "../custom-commands.js";
import {
  APP_PROTOCOL_APP_ONLY_BUILTIN_SLASH_COMMANDS,
  APP_PROTOCOL_VISIBLE_BUILTIN_SLASH_COMMAND_NAMES,
  isReservedZCodeSlashCommandName,
} from "../slash-command-surface.js";

export interface ListProtocolSlashCommandsOptions extends ListZCodeCustomCommandsOptions {
  /**
   * Dynamic-workflow rollout gate (docs/dynamic-workflow/launch.md "Gray release"). **Remove the
   * built-in `workflow` only when explicitly false**: the CLI's own catalog assembly (TUI / callers
   * not participating in the rollout) omits this field and must stay unchanged. The protocol server
   * always passes an explicit boolean from appRuntimePreferences.
   */
  dynamicWorkflowEnabled?: boolean;
}

export async function listProtocolSlashCommands(
  options: ListProtocolSlashCommandsOptions = {},
): Promise<ZCodeSlashCommand[]> {
  // Rollout off: both the Composer plus menu and the `/` panel read only this catalog, so removing
  // the entry hides it in both places (DWG-03). `workflow` is a built-in reserved name; same-named
  // user/plugin custom commands are also removed by the reserved-name filter below and cannot
  // reappear under a custom-command identity while the gate is closed.
  const builtins = listAppProtocolBuiltinSlashCommands().filter(
    (command) =>
      options.dynamicWorkflowEnabled !== false || command.name !== BUILTIN_WORKFLOW_COMMAND_NAME,
  );
  let customCommands: Awaited<ReturnType<typeof listZCodeCustomCommands>>["commands"] = [];
  try {
    const outcome = await listZCodeCustomCommands(options);
    customCommands = outcome.commands;
  } catch {
    // Failure to discover custom commands must not block the session snapshot; keep executable built-in protocol commands.
    customCommands = [];
  }

  return [
    ...builtins,
    ...customCommands
      .filter((command) => !command.disableNonInteractive)
      .filter((command) => !isReservedZCodeSlashCommandName(command.name))
      .map((command) => ({
        description: command.description,
        inputHint: `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""}`,
        name: command.name,
        source: "custom" as const,
      })),
  ];
}

/** The App `/` panel displays commands in this catalog's order; APP_PROTOCOL_VISIBLE_BUILTIN_SLASH_COMMAND_NAMES determines built-in ordering. */
function listAppProtocolBuiltinSlashCommands(): ZCodeSlashCommand[] {
  const sharedBuiltins = APP_PROTOCOL_VISIBLE_BUILTIN_SLASH_COMMAND_NAMES.flatMap((name) => {
    const command = BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES.find((entry) => entry.name === name);
    if (!command) return [];
    return [
      {
        description: command.summary,
        inputHint: command.usage,
        name: command.name,
        source: "builtin" as const,
      },
    ];
  });
  return [...sharedBuiltins, ...APP_PROTOCOL_APP_ONLY_BUILTIN_SLASH_COMMANDS];
}
