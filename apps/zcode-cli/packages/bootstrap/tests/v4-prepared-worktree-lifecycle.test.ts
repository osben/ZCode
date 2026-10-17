// Host/runtime integration regression for the prepared-worktree lifecycle
// (specs/composer-worktree-setup-steps.md, "Validation"): real bridge hooks, real sqlite session
// store, and real gateway command admission, with a controllably deferred first model response.
// Proves: preparation completes at the first input's admission boundary (before the response
// finishes), repeat activation of the same attempt is idempotent (including on a cold Host), and a
// pre-admission failure leaves a recoverable preparation that retries the input exactly once.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionStorePort } from "@zcode/contracts";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import { V4InteractionRegistry } from "../src/zcode-protocol-v4/interaction-registry.js";
import type { ConversationV4Gateway } from "../src/zcode-protocol-v4/v4-gateway.js";
import { createConversationV4Gateway } from "../src/zcode-protocol/v4-bridge.js";
import type {
  ZCodeProtocolAgentServerContext,
  ZCodeProtocolSessionRecord,
} from "../src/zcode-protocol/server-types.js";

// The legacy record-creation operation drags in the full app-factory stack. The lifecycle under
// test only needs the hook's documented contract: the record is registered in context.sessions
// under the prepared id and the same id is returned.
vi.mock("../src/zcode-protocol/server-operations.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../src/zcode-protocol/server-operations.js")
  >();
  return { ...actual, createSessionRecordForV4: vi.fn() };
});
import { createSessionRecordForV4 } from "../src/zcode-protocol/server-operations.js";

const WORKSPACE = "/wt-lifecycle/workspace";
const TARGET_PATH = "/wt-lifecycle/worktrees/feature-a";
const BRANCH = "feature-a";
const ATTEMPT = "attempt-1";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

interface Harness {
  context: ZCodeProtocolAgentServerContext;
  gateway: ConversationV4Gateway;
  store: SessionStorePort;
  sentInputs: string[];
  heldCompletions: Array<{ promise: Promise<void>; resolve: () => void }>;
  materializations: string[];
  preparationNotifications: string[];
  /** While > 0, the fake runtime's sendInput rejects, simulating Core refusing admission. */
  failAdmissions: number;
  dbDir: string;
}

let harness: Harness | null = null;

function makeFakeRecord(sessionId: string, target: Harness): ZCodeProtocolSessionRecord {
  return {
    app: {
      sessionId,
      getModel: () => "glm/test-model",
      getMode: () => "build",
      close: async () => {},
      completeExternalQueueDrain: () => {},
      listThoughtLevels: () => [],
      setModel: async () => ({ model: "glm/test-model", previousModel: "glm/test-model" }),
      setThoughtLevel: async () => ({ thoughtLevel: "medium", previousThoughtLevel: "medium" }),
      sendInput: async (input: { text: string }) => {
        if (target.failAdmissions > 0) {
          target.failAdmissions -= 1;
          throw new Error("core rejected admission");
        }
        target.sentInputs.push(input.text);
        const held = deferred();
        target.heldCompletions.push(held);
        return { kind: "accepted", completion: held.promise };
      },
      runtime: {
        getSessionModelSelection: () => ({ providerId: "glm", modelId: "test-model" }),
        ensureSessionPersistedForExternalActivity: async () => {},
      },
    },
    traceContext: { traceId: "trace-wt-lifecycle", sessionId },
    workspace: { workspacePath: WORKSPACE, workspaceKey: WORKSPACE },
    persistence: "deferred",
  } as unknown as ZCodeProtocolSessionRecord;
}

