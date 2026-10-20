import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FORK_PINS_TO_PROJECTS_CHECKSUM,
  FORK_PINS_TO_PROJECTS_MIGRATION_ID,
  migrateForkWorkspacePinsToProjects,
  type ForkPinSource,
  type PinnableProject,
  type PinProjectPort,
} from "../src/project-storage/forkWorkspacePinMigration.js";
import { ForkWorkspacePinRepo } from "../src/session/forkWorkspacePinRepo.js";

interface FakeProject extends PinnableProject {
  id: string;
}

function createFakes(keys: string[], initialProjects: FakeProject[], existingDirs: string[]) {
  const projects = initialProjects.map((project) => ({ ...project, roots: [...project.roots] }));
  const saves: Array<{ id?: string; roots?: string[]; pinned: boolean }> = [];
  const checksums = new Map<string, string>();
  const logs: Array<{ level: string; message: string }> = [];
  let nextId = 1;

  const source: ForkPinSource = {
    async listPinnedWorkspaceKeys() {
      return keys;
    },
    async readMigrationChecksum(id) {
      return checksums.get(id) ?? null;
    },
    async writeMigrationChecksum(id, checksum) {
      checksums.set(id, checksum);
    },
  };
  const port: PinProjectPort = {
    async readProjects() {
      return projects.map((project) => ({ ...project, roots: [...project.roots] }));
    },
    async saveProject(input) {
      saves.push(input);
      if (input.id) {
        const project = projects.find((candidate) => candidate.id === input.id);
        if (!project) throw new Error("missing project in fake");
        project.pinned = input.pinned;
        return project;
      }
      const created: FakeProject = {
        id: `created-${nextId++}`,
        roots: (input.roots ?? []).map((rootPath, position) => ({
          rootPath,
          position,
          isPrimary: position === 0,
        })),
        pinned: input.pinned,
      };
      projects.push(created);
      return created;
    },
  };
  return {
    projects,
    saves,
    checksums,
    logs,
    deps: {
      source,
      projects: port,
      isDirectory: async (path: string) => existingDirs.includes(path),
      log: {
        info: (message: string) => logs.push({ level: "info", message }),
        warn: (message: string) => logs.push({ level: "warn", message }),
      },
    },
  };
}

const root = (rootPath: string) => ({ rootPath, position: 0, isPrimary: true });

