import { existsSync, statSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsSpy = vi.hoisted(() => ({
  frozenStats: new Map<string, unknown>(),
  readPaths: [] as string[],
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: ((path: Parameters<typeof actual.readFileSync>[0], ...rest: unknown[]) => {
      if (typeof path === "string") fsSpy.readPaths.push(path);
      return (actual.readFileSync as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof actual.readFileSync,
    // Simulates a coarse-timestamp filesystem: a frozen path keeps returning the stat captured
    // when it was frozen, even after its bytes change.
    statSync: ((path: Parameters<typeof actual.statSync>[0], ...rest: unknown[]) => {
      if (typeof path === "string" && fsSpy.frozenStats.has(path)) {
        return fsSpy.frozenStats.get(path);
      }
      return (actual.statSync as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof actual.statSync,
  };
});

import { resolveOfficialPluginRoots } from "../src/app/bundled-plugins.js";

const PACKAGES_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKILL_CREATOR_CACHE = join("cache", "zcode-plugins-official", "skill-creator", "0.1.0");
const SKILL_FILE = join("skills", "skill-creator", "SKILL.md");

describe("bundled official plugin seed hash memo", () => {
  const cleanups: string[] = [];
  const originalEntrypoint = process.argv[1];
  let sourceRoot: string;
  let storageRoot: string;

  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-seed-hash-memo-"));
    cleanups.push(root);
    // The entrypoint directory is the first seed candidate, so this copy shadows the monorepo
    // skill-creator source while every other official plugin still resolves from the checkout.
    const entrypointRoot = join(root, "entrypoint");
    sourceRoot = join(entrypointRoot, "packages", "skill-creator-plugin");
    await cp(join(PACKAGES_ROOT, "skill-creator-plugin"), sourceRoot, { recursive: true });
    process.argv[1] = join(entrypointRoot, "zcode.cjs");
    storageRoot = join(root, "plugins");
    resolveOfficialPluginRoots({ storageRoot });
    fsSpy.readPaths = [];
  });

  afterEach(async () => {
    process.argv[1] = originalEntrypoint;
    await Promise.all(cleanups.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  });

  function sourceReads(): string[] {
    return fsSpy.readPaths.filter((path) => path.startsWith(`${sourceRoot}${sep}`));
  }

  function cachedSkillFile(): string {
    return join(storageRoot, SKILL_CREATOR_CACHE, SKILL_FILE);
  }

  it("does not re-read unchanged seed source files on repeated resolution", async () => {
    const markerBefore = await readFile(
      join(storageRoot, SKILL_CREATOR_CACHE, ".zcode-plugin-seed.json"),
      "utf8",
    );

    resolveOfficialPluginRoots({ storageRoot });

    // plugin.json is still read on purpose: the marketplace description and runtime manifest are
    // derived from it on every call. Hashing must not read anything.
    expect(sourceReads().filter((path) => !path.endsWith("plugin.json"))).toEqual([]);
    expect(
      await readFile(join(storageRoot, SKILL_CREATOR_CACHE, ".zcode-plugin-seed.json"), "utf8"),
    ).toBe(markerBefore);
  });

  it("re-hashes and re-seeds a source file whose content changed", async () => {
    const sourceSkill = join(sourceRoot, SKILL_FILE);
    await writeFile(sourceSkill, `${await readFile(sourceSkill, "utf8")}\nchanged content\n`);

    resolveOfficialPluginRoots({ storageRoot });

    expect(await readFile(cachedSkillFile(), "utf8")).toContain("changed content");
  });

  it("detects a same-size edit that keeps the exact mtime (ctime changes)", async () => {
    const sourceSkill = join(sourceRoot, SKILL_FILE);
    // A whole-second time round-trips exactly through utimes, so only ctime can differ.
    const pinned = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
    await utimes(sourceSkill, pinned, pinned);
    resolveOfficialPluginRoots({ storageRoot });
    const original = await readFile(sourceSkill, "utf8");
    const edited = `${original.slice(0, -1)}${original.endsWith("X") ? "Y" : "X"}`;
    expect(edited.length).toBe(original.length);

    await writeFile(sourceSkill, edited);
    await utimes(sourceSkill, pinned, pinned);
    expect((await stat(sourceSkill, { bigint: true })).mtimeNs).toBe(
      BigInt(pinned.getTime()) * 1_000_000n,
    );
    resolveOfficialPluginRoots({ storageRoot });

    expect(await readFile(cachedSkillFile(), "utf8")).toBe(edited);
  });

  it("recovers after a hash mismatch caused by an edit the stat signature missed", async () => {
    const sourceSkill = join(sourceRoot, SKILL_FILE);
    const original = await readFile(sourceSkill, "utf8");
    fsSpy.frozenStats.set(sourceSkill, statSync(sourceSkill, { bigint: true }));
    const edited = `${original.slice(0, -1)}${original.endsWith("X") ? "Y" : "X"}`;
    await writeFile(sourceSkill, edited);
    // An unrelated edit forces a re-seed; the copy then sees bytes that no longer match the
    // memoized hash of the frozen file.
    const packageJson = join(sourceRoot, "package.json");
    await writeFile(packageJson, `${await readFile(packageJson, "utf8")}\n`);

    try {
      expect(() => resolveOfficialPluginRoots({ storageRoot })).toThrow(/hash mismatch/u);
      resolveOfficialPluginRoots({ storageRoot });
    } finally {
      fsSpy.frozenStats.clear();
    }

    expect(await readFile(cachedSkillFile(), "utf8")).toBe(edited);
  });

  it("follows added and removed source files", async () => {
    const addedRelative = join("skills", "added-skill", "SKILL.md");
    await cp(join(sourceRoot, SKILL_FILE), join(sourceRoot, addedRelative), { recursive: true });

    resolveOfficialPluginRoots({ storageRoot });
    expect(existsSync(join(storageRoot, SKILL_CREATOR_CACHE, addedRelative))).toBe(true);

    await rm(join(sourceRoot, "skills", "added-skill"), { force: true, recursive: true });
    resolveOfficialPluginRoots({ storageRoot });
    expect(existsSync(join(storageRoot, SKILL_CREATOR_CACHE, addedRelative))).toBe(false);
  });
});
