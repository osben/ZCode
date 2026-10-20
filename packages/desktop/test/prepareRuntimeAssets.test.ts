import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";

const { runCommand } = vi.hoisted(() => ({ runCommand: vi.fn() }));
vi.mock("../../../scripts/spawn-command.mjs", () => ({ runCommand }));
vi.mock("../../../scripts/native-search-tools-config.mjs", () => ({
  resolveNativeSearchReleasePlan: () => ({ enabled: false }),
}));
vi.mock("../scripts/target-platform.mjs", () => ({
  getTargetPlatform: () => ({ os: "linux", arch: "x64" }),
}));

afterEach(() => vi.unstubAllEnvs());

it("runs remote asset preparation at the root and agent preparation in the desktop package", async () => {
  vi.stubEnv("ZCODE_SKIP_REMOTE_ASSETS", "0");
  await import("../scripts/prepare-runtime-assets.mjs");

  expect(runCommand.mock.calls.map(([, args, options]) => ({ args, cwd: options.cwd }))).toEqual([
    {
      args: ["run", "prepare:remote-assets"],
      cwd: resolve(fileURLToPath(new URL("../../..", import.meta.url))),
    },
    {
      args: ["run", "prepare:agent-bundle"],
      cwd: resolve(fileURLToPath(new URL("..", import.meta.url))),
    },
  ]);
});
