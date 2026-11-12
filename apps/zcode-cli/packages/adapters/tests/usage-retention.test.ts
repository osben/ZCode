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
  const directory = await mkdtemp(join(tmpdir(), `zcode-usage-retention-${name}-`));
  const store = await createSqliteSessionStore({ dbPath: join(directory, "session.sqlite") });
  const sessionID = createSessionId(`usage-retention-${name}`);
  await store.createSession({
    id: sessionID,
    projectID: createProjectId(`usage-retention-${name}`),
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

// Upstream 3.18.0 keeps usage facts forever; the shared tables must not be pruned on write.
describe("usage retention", () => {
  it("keeps usage rows of any age across writes", async () => {
    const fixture = await createStoreFixture("forever");
    const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
    try {
      await writeToolUsage(fixture, "current", NOW);
      await writeToolUsage(fixture, "old", NOW - 400 * DAY_MS);
      clock.mockReturnValue(NOW + 2 * HOUR_MS);
      await writeToolUsage(fixture, "later", NOW + 2 * HOUR_MS);

      expect(fixture.store.debugCounts(fixture.sessionID).toolUsage).toBe(3);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("no longer exports a prune entry point", async () => {
    const usage = await import("../src/storage/session-store/repositories/usage.js");
    expect("pruneUsage" in usage).toBe(false);
  });
});
