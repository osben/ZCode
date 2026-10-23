import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ProjectRepositoryContract, VirtualProject } from "#src/project-storage/contract.js";
import type { IProjectService } from "#src/project/contract.js";
import { createProjectService } from "#src/project/index.js";

describe("project service reuseExistingRoot input", () => {
  it("accepts reuseExistingRoot only for one local root with no other fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-reuse-"));
    try {
      await mkdir(join(root, "present"));
      const saveProject = vi.fn((input) => input as VirtualProject);
      const repository = { saveProject } as unknown as ProjectRepositoryContract;
      const port: IProjectService = createProjectService({
        repository: async () => repository,
        workspaceDirectory: root,
      });
      const present = join(root, "present");

      await port.saveProject({ roots: [present], reuseExistingRoot: true });
      expect(saveProject).toHaveBeenLastCalledWith(
        expect.objectContaining({ roots: [present], reuseExistingRoot: true }),
      );

      for (const input of [
        { roots: [present, root], reuseExistingRoot: true },
        { roots: [present], reuseExistingRoot: true, name: "Renamed" },
        { roots: [present], reuseExistingRoot: true, hostId: "remote:server:s" },
      ]) {
        await expect(port.saveProject(input)).rejects.toThrow("project.invalid-directory-open");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
