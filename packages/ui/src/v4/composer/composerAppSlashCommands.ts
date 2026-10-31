import type { AppSlashCommand } from "@/slashCommandHelpers.js";

/**
 * App slash commands offered by the composer. A blocked runtime hides ordinary commands, but a
 * recovery command (such as /reload) stays listed whenever recovery is available, since it is the
 * way out of the blocked state.
 */
export function selectComposerAppSlashCommands(
  commands: readonly AppSlashCommand[] | undefined,
  state: { runtimeBlocked: boolean; recoveryAvailable: boolean },
): AppSlashCommand[] | undefined {
  return commands?.filter((command) =>
    command.recovery ? state.recoveryAvailable : !state.runtimeBlocked,
  );
}
