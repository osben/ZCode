import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SYSTEM_PROMPT_OVERRIDE_KEYS } from "@zcode/shared";
import { loadPersistedSystemPromptOverrides } from "../src/system-prompt.js";

let tempHome = "";

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), "zcode-system-prompt-"));
});

afterEach(async () => {
  await rm(tempHome, { recursive: true, force: true });
});

// Overrides live at $HOME/.zcode/system-prompt, so tests point HOME at a temp dir.
function loaderEnv(): NodeJS.ProcessEnv {
  return { HOME: tempHome };
}

async function writeOverride(key: string, content: string): Promise<void> {
  await mkdir(join(tempHome, ".zcode", "system-prompt"), { recursive: true });
  await writeFile(join(tempHome, ".zcode", "system-prompt", `${key}.md`), content, "utf-8");
}

describe("loadPersistedSystemPromptOverrides", () => {
  it("returns an empty map when no override directory exists", async () => {
    await expect(loadPersistedSystemPromptOverrides({ env: loaderEnv() })).resolves.toEqual({});
  });

  it("loads present, non-empty override files keyed by the whitelist", async () => {
    await writeOverride("harness", "# Harness\n- My rule.");
    await writeOverride("communication", "Be terse.");
    const overrides = await loadPersistedSystemPromptOverrides({ env: loaderEnv() });
    expect(overrides).toEqual({
      harness: "# Harness\n- My rule.",
      communication: "Be terse.",
    });
  });

  it("ignores whitespace-only override files", async () => {
    await writeOverride("harness", "   \n\n ");
    const overrides = await loadPersistedSystemPromptOverrides({ env: loaderEnv() });
    expect(overrides).toEqual({});
  });

  it("trims surrounding whitespace from override bodies", async () => {
    await writeOverride("cli-prefix", "\nYou are My Agent.\n");
    const overrides = await loadPersistedSystemPromptOverrides({ env: loaderEnv() });
    expect(overrides["cli-prefix"]).toBe("You are My Agent.");
  });

  it("never invents keys outside the whitelist", async () => {
    await writeOverride("environment", "fake");
    const overrides = await loadPersistedSystemPromptOverrides({ env: loaderEnv() });
    // The loader only reads whitelisted keys, so a foreign file is invisible to it.
    expect(
      Object.keys(overrides).every((key) =>
        (SYSTEM_PROMPT_OVERRIDE_KEYS as readonly string[]).includes(key),
      ),
    ).toBe(true);
    expect(overrides).toEqual({});
  });

  it("reads $HOME/.zcode/system-prompt, not a redirected storage root", async () => {
    // The host service writes the fixed home-based location; a storage.dir/ZCODE_STORAGE_DIR
    // redirect (or the beta ~/.zcode-beta default) must not move the override directory.
    await writeOverride("harness", "# Harness\n- My rule.");
    const redirectedRoot = await mkdtemp(join(tmpdir(), "zcode-system-prompt-storage-"));
    try {
      await mkdir(join(redirectedRoot, "system-prompt"), { recursive: true });
      await writeFile(
        join(redirectedRoot, "system-prompt", "harness.md"),
        "# Harness\n- Wrong root.",
        "utf-8",
      );
      const overrides = await loadPersistedSystemPromptOverrides({ env: loaderEnv() });
      expect(overrides["harness"]).toBe("# Harness\n- My rule.");
    } finally {
      await rm(redirectedRoot, { recursive: true, force: true });
    }
  });
});
