import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import tsupConfig from "../tsup.config";
import { resolveRemotePlatforms } from "../../../scripts/prepare-prebuilds.mjs";

const root = resolve(import.meta.dirname, "../../..");
const manifest = (file: string) => JSON.parse(readFileSync(resolve(root, file), "utf8"));

describe("build pipeline entrypoints", () => {
  it("prepares the manifest format consumed by the existing Desktop remote runtime", () => {
    expect(manifest("package.json").scripts["prepare:remote-assets"]).toBe(
      "node scripts/prepare-prebuilds.mjs",
    );
    expect(manifest("package.json").scripts["prepare:remote-assets:linux"]).toBe(
      "node scripts/prepare-prebuilds.mjs --linux",
    );
    expect(manifest("packages/desktop/package.json").scripts["prepare:remote-assets"]).toBe(
      "pnpm --workspace-root run prepare:remote-assets",
    );
    expect(
      manifest("packages/zcode-server-cli/package.json").scripts["stage:remote-assets"],
    ).toBeUndefined();
  });

  it("selects all existing POSIX targets by default and only Linux targets on request", () => {
    expect(resolveRemotePlatforms([])).toEqual([
      "linux-arm64",
      "linux-x64",
      "darwin-arm64",
      "darwin-x64",
    ]);
    expect(resolveRemotePlatforms(["--linux"])).toEqual(["linux-arm64", "linux-x64"]);
  });

  it("bundles existing source entries and keeps the worker colocated with Host", () => {
    const configs = Array.isArray(tsupConfig) ? tsupConfig : [tsupConfig];
    for (const config of configs) {
      expect(config.entry).toBeTypeOf("object");
      for (const entry of Object.values(config.entry ?? {})) {
        expect(existsSync(resolve(root, "packages/desktop", entry)), entry).toBe(true);
      }
    }
    expect(configs.find((config) => config.name === "host")?.entry).toMatchObject({
      "host/tasksStorageWorker": "src/host/tasksStorageWorker.ts",
    });
  });
});
