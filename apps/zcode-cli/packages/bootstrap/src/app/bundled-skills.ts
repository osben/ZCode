import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Logger, SkillRoot } from "@zcode/contracts";
import { DYNAMIC_WORKFLOW_SKILL_NAME } from "@zcode/contracts";
import { candidateBaseDirs } from "./bundled-plugins.js";

/**
 * Skills bundled with the CLI (apps/zcode-cli/packages/bundled-skills).
 *
 * This is not a plugin: it is not listed in the official marketplace, has no enable/disable switch,
 * cannot be uninstalled, and does not appear in Settings or the `$` reference panel. Runtime registers
 * product-feature tools, and the skills that teach the model to use those tools must be equally
 * irremovable—the root cause of the 2026-09-19 "/workflow disappeared" incident was that the
 * dynamic-workflows skill and command both lived in the user-uninstallable zcode-guide plugin
 * (docs/dynamic-workflow/authoring.md, "The `/workflow` command and the skill").
 *
 * All three runtime forms resolve to the same skills directory:
 * - Development / Electron Desktop: find `packages/bundled-skills` next to the entry point using
 *   the same candidate directories as official plugins; read in place without copying.
 * - SEA binary: assets are embedded under the `zcode-bundled-skills/` prefix and extracted on first
 *   launch by content hash to `<cli storage>/bundled-skills/<hash>/`. The directory name identifies
 *   the content, repeated launches are idempotent, and only one concurrent extractor wins.
 * - Remote host: prepare-prebuilds stages the directory next to remote zcode.cjs, like Desktop.
 */

export const BUNDLED_SKILL_PACK_DIRECTORY_NAME = "bundled-skills";
export const BUNDLED_SKILL_PACK_SKILLS_DIRECTORY = "skills";
/** The gate and skills package share a name; the constant lives in contracts (also used by core's skill gate) and is re-exported here. */
export { DYNAMIC_WORKFLOW_SKILL_NAME };

/** Every file in the skills package is a required asset: reject the whole package if any file is missing rather than creating a skill with a broken reference. */
export const BUNDLED_SKILL_PACK_REQUIRED_PATHS = [
  `skills/${DYNAMIC_WORKFLOW_SKILL_NAME}/SKILL.md`,
  `skills/${DYNAMIC_WORKFLOW_SKILL_NAME}/patterns.md`,
  `skills/${DYNAMIC_WORKFLOW_SKILL_NAME}/examples.md`,
] as const;

/** Mirrors rootCandidates in official-plugin-definitions and covers monorepo src/dist, cli/dist, and desktop resources/glm layouts. */
const BUNDLED_SKILL_PACK_ROOT_CANDIDATES = [
  `packages/${BUNDLED_SKILL_PACK_DIRECTORY_NAME}`,
  `../${BUNDLED_SKILL_PACK_DIRECTORY_NAME}`,
  `../../${BUNDLED_SKILL_PACK_DIRECTORY_NAME}`,
  `../../../${BUNDLED_SKILL_PACK_DIRECTORY_NAME}`,
] as const;

export const SEA_BUNDLED_SKILL_ASSET_PREFIX = "zcode-bundled-skills/";
const SEA_BUNDLED_SKILL_MANIFEST_ASSET_KEY = `${SEA_BUNDLED_SKILL_ASSET_PREFIX}manifest.json`;
const SEED_MARKER_FILE = ".zcode-bundled-skills-seed.json";

/**
 * Place this after all plugin roots (adapter plugin roots start at FIRST_PLUGIN_PRIORITY): when names
 * collide, discovery order selects the first skill, so matching user/project/plugin skills take
 * precedence over the bundled package, matching tier 7 (bundled/system) in skill.md's "Priority"
 * section.
 */
const BUNDLED_SKILL_ROOT_PRIORITY = 1_000_000;

interface SeaBundledSkillManifest {
  files: Array<{ mode?: number; path: string; sha256: string }>;
  hash: string;
  version: 1;
}

type SeaModule = typeof import("node:sea");

export interface ResolveBundledSkillRootsOptions {
  /** `getCliStorageRoot(storage.dir)`; needed only for SEA extraction. */
  cliStorageRoot: string;
  logger?: Logger;
}

export function resolveBundledSkillRoots(options: ResolveBundledSkillRootsOptions): SkillRoot[] {
  const packRoot =
    materializeSeaBundledSkillPack(options) ?? resolveFilesystemBundledSkillPackRoot();
  if (!packRoot) {
    // A missing bundled skills package means the model cannot load the skill after /workflow
    // expands. This is not fatal (tool descriptions still carry the full API), but it must leave a
    // diagnostic; otherwise the only symptom would be "the model writes lower-quality scripts."
    options.logger?.warn("Bundled skill pack unavailable", {
      module: "bootstrap.bundled_skills",
      requiredPaths: [...BUNDLED_SKILL_PACK_REQUIRED_PATHS],
    });
    return [];
  }
  return [
    {
      path: join(packRoot, BUNDLED_SKILL_PACK_SKILLS_DIRECTORY),
      priority: BUNDLED_SKILL_ROOT_PRIORITY,
      scope: "system",
      source: "bundled",
    },
  ];
}

