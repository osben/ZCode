import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 与 CLI adapter（apps/zcode-cli/packages/adapters/src/context/index.ts 的 resolveUserHomeDir）保持一致：
 * HOME → USERPROFILE → os.homedir()。不读取 ZCODE_DESKTOP_HOME_DIR，
 * 否则设置页编辑的文件与 Agent 实际注入的文件可能不同。
 */
export function resolveAgentUserHomeDir(): string {
  const envHome = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
  return envHome && envHome.length > 0 ? envHome : homedir();
}

/** Agent 默认读取的全局用户指令文件 `~/.zcode/AGENTS.md`。 */
export function getUserZcodeAgentsFilePath(): string {
  return join(resolveAgentUserHomeDir(), ".zcode", "AGENTS.md");
}

/** Claude Code 的全局用户指令文件 `~/.claude/CLAUDE.md`（迁移/导入来源）。 */
export function getClaudeUserInstructionsFilePath(): string {
  return join(resolveAgentUserHomeDir(), ".claude", "CLAUDE.md");
}
