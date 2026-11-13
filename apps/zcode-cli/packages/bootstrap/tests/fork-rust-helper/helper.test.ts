import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
function startHelper(env: NodeJS.ProcessEnv, cwd: string) {
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
  const done = runForkRustHelper({ input, output, env, cwd });
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
});
