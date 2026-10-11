import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Matches the CLI adapter's resolveUserHomeDir in apps/zcode-cli/packages/adapters/src/context/index.ts:
 * HOME → USERPROFILE → os.homedir(). Do not read ZCODE_DESKTOP_HOME_DIR,
 * or the file edited in Settings could differ from the file actually injected into the Agent.
 */
export function resolveAgentUserHomeDir(): string {
  const envHome = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
  return envHome && envHome.length > 0 ? envHome : homedir();
}

/** Global user instruction file read by default by the Agent: `~/.zcode/AGENTS.md`. */
export function getUserZcodeAgentsFilePath(): string {
  return join(resolveAgentUserHomeDir(), ".zcode", "AGENTS.md");
}

/** Claude Code global user instruction file `~/.claude/CLAUDE.md` (migration/import source). */
export function getClaudeUserInstructionsFilePath(): string {
  return join(resolveAgentUserHomeDir(), ".claude", "CLAUDE.md");
}
