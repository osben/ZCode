import type { ZCodeProvider } from "@zcode/shared";

type SkillSourceType = "glm" | "unknown";

function resolveSkillSourceType(skillPath: string): SkillSourceType {
  const normalized = skillPath.replaceAll("\\", "/").toLowerCase();
  if (normalized.includes("/.zcode/skills/")) {
    return "glm";
  }
  if (normalized.includes("/.zcode/cli/plugins/cache/")) {
    return "glm";
  }
  return "unknown";
}

const SKILL_ID_PROVIDER_RE = /^glm:/;

function isZcodeSkill(skill: { id?: string; path: string; scope?: string }): boolean {
  return (
    // Plugin skills live in the CLI plugin cache, not `.zcode/skills`.
    // The service layer marks their source with scope, so the frontend filter must allow them or the `/` and `$` panels will omit them.
    skill.scope === "plugin" ||
    (typeof skill.id === "string" && SKILL_ID_PROVIDER_RE.test(skill.id)) ||
    resolveSkillSourceType(skill.path) === "glm"
  );
}

export function filterSkillsForProvider<T extends { path: string; id?: string; scope?: string }>(
  skills: T[],
  _legacyProvider: ZCodeProvider,
): T[] {
  return skills.filter(isZcodeSkill);
}
