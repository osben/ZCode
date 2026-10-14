import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ForkWorkspacePinRepo } from "../src/session/forkWorkspacePinRepo.js";

describe("ForkWorkspacePinRepo", () => {
  let tempDir: string | null = null;
  let repo: ForkWorkspacePinRepo | null = null;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "fork-workspace-pins-"));
  });

  afterEach(() => {
    repo?.close();
    repo = null;
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  function buildDbPath(): string {
    return join(tempDir as string, "tasks-index.sqlite");
  }

  it("applies the fork migration alongside upstream migrations in the shared ledger", async () => {
    repo = new ForkWorkspacePinRepo(buildDbPath());
    await repo.ensureReady();
    const db = new DatabaseSync(buildDbPath());
    try {
      const forkRow = db
        .prepare(
          "SELECT id, checksum FROM tasks_schema_migration WHERE id = '9001_fork_workspace_pins'",
        )
        .get() as { id: string; checksum: string } | undefined;
      expect(forkRow?.id).toBe("9001_fork_workspace_pins");
      expect(forkRow?.checksum).toMatch(/^[0-9a-f]{64}$/);
      // Upstream migrations still run on the same fresh database and keep their own ledger rows.
      const upstreamRow = db
        .prepare("SELECT id FROM tasks_schema_migration WHERE id = '0001_adopt_task_schema'")
        .get();
      expect(upstreamRow).toBeTruthy();
    } finally {
      db.close();
    }
  });

  it("round-trips pin and unpin by workspace key", async () => {
    repo = new ForkWorkspacePinRepo(buildDbPath());
    await repo.setWorkspacePinned({ workspaceKey: "/local/a", pinned: true });
    await repo.setWorkspacePinned({ workspaceKey: "identity:/remote/b", pinned: true });
    expect(await repo.listPinnedWorkspaceKeys()).toEqual(["/local/a", "identity:/remote/b"]);
    await repo.setWorkspacePinned({ workspaceKey: "/local/a", pinned: false });
    expect(await repo.listPinnedWorkspaceKeys()).toEqual(["identity:/remote/b"]);
    // Re-pinning the same key is idempotent.
    await repo.setWorkspacePinned({ workspaceKey: "identity:/remote/b", pinned: true });
    expect(await repo.listPinnedWorkspaceKeys()).toEqual(["identity:/remote/b"]);
  });

  it("survives reopen and rejects a tampered fork migration checksum", async () => {
    repo = new ForkWorkspacePinRepo(buildDbPath());
    await repo.ensureReady();
    repo.close();
    repo = new ForkWorkspacePinRepo(buildDbPath());
    await repo.ensureReady();

    const db = new DatabaseSync(buildDbPath());
    try {
      db.prepare(
        "UPDATE tasks_schema_migration SET checksum = 'deadbeef' WHERE id = '9001_fork_workspace_pins'",
      ).run();
    } finally {
      db.close();
    }

    const tampered = new ForkWorkspacePinRepo(buildDbPath());
    await expect(tampered.ensureReady()).rejects.toThrow(/checksum mismatch/);
    tampered.close();
  });
});
