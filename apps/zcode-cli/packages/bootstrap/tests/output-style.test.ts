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

async function writeSettings(value: unknown): Promise<void> {
  await mkdir(storageRoot(), { recursive: true });
  await writeFile(join(storageRoot(), "settings.json"), JSON.stringify(value), "utf-8");
}

async function writeStyle(filename: string, content: string): Promise<void> {
  await mkdir(join(storageRoot(), "output-styles"), { recursive: true });
  await writeFile(join(storageRoot(), "output-styles", filename), content, "utf-8");
}

describe("loadPersistedOutputStyle", () => {
  it("returns undefined when no settings file exists", async () => {
    await expect(loadPersistedOutputStyle({ storageRoot: storageRoot() })).resolves.toBeUndefined();
  });

  it("returns undefined for the default style id", async () => {
    await writeSettings({ outputStyle: "default" });
    await expect(loadPersistedOutputStyle({ storageRoot: storageRoot() })).resolves.toBeUndefined();
  });

  it("resolves a built-in id to the shared constant prompt", async () => {
    await writeSettings({ outputStyle: "explanatory" });
    const style = await loadPersistedOutputStyle({ storageRoot: storageRoot() });
    expect(style).toEqual({
      name: "Explanatory",
      prompt: builtInOutputStylePrompt("explanatory"),
    });
  });

  it("resolves a custom style file and strips the header block", async () => {
    await writeSettings({ outputStyle: "custom-concise" });
    await writeStyle("concise.md", "name: Concise\ndescription: Short\n\nBe brief.");
    const style = await loadPersistedOutputStyle({ storageRoot: storageRoot() });
    expect(style).toEqual({ name: "Concise", prompt: "Be brief." });
  });

  it("prefers an override file over the built-in constant", async () => {
    await writeSettings({ outputStyle: "explanatory" });
    await writeStyle("explanatory.md", "name: Explanatory\n\nMy custom variant.");
    const style = await loadPersistedOutputStyle({ storageRoot: storageRoot() });
    expect(style).toEqual({ name: "Explanatory", prompt: "My custom variant." });
  });

  it("returns undefined when the resolved prompt is empty", async () => {
    await writeSettings({ outputStyle: "custom-empty" });
    await writeStyle("empty.md", "name: Empty\ndescription: nothing\n");
    await expect(loadPersistedOutputStyle({ storageRoot: storageRoot() })).resolves.toBeUndefined();
  });

  it("sanitizes a crafted active id so it cannot read outside the styles directory", async () => {
    await writeSettings({ outputStyle: "../../etc/passwd" });
    // The sanitized filename does not exist, and no built-in matches, so nothing resolves.
    await expect(loadPersistedOutputStyle({ storageRoot: storageRoot() })).resolves.toBeUndefined();
  });
});
