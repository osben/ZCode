// Golden generator for cli/src/config/workspace_plugins_tests.rs. Writes each fixture plugin into a temp
// workspace and runs Node's own inspectWorkspacePluginRoot (apps/zcode-cli/packages/adapters/src/plugins/
// workspace-plugin-declaration/index.ts), the function the trust write re-checks with. The digest depends only on
// the paths relative to the plugin root and on the plugin root key, so the Rust test rebuilds the same files in its
// own temp dir and must get the same hex.
//
// Rerun from the repository root (after `pnpm install`):
//   node_modules/.bin/tsx packages/rust-cli/crates/cli/src/config/fixtures/gen-workspace-plugin-digest.mts \
//     > packages/rust-cli/crates/cli/src/config/fixtures/workspace_plugin_digest_golden.json
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(fileURLToPath(new URL("../../../../../../..", import.meta.url)));
const { inspectWorkspacePluginRoot } = await import(
  pathToFileURL(
    join(REPO, "apps/zcode-cli/packages/adapters/src/plugins/workspace-plugin-declaration/index.ts"),
  ).href
);

type Case = { name: string; root: string; files: Record<string, string> };

const manifest = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name: "demo", version: "1.0.0", ...extra }, null, 2);

const cases: Case[] = [
  { name: "manifest_only", root: "plugins/demo", files: { ".zcode-plugin/plugin.json": manifest() } },
  {
    name: "manifest_hooks_mcp",
    root: "plugins/demo",
    files: {
      ".zcode-plugin/plugin.json": manifest(),
      "hooks/hooks.json": '{"hooks":{}}\n',
      ".mcp.json": '{"mcpServers":{"ping":{"command":"node","args":["ping.js"]}}}\n',
      "skills/x/SKILL.md": "not in the digest\n",
    },
  },
  {
    name: "nested_mcp_servers",
    root: "tools/p",
    files: {
      ".zcode-plugin/plugin.json": manifest({
        hooks: "./extra/hooks.json",
        mcpServers: [["./mcp/a.json", ["mcp/b.json", "/abs/c.json"]], "../outside.json", "./.mcp.json", 7],
      }),
      "extra/hooks.json": "{}",
      "mcp/a.json": '{"a":1}',
      ".mcp.json": "{}",
    },
  },
  {
    name: "crlf_and_unicode",
    root: "plugins/demo",
    files: {
      ".zcode-plugin/plugin.json": manifest({ description: "Привет   \u001b tab\t" }).replace(/\n/g, "\r\n"),
      "hooks/hooks.json": "{\r\n}\r\n",
    },
  },
  {
    name: "claude_manifest",
    root: "plugins/claude",
    files: { ".claude-plugin/plugin.json": manifest(), ".codex-plugin/plugin.json": manifest({ name: "other" }) },
  },
  { name: "workspace_root", root: ".", files: { ".zcode-plugin/plugin.json": manifest() } },
];

const out = [];
for (const fixture of cases) {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "wpd-"));
  const rootPath = resolve(workspaceRoot, fixture.root);
  for (const [path, text] of Object.entries(fixture.files)) {
    const file = join(rootPath, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  const inspected = await inspectWorkspacePluginRoot({ workspaceRoot, rootPath });
  out.push({ ...fixture, pluginRoot: inspected?.pluginRoot, declarationDigest: inspected?.declarationDigest });
}
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
