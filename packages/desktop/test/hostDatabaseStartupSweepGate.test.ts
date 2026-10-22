import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

const fixtures = vi.hoisted(() => ({ host: vi.fn(), session: vi.fn(), mark: vi.fn() }));
vi.mock("@zcode/services/storage-startup", () => ({
  getTasksIndexDatabasePath: () => "/isolated/tasks.sqlite",
  resolveZCodeAgentSpawnCwd: async (...args: unknown[]) =>
    (
      await import("../../services/src/zcode-agent/zcodeAgentSpawnCwd.js")
    ).resolveZCodeAgentSpawnCwd(...(args as [never])),
  markTasksStoragePrepared: fixtures.mark,
}));
vi.mock("../src/host/database-startup/storagePreparationProcesses.js", () => ({
  prepareHostStorage: fixtures.host,
  prepareSessionStorage: fixtures.session,
}));
import { createHostDatabaseStartup } from "../src/host/database-startup/hostDatabaseStartup.js";

async function startWith(sweepAbandonedReservations?: boolean): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-startup-sweep-gate-"));
  fixtures.host.mockReset();
  fixtures.host.mockResolvedValue(undefined);
  fixtures.session.mockResolvedValue(undefined);
  const startup = createHostDatabaseStartup({
    startupId: "sweep-gate-test",
    cwd: dir,
    workingDirectories: [dir],
    sweepAbandonedReservations,
    initializeServices: async () => {},
    publish: () => {},
    onFailure: () => {},
  });
  try {
    await startup.coordinator.start();
  } finally {
    startup.dispose();
    await rm(dir, { recursive: true, force: true });
  }
}

it("sweeps only on the first prepare attempt, so a retry of the same Host never sweeps", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-startup-sweep-retry-"));
  fixtures.host.mockReset();
  fixtures.host
    .mockRejectedValueOnce(Object.assign(new Error("first attempt failed"), { kind: "io_error" }))
    .mockResolvedValue(undefined);
  fixtures.session.mockResolvedValue(undefined);
  const startup = createHostDatabaseStartup({
    startupId: "sweep-retry-test",
    cwd: dir,
    workingDirectories: [dir],
    sweepAbandonedReservations: true,
    initializeServices: async () => {},
    publish: () => {},
    onFailure: () => {},
  });
  try {
    await startup.coordinator.start().catch(() => undefined);
    await startup.coordinator.retry(startup.coordinator.snapshot.attemptId);
    expect(fixtures.host.mock.calls[0]?.[3]).toEqual({ sweepAbandonedReservations: true });
    expect(fixtures.host.mock.calls[1]?.[3]).toEqual({ sweepAbandonedReservations: false });
  } finally {
    startup.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

it("forwards the reservation sweep gate to the tasks storage preparation only when the Host sets it", async () => {
  await startWith(true);
  expect(fixtures.host.mock.lastCall?.[3]).toEqual({ sweepAbandonedReservations: true });

  await startWith(undefined);
  expect(fixtures.host.mock.lastCall?.[3]?.sweepAbandonedReservations).toBeFalsy();
});
