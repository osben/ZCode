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
import { createProjectId, type SessionStorePort } from "@zcode/contracts";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import { INCOGNITO_LOCKDOWN_PROFILE } from "@zcode/shared";
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
  const store = await createSqliteSessionStore({ dbPath });
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

async function readSubmissionPreparationStatus(
  target: Harness,
  sessionId: string,
): Promise<string | null> {
  const entries = await target.store.sessionEntries!({
    sessionID: sessionId as never,
    type: "v4/fork_submission_preparation",
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
  it("persists a compatible ready prewarm without creating a second runtime", async () => {
    const dbDir = mkdtempSync(join(tmpdir(), "submission-prewarm-"));
    const target = await makeHarness(join(dbDir, "sessions.sqlite"));
    harness = { ...target, dbDir };
    const sessionId = "ready-prewarm";
    const record = makeFakeRecord(sessionId, target);
    Object.assign(record.app.runtime, {
      isIncognito: () => false,
      getExecutionWorktree: () => undefined,
      ensureSessionPersistedForExternalActivity: async () => {
        const now = Date.now();
        await target.store.createSession({ id: sessionId as never, projectID: createProjectId("prewarm"), directory: WORKSPACE, path: WORKSPACE, slug: "prewarm", title: "New session", version: "test", time: { created: now, updated: now } });
      },
    });
    target.context.sessions.set(sessionId, record);
    const reserved = await target.gateway.handleCommand(command("createSession", { workspaceId: WORKSPACE, sessionId, submissionPreparation: { submissionId: "warm-input" } }, "reserve-prewarm"));
    expect(reserved.status).toBe("accepted");
    const activated = await target.gateway.handleCommand(command("createSession", { workspaceId: WORKSPACE, preparedSessionId: sessionId, expectedSubmissionId: "warm-input" }, "activate-prewarm"));
    expect(activated.status).toBe("accepted");
    expect(target.context.sessions.get(sessionId)).toBe(record);
    expect(target.materializations).toEqual([]);
    expect(await target.store.getSession(sessionId as never)).toBeTruthy();
  });
  it("retains the reserved identity when runtime materialization itself rejects", async () => {
    const dbDir = mkdtempSync(join(tmpdir(), "submission-startup-"));
    const target = await makeHarness(join(dbDir, "sessions.sqlite"));
    harness = { ...target, dbDir };
    const sessionId = "reserved-startup-failure";
    await target.gateway.handleCommand(command("createSession", { workspaceId: WORKSPACE, sessionId, submissionPreparation: { submissionId: "startup-failure" } }, "reserve-startup"));
    const activation = { workspaceId: WORKSPACE, preparedSessionId: sessionId, expectedSubmissionId: "startup-failure", firstInput: { text: "Retain this input" } };
    vi.mocked(createSessionRecordForV4).mockRejectedValueOnce(new Error("runtime startup failed"));
    const failed = await target.gateway.handleCommand(command("createSession", activation, "activate-startup-failure"));
    expect(failed.status).toBe("failed");
    expect(await target.store.getSession(sessionId as never)).toBeTruthy();
    expect(target.sentInputs).toEqual([]);
    const retried = await target.gateway.handleCommand(command("createSession", activation, "retry-startup-failure"));
    expect(retried.status).toBe("accepted");
    expect(retried.result).toMatchObject({ sessionId });
    expect(target.materializations).toEqual([sessionId]);
    expect(target.sentInputs).toEqual(["Retain this input"]);
    target.heldCompletions.forEach((held) => held.resolve());
  });
  it("keeps a two-step submission recoverable until sendText admission, including a cold retry", async () => {
    const dbDir = mkdtempSync(join(tmpdir(), "submission-two-step-"));
    const dbPath = join(dbDir, "sessions.sqlite");
    const target = await makeHarness(dbPath);
    harness = { ...target, dbDir };
    const sessionId = "two-step-submission";
    await target.gateway.handleCommand(command("createSession", {
      workspaceId: WORKSPACE, sessionId,
      submissionPreparation: { submissionId: "two-step" },
    }, "reserve-two-step"));
    const activation = { workspaceId: WORKSPACE, preparedSessionId: sessionId, expectedSubmissionId: "two-step" };
    const initialized = await target.gateway.handleCommand(command("createSession", activation, "initialize-two-step"));
    expect(initialized.status).toBe("accepted");
    const entries = await target.store.sessionEntries!({ sessionID: sessionId as never, type: "v4/fork_submission_preparation" });
    expect(entries.at(-1)?.data).toMatchObject({ status: "preparing" });
    expect(target.sentInputs).toEqual([]);
    target.gateway.dispose();
    await target.store.close?.();
    const cold = await makeHarness(dbPath);
    harness = { ...cold, dbDir };
    const retry = await cold.gateway.handleCommand(command("createSession", activation, "retry-initialize-two-step"));
    expect(retry.status).toBe("accepted");
    expect(cold.materializations).toEqual([sessionId]);
    const sent = await cold.gateway.handleCommand(command("sendText", { text: "one frozen input", firstSubmissionId: "two-step" }, "send-two-step", sessionId));
    expect(sent.status).toBe("accepted");
    expect(cold.sentInputs).toEqual(["one frozen input"]);
    const active = await cold.store.sessionEntries!({ sessionID: sessionId as never, type: "v4/fork_submission_preparation" });
    expect(active.at(-1)?.data).toMatchObject({ status: "active" });
    cold.heldCompletions.forEach((held) => held.resolve());
  });
  it("admits a reserved activation by the frozen input's own command id, never by a foreign input", async () => {
    const dbDir = mkdtempSync(join(tmpdir(), "submission-lifecycle-"));
    const target = await makeHarness(join(dbDir, "sessions.sqlite"));
    harness = { ...target, dbDir };
    const sessionId = "identity-submission";
    await target.gateway.handleCommand(command("createSession", {
      workspaceId: WORKSPACE, sessionId, submissionPreparation: { submissionId: "identity" },
    }, "reserve-identity"));
    const activation = { workspaceId: WORKSPACE, preparedSessionId: sessionId, expectedSubmissionId: "identity" };
    const materialized = await target.gateway.handleCommand(command("createSession", activation, "materialize-identity"));
    expect(materialized.status).toBe("accepted");
    // A foreign input (another window or mobile remote control) executes, but it names no submission,
    // so it must leave the reserved preparation preparing.
    const foreign = await target.gateway.handleCommand(command("sendText", { text: "foreign input" }, "cmd-foreign", sessionId));
    expect(foreign.status).toBe("accepted");
    target.heldCompletions.forEach((held) => held.resolve());
    expect(await readSubmissionPreparationStatus(target, sessionId)).toBe("preparing");
    expect(target.sentInputs).toEqual(["foreign input"]);

    // "cmd-frozen" was never admitted and the preparation is still preparing: the retry sees a runtime
    // and answers input-pending, so the sender admits the frozen input once.
    const notAdmitted = await target.gateway.handleCommand(command("createSession", { ...activation, expectedFirstInputCommandId: "cmd-frozen" }, "retry-frozen-not-admitted"));
    expect(notAdmitted.status).toBe("accepted");
    expect(notAdmitted.result).toMatchObject({ sessionId, preparedActivation: "input-pending" });

    // The frozen sendText names its submission: it completes the preparation and is admitted under its own id.
    const frozen = await target.gateway.handleCommand(command("sendText", { text: "frozen input", firstSubmissionId: "identity" }, "cmd-frozen", sessionId));
    expect(frozen.status).toBe("accepted");
    target.heldCompletions.forEach((held) => held.resolve());
    expect(await readSubmissionPreparationStatus(target, sessionId)).toBe("active");
    expect(target.sentInputs).toEqual(["foreign input", "frozen input"]);

    // Once the frozen input is admitted under its own id, the same retry reports input-admitted and is not sent again.
    const admittedRetry = await target.gateway.handleCommand(command("createSession", { ...activation, expectedFirstInputCommandId: "cmd-frozen" }, "retry-frozen-admitted"));
    expect(admittedRetry.status).toBe("accepted");
    expect(admittedRetry.result).toMatchObject({ sessionId, preparedActivation: "input-admitted" });
    expect(target.sentInputs).toEqual(["foreign input", "frozen input"]);
    target.heldCompletions.forEach((held) => held.resolve());
  });

  it("a sendText naming another submission leaves the preparation preparing, and a cold process reads the persisted entry", async () => {
    const dbDir = mkdtempSync(join(tmpdir(), "submission-cold-owner-"));
    const dbPath = join(dbDir, "sessions.sqlite");
    const target = await makeHarness(dbPath);
    harness = { ...target, dbDir };
    const sessionId = "cold-owner-submission";
    await target.gateway.handleCommand(command("createSession", {
      workspaceId: WORKSPACE, sessionId, submissionPreparation: { submissionId: "cold-owner" },
    }, "reserve-cold-owner"));
    const activation = { workspaceId: WORKSPACE, preparedSessionId: sessionId, expectedSubmissionId: "cold-owner" };
    expect((await target.gateway.handleCommand(command("createSession", activation, "materialize-cold-owner"))).status).toBe("accepted");
    const otherSubmission = await target.gateway.handleCommand(command("sendText", { text: "other submission", firstSubmissionId: "someone-else" }, "cmd-other-submission", sessionId));
    expect(otherSubmission.status).toBe("accepted");
    target.heldCompletions.forEach((held) => held.resolve());
    expect(await readSubmissionPreparationStatus(target, sessionId)).toBe("preparing");
    target.gateway.dispose();
    await target.store.close?.();

    // The cold process has no resident preparation: it must read the persisted entry's submissionId.
    const cold = await makeHarness(dbPath);
    harness = { ...cold, dbDir };
    // A real retry carries its original command id; no admitted row for it exists, so the runtime is materialized.
    const retry = await cold.gateway.handleCommand(command("createSession", { ...activation, expectedFirstInputCommandId: "cmd-cold-frozen" }, "retry-cold-owner"));
    expect(retry.status).toBe("accepted");
    expect(cold.materializations).toEqual([sessionId]);
    const wrong = await cold.gateway.handleCommand(command("sendText", { text: "wrong id", firstSubmissionId: "someone-else" }, "cmd-cold-wrong", sessionId));
    expect(wrong.status).toBe("accepted");
    cold.heldCompletions.forEach((held) => held.resolve());
    expect(await readSubmissionPreparationStatus(cold, sessionId)).toBe("preparing");
    const own = await cold.gateway.handleCommand(command("sendText", { text: "own frozen", firstSubmissionId: "cold-owner" }, "cmd-cold-own", sessionId));
    expect(own.status).toBe("accepted");
    cold.heldCompletions.forEach((held) => held.resolve());
    expect(await readSubmissionPreparationStatus(cold, sessionId)).toBe("active");
  });

  it("a foreign admitted row does not count as the frozen input's admission while the preparation stays preparing", async () => {
    const dbDir = mkdtempSync(join(tmpdir(), "submission-lifecycle-"));
    const target = await makeHarness(join(dbDir, "sessions.sqlite"));
    harness = { ...target, dbDir };
    const sessionId = "foreign-row-submission";
    await target.gateway.handleCommand(command("createSession", {
      workspaceId: WORKSPACE, sessionId, submissionPreparation: { submissionId: "foreign-row" },
    }, "reserve-foreign-row"));
    const activation = { workspaceId: WORKSPACE, preparedSessionId: sessionId, expectedSubmissionId: "foreign-row" };
    expect((await target.gateway.handleCommand(command("createSession", activation, "materialize-foreign-row"))).status).toBe("accepted");
    // An admitted row for another command lands without the bridge's marker flip (the marker write
    // failed, or the row came from a path that does not mark the preparation), so it stays preparing.
    await target.store.saveSessionInput!({
      id: "queue_cmd-foreign-row",
      sessionID: sessionId as never,
      kind: "sendText",
      delivery: "startNow",
      payload: { text: "foreign input", intent: { sourceCommandId: "cmd-foreign-row" } },
    } as never);
    expect(await readSubmissionPreparationStatus(target, sessionId)).toBe("preparing");

    // Identity decides: "cmd-frozen-row" has no row, so the foreign row is not its admission.
    // The runtime exists, so the answer is input-pending and the sender admits the frozen input once.
    const retry = await target.gateway.handleCommand(command("createSession", { ...activation, expectedFirstInputCommandId: "cmd-frozen-row" }, "retry-foreign-row"));
    expect(retry.status).toBe("accepted");
    expect(retry.result).toMatchObject({ sessionId, preparedActivation: "input-pending" });
    expect(target.sentInputs).toEqual([]);
    target.heldCompletions.forEach((held) => held.resolve());
  });

  it("reserves an ordinary submitted session before runtime creation and restores without auto-running", async () => {
    const dbDir = mkdtempSync(join(tmpdir(), "submission-lifecycle-"));
    const dbPath = join(dbDir, "sessions.sqlite");
    const target = await makeHarness(dbPath);
    harness = { ...target, dbDir };
    const reserve = await target.gateway.handleCommand(command("createSession", {
      workspaceId: WORKSPACE,
      sessionId: "durable-submission-1",
      submissionPreparation: { submissionId: "submission-1" },
    }, "cmd-reserve-submission"));
    expect(reserve.status).toBe("accepted");
    expect(reserve.result).toMatchObject({ sessionId: "durable-submission-1" });
    expect(target.materializations).toEqual([]);
    expect(await target.store.getSession("durable-submission-1" as never)).toBeTruthy();
    await target.store.close?.();
    target.gateway.dispose();

    const cold = await makeHarness(dbPath);
    harness = { ...cold, dbDir };
    await cold.gateway.subscribe({
      topic: "conversation/durable-submission-1",
      connectionId: "submission-restart",
      clientMode: "desktop-continuous",
    });
    expect(cold.context.sessions.size).toBe(0);
    expect(cold.materializations).toEqual([]);
    expect(cold.sentInputs).toEqual([]);
  });

  it("keeps a reserved incognito row through bootstrap failure and reuses it on explicit retry", async () => {
    const dbDir = mkdtempSync(join(tmpdir(), "submission-lifecycle-"));
    const target = await makeHarness(join(dbDir, "sessions.sqlite"));
    harness = { ...target, dbDir };
    const reserve = await target.gateway.handleCommand(command("createSession", {
      workspaceId: WORKSPACE,
      sessionId: "durable-submission-2",
      submissionPreparation: { submissionId: "submission-2" },
      incognito: INCOGNITO_LOCKDOWN_PROFILE,
    }, "cmd-reserve-incognito"));
    expect(reserve.status).toBe("accepted");
    expect((await target.store.getSession("durable-submission-2" as never))?.incognito)
      .toEqual(INCOGNITO_LOCKDOWN_PROFILE);
    const payload = {
      workspaceId: WORKSPACE,
      preparedSessionId: "durable-submission-2",
      expectedSubmissionId: "submission-2",
      incognito: INCOGNITO_LOCKDOWN_PROFILE,
      firstInput: { text: "durable frozen input" },
    };
    vi.mocked(createSessionRecordForV4).mockRejectedValueOnce(new Error("bootstrap failed"));
    const failed = await target.gateway.handleCommand(command("createSession", payload, "cmd-submission-fail"));
    expect(failed.status).toBe("failed");
    expect(await target.store.getSession("durable-submission-2" as never)).toBeTruthy();
    const retried = await target.gateway.handleCommand(command("createSession", payload, "cmd-submission-retry"));
    expect(retried.status).toBe("accepted");
    expect(retried.result).toMatchObject({ sessionId: "durable-submission-2" });
    expect(target.sentInputs).toEqual(["durable frozen input"]);
    const repeated = await target.gateway.handleCommand(command("createSession", payload, "cmd-submission-repeat"));
    expect(repeated.status).toBe("accepted");
    expect(target.sentInputs).toEqual(["durable frozen input"]);
    target.heldCompletions.forEach((held) => held.resolve());
  });

  it("rejects a stale submission identity or profile before materialization", async () => {
    const dbDir = mkdtempSync(join(tmpdir(), "submission-lifecycle-"));
    const target = await makeHarness(join(dbDir, "sessions.sqlite"));
    harness = { ...target, dbDir };
    const reserve = await target.gateway.handleCommand(command("createSession", {
      workspaceId: WORKSPACE,
      sessionId: "durable-submission-3",
      submissionPreparation: { submissionId: "submission-3" },
    }, "cmd-reserve-stale"));
    expect(reserve.status).toBe("accepted");
    for (const overrides of [
      { expectedSubmissionId: "other-submission" },
      { incognito: INCOGNITO_LOCKDOWN_PROFILE },
      { workspaceId: "/other-workspace" },
      { executionWorktree: { path: TARGET_PATH, branchName: BRANCH } },
    ]) {
      const ack = await target.gateway.handleCommand(command("createSession", {
        workspaceId: WORKSPACE,
        preparedSessionId: "durable-submission-3",
        expectedSubmissionId: "submission-3",
        firstInput: { text: "frozen input" },
        ...overrides,
      }, `cmd-stale-${JSON.stringify(overrides)}`));
      expect(ack.status).toBe("failed");
    }
    expect(target.materializations).toEqual([]);
    expect(target.sentInputs).toEqual([]);
  });

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

describe("prepared worktree incognito freeze (specs/incognito-session.md scenario 20)", () => {
  const LOCKDOWN = INCOGNITO_LOCKDOWN_PROFILE;
  const OTHER_PROFILE = { ...LOCKDOWN, memory: true };

  /** Simulate the first-send persistence that lands the profile on the prepared row. */
  async function persistRowProfile(target: Harness, sessionId: string, incognito: unknown) {
    await target.store.createSession({
      id: sessionId as never,
      projectID: createProjectId("wt-lifecycle"),
      slug: sessionId.toLowerCase(),
      directory: WORKSPACE,
      title: `Worktree ${BRANCH}`,
      version: "wt-lifecycle-test",
      ...(incognito ? { incognito: incognito as never } : {}),
    });
  }

  it("rejects a prepare create that carries an incognito profile (fail-closed)", async () => {
    const dbDir = mkdtempSync(join(tmpdir(), "wt-lifecycle-"));
    const target = await makeHarness(join(dbDir, "sessions.sqlite"));
    harness = { ...target, dbDir };

    const ack = await target.gateway.handleCommand(
      command(
        "createSession",
        {
          workspaceId: WORKSPACE,
          worktreePreparation: { branchName: BRANCH, targetPath: TARGET_PATH, attemptId: ATTEMPT },
          incognito: LOCKDOWN,
        },
        "cmd-prepare-incognito",
      ),
    );
    expect(ack.status).toBe("rejected");
    expect(ack.reasonCode).toBe("proto.invalidPayload");
    expect(target.materializations).toEqual([]);
  });

  it("rejects a repeat activation whose profile differs from the stored row", async () => {
    const dbDir = mkdtempSync(join(tmpdir(), "wt-lifecycle-"));
    const target = await makeHarness(join(dbDir, "sessions.sqlite"));
    harness = { ...target, dbDir };
    const sessionId = await prepare(target);

    const first = await target.gateway.handleCommand(
      command(
        "createSession",
        activationPayload({ preparedSessionId: sessionId, incognito: LOCKDOWN }),
        "cmd-activate",
      ),
    );
    expect(first.status).toBe("accepted");
    target.heldCompletions.forEach((held) => held.resolve());
    // First-send persistence landed the profile; simulate it for the fake runtime.
    await persistRowProfile(target, sessionId, LOCKDOWN);
    expect(await readPreparationStatus(target, sessionId)).toBe("active");

    const differentProfile = await target.gateway.handleCommand(
      command(
        "createSession",
        activationPayload({ preparedSessionId: sessionId, incognito: OTHER_PROFILE }),
        "cmd-reactivate-other",
      ),
    );
    expect(differentProfile.status).toBe("failed");

    const absentProfile = await target.gateway.handleCommand(
      command(
        "createSession",
        activationPayload({ preparedSessionId: sessionId, incognito: undefined }),
        "cmd-reactivate-none",
      ),
    );
    expect(absentProfile.status).toBe("failed");

    const matching = await target.gateway.handleCommand(
      command(
        "createSession",
        activationPayload({ preparedSessionId: sessionId, incognito: LOCKDOWN }),
        "cmd-reactivate-same",
      ),
    );
    expect(matching.status).toBe("accepted");
    expect((matching.result as { sessionId: string }).sessionId).toBe(sessionId);
    // The existing identity is reused; no second runtime or input.
    expect(target.materializations).toEqual([sessionId]);
    expect(target.sentInputs).toEqual(["frozen first input"]);
  });

  it("keeps the first materialization's choice for a warm-host retry of a failed activation", async () => {
    const dbDir = mkdtempSync(join(tmpdir(), "wt-lifecycle-"));
    const target = await makeHarness(join(dbDir, "sessions.sqlite"));
    harness = { ...target, dbDir };
    const sessionId = await prepare(target);

    // First attempt carries the profile but fails before admission; the row has no profile yet,
    // so only the in-memory stamp on the prepared entry holds the frozen choice.
    target.failAdmissions = 1;
    const failed = await target.gateway.handleCommand(
      command(
        "createSession",
        activationPayload({ preparedSessionId: sessionId, incognito: LOCKDOWN }),
        "cmd-fail",
      ),
    );
    expect(failed.status).toBe("failed");
    expect(await readPreparationStatus(target, sessionId)).toBe("preparing");

    const swapped = await target.gateway.handleCommand(
      command(
        "createSession",
        activationPayload({ preparedSessionId: sessionId, incognito: OTHER_PROFILE }),
        "cmd-retry-swapped",
      ),
    );
    expect(swapped.status).toBe("failed");
    expect(target.sentInputs).toEqual([]);

    const kept = await target.gateway.handleCommand(
      command(
        "createSession",
        activationPayload({ preparedSessionId: sessionId, incognito: LOCKDOWN }),
        "cmd-retry-kept",
      ),
    );
    expect(kept.status).toBe("accepted");
    expect(target.sentInputs).toEqual(["frozen first input"]);
    expect(await readPreparationStatus(target, sessionId)).toBe("active");

    target.heldCompletions.forEach((held) => held.resolve());
  });

  it("materializes with the stored row profile, not the retry's request", async () => {
    const dbDir = mkdtempSync(join(tmpdir(), "wt-lifecycle-"));
    const target = await makeHarness(join(dbDir, "sessions.sqlite"));
    harness = { ...target, dbDir };
    const sessionId = await prepare(target);
    // A profile already landed on the row (earlier admitted activation); the runtime is gone.
    await persistRowProfile(target, sessionId, LOCKDOWN);

    const mismatch = await target.gateway.handleCommand(
      command(
        "createSession",
        activationPayload({ preparedSessionId: sessionId, incognito: OTHER_PROFILE }),
        "cmd-activate-mismatch",
      ),
    );
    expect(mismatch.status).toBe("failed");
    expect(target.materializations).toEqual([]);

    const matching = await target.gateway.handleCommand(
      command(
        "createSession",
        activationPayload({ preparedSessionId: sessionId, incognito: LOCKDOWN }),
        "cmd-activate-matching",
      ),
    );
    expect(matching.status).toBe("accepted");
    expect(target.materializations).toEqual([sessionId]);
    const rawParams = vi.mocked(createSessionRecordForV4).mock.calls.at(-1)![1] as {
      incognito?: unknown;
    };
    expect(rawParams.incognito).toEqual(LOCKDOWN);

    target.heldCompletions.forEach((held) => held.resolve());
  });
});