describe("migrateForkWorkspacePinsToProjects", () => {
  it("pins an existing project whose root matches a fork pin (case A)", async () => {
    const fakes = createFakes(
      ["/work/alpha"],
      [{ id: "p1", roots: [root("/work/alpha")], pinned: false }],
      [],
    );
    const result = await migrateForkWorkspacePinsToProjects(fakes.deps);
    expect(result).toMatchObject({ status: "applied", pinnedExisting: 1, registeredProjects: 0 });
    expect(fakes.saves).toEqual([{ id: "p1", pinned: true }]);
  });

  it("registers an existing directory as a pinned project (case B)", async () => {
    const fakes = createFakes(["/work/beta"], [], ["/work/beta"]);
    const result = await migrateForkWorkspacePinsToProjects(fakes.deps);
    expect(result).toMatchObject({ registeredProjects: 1 });
    expect(fakes.saves).toEqual([{ roots: ["/work/beta"], pinned: true }]);
    expect(fakes.projects).toEqual([
      expect.objectContaining({
        pinned: true,
        roots: [expect.objectContaining({ rootPath: "/work/beta" })],
      }),
    ]);
  });

  it("keeps a missing directory pin in place and counts it as skipped (case C)", async () => {
    const fakes = createFakes(["/work/gone"], [], []);
    const result = await migrateForkWorkspacePinsToProjects(fakes.deps);
    expect(result).toMatchObject({ registeredProjects: 0, skippedMissing: 1 });
    expect(fakes.saves).toEqual([]);
    expect(fakes.logs.some((entry) => entry.level === "warn")).toBe(true);
  });

  it("skips remote workspace identities that are not absolute paths (case D)", async () => {
    const fakes = createFakes(["remote-host:task-7", "/work/alpha"], [], ["/work/alpha"]);
    const result = await migrateForkWorkspacePinsToProjects(fakes.deps);
    expect(result).toMatchObject({ skippedRemote: 1, registeredProjects: 1 });
  });

  it("pins a project once for duplicate keys with whitespace (case E)", async () => {
    const fakes = createFakes(
      ["/work/alpha", " /work/alpha ", "/work/alpha/"],
      [{ id: "p1", roots: [root("/work/alpha")], pinned: false }],
      [],
    );
    const result = await migrateForkWorkspacePinsToProjects(fakes.deps);
    expect(result.pinnedExisting).toBe(1);
    expect(fakes.saves).toEqual([{ id: "p1", pinned: true }]);
  });

  it("does nothing on a second run once the marker is recorded (idempotent)", async () => {
    const fakes = createFakes(["/work/beta"], [], ["/work/beta"]);
    await migrateForkWorkspacePinsToProjects(fakes.deps);
    const saveCount = fakes.saves.length;
    const second = await migrateForkWorkspacePinsToProjects(fakes.deps);
    expect(second.status).toBe("already-applied");
    expect(fakes.saves.length).toBe(saveCount);
    expect(fakes.checksums.get(FORK_PINS_TO_PROJECTS_MIGRATION_ID)).toBe(
      FORK_PINS_TO_PROJECTS_CHECKSUM,
    );
  });

  it("re-running after a crash before the marker does not duplicate projects", async () => {
    const fakes = createFakes(["/work/beta"], [], ["/work/beta"]);
    // Crash simulation: the project is written, the marker write fails.
    const failingSource = { ...fakes.deps.source };
    failingSource.writeMigrationChecksum = async () => {
      throw new Error("disk full");
    };
    await expect(
      migrateForkWorkspacePinsToProjects({ ...fakes.deps, source: failingSource }),
    ).rejects.toThrow("disk full");
    expect(fakes.projects).toHaveLength(1);

    const second = await migrateForkWorkspacePinsToProjects(fakes.deps);
    expect(second.status).toBe("applied");
    expect(second.registeredProjects).toBe(0);
    expect(fakes.projects).toHaveLength(1);
  });

  it("fails loudly when the recorded checksum differs", async () => {
    const fakes = createFakes([], [], []);
    fakes.checksums.set(FORK_PINS_TO_PROJECTS_MIGRATION_ID, "tampered");
    await expect(migrateForkWorkspacePinsToProjects(fakes.deps)).rejects.toThrow(
      "checksum mismatch",
    );
  });
});

describe("ForkWorkspacePinRepo migration ledger", () => {
  let tempDir: string | null = null;
  let repo: ForkWorkspacePinRepo | null = null;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "fork-pin-migration-"));
    mkdirSync(join(tempDir, "data"), { recursive: true });
  });

  afterEach(() => {
    repo?.close();
    repo = null;
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it("records the migration marker in the shared ledger and reads it back", async () => {
    repo = new ForkWorkspacePinRepo(join(tempDir as string, "data", "tasks-index.sqlite"));
    expect(await repo.readMigrationChecksum(FORK_PINS_TO_PROJECTS_MIGRATION_ID)).toBeNull();
    await repo.writeMigrationChecksum(FORK_PINS_TO_PROJECTS_MIGRATION_ID, "abc");
    expect(await repo.readMigrationChecksum(FORK_PINS_TO_PROJECTS_MIGRATION_ID)).toBe("abc");
  });

  it("reads pre-migration pins that were written to fork_workspace_pins", async () => {
    repo = new ForkWorkspacePinRepo(join(tempDir as string, "data", "tasks-index.sqlite"));
    await repo.setWorkspacePinned({ workspaceKey: "/work/seed", pinned: true });
    expect(await repo.listPinnedWorkspaceKeys()).toEqual(["/work/seed"]);
  });
});
