import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { SkillMetadata } from "@zcode/contracts";
import {
  canonicalSkillIdentity,
  filterSkillsByGrants,
  resolveSubagentSkillGrants,
} from "../src/runtime/methods/subagent-skill-grants.js";

// Paths point at nonexistent directories so realpath falls back to the resolved path,
// making identities predictable as resolve(skill.path) on the host platform.
const USER_FOO = "/nonexistent-zcode-tests/user/skills/foo/SKILL.md";
const PROJECT_FOO = "/nonexistent-zcode-tests/project/.zcode/skills/foo/SKILL.md";
const PLUGIN_SP = "/nonexistent-zcode-tests/plugins/superpowers/allowed-skill/SKILL.md";
const PLUGIN_OTHER = "/nonexistent-zcode-tests/plugins/other/allowed-skill/SKILL.md";
const USER_X = "/nonexistent-zcode-tests/user/skills/x/SKILL.md";
const PLUGIN_X = "/nonexistent-zcode-tests/plugins/p1/x/SKILL.md";

function makeSkill(
  name: string,
  path: string,
  overrides: Partial<SkillMetadata> = {},
): SkillMetadata {
  return {
    name,
    description: `${name} description`,
    path,
    directory: dirname(path),
    rootPath: dirname(dirname(path)),
    scope: "user",
    source: "zcode",
    safeToAutoLoad: true,
    frontmatterKeys: [],
    ...overrides,
  };
}

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("canonicalSkillIdentity", () => {
  it("falls back to the resolved path when the file does not exist", async () => {
    const identity = await canonicalSkillIdentity(USER_FOO);
    expect(identity).toBe(resolve(USER_FOO));
    // The SKILL.md file name is kept, not stripped.
    expect(identity.endsWith("SKILL.md")).toBe(true);
  });

  it("resolves a symlinked path to the real directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-skill-identity-"));
    tempDirs.push(dir);
    const realDir = join(dir, "real", "foo");
    await mkdir(realDir, { recursive: true });
    await writeFile(join(realDir, "SKILL.md"), "---\nname: foo\n---\n");
    const linkDir = join(dir, "linked", "foo");
    await mkdir(dirname(linkDir), { recursive: true });
    await symlink(realDir, linkDir, "dir");

    const viaLink = await canonicalSkillIdentity(join(linkDir, "SKILL.md"));
    const viaReal = await canonicalSkillIdentity(join(realDir, "SKILL.md"));
    expect(viaLink).toBe(viaReal);
    expect(viaLink).toBe(join(await realpath(realDir), "SKILL.md"));
  });

  it("lower-cases the identity on win32", async () => {
    // The path does not exist, so realpath falls back; on posix, path.resolve treats
    // a Windows drive path as relative, so only the documented invariants are checked.
    const identity = await canonicalSkillIdentity("C:\\Skills\\Foo\\SKILL.md", "win32");
    expect(identity).toBe(identity.toLowerCase());
    expect(identity).toContain("skill.md");
  });
});

