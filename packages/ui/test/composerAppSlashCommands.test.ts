// Upstream 3.17.1 keeps the recovery command in the slash menu while the runtime is blocked; the
// merge had kept the older "blocked hides everything" rule.
import { describe, expect, it } from "vitest";
import type { AppSlashCommand } from "@/slashCommandHelpers.js";
import { selectComposerAppSlashCommands } from "@/v4/composer/composerAppSlashCommands.js";

const command = (value: string, recovery?: boolean): AppSlashCommand => ({
  value,
  description: value,
  ...(recovery ? { recovery } : {}),
  run: () => {},
});
const commands = [command("side"), command("reload", true)];
const values = (list: AppSlashCommand[] | undefined) => list?.map((item) => item.value);

describe("selectComposerAppSlashCommands", () => {
  it("keeps only the recovery command while the runtime is blocked and recovery is available", () => {
    expect(
      values(
        selectComposerAppSlashCommands(commands, { runtimeBlocked: true, recoveryAvailable: true }),
      ),
    ).toEqual(["reload"]);
  });

  it("hides everything when the runtime is blocked and recovery is unavailable", () => {
    expect(
      values(
        selectComposerAppSlashCommands(commands, {
          runtimeBlocked: true,
          recoveryAvailable: false,
        }),
      ),
    ).toEqual([]);
  });

  it("lists ordinary commands when the runtime is not blocked, and recovery only when available", () => {
    expect(
      values(
        selectComposerAppSlashCommands(commands, {
          runtimeBlocked: false,
          recoveryAvailable: true,
        }),
      ),
    ).toEqual(["side", "reload"]);
    expect(
      values(
        selectComposerAppSlashCommands(commands, {
          runtimeBlocked: false,
          recoveryAvailable: false,
        }),
      ),
    ).toEqual(["side"]);
  });

  it("passes an absent command list through", () => {
    expect(
      selectComposerAppSlashCommands(undefined, { runtimeBlocked: true, recoveryAvailable: true }),
    ).toBeUndefined();
  });
});
