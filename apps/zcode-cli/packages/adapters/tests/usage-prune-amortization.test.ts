import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProjectId, createSessionId, createToolCallId } from "@zcode/contracts";
import { createSqliteSessionStore } from "../src/storage/index.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const NOW = 2_000_000_000_000;

interface StoreFixture {
  directory: string;
  sessionID: ReturnType<typeof createSessionId>;
  store: Awaited<ReturnType<typeof createSqliteSessionStore>>;
}

async function createStoreFixture(name: string): Promise<StoreFixture> {
  const directory = await mkdtemp(join(tmpdir(), `zcode-usage-prune-${name}-`));
  const store = await createSqliteSessionStore({ dbPath: join(directory, "session.sqlite") });
  const sessionID = createSessionId(`usage-prune-${name}`);
  await store.createSession({
    id: sessionID,
    projectID: createProjectId(`usage-prune-${name}`),
    slug: name,
    directory,
    title: name,
    version: "0.1.0",
  });
  return { directory, sessionID, store };
}

async function writeToolUsage(
  fixture: StoreFixture,
  id: string,
  startedAt: number,
): Promise<void> {
  await fixture.store.upsertToolUsage({
    id: `usage_tool_${id}`,
    sessionID: fixture.sessionID,
    startedAt,
    status: "running",
    toolCallID: createToolCallId(id),
    toolName: "Bash",
  });
}

async function closeFixture(fixture: StoreFixture): Promise<void> {
  fixture.store.close();
  await rm(fixture.directory, { recursive: true, force: true });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("usage retention pruning", () => {
  it("amortizes automatic pruning for a connection, then prunes after an hour", async () => {
    const fixture = await createStoreFixture("hourly");
    const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
    try {
      await writeToolUsage(fixture, "current", NOW);
      await writeToolUsage(fixture, "expired", NOW - 31 * DAY_MS);

      expect(fixture.store.debugCounts(fixture.sessionID).toolUsage).toBe(2);

      clock.mockReturnValue(NOW + HOUR_MS + 1);
      await writeToolUsage(fixture, "after-interval", NOW + HOUR_MS + 1);

      expect(fixture.store.debugCounts(fixture.sessionID).toolUsage).toBe(2);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("keeps explicit pruning immediate even during the automatic interval", async () => {
    const fixture = await createStoreFixture("explicit");
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    try {
      await writeToolUsage(fixture, "current", NOW);
      await writeToolUsage(fixture, "expired", NOW - 31 * DAY_MS);
      expect(fixture.store.debugCounts(fixture.sessionID).toolUsage).toBe(2);

      await fixture.store.pruneUsage({ beforeTime: NOW - 30 * DAY_MS });

      expect(fixture.store.debugCounts(fixture.sessionID).toolUsage).toBe(1);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("tracks automatic pruning independently for each database connection", async () => {
    const first = await createStoreFixture("first-connection");
    const second = await createStoreFixture("second-connection");
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    try {
      await writeToolUsage(first, "first-current", NOW);
      await writeToolUsage(first, "first-expired", NOW - 31 * DAY_MS);
      await writeToolUsage(second, "second-expired", NOW - 31 * DAY_MS);

      expect(first.store.debugCounts(first.sessionID).toolUsage).toBe(2);
      expect(second.store.debugCounts(second.sessionID).toolUsage).toBe(0);
    } finally {
      await closeFixture(first);
      await closeFixture(second);
    }
  });
});
