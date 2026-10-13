import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { composeMemoryGuidanceDefault, SYSTEM_PROMPT_DEFAULTS } from "@zcode/shared";
import { createSystemPromptService } from "../src/system-prompt/systemPromptService.js";

let tempHome = "";
let previousHome: string | undefined;
let previousUserProfile: string | undefined;

beforeEach(async () => {
  previousHome = process.env.HOME;
  previousUserProfile = process.env.USERPROFILE;
  tempHome = await mkdtemp(join(tmpdir(), "zcode-system-prompt-service-"));
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

function overridesDir(): string {
  return join(tempHome, ".zcode", "system-prompt");
}

test("listSections returns defaults with no overrides on a fresh install", async () => {
  const service = createSystemPromptService();
  const { sections } = await service.listSections();

  assert.equal(sections.length, 6);
  for (const section of sections) {
    const expectedDefault =
      section.key === "memory-guidance"
        ? composeMemoryGuidanceDefault("default-index")
        : SYSTEM_PROMPT_DEFAULTS[section.key as keyof typeof SYSTEM_PROMPT_DEFAULTS];
    assert.equal(section.defaultContent, expectedDefault);
    assert.equal(section.overrideContent, null);
    assert.equal(section.isOverridden, false);
    assert.equal(section.filePath, join(overridesDir(), `${section.key}.md`));
  }
});

test("memory-guidance default matches the active runtime branch, including the MEMORY.md pointer", async () => {
  // The active retrieval branch (default-index) renders one extra paragraph — the MEMORY.md
  // index pointer. The service must report that complete default, or a Settings diff/restore
  // preview would disagree with the prompt the runtime produces after deleting an override.
  const service = createSystemPromptService();
  const { sections } = await service.listSections();
  const memory = sections.find((section) => section.key === "memory-guidance");
  assert.ok(memory);
  assert.equal(memory.defaultContent, composeMemoryGuidanceDefault("default-index"));
  assert.match(memory.defaultContent, /add a one-line pointer in `MEMORY\.md`/);
});

test("getOverridesDirectory is a pure lookup and never creates the directory", async () => {
  const service = createSystemPromptService();
  const { path } = await service.getOverridesDirectory();
  assert.equal(path, overridesDir());
  assert.equal(
    await stat(overridesDir()).then(
      () => true,
      () => false,
    ),
    false,
  );
});

test("writeOverride then listSections marks the section overridden", async () => {
  const service = createSystemPromptService();
  await service.writeOverride({ key: "harness", content: "# Harness\n- Mine." });

  const { sections } = await service.listSections();
  const harness = sections.find((section) => section.key === "harness");
  assert.ok(harness);
  assert.equal(harness.isOverridden, true);
  assert.equal(harness.overrideContent, "# Harness\n- Mine.");
  assert.equal(harness.defaultContent, SYSTEM_PROMPT_DEFAULTS.harness);
});

test("whitespace-only override files are ignored, matching the CLI loader", async () => {
  await mkdir(overridesDir(), { recursive: true });
  await writeFile(join(overridesDir(), "communication.md"), "  \n", "utf-8");

  const service = createSystemPromptService();
  const { sections } = await service.listSections();
  assert.equal(sections.find((section) => section.key === "communication")?.isOverridden, false);
});

test("deleteOverride restores the default", async () => {
  const service = createSystemPromptService();
  await service.writeOverride({ key: "communication", content: "Terse." });
  await service.deleteOverride({ key: "communication" });

  const { sections } = await service.listSections();
  assert.equal(sections.find((section) => section.key === "communication")?.isOverridden, false);
});

test("writeOverride and deleteOverride reject keys outside the whitelist", async () => {
  const service = createSystemPromptService();
  await assert.rejects(() => service.writeOverride({ key: "../../evil", content: "x" }));
  await assert.rejects(() => service.writeOverride({ key: "environment", content: "x" }));
  await assert.rejects(() => service.deleteOverride({ key: "no-such-key" }));
});

test("writeOverride commits atomically: no temp files remain and content is complete", async () => {
  const service = createSystemPromptService();
  await service.writeOverride({ key: "harness", content: "# Harness\n- Atomic." });

  const entries = await readdir(overridesDir());
  assert.deepEqual(entries, ["harness.md"]);
  const { sections } = await service.listSections();
  assert.equal(
    sections.find((section) => section.key === "harness")?.overrideContent,
    "# Harness\n- Atomic.",
  );
});

test("an unreadable override file degrades to the default without failing the listing", async () => {
  // A directory named like the override file makes readFile fail with EISDIR, a non-ENOENT
  // error that must surface in logs but still leave the section listed with its default.
  await mkdir(join(overridesDir(), "harness.md"), { recursive: true });

  const service = createSystemPromptService();
  const { sections } = await service.listSections();
  const harness = sections.find((section) => section.key === "harness");
  assert.ok(harness);
  assert.equal(harness.isOverridden, false);
});
