import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDefinitionFilesAdapter } from "./files.js";

let base: string;
let skillRoot: string;
let outside: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "definition-preview-"));
  skillRoot = join(base, "skills", "skill-creator");
  outside = join(base, "outside");
  await mkdir(join(skillRoot, "references"), { recursive: true });
  await mkdir(join(skillRoot, "scripts"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(skillRoot, "SKILL.md"), "---\nname: skill-creator\n---\n# Skill\n");
  await writeFile(join(skillRoot, "references", "schemas.md"), "# Schemas\n");
  await writeFile(join(skillRoot, "scripts", "init.py"), "print('hi')\n");
  await writeFile(join(outside, "secret.md"), "secret\n");
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("listTree", () => {
  it("lists directories before files, with sizes and POSIX relative paths", async () => {
    const listing = await createDefinitionFilesAdapter().listTree(skillRoot);
    expect(listing?.truncated).toBe(false);
    expect(listing?.tree.map((entry) => [entry.relativePath, entry.kind])).toEqual([
      ["references", "directory"],
      ["references/schemas.md", "file"],
      ["scripts", "directory"],
      ["scripts/init.py", "file"],
      ["SKILL.md", "file"],
    ]);
    expect(listing?.tree.find((entry) => entry.relativePath === "SKILL.md")?.size).toBeGreaterThan(
      0,
    );
  });

  it("shows symlinks as links without following them", async () => {
    await symlink(outside, join(skillRoot, "escape"));
    const listing = await createDefinitionFilesAdapter().listTree(skillRoot);
    expect(listing?.tree).toContainEqual({ relativePath: "escape", kind: "link" });
    expect(listing?.tree.some((entry) => entry.relativePath.startsWith("escape/"))).toBe(false);
  });

  it("skips excluded and dot directories", async () => {
    await mkdir(join(skillRoot, "node_modules", "pkg"), { recursive: true });
    await mkdir(join(skillRoot, ".git"), { recursive: true });
    const listing = await createDefinitionFilesAdapter().listTree(skillRoot);
    const paths = listing?.tree.map((entry) => entry.relativePath) ?? [];
    expect(paths.some((path) => path.startsWith("node_modules"))).toBe(false);
    expect(paths.some((path) => path.startsWith(".git"))).toBe(false);
  });

  it("reports truncated when the entry cap is hit", async () => {
    const listing = await createDefinitionFilesAdapter({ maxTreeEntries: 2 }).listTree(skillRoot);
    expect(listing?.tree).toHaveLength(2);
    expect(listing?.truncated).toBe(true);
  });

  it("stops descending at the depth limit", async () => {
    await mkdir(join(skillRoot, "a", "b", "c"), { recursive: true });
    await writeFile(join(skillRoot, "a", "b", "c", "deep.md"), "deep\n");
    const listing = await createDefinitionFilesAdapter({ maxDepth: 2 }).listTree(skillRoot);
    const paths = listing?.tree.map((entry) => entry.relativePath) ?? [];
    expect(paths).toContain("a/b");
    expect(paths).not.toContain("a/b/c");
  });

  it("follows a symlinked root once, as discovery does for imported skills", async () => {
    const linkedRoot = join(base, "linked-skill");
    await symlink(skillRoot, linkedRoot);
    const listing = await createDefinitionFilesAdapter().listTree(linkedRoot);
    expect(listing?.tree.map((entry) => entry.relativePath)).toContain("SKILL.md");
  });

  it("returns null for a missing root or a file root", async () => {
    const adapter = createDefinitionFilesAdapter();
    expect(await adapter.listTree(join(base, "missing"))).toBeNull();
    expect(await adapter.listTree(join(skillRoot, "SKILL.md"))).toBeNull();
  });
});

describe("readFile", () => {
  it("reads a nested text file", async () => {
    const result = await createDefinitionFilesAdapter().readFile(skillRoot, [
      "references",
      "schemas.md",
    ]);
    expect(result).toEqual({
      status: "text",
      relativePath: "references/schemas.md",
      content: "# Schemas\n",
      size: 10,
    });
  });

  it("rejects a symlink that points outside the root", async () => {
    await symlink(join(outside, "secret.md"), join(skillRoot, "leak.md"));
    expect(await createDefinitionFilesAdapter().readFile(skillRoot, ["leak.md"])).toEqual({
      status: "rejected",
    });
  });

  it("rejects a symlink even when it points inside the root", async () => {
    await symlink(join(skillRoot, "SKILL.md"), join(skillRoot, "alias.md"));
    expect(await createDefinitionFilesAdapter().readFile(skillRoot, ["alias.md"])).toEqual({
      status: "rejected",
    });
  });

  it("rejects a path through a symlinked directory", async () => {
    await symlink(outside, join(skillRoot, "escape"));
    expect(
      await createDefinitionFilesAdapter().readFile(skillRoot, ["escape", "secret.md"]),
    ).toEqual({ status: "rejected" });
  });

  it("returns not_found for missing files and directories", async () => {
    const adapter = createDefinitionFilesAdapter();
    expect(await adapter.readFile(skillRoot, ["missing.md"])).toEqual({ status: "not_found" });
    expect(await adapter.readFile(skillRoot, ["references"])).toEqual({ status: "not_found" });
    expect(await adapter.readFile(skillRoot, ["SKILL.md", "child"])).toEqual({
      status: "not_found",
    });
  });

  it("does not read inside directories the tree hides or beyond the depth limit", async () => {
    await mkdir(join(skillRoot, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(skillRoot, "node_modules", "pkg", "index.js"), "x\n");
    await mkdir(join(skillRoot, ".git"), { recursive: true });
    await writeFile(join(skillRoot, ".git", "config"), "x\n");
    await mkdir(join(skillRoot, "a", "b"), { recursive: true });
    await writeFile(join(skillRoot, "a", "b", "deep.md"), "deep\n");
    await writeFile(join(skillRoot, ".env.example"), "KEY=\n");
    const adapter = createDefinitionFilesAdapter({ maxDepth: 2 });
    expect(await adapter.readFile(skillRoot, ["node_modules", "pkg", "index.js"])).toEqual({
      status: "not_found",
    });
    expect(await adapter.readFile(skillRoot, [".git", "config"])).toEqual({ status: "not_found" });
    expect(await adapter.readFile(skillRoot, ["a", "b", "deep.md"])).toEqual({
      status: "not_found",
    });
    // Dot files at a listed level stay readable, matching the tree.
    expect((await adapter.readFile(skillRoot, [".env.example"])).status).toBe("text");
    const listed = (await adapter.listTree(skillRoot))?.tree.map((entry) => entry.relativePath);
    expect(listed).toContain(".env.example");
    expect(listed).not.toContain("a/b/deep.md");
  });

  it("reports binary content instead of returning it", async () => {
    await writeFile(join(skillRoot, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    await writeFile(join(skillRoot, "latin1.txt"), Buffer.from([0xff, 0xfe, 0x41]));
    const adapter = createDefinitionFilesAdapter();
    expect(await adapter.readFile(skillRoot, ["logo.png"])).toEqual({
      status: "binary",
      relativePath: "logo.png",
      size: 6,
    });
    expect((await adapter.readFile(skillRoot, ["latin1.txt"])).status).toBe("binary");
  });

  it("reports files over the text cap as too_large", async () => {
    await writeFile(join(skillRoot, "big.md"), "x".repeat(64));
    expect(
      await createDefinitionFilesAdapter({ maxTextBytes: 16 }).readFile(skillRoot, ["big.md"]),
    ).toEqual({ status: "too_large", relativePath: "big.md", size: 64, limit: 16 });
  });
});

describe("readSingleFile", () => {
  it("reads a regular file and follows a Host-derived symlinked file once", async () => {
    const agentFile = join(base, "reviewer.md");
    await writeFile(agentFile, "---\nname: reviewer\n---\n");
    const linked = join(base, "linked-reviewer.md");
    await symlink(agentFile, linked);
    const adapter = createDefinitionFilesAdapter();
    expect(await adapter.readSingleFile(agentFile)).toMatchObject({
      status: "text",
      relativePath: "reviewer.md",
    });
    expect(await adapter.readSingleFile(linked)).toMatchObject({
      status: "text",
      relativePath: "linked-reviewer.md",
    });
    expect(await adapter.isRegularFile(linked)).toBe(true);
  });

  it("returns not_found for missing files and directories", async () => {
    const adapter = createDefinitionFilesAdapter();
    expect(await adapter.readSingleFile(join(base, "missing.md"))).toEqual({ status: "not_found" });
    expect(await adapter.readSingleFile(skillRoot)).toEqual({ status: "not_found" });
    expect(await adapter.isRegularFile(skillRoot)).toBe(false);
  });
});
