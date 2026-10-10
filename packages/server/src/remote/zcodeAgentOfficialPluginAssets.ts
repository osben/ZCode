import { posix } from "node:path";

export const REMOTE_AGENT_OFFICIAL_PLUGIN_DIR_NAME = "packages";

export const REMOTE_AGENT_OFFICIAL_PLUGIN_PACKAGE_NAMES = ["browser-use-plugin"] as const;

export const REMOTE_AGENT_OFFICIAL_PLUGIN_INCLUDED_TOP_LEVEL_PATHS = [
  ".mcp.json",
  ".zcode-plugin",
  "README.md",
  // Development remote-plugin copying uses a dedicated allowlist; omitting agents would break subagents only on remote hosts.
  "agents",
  "commands",
  "dist",
  "docs",
  "hooks",
  "output-styles",
  "package.json",
  // Browser bootstrap dynamically imports scripts/browser-client.mjs from the plugin root. If a
  // development SSH deployment omits scripts, the MCP server starts but browser binding cannot initialize.
  "scripts",
  "skills",
  "templates",
] as const;

export const REMOTE_AGENT_OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS = [
  ...REMOTE_AGENT_OFFICIAL_PLUGIN_PACKAGE_NAMES.map(
    (packageName) => `${packageName}/.zcode-plugin/plugin.json`,
  ),
  // Checking only the Browser Use manifest would treat an incomplete directory with a plugin shell as
  // reusable. Production remote, development remote, and release-source validation share this required-assets contract.
  //
  // List only assets produced by browser-use itself. After the node_repl host moved to
  // @zcode/node-repl-host, browser-use no longer produces dist/mcp/server.js; listing that nonexistent
  // file would make remote asset validation report a missing ghost path.
  // Remote workspaces do not currently support Browser Use / Computer Use, so the host runtime is not
  // part of this remote contract. To support remote browser/CUA, add node-repl-host to PACKAGE_NAMES
  // above and declare its dist/mcp/server.js here instead of attributing host output to browser-use.
  "browser-use-plugin/docs/api.json",
  "browser-use-plugin/docs/documents.json",
  "browser-use-plugin/docs/overview.md",
  // If the remote cache lacks the recording body, documents.json would still incorrectly declare the lookup available.
  "browser-use-plugin/docs/recording.md",
  "browser-use-plugin/docs/workflow.md",
  "browser-use-plugin/scripts/browser-client.mjs",
  "browser-use-plugin/skills/control-browser/SKILL.md",
  "browser-use-plugin/skills/web-gui-tester/SKILL.md",
  // Checking only the manifest cannot detect missing skill content or the visual-review Agent in the documentation plugin.
] as const;

export function buildRemoteAgentOfficialPluginDir(remoteProviderDir: string): string {
  return posix.join(remoteProviderDir, REMOTE_AGENT_OFFICIAL_PLUGIN_DIR_NAME);
}

export function buildRemoteAgentOfficialPluginSourceRelativePath(params: {
  runtimeResourceDir: string;
  platformArch: string;
}): string {
  return posix.join(
    params.runtimeResourceDir,
    params.platformArch,
    REMOTE_AGENT_OFFICIAL_PLUGIN_DIR_NAME,
  );
}

export function buildRemoteAgentOfficialPluginRequiredPaths(remoteProviderDir: string): string[] {
  const remoteOfficialPluginDir = buildRemoteAgentOfficialPluginDir(remoteProviderDir);
  return REMOTE_AGENT_OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS.map((relativePath) =>
    posix.join(remoteOfficialPluginDir, relativePath),
  );
}
