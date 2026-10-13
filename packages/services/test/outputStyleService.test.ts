import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { createOutputStyleService } from "../src/output-style/outputStyleService.js";

let tempHome = "";
let previousHome: string | undefined;
let previousUserProfile: string | undefined;

beforeEach(async () => {
  previousHome = process.env.HOME;
  previousUserProfile = process.env.USERPROFILE;
  tempHome = await mkdtemp(join(tmpdir(), "zcode-output-style-"));
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

function zcodeStylesDir(): string {
  return join(tempHome, ".zcode", "output-styles");
}

function claudeStylesDir(): string {
  return join(tempHome, ".claude", "output-styles");
}

async function writeStyleFile(dir: string, filename: string, content: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, filename), content, "utf-8");
}

test("built-in styles expose the shared constant prompt text", async () => {
  const service = createOutputStyleService();
  const { styles } = await service.listStyles();

  const byId = new Map(styles.map((style) => [style.id, style]));
  assert.equal(byId.get("default")?.content, "");
  assert.ok(byId.get("explanatory")?.content.length! > 0);
  assert.ok(byId.get("learning")?.content.length! > 0);
});

test("getUserStylesDirectory returns the path without creating the directory", async () => {
  const service = createOutputStyleService();
  const { path } = await service.getUserStylesDirectory();
  assert.equal(path, zcodeStylesDir());
  // Reading the storage location must stay side-effect free: a fresh install should not
  // grow an empty output-styles directory just from opening Settings.
  assert.equal(
    await stat(zcodeStylesDir()).then(
      () => true,
      () => false,
    ),
    false,
  );
});

test("setActiveStyle writes the zcode settings file and reads it back", async () => {
  const service = createOutputStyleService();
  await service.setActiveStyle({ styleId: "explanatory" });

  const active = await service.getActiveStyle();
  assert.equal(active.styleId, "explanatory");

  const { styles } = await service.listStyles();
  assert.equal(styles.find((style) => style.id === "explanatory")?.enabled, true);
});

test("getActiveStyle falls back to the legacy claude settings file", async () => {
  await mkdir(join(tempHome, ".claude"), { recursive: true });
  await writeFile(
    join(tempHome, ".claude", "settings.json"),
    JSON.stringify({ outputStyle: "learning" }),
    "utf-8",
  );

  const service = createOutputStyleService();
  const active = await service.getActiveStyle();
  assert.equal(active.styleId, "learning");
});

test("listStyles merges custom styles from zcode and legacy claude directories", async () => {
  await writeStyleFile(
    zcodeStylesDir(),
    "concise.md",
    "name: Concise Reviews\ndescription: Short review responses\n\nBe brief.",
  );
  await writeStyleFile(
    claudeStylesDir(),
    "legacy-tone.md",
    "name: Legacy Tone\ndescription: Old setup\n\nUse the old tone.",
  );

  const service = createOutputStyleService();
  const { styles } = await service.listStyles();

  const concise = styles.find((style) => style.id === "custom-concise");
  assert.ok(concise);
  assert.equal(concise.name, "Concise Reviews");
  assert.equal(concise.description, "Short review responses");
  assert.equal(concise.content, "Be brief.");
  assert.equal(concise.filePath, join(zcodeStylesDir(), "concise.md"));

  const legacy = styles.find((style) => style.id === "custom-legacy-tone");
  assert.ok(legacy);
  assert.equal(legacy.name, "Legacy Tone");
});

test("a zcode file wins over a legacy file with the same name", async () => {
  await writeStyleFile(zcodeStylesDir(), "tone.md", "name: New Tone\n\nNew prompt.");
  await writeStyleFile(claudeStylesDir(), "tone.md", "name: Old Tone\n\nOld prompt.");

  const service = createOutputStyleService();
  const { styles } = await service.listStyles();

  const toneStyles = styles.filter((style) => style.id === "custom-tone");
  assert.equal(toneStyles.length, 1);
  assert.equal(toneStyles[0]?.name, "New Tone");
});

test("updateStyle on a built-in id writes an override file; deleteStyle removes it", async () => {
  const service = createOutputStyleService();
  await service.updateStyle({
    id: "explanatory",
    config: { name: "Explanatory", description: "Customized", content: "Custom prompt." },
  });

  const { styles } = await service.listStyles();
  // The override folds into the built-in entry: effective content from the file, no duplicate row.
  const overridden = styles.find((style) => style.id === "explanatory");
  assert.ok(overridden);
  assert.equal(overridden.isOverridden, true);
  assert.equal(overridden.content, "Custom prompt.");
  assert.equal(overridden.filePath, join(zcodeStylesDir(), "explanatory.md"));
  assert.ok(!styles.some((style) => style.id === "custom-explanatory"));

  await service.deleteStyle({ id: "explanatory" });
  const after = await service.listStyles();
  const restored = after.styles.find((style) => style.id === "explanatory");
  assert.ok(restored);
  assert.notEqual(restored.isOverridden, true);
  assert.ok(restored.content.length > 0);
});
