import type { SkillMetadata, SkillPort } from "@zcode/contracts";

/** One discoverable project skill; loading is not exercised by the tests that use it. */
export function createTestSkillPort(name: string): SkillPort {
  const skill: SkillMetadata = {
    name,
    description: `${name} description`,
    path: `/workspace/.zcode/skills/${name}/SKILL.md`,
    directory: `/workspace/.zcode/skills/${name}`,
    rootPath: "/workspace/.zcode/skills",
    scope: "project",
    source: "zcode",
    safeToAutoLoad: true,
    frontmatterKeys: ["name", "description"],
    policy: { allowImplicitInvocation: true },
  };
  return {
    discoverSkills: async () => ({ skills: [skill], diagnostics: [], totalDiscovered: 1 }),
    loadSkill: async () => {
      throw new Error(`createTestSkillPort does not load skills (${name})`);
    },
  };
}
