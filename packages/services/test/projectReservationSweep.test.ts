import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { projectStorage } from "../src/project-storage/index.js";
import { sweepAbandonedReservations } from "../src/project-storage/project-repository.js";
import { prepareTasksIndexStorage } from "../src/project-storage/startup.js";

const WORKSPACE = "/workspace/reservation-sweep";
// Exact placeholders: no CLI facts, created_at 0, meta_json '{}'.
const SWEPT = ["placeholder-a", "placeholder-b"];
// Each kept row matches two of the three signature parts, or is an admitted, pinned, archived or other-host row.
const KEPT = [
  "near-facts",
  "near-created",
  "near-meta",
  "admitted",
  "pinned",
  "archived",
  "other-host",
];

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "zcode-reservation-sweep-"));
  path = join(dir, "tasks.sqlite");
  await prepareTasksIndexStorage(path, () => {});
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function withDb<T>(body: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path);
  try {
    return body(db);
  } finally {
    db.close();
  }
}

function taskIds(db: DatabaseSync): string[] {
  return db
    .prepare("SELECT task_id FROM tasks ORDER BY task_id")
    .all()
    .map((row) => String(row.task_id));
}

function seed(db: DatabaseSync): void {
  const repo = projectStorage.repository(db);
  for (const taskId of [...SWEPT, ...KEPT])
    repo.reserveCreatedTask({ task: { workspacePath: WORKSPACE, taskId }, projectId: null });
  db.exec("INSERT OR IGNORE INTO hosts(host_id,kind,position) VALUES('remote-x','server',9)");
  const edits: Array<[string, string]> = [
    ["UPDATE tasks SET cli_created_at=1,cli_updated_at=1 WHERE task_id=?", "near-facts"],
    ["UPDATE tasks SET created_at=5 WHERE task_id=?", "near-created"],
    ['UPDATE tasks SET meta_json=\'{"title":"kept"}\' WHERE task_id=?', "near-meta"],
    ["UPDATE tasks SET cli_created_at=1,cli_updated_at=1 WHERE task_id=?", "admitted"],
    ["UPDATE tasks SET cli_created_at=1,cli_updated_at=1,pinned=1 WHERE task_id=?", "pinned"],
    ["UPDATE tasks SET cli_created_at=1,cli_updated_at=1,archived=1 WHERE task_id=?", "archived"],
    ["UPDATE tasks SET host_id='remote-x' WHERE task_id=?", "other-host"],
  ];
  for (const [sql, taskId] of edits) db.prepare(sql).run(taskId);
}

function loggedMessages(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.flatMap((call) =>
    call.filter((arg): arg is string => typeof arg === "string" && arg.includes("swept")),
  );
}

it("removes only exact placeholders of the local owner and returns the count", () => {
  withDb((db) => {
    seed(db);
    expect(sweepAbandonedReservations(db)).toBe(SWEPT.length);
    expect(taskIds(db)).toEqual([...KEPT].sort());
  });
});

it("is idempotent, and a draft reserved after the sweep survives because the gate does not run it again", () => {
  withDb((db) => {
    seed(db);
    expect(sweepAbandonedReservations(db)).toBe(SWEPT.length);
    expect(sweepAbandonedReservations(db)).toBe(0);
    projectStorage.repository(db).reserveCreatedTask({
      task: { workspacePath: WORKSPACE, taskId: "live-draft" },
      projectId: null,
    });
    // The sweep matches any placeholder, so a live draft is safe only because the startup gate never repeats it.
    expect(taskIds(db)).toContain("live-draft");
  });
});

it("runs at startup only when the caller passes the gate, and logs only a positive count", async () => {
  withDb((db) => seed(db));
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await prepareTasksIndexStorage(path, () => {});
    expect(loggedMessages(log)).toEqual([]);
    withDb((db) => expect(taskIds(db)).toContain("placeholder-a"));

    await prepareTasksIndexStorage(path, () => {}, undefined, {
      sweepAbandonedReservations: true,
    });
    withDb((db) => expect(taskIds(db)).toEqual([...KEPT].sort()));
    expect(loggedMessages(log)).toEqual([
      `swept ${SWEPT.length} abandoned reservation placeholder row(s)`,
    ]);

    await prepareTasksIndexStorage(path, () => {}, undefined, {
      sweepAbandonedReservations: true,
    });
    expect(loggedMessages(log)).toHaveLength(1);
  } finally {
    log.mockRestore();
  }
});
