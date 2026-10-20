/* One-time move of fork sidebar pins (fork_workspace_pins) onto upstream project pins (projects.pinned).
   Spec: specs/ui-pins-upstream-migration.md. The fork table is read here and never written again.
   The migration is idempotent: every case is a no-op on a second run, and the done-marker only
   prevents repeated work. */
import { createHash } from "node:crypto";
import { isAbsolute, normalize } from "node:path";

export const FORK_PINS_TO_PROJECTS_MIGRATION_ID = "9002_fork_pins_to_projects";
const FORK_PINS_TO_PROJECTS_DEFINITION =
  "9002_fork_pins_to_projects:v1 case-A-pin-existing-root; case-B-register-directory-pinned; skip-missing; skip-remote-identity";
export const FORK_PINS_TO_PROJECTS_CHECKSUM = createHash("sha256")
  .update(FORK_PINS_TO_PROJECTS_DEFINITION)
  .digest("hex");

export interface ForkPinSource {
  listPinnedWorkspaceKeys(): Promise<string[]>;
  /** Returns the stored checksum for a fork migration id, or null when it has not run. */
  readMigrationChecksum(id: string): Promise<string | null>;
  writeMigrationChecksum(id: string, checksum: string): Promise<void>;
}

export interface PinnableProject {
  id: string;
  roots: Array<{ rootPath: string }>;
  pinned: boolean;
}

export interface PinProjectPort {
  readProjects(): Promise<PinnableProject[]>;
  saveProject(input: { id?: string; roots?: string[]; pinned: boolean }): Promise<unknown>;
}

export interface PinMigrationLog {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
}

export interface ForkPinMigrationResult {
  status: "already-applied" | "applied";
  pinnedExisting: number;
  registeredProjects: number;
  skippedMissing: number;
  skippedRemote: number;
}

export interface ForkPinMigrationDeps {
  source: ForkPinSource;
  projects: PinProjectPort;
  isDirectory(path: string): Promise<boolean>;
  log: PinMigrationLog;
}

// normalize() keeps a trailing separator, so "/work/a/" and "/work/a" must compare equal here.
function canonicalPath(path: string): string {
  const normalized = normalize(path);
  return normalized.length > 1 ? normalized.replace(/[\\/]+$/, "") : normalized;
}

function sameRoot(a: string, b: string): boolean {
  return canonicalPath(a) === canonicalPath(b);
}

export async function migrateForkWorkspacePinsToProjects(
  deps: ForkPinMigrationDeps,
): Promise<ForkPinMigrationResult> {
  const id = FORK_PINS_TO_PROJECTS_MIGRATION_ID;
  const recorded = await deps.source.readMigrationChecksum(id);
  if (recorded !== null) {
    if (recorded !== FORK_PINS_TO_PROJECTS_CHECKSUM) {
      throw Object.assign(new Error(`Task database migration checksum mismatch: ${id}`), {
        kind: "checksum_mismatch",
      });
    }
    return {
      status: "already-applied",
      pinnedExisting: 0,
      registeredProjects: 0,
      skippedMissing: 0,
      skippedRemote: 0,
    };
  }

  const keys = [...new Set((await deps.source.listPinnedWorkspaceKeys()).map((key) => key.trim()))]
    .filter((key) => key.length > 0)
    .sort();
  const projects = await deps.projects.readProjects();
  const result: ForkPinMigrationResult = {
    status: "applied",
    pinnedExisting: 0,
    registeredProjects: 0,
    skippedMissing: 0,
    skippedRemote: 0,
  };

  for (const key of keys) {
    // Case D: remote identities are owned by their Host; registering needs that connection.
    if (!isAbsolute(key)) {
      result.skippedRemote += 1;
      continue;
    }
    const match = projects.find((project) =>
      project.roots.some((root) => sameRoot(root.rootPath, key)),
    );
    if (match) {
      // Case A (and E: a second key for the same root finds the project it just pinned).
      if (!match.pinned) {
        await deps.projects.saveProject({ id: match.id, pinned: true });
        match.pinned = true;
        result.pinnedExisting += 1;
      }
      continue;
    }
    // Case C: the directory no longer exists, so the project service would refuse it.
    if (!(await deps.isDirectory(key))) {
      result.skippedMissing += 1;
      continue;
    }
    // Case B: register the directory as a project, pinned.
    await deps.projects.saveProject({ roots: [canonicalPath(key)], pinned: true });
    result.registeredProjects += 1;
    // Refresh the list so later keys see the project created here (case E/F).
    projects.splice(0, projects.length, ...(await deps.projects.readProjects()));
  }

  await deps.source.writeMigrationChecksum(id, FORK_PINS_TO_PROJECTS_CHECKSUM);
  deps.log.info("fork workspace pins migrated to project pins", {
    keys: keys.length,
    pinnedExisting: result.pinnedExisting,
    registeredProjects: result.registeredProjects,
    skippedMissing: result.skippedMissing,
    skippedRemote: result.skippedRemote,
  });
  if (result.skippedMissing + result.skippedRemote > 0) {
    deps.log.warn("some fork workspace pins could not become project pins", {
      skippedMissing: result.skippedMissing,
      skippedRemote: result.skippedRemote,
    });
  }
  return result;
}
