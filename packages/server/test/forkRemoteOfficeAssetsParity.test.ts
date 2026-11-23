import { describe, expect, it } from "vitest";
// @ts-expect-error untyped build script; the desktop bundle list is the reference contract here.
import { officialPluginPackages } from "../../desktop/scripts/official-plugin-packages.mjs";
import { REMOTE_AGENT_OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS } from "../src/remote/zcodeAgentOfficialPluginAssets.js";

const OFFICE_PLUGINS = ["documents", "pdf", "presentations", "spreadsheets"] as const;

type DesktopPluginPackage = {
  packageName: string;
  requiredRuntimePaths?: readonly string[];
  requiredSeedPaths?: readonly string[];
};

// The office asset lists are hand-maintained in the desktop bundle, the SEA collector and the
// remote validator. The 4.0.0 merge silently dropped the spreadsheets viewer from the remote list,
// so a remote cache without the viewer panel passed validation and only failed at runtime.
describe("remote office plugin assets match the desktop bundle contract", () => {
  for (const name of OFFICE_PLUGINS) {
    it(`${name}-plugin requires every desktop seed and runtime path remotely`, () => {
      const desktop = (officialPluginPackages as readonly DesktopPluginPackage[]).find(
        (item) => item.packageName === `@zcode/${name}-plugin`,
      );
      expect(desktop).toBeDefined();
      const remote = new Set<string>(REMOTE_AGENT_OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS);
      const missing = [
        ...(desktop?.requiredSeedPaths ?? []),
        ...(desktop?.requiredRuntimePaths ?? []),
      ]
        .map((path) => `${name}-plugin/${path}`)
        .filter((path) => !remote.has(path));
      expect(missing).toEqual([]);
    });
  }
});
