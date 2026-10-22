import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setZCodePluginEnabled } from "../src/plugins.js";
import { listProtocolSlashCommands } from "../src/zcode-protocol/slash-commands.js";

// specs/plugin-discovery-process-cache.md: discovery results are not cached across calls, so
// CLI plugin ops, config edits, and edits made outside the CLI are visible on the next call.
describe("plugin discovery liveness across calls in one process", () => {
  let root: string;
  let workspace: string;
  let home: string;
  let userConfigPath: string;
  let pluginRoot: string;
  const pluginId = "live-plugin@inline";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "zcode-plugin-liveness-"));
    workspace = join(root, "workspace");
    home = join(root, "home");
    userConfigPath = join(root, "user-config.json");
    pluginRoot = join(root, "live-plugin");
    await mkdir(workspace, { recursive: true });
    await mkdir(home, { recursive: true });
    await writeTestFile(
      join(pluginRoot, ".zcode-plugin", "plugin.json"),
      JSON.stringify({ name: "live-plugin" }),
    );
    await writeTestFile(
      userConfigPath,
      JSON.stringify({ plugins: { dirs: [pluginRoot] }, storage: { dir: join(root, "store") } }),
    );
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  async function commandNames(): Promise<string[]> {
    const commands = await listProtocolSlashCommands({
      env: { ZCODE_ENV: "test" },
      homeDirectory: home,
      userConfigPath,
      workingDirectory: workspace,
    });
    return commands.filter((command) => command.source === "custom").map(({ name }) => name);
  }

  it("sees workspace .zcode/commands files added and removed outside the CLI", async () => {
    expect(await commandNames()).not.toContain("outside-edit");

    const commandFile = join(workspace, ".zcode", "commands", "outside-edit.md");
    await writeCommand(commandFile, "Added outside the CLI");
    expect(await commandNames()).toContain("outside-edit");

    await rm(commandFile);
    expect(await commandNames()).not.toContain("outside-edit");
  });

  it("sees a commands directory added to an inline plugin outside the CLI", async () => {
    expect((await commandNames()).some((name) => name.includes("plugin-cmd"))).toBe(false);

    await writeCommand(join(pluginRoot, "commands", "plugin-cmd.md"), "Plugin command");

    expect((await commandNames()).some((name) => name.includes("plugin-cmd"))).toBe(true);
  });

  it("follows CLI enable/disable ops and direct config file edits", async () => {
    await writeCommand(join(pluginRoot, "commands", "plugin-cmd.md"), "Plugin command");
    const hasPluginCommand = async () =>
      (await commandNames()).some((name) => name.includes("plugin-cmd"));
    expect(await hasPluginCommand()).toBe(true);

    await setZCodePluginEnabled({
      enabled: false,
      plugin: pluginId,
      scope: "user",
      userConfigPath,
      workingDirectory: workspace,
    });
    expect(await hasPluginCommand()).toBe(false);

    const config = JSON.parse(await readFile(userConfigPath, "utf8")) as {
      plugins: { enabledPlugins?: Record<string, boolean> };
    };
    config.plugins.enabledPlugins = { ...config.plugins.enabledPlugins, [pluginId]: true };
    await writeFile(userConfigPath, JSON.stringify(config));
    expect(await hasPluginCommand()).toBe(true);
  });
});

async function writeCommand(path: string, description: string): Promise<void> {
  await writeTestFile(path, `---\ndescription: ${description}\n---\n\nBody.\n`);
}

async function writeTestFile(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}
