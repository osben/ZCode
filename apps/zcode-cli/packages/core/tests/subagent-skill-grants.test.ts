import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import type { SkillMetadata } from "@zcode/contracts";
import {
  filterSkillsByGrants,
  resolveSubagentSkillGrants,
  skillIdentity,
} from "../src/runtime/methods/subagent-skill-grants.js";

// Identities come from discovered metadata (the adapter sets `identity`); core does no I/O, so
// skills without `identity` are identified by `path`.
const USER_FOO = "/zcode-tests/user/skills/foo/SKILL.md";
const PROJECT_FOO = "/zcode-tests/project/.zcode/skills/foo/SKILL.md";
const PLUGIN_SP = "/zcode-tests/plugins/superpowers/allowed-skill/SKILL.md";
const PLUGIN_OTHER = "/zcode-tests/plugins/other/allowed-skill/SKILL.md";
const USER_X = "/zcode-tests/user/skills/x/SKILL.md";
const PLUGIN_X = "/zcode-tests/plugins/p1/x/SKILL.md";

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

describe("skillIdentity", () => {
  it("uses the adapter-provided identity", () => {
    const skill = makeSkill("foo", "/linked/foo/SKILL.md", { identity: "/real/foo/SKILL.md" });
    expect(skillIdentity(skill)).toBe("/real/foo/SKILL.md");
  });

  it("falls back to the path when the port sets no identity", () => {
    expect(skillIdentity(makeSkill("foo", USER_FOO))).toBe(USER_FOO);
  });
});

describe("resolveSubagentSkillGrants", () => {
  it("grants only the first non-plugin match in root order for a bare entry (scenario 1)", () => {
    const userFoo = makeSkill("foo", USER_FOO, { scope: "user" });
    const projectFoo = makeSkill("foo", PROJECT_FOO, { scope: "project" });

    const grants = resolveSubagentSkillGrants(["foo"], [userFoo, projectFoo]);

    expect(grants.identities.size).toBe(1);
    expect(grants.identities.has(USER_FOO)).toBe(true);
    expect(grants.identities.has(PROJECT_FOO)).toBe(false);
    expect(grants.unresolvedEntries).toEqual([]);
    expect(Object.isFrozen(grants.identities)).toBe(true);

    const visible = filterSkillsByGrants([userFoo, projectFoo], grants.identities);
    expect(visible).toEqual([userFoo]);
    expect(visible.filter((skill) => skill.name === "foo")).toHaveLength(1);
  });

  it("grants the project copy when the user copy is absent (scenario 2)", () => {
    const projectFoo = makeSkill("foo", PROJECT_FOO, { scope: "project" });

    const grants = resolveSubagentSkillGrants(["foo"], [projectFoo]);

    expect(grants.identities.size).toBe(1);
    expect(grants.identities.has(PROJECT_FOO)).toBe(true);
    expect(filterSkillsByGrants([projectFoo], grants.identities)).toEqual([projectFoo]);
  });

  it("counts symlinked copies sharing one identity as one grant (scenario 3)", () => {
    const realSkill = makeSkill("foo", "/zcode-tests/real/foo/SKILL.md", {
      identity: "/zcode-tests/real/foo/SKILL.md",
    });
    const linkedSkill = makeSkill("foo", "/zcode-tests/linked/foo/SKILL.md", {
      identity: "/zcode-tests/real/foo/SKILL.md",
    });

    const grants = resolveSubagentSkillGrants(["foo"], [realSkill, linkedSkill]);

    expect(grants.identities.size).toBe(1);
    const visible = filterSkillsByGrants([realSkill, linkedSkill], grants.identities);
    expect(visible).toHaveLength(1);
    expect(visible[0]).toBe(realSkill);
  });

  it("resolves a qualified plugin entry to that plugin only, and a bare plugin name to all copies (scenario 4)", () => {
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

    const qualified = resolveSubagentSkillGrants(["superpowers:allowed-skill"], skills);
    expect(qualified.identities.size).toBe(1);
    expect(qualified.identities.has(PLUGIN_SP)).toBe(true);
    expect(qualified.identities.has(PLUGIN_OTHER)).toBe(false);

    const bare = resolveSubagentSkillGrants(["allowed-skill"], skills);
    expect(bare.identities.size).toBe(2);
    expect(bare.identities.has(PLUGIN_SP)).toBe(true);
    expect(bare.identities.has(PLUGIN_OTHER)).toBe(true);
  });

  it("does not grant plugin copies when a non-plugin skill matches a bare entry (scenario 5a)", () => {
    const userX = makeSkill("x", USER_X, { scope: "user" });
    const pluginX = makeSkill("x", PLUGIN_X, {
      source: "plugin",
      pluginId: "p1",
      qualifiedName: "p1:x",
    });

    const grants = resolveSubagentSkillGrants(["x"], [userX, pluginX]);

    expect(grants.identities.size).toBe(1);
    expect(grants.identities.has(USER_X)).toBe(true);
    expect(grants.identities.has(PLUGIN_X)).toBe(false);

    const visible = filterSkillsByGrants([userX, pluginX], grants.identities);
    expect(visible).toEqual([userX]);
  });

  it("reports an unmatched entry without granting anything (scenario 9)", () => {
    const userFoo = makeSkill("foo", USER_FOO);
    const grants = resolveSubagentSkillGrants(["missing", "foo"], [userFoo]);

    expect(grants.identities.size).toBe(1);
    expect(grants.identities.has(USER_FOO)).toBe(true);
    expect(grants.unresolvedEntries).toEqual(["missing"]);
  });

  it("ignores empty and whitespace-only entries", () => {
    const grants = resolveSubagentSkillGrants(["", "   ", "\t"], []);
    expect(grants.identities.size).toBe(0);
    expect(grants.unresolvedEntries).toEqual([]);
  });

  it("trims entries before matching", () => {
    const userFoo = makeSkill("foo", USER_FOO);
    const grants = resolveSubagentSkillGrants(["  foo  "], [userFoo]);
    expect(grants.identities.has(USER_FOO)).toBe(true);
    expect(grants.unresolvedEntries).toEqual([]);
  });
});

describe("filterSkillsByGrants", () => {
  it("keeps only granted skills and only the first skill per identity", () => {
    const foo = makeSkill("foo", USER_FOO);
    const bar = makeSkill("bar", PROJECT_FOO.replace("foo", "bar"));
    const identities = new Set([USER_FOO]);

    const visible = filterSkillsByGrants([foo, makeSkill("foo-alias", USER_FOO), bar], identities);

    expect(visible).toEqual([foo]);
  });
});
