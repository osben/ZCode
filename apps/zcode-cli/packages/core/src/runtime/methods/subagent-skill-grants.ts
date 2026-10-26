// Pattern adapted from Cindy (Apache-2.0) maker-core skill-activation.ts.
import type { SkillMetadata } from "@zcode/contracts";

/**
 * Physical identity of a discovered skill. The skill adapter owns the filesystem lookup and sets
 * `identity`; core never touches the filesystem and falls back to `path` for ports that omit it.
 */
export function skillIdentity(skill: SkillMetadata): string {
  return skill.identity ?? skill.path;
}

/** Grants resolved for one subagent start: frozen identities plus unmatched profile entries. */
export interface SubagentSkillGrants {
  /** Frozen physical identities the child may see and load. */
  readonly identities: ReadonlySet<string>;
  /** Profile entries that matched no discovered skill (for one warn log). */
  readonly unresolvedEntries: readonly string[];
}

function isQualifiedEntry(entry: string): boolean {
  return entry.includes(":") || entry.includes("/");
}

/**
 * Turns profile `skills:` entries into a frozen set of physical identities,
 * using one already-computed discovery result (root-priority order preserved).
 *
 * A qualified entry matches `qualifiedName` exactly. A bare entry matches
 * `name` or `qualifiedName`; the first non-plugin match wins alone, while
 * all-plugin matches are granted together (the existing `Skill(x)` ambiguity
 * contract). Symlinked copies sharing one identity count as one.
 */
export function resolveSubagentSkillGrants(
  entries: readonly string[],
  skills: readonly SkillMetadata[],
): SubagentSkillGrants {
  const identities = new Set<string>();
  const unresolvedEntries: string[] = [];

  for (const rawEntry of entries) {
    const entry = rawEntry.trim();
    if (entry === "") {
      continue;
    }
    const matches = skills.filter((skill) =>
      isQualifiedEntry(entry)
        ? skill.qualifiedName === entry
        : skill.name === entry || skill.qualifiedName === entry,
    );
    if (matches.length === 0) {
      unresolvedEntries.push(entry);
      continue;
    }
    const firstNonPlugin = isQualifiedEntry(entry)
      ? undefined
      : matches.find((skill) => skill.source !== "plugin");
    const granted = firstNonPlugin ? [firstNonPlugin] : matches;
    for (const skill of granted) {
      identities.add(skillIdentity(skill));
    }
  }

  return { identities: Object.freeze(identities), unresolvedEntries };
}

/**
 * Keeps only skills whose identity is in the grant set, and only the first
 * skill per identity in array (root) order. Other filtering (official CUA
 * skills) stays with the caller.
 */
export function filterSkillsByGrants(
  skills: readonly SkillMetadata[],
  identities: ReadonlySet<string>,
): SkillMetadata[] {
  const seen = new Set<string>();
  const visible: SkillMetadata[] = [];
  for (const skill of skills) {
    const identity = skillIdentity(skill);
    if (identities.has(identity) && !seen.has(identity)) {
      seen.add(identity);
      visible.push(skill);
    }
  }
  return visible;
}
