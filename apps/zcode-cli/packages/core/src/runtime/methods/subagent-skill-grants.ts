// Pattern adapted from Cindy (Apache-2.0) maker-core skill-activation.ts.
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { SkillMetadata } from "@zcode/contracts";

/**
 * Computes the physical identity of a SKILL.md file: the resolved real path,
 * lower-cased on Windows. `realpath` failures (missing or unreadable file) fall
 * back to the resolved path so identities stay stable during a run.
 */
export async function canonicalSkillIdentity(
  path: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const resolved = resolve(path);
  let identity: string;
  try {
    identity = await realpath(resolved);
  } catch {
    identity = resolved;
  }
  return platform === "win32" ? identity.toLowerCase() : identity;
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
export async function resolveSubagentSkillGrants(
  entries: readonly string[],
  skills: readonly SkillMetadata[],
  platform?: NodeJS.Platform,
): Promise<SubagentSkillGrants> {
  const identities = new Set<string>();
  const unresolvedEntries: string[] = [];
  const skillIdentities = new Map<SkillMetadata, string>();
  const identityOf = async (skill: SkillMetadata): Promise<string> => {
    let identity = skillIdentities.get(skill);
    if (identity === undefined) {
      identity = await canonicalSkillIdentity(skill.path, platform);
      skillIdentities.set(skill, identity);
    }
    return identity;
  };

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
      identities.add(await identityOf(skill));
    }
  }

  return { identities: Object.freeze(identities), unresolvedEntries };
}

/**
 * Keeps only skills whose identity is in the grant set, and only the first
 * skill per identity in array (root) order. Other filtering (official CUA
 * skills) stays with the caller.
 */
export async function filterSkillsByGrants(
  skills: readonly SkillMetadata[],
  identities: ReadonlySet<string>,
  platform?: NodeJS.Platform,
): Promise<SkillMetadata[]> {
  const seen = new Set<string>();
  const visible: SkillMetadata[] = [];
  for (const skill of skills) {
    const identity = await canonicalSkillIdentity(skill.path, platform);
    if (identities.has(identity) && !seen.has(identity)) {
      seen.add(identity);
      visible.push(skill);
    }
  }
  return visible;
}