describe("resolveSubagentSkillGrants", () => {
  it("grants only the first non-plugin match in root order for a bare entry (scenario 1)", async () => {
    const userFoo = makeSkill("foo", USER_FOO, { scope: "user" });
    const projectFoo = makeSkill("foo", PROJECT_FOO, { scope: "project" });

    const grants = await resolveSubagentSkillGrants(["foo"], [userFoo, projectFoo]);

    expect(grants.identities.size).toBe(1);
    expect(grants.identities.has(resolve(USER_FOO))).toBe(true);
    expect(grants.identities.has(resolve(PROJECT_FOO))).toBe(false);
    expect(grants.unresolvedEntries).toEqual([]);
    expect(Object.isFrozen(grants.identities)).toBe(true);

    const visible = await filterSkillsByGrants([userFoo, projectFoo], grants.identities);
    expect(visible).toEqual([userFoo]);
    expect(visible.filter((skill) => skill.name === "foo")).toHaveLength(1);
  });

  it("grants the project copy when the user copy is absent (scenario 2)", async () => {
    const projectFoo = makeSkill("foo", PROJECT_FOO, { scope: "project" });

    const grants = await resolveSubagentSkillGrants(["foo"], [projectFoo]);

    expect(grants.identities.size).toBe(1);
    expect(grants.identities.has(resolve(PROJECT_FOO))).toBe(true);
    expect(await filterSkillsByGrants([projectFoo], grants.identities)).toEqual([projectFoo]);
  });

  it("counts symlinked copies sharing one identity as one grant (scenario 3)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-skill-grants-"));
    tempDirs.push(dir);
    const realDir = join(dir, "real", "foo");
    await mkdir(realDir, { recursive: true });
    await writeFile(join(realDir, "SKILL.md"), "---\nname: foo\n---\n");
    const linkDir = join(dir, "linked", "foo");
    await mkdir(dirname(linkDir), { recursive: true });
    await symlink(realDir, linkDir, "dir");

    const realSkill = makeSkill("foo", join(realDir, "SKILL.md"));
    const linkedSkill = makeSkill("foo", join(linkDir, "SKILL.md"));

    const grants = await resolveSubagentSkillGrants(["foo"], [realSkill, linkedSkill]);

    expect(grants.identities.size).toBe(1);
    const visible = await filterSkillsByGrants([realSkill, linkedSkill], grants.identities);
    expect(visible).toHaveLength(1);
    expect(visible[0]).toBe(realSkill);
  });

  it("resolves a qualified plugin entry to that plugin only, and a bare plugin name to all copies (scenario 4)", async () => {
    const superpowers = makeSkill("allowed-skill", PLUGIN_SP, {
      source: "plugin",
      pluginId: "superpowers",
      qualifiedName: "superpowers:allowed-skill",
    });
    const other = makeSkill("allowed-skill", PLUGIN_OTHER, {
      source: "plugin",
      pluginId: "other-plugin",
      qualifiedName: "other-plugin:allowed-skill",
    });
    const skills = [superpowers, other];

    const qualified = await resolveSubagentSkillGrants(["superpowers:allowed-skill"], skills);
    expect(qualified.identities.size).toBe(1);
    expect(qualified.identities.has(resolve(PLUGIN_SP))).toBe(true);
    expect(qualified.identities.has(resolve(PLUGIN_OTHER))).toBe(false);

    const bare = await resolveSubagentSkillGrants(["allowed-skill"], skills);
    expect(bare.identities.size).toBe(2);
    expect(bare.identities.has(resolve(PLUGIN_SP))).toBe(true);
    expect(bare.identities.has(resolve(PLUGIN_OTHER))).toBe(true);
  });

  it("does not grant plugin copies when a non-plugin skill matches a bare entry (scenario 5a)", async () => {
    const userX = makeSkill("x", USER_X, { scope: "user" });
    const pluginX = makeSkill("x", PLUGIN_X, {
      source: "plugin",
      pluginId: "p1",
      qualifiedName: "p1:x",
    });

    const grants = await resolveSubagentSkillGrants(["x"], [userX, pluginX]);

    expect(grants.identities.size).toBe(1);
    expect(grants.identities.has(resolve(USER_X))).toBe(true);
    expect(grants.identities.has(resolve(PLUGIN_X))).toBe(false);

    const visible = await filterSkillsByGrants([userX, pluginX], grants.identities);
    expect(visible).toEqual([userX]);
  });

  it("reports an unmatched entry without granting anything (scenario 9)", async () => {
    const userFoo = makeSkill("foo", USER_FOO);
    const grants = await resolveSubagentSkillGrants(["missing", "foo"], [userFoo]);

    expect(grants.identities.size).toBe(1);
    expect(grants.identities.has(resolve(USER_FOO))).toBe(true);
    expect(grants.unresolvedEntries).toEqual(["missing"]);
  });

  it("ignores empty and whitespace-only entries", async () => {
    const grants = await resolveSubagentSkillGrants(["", "   ", "\t"], []);
    expect(grants.identities.size).toBe(0);
    expect(grants.unresolvedEntries).toEqual([]);
  });

  it("trims entries before matching", async () => {
    const userFoo = makeSkill("foo", USER_FOO);
    const grants = await resolveSubagentSkillGrants(["  foo  "], [userFoo]);
    expect(grants.identities.has(resolve(USER_FOO))).toBe(true);
    expect(grants.unresolvedEntries).toEqual([]);
  });
});

describe("filterSkillsByGrants", () => {
  it("keeps only granted skills and only the first skill per identity", async () => {
    const foo = makeSkill("foo", USER_FOO);
    const bar = makeSkill("bar", PROJECT_FOO.replace("foo", "bar"));
    const identities = new Set([await canonicalSkillIdentity(USER_FOO)]);

    const visible = await filterSkillsByGrants([foo, makeSkill("foo-alias", USER_FOO), bar], identities);

    expect(visible).toEqual([foo]);
  });
});
