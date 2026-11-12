import { existsSync } from "node:fs";
import { mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "@zcode/contracts";
import { seedOfficialPluginsForForkRustAgent } from "../../src/fork-agent-runtime/contract.js";
import { prepareProtocolStartupStorage } from "../../src/zcode-protocol/storage-startup.js";

const faults = vi.hoisted(() => ({
  promoteFailsFor: undefined as string | undefined,
  seedThrows: false,
}));

// Fails promoting a freshly laid out plugin version into place, the way an exhausted EPERM retry
// does on a locked cache, so the seeder degrades that plugin to its last usable cache.
vi.mock("../../src/app/official-plugin-cache-fs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/app/official-plugin-cache-fs.js")>();
  return {
    ...actual,
    renameOfficialPluginCachePath(
      ...args: Parameters<typeof actual.renameOfficialPluginCachePath>
    ): void {
      const [fromPath, toPath] = args;
      if (faults.promoteFailsFor && fromPath.includes(".tmp-") && toPath.endsWith(faults.promoteFailsFor))
        throw Object.assign(new Error("EPERM"), { code: "EPERM", zcodeOfficialPluginCacheAttempts: 4 });
      actual.renameOfficialPluginCachePath(...args);
    },
  };
});

vi.mock("../../src/app/bundled-plugins.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/app/bundled-plugins.js")>();
  return {
    ...actual,
    resolveOfficialPluginRoots(input: Parameters<typeof actual.resolveOfficialPluginRoots>[0]) {
      if (faults.seedThrows) throw new Error("broken bundled plugin asset");
      return actual.resolveOfficialPluginRoots(input);
    },
  };
});

const dirs: string[] = [];
afterEach(async () => {
  faults.promoteFailsFor = undefined;
  faults.seedThrows = false;
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/**
 * Runs the `prepareStorageOnly` branch of `runZCodeProtocolAgent` (database, then the fork seed)
 * the way the Host Worker drives it, and returns its stdout frames. The entrypoint itself is not
 * imported: its module graph needs every CLI package built, which the unit-test CI job does not do;
 * the desktop E2E case `conversation-session-fork-official-plugins-fresh-home` covers the wiring.
 */
async function prepareStorage(runtime: string, existingDir?: string) {
  const dir = existingDir ?? (await mkdtemp(join(tmpdir(), "zcode-fork-plugin-seed-")));
  if (!existingDir) dirs.push(dir);
  const storageDir = join(dir, "home", ".zcode");
  const input = new PassThrough();
  const output = new PassThrough();
  const frames: Array<{ method: string }> = [];
  createInterface({ input: output }).on("line", (line) => {
    // stdout is the Host's control channel: every line must be a JSON frame.
    const frame = JSON.parse(line) as { method: string };
    frames.push(frame);
    if (frame.method === "startup/storagePath")
      input.write(`${JSON.stringify({ method: "startup/storagePathReady", reuse: false })}\n`);
    if (frame.method === "startup/storagePrepared") input.end();
  });
  const env = { ...process.env, ZCODE_FORK_AGENT_RUNTIME: runtime, ZCODE_STORAGE_DIR: storageDir };
  const warnings: string[] = [];
  const logger = { warn: (message: string) => warnings.push(message) } as unknown as Logger;
  await prepareProtocolStartupStorage({
    dbPath: join(storageDir, "cli", "db", "db.sqlite"),
    input,
    output,
  });
  await seedOfficialPluginsForForkRustAgent({ cwd: dir, env, logger });
  output.end();
  return { dir, frames, pluginRoot: join(storageDir, "cli", "plugins"), warnings };
}

describe("fork: prepare-storage seeds the official plugins for the Rust agent", () => {
  it("lays out the bundled marketplace and the plugin cache when the runtime is rust", async () => {
    const { frames, pluginRoot } = await prepareStorage("rust");
    const methods = frames.map((frame) => frame.method);
    expect(methods[0]).toBe("startup/storagePath");
    expect(methods.at(-1)).toBe("startup/storagePrepared");
    expect(new Set(methods.slice(1, -1))).toEqual(new Set(["startup/storageState"]));
    const partition = JSON.parse(
      await readFile(
        join(pluginRoot, "marketplaces", "zcode-plugins-official", "bundled-marketplace.json"),
        "utf8",
      ),
    ) as { manifest: { plugins: Array<{ cachePath: string; name: string }> } };
    const visualize = partition.manifest.plugins.find((plugin) => plugin.name === "visualize");
    expect(visualize?.cachePath).toBe(
      join(pluginRoot, "cache", "zcode-plugins-official", "visualize", "0.1.2"),
    );
    expect(existsSync(join(visualize!.cachePath, "skills", "visualize", "SKILL.md"))).toBe(true);
  }, 60_000);

  it("points the catalog at the last usable cache when a new version cannot be laid out", async () => {
    const first = await prepareStorage("rust");
    const visualizeCache = join(first.pluginRoot, "cache", "zcode-plugins-official", "visualize");
    // An older install: only a previous visualize version is in the cache.
    await rename(join(visualizeCache, "0.1.2"), join(visualizeCache, "0.1.0"));
    faults.promoteFailsFor = join("visualize", "0.1.2");

    const { pluginRoot } = await prepareStorage("rust", first.dir);

    expect(existsSync(join(visualizeCache, "0.1.2"))).toBe(false);
    const partition = JSON.parse(
      await readFile(
        join(pluginRoot, "marketplaces", "zcode-plugins-official", "bundled-marketplace.json"),
        "utf8",
      ),
    ) as { manifest: { plugins: Array<{ cachePath: string; name: string; version: string }> } };
    const byName = new Map(partition.manifest.plugins.map((plugin) => [plugin.name, plugin]));
    // zcode-rs loads `cachePath` (platform/src/local/plugin_inventory.rs), so it now sees the same
    // visualize the Node agent loads from the seeder's fallback roots.
    expect(byName.get("visualize")?.cachePath).toBe(join(visualizeCache, "0.1.0"));
    expect(byName.get("visualize")?.version).toBe("0.1.2");
    expect(byName.get("skill-creator")?.cachePath).toBe(
      join(pluginRoot, "cache", "zcode-plugins-official", "skill-creator", byName.get("skill-creator")!.version),
    );
    const merged = JSON.parse(
      await readFile(join(pluginRoot, "marketplaces", "zcode-plugins-official", "marketplace.json"), "utf8"),
    ) as { plugins: Array<{ cachePath: string; name: string }> };
    expect(merged.plugins.find((plugin) => plugin.name === "visualize")?.cachePath).toBe(
      join(visualizeCache, "0.1.0"),
    );
  }, 60_000);

  it("leaves the plugin storage alone when the runtime is node", async () => {
    const { frames, pluginRoot } = await prepareStorage("node");
    expect(frames.at(-1)?.method).toBe("startup/storagePrepared");
    expect(existsSync(pluginRoot)).toBe(false);
  }, 60_000);

  it("logs a seed failure instead of failing storage preparation", async () => {
    faults.seedThrows = true;
    const { frames, pluginRoot, warnings } = await prepareStorage("rust");
    expect(frames.at(-1)?.method).toBe("startup/storagePrepared");
    expect(existsSync(join(pluginRoot, "cache"))).toBe(false);
    expect(warnings).toEqual(["Official plugin seed for the Rust agent failed"]);
  }, 60_000);
});