export function findMissingBundledSkillPackPaths(packRoot: string): string[] {
  return BUNDLED_SKILL_PACK_REQUIRED_PATHS.filter(
    (requiredPath) => !existsSync(join(packRoot, ...requiredPath.split("/"))),
  );
}

function resolveFilesystemBundledSkillPackRoot(): string | undefined {
  for (const baseDir of candidateBaseDirs()) {
    for (const relativePath of BUNDLED_SKILL_PACK_ROOT_CANDIDATES) {
      const packRoot = resolve(baseDir, relativePath);
      if (
        existsSync(join(packRoot, BUNDLED_SKILL_PACK_SKILLS_DIRECTORY)) &&
        findMissingBundledSkillPackPaths(packRoot).length === 0
      ) {
        return packRoot;
      }
    }
  }
  return undefined;
}

function materializeSeaBundledSkillPack(
  options: ResolveBundledSkillRootsOptions,
): string | undefined {
  const sea = getSeaModule();
  if (!sea?.isSea()) return undefined;
  const manifest = readSeaManifest(sea);
  if (!manifest) return undefined;

  const packsRoot = join(options.cliStorageRoot, BUNDLED_SKILL_PACK_DIRECTORY_NAME);
  const targetRoot = join(packsRoot, manifest.hash);
  if (isSeedComplete(targetRoot, manifest.hash)) return targetRoot;

  // The directory name is the content hash. Write into a unique temporary directory and then rename;
  // if rename fails but the target is complete, another concurrent writer won and we can reuse it.
  // For other failures, fall back to any complete older package so skills remain available if an upgrade is interrupted.
  const temporaryRoot = `${targetRoot}.tmp-${process.pid}-${Date.now()}`;
  try {
    mkdirSync(temporaryRoot, { recursive: true });
    for (const file of manifest.files) {
      const bytes = Buffer.from(sea.getRawAsset(`${SEA_BUNDLED_SKILL_ASSET_PREFIX}${file.path}`));
      if (hashBytes(bytes) !== file.sha256) {
        throw new Error(`Bundled skill asset hash mismatch: ${file.path}`);
      }
      const outputPath = join(temporaryRoot, ...file.path.split("/"));
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, bytes, { mode: file.mode ?? 0o644 });
    }
    writeFileSync(
      join(temporaryRoot, SEED_MARKER_FILE),
      JSON.stringify({ hash: manifest.hash, version: 1 }, null, 2),
    );
    mkdirSync(packsRoot, { recursive: true });
    renameSync(temporaryRoot, targetRoot);
    return targetRoot;
  } catch (error) {
    rmSync(temporaryRoot, { force: true, recursive: true });
    if (isSeedComplete(targetRoot, manifest.hash)) return targetRoot;
    const fallbackRoot = findUsableSeededPack(packsRoot);
    options.logger?.warn("Bundled skill pack seed degraded", {
      error: error instanceof Error ? error.message : String(error),
      fallbackRoot,
      module: "bootstrap.bundled_skills",
      targetRoot,
    });
    return fallbackRoot;
  }
}

function isSeedComplete(targetRoot: string, expectedHash: string): boolean {
  try {
    const marker = JSON.parse(readFileSync(join(targetRoot, SEED_MARKER_FILE), "utf8")) as {
      hash?: unknown;
    };
    if (marker.hash !== expectedHash) return false;
  } catch {
    return false;
  }
  return findMissingBundledSkillPackPaths(targetRoot).length === 0;
}

function findUsableSeededPack(packsRoot: string): string | undefined {
  let entries;
  try {
    entries = readdirSync(packsRoot, { withFileTypes: true });
  } catch {
    return undefined;
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.includes(".tmp-"))
    .map((entry) => join(packsRoot, entry.name))
    .find((packRoot) => {
      try {
        const marker = JSON.parse(readFileSync(join(packRoot, SEED_MARKER_FILE), "utf8")) as {
          hash?: unknown;
        };
        return typeof marker.hash === "string" && isSeedComplete(packRoot, marker.hash);
      } catch {
        return false;
      }
    });
}

function readSeaManifest(sea: SeaModule): SeaBundledSkillManifest | undefined {
  try {
    const manifest = JSON.parse(
      sea.getAsset(SEA_BUNDLED_SKILL_MANIFEST_ASSET_KEY, "utf8"),
    ) as SeaBundledSkillManifest;
    return manifest.version === 1 &&
      typeof manifest.hash === "string" &&
      Array.isArray(manifest.files)
      ? manifest
      : undefined;
  } catch {
    return undefined;
  }
}

function getSeaModule(): SeaModule | undefined {
  const getBuiltinModule = process.getBuiltinModule as ((id: "node:sea") => SeaModule) | undefined;
  try {
    return getBuiltinModule?.("node:sea");
  } catch {
    return undefined;
  }
}

function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