async function makeHarness(dbPath: string): Promise<Harness> {
  const store = createSqliteSessionStore({ dbPath });
  const target: Harness = {
    context: null as unknown as ZCodeProtocolAgentServerContext,
    gateway: null as unknown as ConversationV4Gateway,
    store,
    sentInputs: [],
    heldCompletions: [],
    materializations: [],
    preparationNotifications: [],
    failAdmissions: 0,
    dbDir: "",
  };
  const context = {
    deps: { sessionStore: store, version: "wt-lifecycle-test" },
    appRuntimePreferences: {
      askUserQuestionAutoResolutionEnabled: false,
      modelIoFullRetentionEnabled: false,
      offPeakToolEnabled: false,
      dynamicWorkflowEnabled: false,
    },
    sessions: new Map<string, ZCodeProtocolSessionRecord>(),
    v4Interactions: new V4InteractionRegistry(),
    notify: () => {},
    requestClient: async () => {
      throw new Error("no client in wt lifecycle test");
    },
  } as unknown as ZCodeProtocolAgentServerContext;
  target.context = context;
  const gateway = createConversationV4Gateway(context);
  context.v4Gateway = gateway;
  target.gateway = gateway;
  vi.mocked(createSessionRecordForV4).mockImplementation(
    async (ctx, _rawParams, preparedSessionId) => {
      const sessionId = String(preparedSessionId);
      target.materializations.push(sessionId);
      ctx.sessions.set(sessionId, makeFakeRecord(sessionId, target));
      return { sessionId };
    },
  );
  // Record preparation publications while keeping the real one running: the bridge seeds
  // publishers and republishes the sessions-index from this notification.
  const originalNotify = gateway.notifyPreparedSessionChanged.bind(gateway);
  gateway.notifyPreparedSessionChanged = (sessionId: string) => {
    target.preparationNotifications.push(sessionId);
    return originalNotify(sessionId);
  };
  return target;
}

function command(type: string, payload: unknown, commandId: string, sessionId?: string) {
  return {
    type,
    commandId,
    clientId: "wt-lifecycle-test",
    sessionId: sessionId ?? null,
    payload,
    issuedAt: Date.now(),
  };
}

async function prepare(target: Harness, suffix = ""): Promise<string> {
  const ack = await target.gateway.handleCommand(
    command(
      "createSession",
      {
        workspaceId: WORKSPACE,
        worktreePreparation: {
          branchName: BRANCH,
          targetPath: TARGET_PATH,
          attemptId: ATTEMPT,
        },
      },
      `cmd-prepare${suffix}`,
    ),
  );
  expect(ack.status).toBe("accepted");
  const sessionId = (ack.result as { sessionId: string }).sessionId;
  expect(sessionId).toBeTruthy();
  return sessionId;
}

function activationPayload(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: WORKSPACE,
    preparedSessionId: undefined as string | undefined,
    expectedAttemptId: ATTEMPT,
    executionWorktree: { path: TARGET_PATH, branchName: BRANCH },
    firstInput: { text: "frozen first input" },
    ...overrides,
  };
}

async function readPreparationStatus(
  target: Harness,
  sessionId: string,
): Promise<string | null> {
  const entries = await target.store.sessionEntries!({
    sessionID: sessionId as never,
    type: "v4/worktree_preparation",
  });
  const data = entries.at(-1)?.data as { status?: string } | undefined;
  return data?.status ?? null;
}

async function admittedInputCount(target: Harness, sessionId: string): Promise<number> {
  const inputs = await target.store.listSessionInputs!({ sessionID: sessionId as never });
  return inputs.filter((input) => input.status === "admitted" || input.status === "promoted")
    .length;
}

beforeEach(() => {
  harness = null;
});

afterEach(() => {
  vi.mocked(createSessionRecordForV4).mockReset();
  if (harness?.store) void harness.store.close?.();
  if (harness?.dbDir) rmSync(harness.dbDir, { recursive: true, force: true });
  harness = null;
});

