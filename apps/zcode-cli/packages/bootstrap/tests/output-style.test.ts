import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { builtInOutputStylePrompt } from "@zcode/shared";
import { loadPersistedOutputStyle } from "../src/output-style.js";

let tempHome = "";
let previousHome: string | undefined;
let previousUserProfile: string | undefined;

beforeEach(async () => {
  previousHome = process.env.HOME;
  previousUserProfile = process.env.USERPROFILE;
  tempHome = await mkdtemp(join(tmpdir(), "zcode-output-style-loader-"));
  process.env.HOME = tempHome;
  delete process.env.USERPROFILE;
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
  await rm(tempHome, { recursive: true, force: true });
});

function storageRoot(): string {
  // The CLI user storage root is <home>/.zcode for these tests.
  return join(tempHome, ".zcode");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(value), "utf-8");
}

async function writeStyle(
  dir: "zcode" | "claude",
  filename: string,
  content: string,
): Promise<void> {
  const base = dir === "zcode" ? join(tempHome, ".zcode") : join(tempHome, ".claude");
  await mkdir(join(base, "output-styles"), { recursive: true });
  await writeFile(join(base, "output-styles", filename), content, "utf-8");
}

describe("loadPersistedOutputStyle", () => {
  it("returns undefined when no settings file exists", async () => {
    await expect(loadPersistedOutputStyle({ storageRoot: storageRoot() })).resolves.toBeUndefined();
  });

  it("returns undefined for the default style id", async () => {
    await writeJson(join(storageRoot(), "settings.json"), { outputStyle: "default" });
    await expect(loadPersistedOutputStyle({ storageRoot: storageRoot() })).resolves.toBeUndefined();
  });

  it("resolves a built-in id to the shared constant prompt", async () => {
    await writeJson(join(storageRoot(), "settings.json"), { outputStyle: "explanatory" });
    const style = await loadPersistedOutputStyle({ storageRoot: storageRoot() });
    expect(style).toEqual({
      name: "Explanatory",
      prompt: builtInOutputStylePrompt("explanatory"),
    });
  });

  it("resolves a custom style file and strips the header block", async () => {
    await writeJson(join(storageRoot(), "settings.json"), { outputStyle: "custom-concise" });
    await writeStyle("zcode", "concise.md", "name: Concise\ndescription: Short\n\nBe brief.");
    const style = await loadPersistedOutputStyle({ storageRoot: storageRoot() });
    expect(style).toEqual({ name: "Concise", prompt: "Be brief." });
  });

  it("prefers an override file over the built-in constant", async () => {
    await writeJson(join(storageRoot(), "settings.json"), { outputStyle: "explanatory" });
    await writeStyle("zcode", "explanatory.md", "name: Explanatory\n\nMy custom variant.");
    const style = await loadPersistedOutputStyle({ storageRoot: storageRoot() });
    expect(style).toEqual({ name: "Explanatory", prompt: "My custom variant." });
  });

  it("falls back to legacy claude settings and files", async () => {
    await writeJson(join(tempHome, ".claude", "settings.json"), { outputStyle: "custom-legacy" });
    await writeStyle("claude", "legacy.md", "name: Legacy\n\nLegacy prompt.");
    const style = await loadPersistedOutputStyle({ storageRoot: storageRoot() });
    expect(style).toEqual({ name: "Legacy", prompt: "Legacy prompt." });
  });

  it("returns undefined when the resolved prompt is empty", async () => {
    await writeJson(join(storageRoot(), "settings.json"), { outputStyle: "custom-empty" });
    await writeStyle("zcode", "empty.md", "name: Empty\ndescription: nothing\n");
    await expect(loadPersistedOutputStyle({ storageRoot: storageRoot() })).resolves.toBeUndefined();
  });
});
