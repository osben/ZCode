import { FOREGROUND_SLEEP_MIN_SECONDS } from "./bash-semantics.js";

export function createBashProviderDescription(input: {
  defaultTimeoutMs: number;
  embeddedSearchEnabled?: boolean;
  maxTimeoutMs: number;
}): string {
  const avoidCommands = input.embeddedSearchEnabled
    ? "`cat`, `head`, `tail`, `sed`, `awk`, or `echo`"
    : "`find`, `grep`, `cat`, `head`, `tail`, `sed`, `awk`, or `echo`";

  return [
    "Executes a bash command and returns its output.",
    "",
    "- `cd` carries to the next call only in the main session, if the command succeeds and ends inside the working directories. Outside them the shell returns to the start folder; otherwise it stays where it was. Prefer absolute paths — `cd` in a compound command can trigger a permission prompt. Shell state (env vars, functions) does not persist; the shell is initialized from the user's profile.",
    `- IMPORTANT: Avoid using this tool to run ${avoidCommands} commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Instead, use the appropriate dedicated tool as this will provide a much better experience for the user.`,
    "- Command output is displayed to you, not reliably to the user.",
    "- Workspace-controlled adb executables are blocked. Installed SDK adb outside the workspace is allowed; bare adb resolves through SDK paths and absolute PATH entries. Use an SDK absolute path if it is only configured in shell startup files. Android MCP tools are optional.",
    // An explicitly backgrounded command clears the foreground deadline; the cap constrains foreground commands only.
    `- \`timeout\` is in milliseconds: default ${input.defaultTimeoutMs}, max ${input.maxTimeoutMs} for a foreground command.`,
    // A long foreground sleep is rejected in validateInput (bash-semantics.ts); the description and the rule read the same threshold constant.
    `- \`run_in_background\` runs the command detached: it keeps running across turns and re-invokes you when it exits. No \`&\` needed. Foreground \`sleep\` of ${FOREGROUND_SLEEP_MIN_SECONDS} seconds or more is blocked; to wait on a condition, run an until-loop with \`run_in_background\`.`,
    "- Independent read-only commands (e.g. `git status`, `git diff`, `ls`) can be sent as multiple Bash tool calls in one message so they run in parallel. Chain dependent steps with `&&`; commands that write or `cd` run one at a time.",
    "",
    "# Git",
    "- Interactive flags (`-i`, e.g. `git rebase -i`, `git add -i`) are not supported in this environment.",
    "- Use the `gh` CLI for GitHub operations (PRs, issues, API).",
    "- GitHub notifies the owner of any `@name` written in a PR, issue, or comment. Write a bare `@name` only for a real login you mean to notify. Put roles, placeholders, and code (`@human`, `@reviewer`, `@types/node`) in backticks or drop the `@`, even when copied from project files.",
    "- Commit or push only when the user asks. If on the default branch, branch first.",
  ].join("\n");
}