describe("prepared worktree lifecycle (real bridge + sqlite store + gateway)", () => {
  it("completes preparation at the first input's admission boundary, before the response finishes", async () => {
    const dbDir = mkdtempSync(join(tmpdir(), "wt-lifecycle-"));
    const target = await makeHarness(join(dbDir, "sessions.sqlite"));
    harness = { ...target, dbDir };
    const sessionId = await prepare(target);

    const ack = await target.gateway.handleCommand(
      command(
        "createSession",
        activationPayload({ preparedSessionId: sessionId }),
        "cmd-activate",
      ),
    );
    expect(ack.status).toBe("accepted");
    expect((ack.result as { sessionId: string }).sessionId).toBe(sessionId);
    expect((ack.result as { input?: { delivery: string } }).input?.delivery).toBe("startNow");

    // The first model response is still held: preparation must already be complete.
    expect(target.sentInputs).toEqual(["frozen first input"]);
    expect(target.heldCompletions).toHaveLength(1);
    expect(await readPreparationStatus(target, sessionId)).toBe("active");
    expect(target.context.preparedWorktreeSessions?.get(sessionId)).toBeUndefined();
    expect(target.preparationNotifications).toContain(sessionId);

    // A second send during the running first response is ordinary session input, not a new
    // reservation: no second runtime and no second createSession materialization.
    const second = await target.gateway.handleCommand(
      command("sendText", { text: "second message" }, "cmd-second", sessionId),
    );
    expect(second.status).toBe("accepted");
    expect(target.materializations).toEqual([sessionId]);
    expect(target.sentInputs).toEqual(["frozen first input", "second message"]);

    target.heldCompletions.forEach((held) => held.resolve());
  });

  it("repeat activation of the same attempt returns the existing session without a second input", async () => {
    const dbDir = mkdtempSync(join(tmpdir(), "wt-lifecycle-"));
    const target = await makeHarness(join(dbDir, "sessions.sqlite"));
    harness = { ...target, dbDir };
    const sessionId = await prepare(target);

    const first = await target.gateway.handleCommand(
      command("createSession", activationPayload({ preparedSessionId: sessionId }), "cmd-activate"),
    );
    expect(first.status).toBe("accepted");

    const repeat = await target.gateway.handleCommand(
      command(
        "createSession",
        activationPayload({ preparedSessionId: sessionId }),
        "cmd-reactivate",
      ),
    );
    expect(repeat.status).toBe("accepted");
    expect((repeat.result as { sessionId: string }).sessionId).toBe(sessionId);
    expect((repeat.result as { input?: unknown }).input).toBeUndefined();
    expect(target.materializations).toEqual([sessionId]);
    expect(target.sentInputs).toEqual(["frozen first input"]);
    expect(await admittedInputCount(target, sessionId)).toBe(1);
    expect(await readPreparationStatus(target, sessionId)).toBe("active");

    target.heldCompletions.forEach((held) => held.resolve());
  });

  it("repeat activation works identically on a cold Host restored from the same store", async () => {
    const dbDir = mkdtempSync(join(tmpdir(), "wt-lifecycle-"));
    const dbPath = join(dbDir, "sessions.sqlite");
    const first = await makeHarness(dbPath);
    const sessionId = await prepare(first);
    const ack = await first.gateway.handleCommand(
      command("createSession", activationPayload({ preparedSessionId: sessionId }), "cmd-activate"),
    );
    expect(ack.status).toBe("accepted");
    first.heldCompletions.forEach((held) => held.resolve());
    await first.store.close?.();

    // Cold Host: same durable store, no in-memory sessions, no gateway state.
    const second = await makeHarness(dbPath);
    harness = { ...second, dbDir };
    const repeat = await second.gateway.handleCommand(
      command(
        "createSession",
        activationPayload({ preparedSessionId: sessionId }),
        "cmd-cold-reactivate",
      ),
    );
    expect(repeat.status).toBe("accepted");
    expect((repeat.result as { sessionId: string }).sessionId).toBe(sessionId);
    expect(second.materializations).toEqual([]);
    expect(second.sentInputs).toEqual([]);
    expect(await admittedInputCount(second, sessionId)).toBe(1);
    expect(await readPreparationStatus(second, sessionId)).toBe("active");
  });

  it("a materialized runtime with an admitted input receipt heals completion without re-sending", async () => {
    const dbDir = mkdtempSync(join(tmpdir(), "wt-lifecycle-"));
    const target = await makeHarness(join(dbDir, "sessions.sqlite"));
    harness = { ...target, dbDir };
    const sessionId = await prepare(target);

    // Simulate an activation that admitted its input durably but crashed before the active
    // receipt persisted: runtime present, durable status still preparing, ledger row admitted.
    target.context.sessions.set(sessionId, makeFakeRecord(sessionId, target));
    await target.store.saveSessionInput({
      id: "queue_cmd-original",
      sessionID: sessionId as never,
      kind: "sendText",
      delivery: "startNow",
      payload: { text: "frozen first input" },
    } as never);

    const ack = await target.gateway.handleCommand(
      command(
        "createSession",
        activationPayload({ preparedSessionId: sessionId }),
        "cmd-retry-new-id",
      ),
    );
    expect(ack.status).toBe("accepted");
    expect((ack.result as { input?: unknown }).input).toBeUndefined();
    expect(target.sentInputs).toEqual([]);
    expect(target.materializations).toEqual([]);
    expect(await readPreparationStatus(target, sessionId)).toBe("active");
  });

  it("a pre-admission failure keeps the preparation recoverable and retries the input exactly once", async () => {
    const dbDir = mkdtempSync(join(tmpdir(), "wt-lifecycle-"));
    const target = await makeHarness(join(dbDir, "sessions.sqlite"));
    harness = { ...target, dbDir };
    const sessionId = await prepare(target);

    // Core refuses the first input's admission; the runtime stays materialized.
    target.failAdmissions = 1;
    const failed = await target.gateway.handleCommand(
      command(
        "createSession",
        activationPayload({ preparedSessionId: sessionId }),
        "cmd-fail",
      ),
    );
    expect(failed.status).toBe("failed");
    expect(await readPreparationStatus(target, sessionId)).toBe("preparing");

    // Retry with a new command id: exactly one successful admission and a completed preparation.
    const retried = await target.gateway.handleCommand(
      command(
        "createSession",
        activationPayload({ preparedSessionId: sessionId }),
        "cmd-retry",
      ),
    );
    expect(retried.status).toBe("accepted");
    expect((retried.result as { input?: { delivery: string } }).input?.delivery).toBe("startNow");
    expect(target.sentInputs).toEqual(["frozen first input"]);
    expect(target.materializations).toEqual([sessionId]);
    expect(await readPreparationStatus(target, sessionId)).toBe("active");

    target.heldCompletions.forEach((held) => held.resolve());
  });

  it("rejects mismatched worktree or stale attempt without side effects", async () => {
    const dbDir = mkdtempSync(join(tmpdir(), "wt-lifecycle-"));
    const target = await makeHarness(join(dbDir, "sessions.sqlite"));
    harness = { ...target, dbDir };
    const sessionId = await prepare(target);

    const wrongPath = await target.gateway.handleCommand(
      command(
        "createSession",
        activationPayload({
          preparedSessionId: sessionId,
          executionWorktree: { path: "/wt-lifecycle/other", branchName: BRANCH },
        }),
        "cmd-wrong-path",
      ),
    );
    expect(wrongPath.status).toBe("failed");

    const staleAttempt = await target.gateway.handleCommand(
      command(
        "createSession",
        activationPayload({ preparedSessionId: sessionId, expectedAttemptId: "attempt-stale" }),
        "cmd-stale-attempt",
      ),
    );
    expect(staleAttempt.status).toBe("failed");

    expect(target.materializations).toEqual([]);
    expect(target.sentInputs).toEqual([]);
    expect(await readPreparationStatus(target, sessionId)).toBe("preparing");
  });
});
