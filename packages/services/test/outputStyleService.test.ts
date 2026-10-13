import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
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

async function writeStyleFile(filename: string, content: string): Promise<void> {
  await mkdir(zcodeStylesDir(), { recursive: true });
  await writeFile(join(zcodeStylesDir(), filename), content, "utf-8");
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

test("getActiveStyle returns null without a settings file", async () => {
  const service = createOutputStyleService();
  const active = await service.getActiveStyle();
  assert.equal(active.styleId, null);
});

test("listStyles lists custom styles with parsed prompt bodies", async () => {
  await writeStyleFile(
    "concise.md",
    "name: Concise Reviews\ndescription: Short review responses\n\nBe brief.",
  );

  const service = createOutputStyleService();
  const { styles } = await service.listStyles();

  const concise = styles.find((style) => style.id === "custom-concise");
  assert.ok(concise);
  assert.equal(concise.name, "Concise Reviews");
  assert.equal(concise.description, "Short review responses");
  assert.equal(concise.content, "Be brief.");
  assert.equal(concise.filePath, join(zcodeStylesDir(), "concise.md"));
});

test("addStyle sanitizes the filename so names cannot escape the styles directory", async () => {
  const service = createOutputStyleService();
  await service.addStyle({
    config: { name: "../../.ssh/evil", description: "x", content: "P." },
  });
  await service.addStyle({
    config: { name: "a/b\\c", description: "x", content: "Q." },
  });

  const files = await readdir(zcodeStylesDir());
  assert.ok(files.includes(".....sshevil.md"));
  assert.ok(files.includes("abc.md"));
  // Only files inside the styles directory exist; nothing leaked to tempHome itself.
  const homeEntries = await readdir(tempHome);
  assert.deepEqual(
    homeEntries.filter((entry) => entry.startsWith(".") && entry !== ".zcode"),
    [],
  );
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

test("deleteStyle with a crafted id stays inside the styles directory", async () => {
  const service = createOutputStyleService();
  // Must not throw ENOENT-related surprises nor touch anything outside; rm targets the
  // sanitized path inside the (nonexistent) styles directory with force: true.
  await service.deleteStyle({ id: "../../outside" });
  assert.equal(
    await stat(join(tempHome, "outside.md")).then(
      () => true,
      () => false,
    ),
    false,
  );
});
