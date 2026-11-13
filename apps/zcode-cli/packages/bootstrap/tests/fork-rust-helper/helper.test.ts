import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import {
  FORK_RUST_HELPER_METHODS,
  FORK_RUST_HELPER_PROTOCOL_VERSION,
  runForkRustHelper,
} from "../../src/fork-rust-helper/contract.js";
import { resolveDynamicWorkflowJournalStore } from "../../src/app/dynamic-workflow-run-journal.js";
import { createArtifactReadCache } from "../../src/fork-rust-helper/artifact-read-cache.js";
import { createWorkflowRunReads } from "../../src/fork-rust-helper/workflow-run-reads.js";

// Rule 2 of specs/fork-rust-node-helper.md: run history is read from the journal directly. The run
// service's constructor reconciles orphan runs (a journal write), and the gateway's read path
// cold-resumes the session; the helper must reach neither.
const forbidden = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("../../src/app/dynamic-workflow-run-service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/app/dynamic-workflow-run-service.js")>();
  return {
    ...actual,
    createDynamicWorkflowRunService: (...args: unknown[]) => {
      forbidden.calls.push("createDynamicWorkflowRunService");
      return (actual.createDynamicWorkflowRunService as (...rest: unknown[]) => unknown)(...args);
    },
  };
});

interface Frame {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

const dirs: string[] = [];
afterEach(async () => {
  forbidden.calls.length = 0;
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempHome() {
  const dir = await mkdtemp(join(tmpdir(), "zcode-fork-rust-helper-"));
  dirs.push(dir);
  const storageDir = join(dir, "home", ".zcode");
  const workspace = join(dir, "project");
  await mkdir(workspace, { recursive: true });
  const dbPath = join(storageDir, "cli", "db", "db.sqlite");
  // `~/` defaults (the session database among them) resolve through os.homedir(), which reads this
  // process's HOME, not the env handed to the helper: stub it so no test reaches the real home.
  vi.stubEnv("HOME", join(dir, "home"));
  return {
    dir,
    storageDir,
    workspace,
    dbPath,
    env: {
      ...process.env,
      HOME: join(dir, "home"),
      ZCODE_STORAGE_DIR: storageDir,
      ZCODE_SESSION_DB_PATH: dbPath,
    },
  };
}

/** Drives the helper over its real stdio framing, the way the Rust agent does. */
function startHelper(env: NodeJS.ProcessEnv, cwd: string, signal?: AbortSignal) {
  const input = new PassThrough();
  const output = new PassThrough();
  const pending = new Map<string, (frame: Frame) => void>();
  const notifications: Frame[] = [];
  createInterface({ input: output }).on("line", (line) => {
    const frame = JSON.parse(line) as Frame;
    if (frame.id !== undefined && pending.has(String(frame.id))) {
      pending.get(String(frame.id))!(frame);
      pending.delete(String(frame.id));
    } else if (frame.method) notifications.push(frame);
  });
  const done = runForkRustHelper({ input, output, env, cwd, ...(signal ? { signal } : {}) });
  let next = 0;
  return {
    notifications,
    done,
    request(method: string, params: unknown): Promise<Frame> {
      next += 1;
      const id = `rs-${next}`;
      const reply = new Promise<Frame>((resolve) => pending.set(id, resolve));
      input.write(`${JSON.stringify({ id, method, params })}\n`);
      return reply;
    },
    close() {
      input.end();
    },
  };
}

describe("fork: Node helper for the Rust agent", () => {
  it("answers helper/initialize with its protocol version and the forwarded methods", async () => {
    const home = await tempHome();
    const helper = startHelper(home.env, home.workspace);
    const reply = await helper.request("helper/initialize", { protocolVersion: 1 });
    expect(reply.error).toBeUndefined();
    expect(reply.result).toEqual({
      protocolVersion: FORK_RUST_HELPER_PROTOCOL_VERSION,
      methods: [...FORK_RUST_HELPER_METHODS],
    });
    // F1+F2 only: nothing session-bound is served yet.
    expect(FORK_RUST_HELPER_METHODS.some((method) => method.startsWith("mcp/ui"))).toBe(false);
    expect(FORK_RUST_HELPER_METHODS).not.toContain("plugins/mentionItems");
    helper.close();
    await helper.done;
  });

  it("refuses an initialize with another protocol version", async () => {
    const home = await tempHome();
    const helper = startHelper(home.env, home.workspace);
    const reply = await helper.request("helper/initialize", { protocolVersion: 2 });
    expect(reply.error?.message).toMatch(/protocol version/i);
    helper.close();
    await helper.done;
  });

  it("answers -32601 for methods outside its allowlist", async () => {
    const home = await tempHome();
    const helper = startHelper(home.env, home.workspace);
    const reply = await helper.request("session/create", { workspace: { workspacePath: home.workspace } });
    expect(reply.error?.code).toBe(-32601);
    helper.close();
    await helper.done;
  });

  it("serves plugin management and saved workflows against the storage root from the env", async () => {
    const home = await tempHome();
    const helper = startHelper(home.env, home.workspace);
    const workspace = { workspacePath: home.workspace, workspaceKey: home.workspace };

    const plugins = await helper.request("plugins/list", { workspace });
    expect(plugins.error).toBeUndefined();
    expect(Array.isArray(plugins.result?.plugins)).toBe(true);

    const cancelled = await helper.request("plugins/cancelOperation", { operationId: "op-unknown" });
    expect(cancelled.result).toEqual({ operationId: "op-unknown", cancelled: false });

    const workflows = await helper.request("workflows/list", { workspace });
    expect(workflows.error).toBeUndefined();
    expect(workflows.result?.workflows).toEqual([]);
    expect(workflows.result?.dir).toBe(join(home.workspace, ".zcode", "workflows"));
    helper.close();
    await helper.done;
  }, 60_000);

  it("reads run history from the journal without building the run service or touching the run", async () => {
    const home = await tempHome();
    const store = await createSqliteSessionStore({ dbPath: home.dbPath });
    const journal = resolveDynamicWorkflowJournalStore(store as never)!;
    journal.createRun({
      runId: "dwfrun-helper-running",
      parentSessionId: "session-rust-owned",
      cwd: home.workspace,
      name: "nightly",
      caps: { maxConcurrency: 4 },
      spentTokens: 0,
      status: "running",
    });
    journal.createRun({
      runId: "dwfrun-other-session",
      parentSessionId: "session-other",
      caps: { maxConcurrency: 4 },
      spentTokens: 0,
      status: "completed",
    });
    journal.appendEvent("dwfrun-helper-running", {
      caps: { maxConcurrency: 4 },
      runId: "dwfrun-helper-running",
      type: "run-started",
    });
    store.close();

    const helper = startHelper(home.env, home.workspace);
    const workspace = { workspacePath: home.workspace, workspaceKey: home.workspace };
    const runs = await helper.request("v4/conversation/workflowRuns", {
      workspace,
      sessionId: "session-rust-owned",
    });
    expect(runs.error).toBeUndefined();
    expect(runs.result?.runs).toEqual([
      expect.objectContaining({ runId: "dwfrun-helper-running", status: "running", label: "nightly" }),
    ]);

    const events = await helper.request("v4/conversation/workflowRunEvents", {
      workspace,
      sessionId: "session-rust-owned",
      runId: "dwfrun-helper-running",
    });
    expect(events.error).toBeUndefined();
    expect(events.result).toEqual({
      events: [expect.objectContaining({ sequence: 0 })],
      hasMore: false,
    });

    // A run of another conversation is the same business fact as an unknown run.
    const foreign = await helper.request("v4/conversation/workflowRunEvents", {
      workspace,
      sessionId: "session-rust-owned",
      runId: "dwfrun-other-session",
    });
    expect(foreign.result).toEqual({ events: [], hasMore: false });
    const foreignArtifacts = await helper.request("v4/conversation/workflowRunArtifacts", {
      workspace,
      sessionId: "session-rust-owned",
      runId: "dwfrun-other-session",
    });
    expect(foreignArtifacts.result).toEqual({ artifacts: [] });
    const missingNode = await helper.request("v4/conversation/workflowRunNodeResult", {
      workspace,
      sessionId: "session-rust-owned",
      runId: "dwfrun-helper-running",
      siteId: "site-missing",
      ordinal: 0,
    });
    expect(missingNode.error?.message).toMatch(/^fault\.workflowRunNodeResult\.notFound/);

    helper.close();
    await helper.done;

    expect(forbidden.calls).toEqual([]);
    const reopened = await createSqliteSessionStore({ dbPath: home.dbPath });
    // Orphan reconciliation would have stopped this run (status "stopped", reason "interrupted").
    expect(resolveDynamicWorkflowJournalStore(reopened as never)!.getRun("dwfrun-helper-running")?.status).toBe(
      "running",
    );
    reopened.close();
  }, 60_000);
  it("serves the file-only saved workflow methods without opening the session database", async () => {
    const home = await tempHome();
    // A regular file where the database directory should be: the store cannot be opened.
    const blocker = join(home.dir, "not-a-dir");
    await writeFile(blocker, "");
    const env = { ...home.env, ZCODE_SESSION_DB_PATH: join(blocker, "db.sqlite") };
    const helper = startHelper(env, home.workspace);
    const workspace = { workspacePath: home.workspace, workspaceKey: home.workspace };

    const workflows = await helper.request("workflows/list", { workspace });
    expect(workflows.error).toBeUndefined();
    expect(workflows.result?.workflows).toEqual([]);
    // Only the journal-backed methods need the database, and they report its failure.
    const runs = await helper.request("workflows/runs", { workspace, workflowId: "nightly" });
    expect(runs.error).toBeDefined();
    helper.close();
    await helper.done;
  }, 60_000);

  it("refuses a session-authority plugin reference catalog: the conversation belongs to the Rust agent", async () => {
    const home = await tempHome();
    const helper = startHelper(home.env, home.workspace);
    const workspace = { workspacePath: home.workspace, workspaceKey: home.workspace };

    const draft = await helper.request("plugins/referenceCatalogWithCategory", { workspace });
    expect(draft.error).toBeUndefined();
    expect(draft.result?.authority).toBe("workspace");

    for (const method of ["plugins/referenceCatalog", "plugins/referenceCatalogWithCategory"]) {
      const session = await helper.request(method, { workspace, sessionId: "session-rust-owned" });
      expect(session.result).toBeUndefined();
      expect(session.error?.data).toEqual({
        reasonCode: "proto.forkRustAgent.sessionPluginCatalogUnavailable",
      });
    }
    helper.close();
    await helper.done;
  }, 60_000);

  it("closes and releases its stores when the process lifecycle aborts, with stdin still open", async () => {
    const home = await tempHome();
    const controller = new AbortController();
    const helper = startHelper(home.env, home.workspace, controller.signal);
    const reply = await helper.request("helper/initialize", { protocolVersion: 1 });
    expect(reply.error).toBeUndefined();
    controller.abort(new Error("Protocol received SIGTERM"));
    await expect(helper.done).resolves.toBeUndefined();
  });
});

describe("fork: Node helper run-history reads", () => {
  it("degrades a failed run enumeration to an empty list with Node's warning", async () => {
    const warn = vi.fn();
    const journal = {
      getRun: () => undefined,
      listRunsByParentSession: () => {
        throw new Error("database is locked");
      },
      listOrphanRuns: () => [],
    };
    const reads = createWorkflowRunReads({
      journal: async () => journal as never,
      artifactStore: undefined,
      logger: { warn } as never,
    });
    const workspace = { workspacePath: "/tmp/project", workspaceKey: "/tmp/project" };
    await expect(
      reads["v4/conversation/workflowRuns"]({ workspace, sessionId: "session-1" }),
    ).resolves.toEqual({ runs: [] });
    expect(warn).toHaveBeenCalledWith(
      "Dynamic workflow run enumeration failed",
      expect.objectContaining({ event: "dynamic_workflow.run.list_failed" }),
    );
  });
});

describe("fork: Node helper artifact read cache", () => {
  const payload = (size: number) => ({ bytes: new Uint8Array(size), mediaType: "text/plain" });

  it("evicts the least recently read artifact when over its byte budget", async () => {
    let clock = 0;
    const cache = createArtifactReadCache({ now: () => clock, maxBytes: 10, ttlMs: 1_000 });
    const loads: string[] = [];
    const read = (key: string, size: number) =>
      cache.read(key, async () => {
        loads.push(key);
        return payload(size);
      });
    await read("a", 4);
    clock = 1;
    await read("b", 4);
    clock = 2;
    await read("a", 4); // a is now the hot entry
    clock = 3;
    await read("c", 4); // 12 bytes > 10: b, the coldest, goes
    expect(cache.stats()).toEqual({ entries: 2, bytes: 8 });
    await read("a", 4);
    await read("b", 4);
    expect(loads).toEqual(["a", "b", "c", "b"]);
    cache.clear();
  });

  it("releases idle artifacts after the TTL without waiting for another read", async () => {
    vi.useFakeTimers();
    try {
      let clock = 0;
      const cache = createArtifactReadCache({ now: () => clock, maxBytes: 100, ttlMs: 1_000 });
      await cache.read("a", async () => payload(8));
      expect(cache.stats()).toEqual({ entries: 1, bytes: 8 });
      clock = 1_001;
      await vi.advanceTimersByTimeAsync(1_001);
      expect(cache.stats()).toEqual({ entries: 0, bytes: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts a slow load as read when it settles, so it is not the first entry evicted", async () => {
    let clock = 0;
    const cache = createArtifactReadCache({ now: () => clock, maxBytes: 10, ttlMs: 1_000 });
    let settle: (value: { bytes: Uint8Array; mediaType: string }) => void = () => undefined;
    const slow = cache.read("x", () => new Promise((resolve) => (settle = resolve)));
    clock = 5;
    await cache.read("a", async () => payload(4));
    clock = 6;
    settle(payload(8)); // 12 bytes > 10: a (read at 5) goes, not x (settled at 6)
    await slow;
    const loads: string[] = [];
    await cache.read("x", async () => {
      loads.push("x");
      return payload(8);
    });
    expect(loads).toEqual([]);
    expect(cache.stats()).toEqual({ entries: 1, bytes: 8 });
    cache.clear();
  });

  it("keeps a load in flight past the TTL, so a concurrent reader shares it", async () => {
    let clock = 0;
    const cache = createArtifactReadCache({ now: () => clock, maxBytes: 100, ttlMs: 1_000 });
    let loads = 0;
    let settle: (value: { bytes: Uint8Array; mediaType: string }) => void = () => undefined;
    const load = () => {
      loads += 1;
      return new Promise<{ bytes: Uint8Array; mediaType: string }>((resolve) => (settle = resolve));
    };
    const first = cache.read("x", load);
    clock = 2_000;
    const second = cache.read("x", load);
    settle(payload(4));
    await Promise.all([first, second]);
    expect(loads).toBe(1);
    expect(cache.stats()).toEqual({ entries: 1, bytes: 4 });
    cache.clear();
  });

  it("forgets a failed read so the next one retries", async () => {
    const cache = createArtifactReadCache({ now: () => 0, maxBytes: 100, ttlMs: 1_000 });
    await expect(cache.read("a", async () => Promise.reject(new Error("gone")))).rejects.toThrow("gone");
    await expect(cache.read("a", async () => payload(2))).resolves.toEqual(payload(2));
    cache.clear();
  });
});
