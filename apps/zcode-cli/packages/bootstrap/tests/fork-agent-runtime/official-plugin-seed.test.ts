import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "@zcode/contracts";
import { seedOfficialPluginsForForkRustAgent } from "../../src/fork-agent-runtime/contract.js";
import { prepareProtocolStartupStorage } from "../../src/zcode-protocol/storage-startup.js";

const faults = vi.hoisted(() => ({ seedThrows: false }));

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
  faults.seedThrows = false;
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/**
 * Runs the `prepareStorageOnly` branch of `runZCodeProtocolAgent` (database, then the fork seed)
 * the way the Host Worker drives it, and returns its stdout frames. The entrypoint itself is not
 * imported: its module graph needs every CLI package built, which the unit-test CI job does not do;
 * the desktop E2E case `conversation-session-fork-official-plugins-fresh-home` covers the wiring.
 */
async function prepareStorage(runtime: string) {
  const dir = await mkdtemp(join(tmpdir(), "zcode-fork-plugin-seed-"));
  dirs.push(dir);
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
  seedOfficialPluginsForForkRustAgent({ cwd: dir, env, logger });
  output.end();
  return { frames, pluginRoot: join(storageDir, "cli", "plugins"), warnings };
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
      join(pluginRoot, "cache", "zcode-plugins-official", "visualize", "0.1.1"),
    );
    expect(existsSync(join(visualize!.cachePath, "skills", "visualize", "SKILL.md"))).toBe(true);
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
