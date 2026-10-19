import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

  assert.equal(sections.length, 8);
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

test("memory agent defaults are templates that keep their runtime placeholders literal", async () => {
  const service = createSystemPromptService();
  const { sections } = await service.listSections();
  const extraction = sections.find((section) => section.key === "memory-extraction");
  const dream = sections.find((section) => section.key === "memory-dream");
  assert.ok(extraction);
  assert.ok(dream);
  assert.match(extraction.defaultContent, /\{\{messageCount\}\}/);
  assert.match(extraction.defaultContent, /\{\{existingMemories\}\}/);
  assert.match(dream.defaultContent, /\{\{memoryRoot\}\}/);
  assert.match(dream.defaultContent, /\{\{transcriptRoot\}\}/);
  // The runtime-owned tail (tool constraints + session list) is not part of the editable body.
  assert.doesNotMatch(dream.defaultContent, /## Additional context/);
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

function sha256(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf-8")).digest("hex");
}

function sectionOf(
  sections: readonly { key: string; revision?: string | null }[],
  key: string,
): { key: string; revision?: string | null } {
  const section = sections.find((candidate) => candidate.key === key);
  assert.ok(section, `missing section ${key}`);
  return section;
}

test("listSections reports the SHA-256 of the override file bytes, and null when missing", async () => {
  const service = createSystemPromptService();
  let listing = await service.listSections();
  assert.equal(sectionOf(listing.sections, "harness").revision, null);

  await mkdir(overridesDir(), { recursive: true });
  await writeFile(join(overridesDir(), "harness.md"), "# Harness\n- Raw bytes.\n", "utf-8");
  listing = await service.listSections();
  assert.equal(
    sectionOf(listing.sections, "harness").revision,
    sha256("# Harness\n- Raw bytes.\n"),
  );
});

test("writeOverride stores the trimmed text and returns the revision of the stored bytes", async () => {
  const service = createSystemPromptService();
  const result = await service.writeOverride({
    key: "communication",
    content: "\n  Terse.  \n\n",
  });

  assert.deepEqual(result, { kind: "ok", revision: sha256("Terse.") });
  const { sections } = await service.listSections();
  const communication = sectionOf(sections, "communication") as {
    overrideContent: string | null;
    revision: string | null;
  };
  assert.equal(communication.overrideContent, "Terse.");
  assert.equal(communication.revision, sha256("Terse."));
});

test("writeOverride rejects empty or whitespace-only content at the service boundary", async () => {
  const service = createSystemPromptService();
  await assert.rejects(() => service.writeOverride({ key: "harness", content: "" }), /empty/i);
  await assert.rejects(
    () => service.writeOverride({ key: "harness", content: " \n\t " }),
    /empty/i,
  );
  const { sections } = await service.listSections();
  assert.equal(sectionOf(sections, "harness").revision, null);
});

test("writeOverride with a matching expectedRevision writes; a stale one returns a conflict and writes nothing", async () => {
  const service = createSystemPromptService();
  await service.writeOverride({ key: "harness", content: "First." });
  const current = sha256("First.");

  const ok = await service.writeOverride({
    key: "harness",
    content: "Second.",
    expectedRevision: current,
  });
  assert.deepEqual(ok, { kind: "ok", revision: sha256("Second.") });

  const conflict = await service.writeOverride({
    key: "harness",
    content: "Stale save.",
    expectedRevision: current,
  });
  assert.deepEqual(conflict, { kind: "conflict", currentRevision: sha256("Second.") });
  const { sections } = await service.listSections();
  assert.equal(
    (sectionOf(sections, "harness") as { overrideContent: string | null }).overrideContent,
    "Second.",
  );
});

test("expectedRevision null means the file must still be missing", async () => {
  const service = createSystemPromptService();
  await service.writeOverride({ key: "harness", content: "Created elsewhere." });

  const result = await service.writeOverride({
    key: "harness",
    content: "Mine.",
    expectedRevision: null,
  });
  assert.deepEqual(result, { kind: "conflict", currentRevision: sha256("Created elsewhere.") });
});

test("omitting expectedRevision keeps the unchecked write used by older clients", async () => {
  const service = createSystemPromptService();
  await service.writeOverride({ key: "harness", content: "One." });
  const result = await service.writeOverride({ key: "harness", content: "Two." });
  assert.deepEqual(result, { kind: "ok", revision: sha256("Two.") });
});

test("deleteOverride checks expectedRevision and reports a conflict without deleting", async () => {
  const service = createSystemPromptService();
  await service.writeOverride({ key: "communication", content: "Keep me." });

  const conflict = await service.deleteOverride({
    key: "communication",
    expectedRevision: null,
  });
  assert.deepEqual(conflict, { kind: "conflict", currentRevision: sha256("Keep me.") });
  const kept = await service.listSections();
  assert.equal(sectionOf(kept.sections, "communication").revision, sha256("Keep me."));

  const deleted = await service.deleteOverride({
    key: "communication",
    expectedRevision: sha256("Keep me."),
  });
  assert.deepEqual(deleted, { kind: "ok", revision: null });
});

test("deleteOverride on a missing file is ok with a null revision", async () => {
  const service = createSystemPromptService();
  assert.deepEqual(await service.deleteOverride({ key: "harness", expectedRevision: null }), {
    kind: "ok",
    revision: null,
  });
});
