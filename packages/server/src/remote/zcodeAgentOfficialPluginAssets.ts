import { posix } from "node:path";

export const REMOTE_AGENT_OFFICIAL_PLUGIN_DIR_NAME = "packages";

export const REMOTE_AGENT_OFFICIAL_PLUGIN_PACKAGE_NAMES = [
  "android-emulator-plugin",
  "browser-use-plugin",
  "zcode-cua-plugin",
  "documents-plugin",
  "pdf-plugin",
  "presentations-plugin",
  "spreadsheets-plugin",
  "image-search-plugin",
  "ios-simulator-plugin",
  "restore-legacy-sessions-plugin",
  "skill-creator-plugin",
  "plugin-creator-plugin",
  "zcode-guide-plugin",
  "visualize-plugin",
  "typescript-lsp-plugin",
] as const;

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
  // 工作流技能已迁出插件；远端复用仍必须检查这份 Agent 必需资产。
  "bundled-skills/skills/dynamic-workflows/SKILL.md",
  "bundled-skills/skills/dynamic-workflows/patterns.md",
  "bundled-skills/skills/dynamic-workflows/examples.md",
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
  "visualize-plugin/skills/visualize/SKILL.md",
  "visualize-plugin/skills/visualize/references/api.md",
  "visualize-plugin/skills/visualize/references/styles.md",
  "visualize-plugin/skills/visualize/tweak.md",
  "visualize-plugin/skills/visualize/LICENSE.md",
  "visualize-plugin/skills/visualize/scripts/render.py",
  "visualize-plugin/skills/visualize/assets/visualize.css",
  "visualize-plugin/skills/visualize/assets/visualize.html",
  "visualize-plugin/skills/visualize/assets/calendar.js",
  "visualize-plugin/skills/visualize/assets/runtime-manifest.json",
  "visualize-plugin/skills/visualize/scripts/vendor.py",
  "visualize-plugin/skills/visualize/assets/vendor/manifest.json",
  "visualize-plugin/skills/visualize/assets/vendor/floating-ui-core-1.7.3.min.js",
  "visualize-plugin/skills/visualize/assets/vendor/floating-ui-core-1.7.3.min.js.LICENSE",
  "visualize-plugin/skills/visualize/assets/vendor/floating-ui-dom-1.7.4.min.js",
  "visualize-plugin/skills/visualize/assets/vendor/floating-ui-dom-1.7.4.min.js.LICENSE",
  "visualize-plugin/skills/visualize/assets/vendor/lucide-1.17.0.js",
  "visualize-plugin/skills/visualize/assets/vendor/lucide-1.17.0.js.LICENSE",
  "visualize-plugin/skills/visualize/assets/vendor/d3-7.9.0.min.js",
  "visualize-plugin/skills/visualize/assets/vendor/d3-7.9.0.min.js.LICENSE",
  "visualize-plugin/skills/visualize/assets/standalone-host-bridge.js",
  "visualize-plugin/skills/visualize/assets/standalone-shell.js",
  "visualize-plugin/skills/visualize/widgets/calendar.md",
  "visualize-plugin/skills/visualize/examples/calendar.html",
  "browser-use-plugin/docs/api.json",
  "browser-use-plugin/docs/documents.json",
  "browser-use-plugin/docs/overview.md",
  // If the remote cache lacks the recording body, documents.json would still incorrectly declare the lookup available.
  "browser-use-plugin/docs/recording.md",
  "browser-use-plugin/docs/workflow.md",
  "browser-use-plugin/scripts/browser-client.mjs",
  "browser-use-plugin/skills/control-browser/SKILL.md",
  "browser-use-plugin/skills/web-gui-tester/SKILL.md",
  // Fix rationale: checking only the manifest cannot detect documentation plugins missing skill
  // content or the visual-review Agent.
  "image-search-plugin/.mcp.json",
  "documents-plugin/agents/visual-judge.md",
  "documents-plugin/skills/docx/SKILL.md",
  "pdf-plugin/agents/visual-judge.md",
  "pdf-plugin/skills/pdf/SKILL.md",
  "presentations-plugin/agents/visual-judge.md",
  "presentations-plugin/skills/pptx/SKILL.md",
  "spreadsheets-plugin/agents/visual-judge.md",
  "spreadsheets-plugin/skills/xlsx/SKILL.md",
  "zcode-cua-plugin/docs/computer-use.md",
  "zcode-cua-plugin/scripts/computer-use-client.mjs",
  "zcode-cua-plugin/skills/computer-use/SKILL.md",
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
