import { expandCustomCommandPrompt } from "@zcode/contracts";
import { loadZCodeCustomCommand, type ListZCodeCustomCommandsOptions } from "./custom-commands.js";
import { isReservedZCodeSlashCommandName } from "./slash-command-surface.js";

const CUSTOM_COMMAND_NOT_FOUND_PATTERN = /not found/i;
const PROMPT_CUSTOM_COMMAND_PATTERN = /^\/([^\s]+)(?:\s+([\s\S]*))?$/;

export async function resolveZCodeCustomCommandPrompt(
  input: string,
  options: ListZCodeCustomCommandsOptions = {},
): Promise<string | undefined> {
  const invocation = parsePromptCustomCommandInvocation(input);
  // Reserved names (including built-in `workflow`) return undefined here, as for "command not found".
  // builtin-prompt-command.ts expands built-ins first; this rejects attempts to use a same-named custom
  // command to bypass built-in semantics or the gradual-rollout gate.
  if (!invocation || isReservedZCodeSlashCommandName(invocation.name)) {
    return undefined;
  }

  try {
    const command = await loadZCodeCustomCommand({
      ...options,
      name: invocation.name,
    });
    // Parsing only rewrites text: `!` blocks are handed to the model to run through the Bash tool.
    // See handOffCustomCommandShellBlocks in contracts.
    return expandCustomCommandPrompt({
      args: invocation.args,
      command,
    }).prompt;
  } catch (error) {
    if (error instanceof Error && CUSTOM_COMMAND_NOT_FOUND_PATTERN.test(error.message)) {
      return undefined;
    }
    throw error;
  }
}

function parsePromptCustomCommandInvocation(input: string): { args: string; name: string } | null {
  const match = PROMPT_CUSTOM_COMMAND_PATTERN.exec(input.trim());
  if (!match?.[1]) {
    return null;
  }
  return {
    args: match[2]?.trim() ?? "",
    name: match[1].toLowerCase(),
  };
}
