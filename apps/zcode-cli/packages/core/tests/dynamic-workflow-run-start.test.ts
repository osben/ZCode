// Runtime method for the hub to directly launch a saved workflow (docs/dynamic-workflow/launch.md "On the agent"
// and the "launch turn" row). It is `port.submit`'s second caller, isomorphic with the CreateWorkflow tool path:
// it reuses resolveSavedWorkflow + validateWorkflowArgs normalization and trackExternalBackgroundTask tracking, but
// bypasses the permission decision + alwaysAsk, and lands the user's real action into the session as one controlOnly launch turn.
//
// Two groups of invariants are pinned here:
//   1. Failure precedes any persistence — not_found / invalid_name / invalid_args / compile_failed /
//      session_busy each mean zero submits, zero messages, zero events, zero tracking.
//   2. The success path submits args + the launch-turn message (source/visibility/metadata) + TurnStarted/TurnComplete
//      (controlOnly, workflowLaunch) + a trackExternalBackgroundTask synthesized CreateWorkflow shape +
//      session title = the workflow name.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SessionEventType,
  WORKFLOW_DRAFTS_DIR,
  createSessionId,
  type CreateSessionInput,
  type MessageInfo,
  type MessagePart,
  type MessageWithParts,
  type SavedWorkflowMeta,
  type SessionEvent,
  type SessionInfo,
  type ModelCatalogPort,
} from "@zcode/contracts";
import { AgentRuntime, saveSavedWorkflow } from "../src/index.js";
import { createTestSessionEventStore } from "./test-event-store.js";

const OK_SCRIPT = "return 42;";
/** A script from the analyzer corpus (same corpus, same reading as create-workflow-tool.test.ts). */
function fixture(name: string): string {
  return readFileSync(
    new URL(`../../dynamic-workflow/tests/graphs/${name}`, import.meta.url),
    "utf8",
  );
}
// A script with phase markers and two subagents: the display graph must have all three layers (sites / phase vocabulary / subagent cards).
const PHASED_SCRIPT = [
  'phase("plan");',
  'const plan = await agent("planner").ask<string>("plan it");',
  'phase("verify");',
  'await agent("checker").ask<string>(`check ${plan}`);',
  "return plan;",
].join("\n");
const BAD_SCRIPT = 'const x: number = "nope";\nreturn x;';
const MODEL_CATALOG: ModelCatalogPort = {
  listModels: () => [{ providerId: "acme", modelId: "gpt-5", reasoningLevels: [], current: true }],
};

const dirs: string[] = [];
function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

// The global root defaults to os.homedir(): point HOME at an empty temp dir to avoid scanning the dev machine's real ~/.zcode/workflows.
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
beforeEach(() => {
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  const home = makeDir("dwf-launch-home-");
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});
afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  while (dirs.length > 0) rmSync(dirs.pop()!, { force: true, recursive: true });
});

interface RecordingStore {
  createdSessions: CreateSessionInput[];
  savedMessages: MessageInfo[];
  savedParts: MessagePart[];
}

/** Minimal recording session store: enough for ensureSessionPersisted + landing and asserting the launch-turn messages. */
function createRecordingStore(): RecordingStore & Record<string, unknown> {
  const createdSessions: CreateSessionInput[] = [];
  const savedMessages: MessageInfo[] = [];
  const savedParts: MessagePart[] = [];
  const sessions = new Map<string, SessionInfo>();
  return {
    createdSessions,
    savedMessages,
    savedParts,
    async createSession(input: CreateSessionInput) {
      createdSessions.push(input);
      const now = Date.now();
      const session = {
        ...input,
        taskType: input.taskType ?? "interactive",
        time: { created: now, updated: now },
      } as SessionInfo;
      sessions.set(input.id, session);
      return session;
    },
    async getSession(id: string) {
      return sessions.get(id) ?? null;
    },
    async listSessions() {
      return Array.from(sessions.values());
    },
    async updateSession(input: { id: string }) {
      return sessions.get(input.id) ?? null;
    },
    async saveMessage(input: MessageInfo) {
      savedMessages.push(input);
    },
    async savePart(input: MessagePart) {
      savedParts.push(input);
    },
    async messages(input: { sessionID: string }): Promise<MessageWithParts[]> {
      return savedMessages
        .filter((message) => message.sessionID === input.sessionID)
        .map((info) => ({
          info,
          parts: savedParts.filter((part) => part.messageID === info.id),
        }));
    },
  };
}

interface SubmitCall {
  scriptText: string;
  cwd: string;
  name?: string;
  args?: Record<string, unknown>;
  parentSessionId?: string;
  toolCallId?: string;
  /** The sidebar mini rail's two tables; the hub's direct launch and the CreateWorkflow tool path must draw the same rail. */
  phaseNames?: string[];
  phaseAlongside?: number[][];
  /** Where the working copy lands (docs/dynamic-workflow/launch.md "Script files"). */
  scriptPath?: string;
  /** The models the script names (docs/dynamic-workflow/launch.md "Models the script names"). */
  modelBindings?: Record<string, unknown>;
  /** Test-side record: how many session rows the store already held at submit time (the parent session must persist its row before submit). */
  sessionsPersistedAtSubmit?: number;
}

function makeRuntime(options: {
  name: string;
  cwd: string;
  modelCatalogPort?: ModelCatalogPort;
  submit?: (request: SubmitCall) => { ok: true; runId: string } | { ok: false; reason: string };
}): {
  runtime: AgentRuntime;
  events: SessionEvent[];
  store: RecordingStore;
  submitCalls: SubmitCall[];
} {
  const submitCalls: SubmitCall[] = [];
  const store = createRecordingStore();
  const runtime = new AgentRuntime(
    createSessionId(options.name),
    { agentName: "dwf-launch-test", workingDirectory: options.cwd },
    {
      eventStore: createTestSessionEventStore(),
      sessionStore: store as never,
      modelAdapter: {} as never,
      ...(options.modelCatalogPort === undefined
        ? {}
        : { modelCatalogPort: options.modelCatalogPort }),
      dynamicWorkflowRunPort: {
        async submit(request: SubmitCall) {
          submitCalls.push({ ...request, sessionsPersistedAtSubmit: store.createdSessions.length });
          return options.submit ? options.submit(request) : { ok: true, runId: "dwfrun-launch-1" };
        },
        // The tracker attaches a waiter; it never settles, and the tests do not wait for completion.
        async getTask() {
          return {
            runId: "dwfrun-launch-1",
            taskId: "dwfrun-launch-1",
            startedAt: new Date(),
            status: "running",
          };
        },
        waitForTask: () => new Promise(() => {}),
        async cancel() {
          return true;
        },
        async listEvents() {
          return [];
        },
      } as never,
    },
  );
  const events: SessionEvent[] = [];
  runtime.subscribeEvents({ onSessionEvent: (event) => events.push(event) });
  return { runtime, events, store, submitCalls };
}

function seed(cwd: string, name: string, script: string, meta?: Partial<SavedWorkflowMeta>): void {
  saveSavedWorkflow({
    cwd,
    name,
    scope: "project",
    script,
    meta: { description: meta?.description ?? `${name} workflow`, ...meta },
  });
}

describe("startSavedWorkflowRun — 失败在任何持久化之前", () => {
  it("session_busy：有活动 turn 时零 submit、零持久化、零事件", async () => {
    const cwd = makeDir("dwf-launch-cwd-");
    seed(cwd, "reporter", OK_SCRIPT);
    const { runtime, events, store, submitCalls } = makeRuntime({ name: "busy", cwd });
    // Manufacture busy-ness: hasActiveOrQueuedTurnWork reads activeTurn.
    (runtime as unknown as { activeTurn: unknown }).activeTurn = { pendingInputs: [] };

    const result = await runtime.startSavedWorkflowRun({ name: "reporter" });

    expect(result).toEqual({ ok: false, reason: "session_busy" });
    expect(submitCalls).toHaveLength(0);
    expect(store.createdSessions).toHaveLength(0);
    expect(store.savedMessages).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it("not_found：无此定义时零副作用", async () => {
    const cwd = makeDir("dwf-launch-cwd-");
    const { runtime, events, store, submitCalls } = makeRuntime({ name: "missing", cwd });

    const result = await runtime.startSavedWorkflowRun({ name: "ghost" });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: "not_found" });
    expect(submitCalls).toHaveLength(0);
    expect(store.createdSessions).toHaveLength(0);
    expect(store.savedMessages).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it("invalid_name：路径穿越形状的名字被名字校验挡下", async () => {
    const cwd = makeDir("dwf-launch-cwd-");
    const { runtime, submitCalls, store } = makeRuntime({ name: "badname", cwd });

    const result = await runtime.startSavedWorkflowRun({ name: "../../etc/passwd" });

    expect(result).toMatchObject({ ok: false, reason: "invalid_name" });
    expect(submitCalls).toHaveLength(0);
    expect(store.savedMessages).toHaveLength(0);
  });

  it("invalid_args：多传未声明参数即拒绝，零 submit", async () => {
    const cwd = makeDir("dwf-launch-cwd-");
    seed(cwd, "reporter", OK_SCRIPT); // no args declared
    const { runtime, submitCalls, store, events } = makeRuntime({ name: "badargs", cwd });

    const result = await runtime.startSavedWorkflowRun({ name: "reporter", args: { pr: "12" } });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: "invalid_args" });
    expect((result as { message?: string }).message).toContain("pr");
    expect(submitCalls).toHaveLength(0);
    expect(store.savedMessages).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it("compile_failed：编不过的脚本拒绝，诊断进 message，零 submit", async () => {
    const cwd = makeDir("dwf-launch-cwd-");
    seed(cwd, "broken", BAD_SCRIPT);
    const { runtime, submitCalls, store, events } = makeRuntime({ name: "compilefail", cwd });

    const result = await runtime.startSavedWorkflowRun({ name: "broken" });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: "compile_failed" });
    expect((result as { message?: string }).message).toContain("not assignable");
    expect(submitCalls).toHaveLength(0);
    expect(store.savedMessages).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  // docs/dynamic-workflow/launch.md "On the agent": models the script names resolve through the same code as
  // CreateWorkflow; an unresolvable name is 9011, rejected as compile_failed.
  it("compile_failed：脚本点名的模型在本机目录里解析不出来（9011），零 submit", async () => {
    const cwd = makeDir("dwf-launch-cwd-");
    seed(cwd, "judged", 'await agent("评审员", { model: "gemini-3" }).ask("x");\nreturn 1;');
    const { runtime, submitCalls, store } = makeRuntime({
      name: "modelfail",
      cwd,
      modelCatalogPort: MODEL_CATALOG,
    });

    const result = await runtime.startSavedWorkflowRun({ name: "judged" });

    expect(result).toMatchObject({ ok: false, reason: "compile_failed" });
    expect((result as { message?: string }).message).toContain('The model "gemini-3"');
    expect((result as { message?: string }).message).toContain("acme/gpt-5");
    expect(submitCalls).toHaveLength(0);
    expect(store.savedMessages).toHaveLength(0);
  });

  it("start_failed：端口缺席 → 能力不支持面（干净编译之后）", async () => {
    const cwd = makeDir("dwf-launch-cwd-");
    seed(cwd, "reporter", OK_SCRIPT);
    const store = createRecordingStore();
    const runtime = new AgentRuntime(
      createSessionId("noport"),
      { agentName: "dwf-launch-test", workingDirectory: cwd },
      {
        eventStore: createTestSessionEventStore(),
        sessionStore: store as never,
        modelAdapter: {} as never,
        // No dynamicWorkflowRunPort.
      },
    );
    const result = await runtime.startSavedWorkflowRun({ name: "reporter" });
    expect(result).toMatchObject({ ok: false, reason: "start_failed" });
    expect((result as { message?: string }).message).toContain("port unavailable");
    expect(store.savedMessages).toHaveLength(0);
  });
});

describe("startSavedWorkflowRun — 成功路径", () => {
  it("启动轮元数据的显示图三层齐全：站点、阶段词汇表、子代理卡（与 CreateWorkflow 同一投影）", async () => {
    // Root cause observed on a real machine 2026-09-14: the launch path hand-assembled boundCausalityGraph arguments
    // and passed only the causality graph, so display had sites but no phases / participants, and the run detail
    // side panel showed an empty spine with no subagents. The zero-ask OK_SCRIPT cannot reveal that missing layer,
    // so this pins all three layers with a script that has phases and two subagents.
    const cwd = makeDir("dwf-launch-cwd-");
    seed(cwd, "phased", PHASED_SCRIPT);
    const { runtime, store } = makeRuntime({
      name: "ok-phased",
      cwd,
      submit: () => ({ ok: true, runId: "dwfrun-phased" }),
    });

    const result = await runtime.startSavedWorkflowRun({ name: "phased" });
    expect(result).toMatchObject({ ok: true, runId: "dwfrun-phased" });

    const launchMessage = store.savedMessages.find((m) => m.source === "workflow_launch");
    const display = (
      launchMessage?.metadata?.workflowLaunch as
        | {
            display?: {
              causalityGraph?: {
                steps: unknown[];
                phases?: { name?: string }[];
                participants: { lane: string; phase: string }[];
              };
            };
          }
        | undefined
    )?.display;
    const graph = display?.causalityGraph;
    expect(graph).toBeDefined();
    expect(graph!.steps).toHaveLength(2);
    expect(graph!.phases?.map((phase) => phase.name)).toEqual(["plan", "verify"]);
    expect(graph!.participants).toHaveLength(2);
    expect(new Set(graph!.participants.map((participant) => participant.lane)).size).toBe(2);
    for (const participant of graph!.participants) {
      expect(
        graph!.phases!.some((phase) => (phase as { id?: string }).id === participant.phase),
      ).toBe(true);
    }
  });

  // The sidebar mini rail's two tables (docs/dynamic-workflow/presentation.md "The sidebar run line"):
  // the hub's direct launch and the CreateWorkflow tool path read the same projection and the same function pair; the
  // same script draws the same rail.
  it("submit 带上声明阶段表与「同时在跑」表", async () => {
    const cwd = makeDir("dwf-launch-cwd-");
    seed(cwd, "parallel", fixture("strand-fanout-two-phases-join.ts"));
    const { runtime, submitCalls } = makeRuntime({
      name: "ok-alongside",
      cwd,
      submit: () => ({ ok: true, runId: "dwfrun-alongside" }),
    });

    const result = await runtime.startSavedWorkflowRun({ name: "parallel" });

    expect(result.ok).toBe(true);
    expect(submitCalls).toHaveLength(1);
    expect(submitCalls[0]!.phaseNames).toEqual(["A", "B", "C"]);
    expect(submitCalls[0]!.phaseAlongside).toEqual([[], [0], []]);
  });

  // docs/dynamic-workflow/launch.md "Script files": the hub's direct launch and CreateWorkflow share the same saved
  // source, so the working copy follows the same rule — byte-for-byte, with the saved definition itself untouched.
  it("submit 带上工作副本的落点，拷贝逐字节等于保存的文件", async () => {
    const cwd = makeDir("dwf-launch-cwd-");
    seed(cwd, "reporter", OK_SCRIPT, { description: "Write a daily report" });
    const { runtime, submitCalls } = makeRuntime({
      name: "ok-scriptpath",
      cwd,
      submit: () => ({ ok: true, runId: "dwfrun-scriptpath" }),
    });

    const result = await runtime.startSavedWorkflowRun({ name: "reporter" });

    expect(result.ok).toBe(true);
    const draft = join(cwd, WORKFLOW_DRAFTS_DIR, "reporter.dwf.ts");
    expect(submitCalls[0]!.scriptPath).toBe(draft);
    expect(readFileSync(draft, "utf8")).toBe(
      readFileSync(join(cwd, ".zcode/workflows/reporter.dwf.ts"), "utf8"),
    );
  });

  it("submit 带上脚本点名的模型，已解析成结构化选择", async () => {
    const cwd = makeDir("dwf-launch-cwd-");
    seed(cwd, "judged", 'await agent("评审员", { model: "GPT-5" }).ask("x");\nreturn 1;');
    const { runtime, submitCalls } = makeRuntime({
      name: "ok-models",
      cwd,
      modelCatalogPort: MODEL_CATALOG,
      submit: () => ({ ok: true, runId: "dwfrun-models" }),
    });

    expect((await runtime.startSavedWorkflowRun({ name: "judged" })).ok).toBe(true);
    expect(submitCalls[0]!.modelBindings).toEqual({
      "GPT-5": { providerId: "acme", modelId: "gpt-5" },
    });
  });

  it("submit 参数 + 启动轮消息 + turn 边界 + 追踪 + 会话标题（无实参）", async () => {
    const cwd = makeDir("dwf-launch-cwd-");
    seed(cwd, "reporter", OK_SCRIPT, { description: "Write a daily report" });
    const { runtime, events, store, submitCalls } = makeRuntime({
      name: "ok-noargs",
      cwd,
      submit: () => ({ ok: true, runId: "dwfrun-ok" }),
    });

    const result = await runtime.startSavedWorkflowRun({ name: "reporter" });

    const toolCallId = (result as { toolCallId: string }).toolCallId;
    expect(result).toMatchObject({ ok: true, runId: "dwfrun-ok" });
    expect(toolCallId).toMatch(/^launch-/);
    // This is what lets the protocol layer move the session out of draft (into session/list and sessions-index, so the sidebar can see it).
    expect(runtime.isSessionPersisted()).toBe(true);

    // submit: script verbatim, name = resolved name, parentSessionId = the session, toolCallId = launch- prefix; no args key.
    expect(submitCalls).toHaveLength(1);
    expect(submitCalls[0]).toMatchObject({
      scriptText: OK_SCRIPT,
      cwd,
      name: "reporter",
      parentSessionId: "sess_ok-noargs",
      toolCallId,
    });
    expect(submitCalls[0]!.args).toBeUndefined();
    // The parent session row must persist before submit (the actor's session_task_link.parent_session_id has a
    // foreign key on session(id); the root cause of the 2026-09-03 real-machine first launch settling as DriverError
    // "failed to create actor session").
    expect(submitCalls[0]!.sessionsPersistedAtSubmit).toBe(1);
    expect(store.createdSessions[0]).toMatchObject({ id: "sess_ok-noargs" });

    // Launch-turn message: role=user, synthetic, source/visibility, real_user semantics, workflowLaunch metadata.
    const launchMessage = store.savedMessages.find((m) => m.source === "workflow_launch");
    expect(launchMessage).toBeDefined();
    expect(launchMessage).toMatchObject({
      role: "user",
      synthetic: true,
      source: "workflow_launch",
      visibility: "user-visible",
    });
    expect(launchMessage?.semantics).toMatchObject({
      origin: "real_user",
      kind: "user_prompt",
      source: "workflow_launch",
      transcriptVisibility: "visible",
    });
    expect(launchMessage?.metadata?.workflowLaunch).toMatchObject({
      runId: "dwfrun-ok",
      toolCallId,
      name: "reporter",
      scope: "project",
      description: "Write a daily report",
    });
    // Graph and script travel with the launch turn (the side panel finds the originating row by toolCallId for the
    // graph/script; a direct launch has no tool row).
    // OK_SCRIPT is a minimal zero-ask script: the graph may be empty, but the display itself (same constructor) and
    // the verbatim script must be present.
    const launchMeta = launchMessage?.metadata?.workflowLaunch as
      | { display?: { kind?: string; ok?: boolean; diagnostics?: unknown[] }; script?: string }
      | undefined;
    expect(launchMeta?.display).toMatchObject({
      kind: "create_workflow",
      ok: true,
      diagnostics: [],
    });
    expect(launchMeta?.script).toBe(OK_SCRIPT);

    // Message body = the canonical English sentence (old clients render it as a fallback), discouraging a duplicate launch.
    const part = store.savedParts.find(
      (p) => p.messageID === launchMessage?.id && p.type === "text",
    );
    expect((part as { text?: string } | undefined)?.text).toContain(
      'Started the saved workflow "reporter" (project)',
    );
    expect((part as { text?: string } | undefined)?.text).toContain("do not start it again");
    expect((part as { text?: string } | undefined)?.text).not.toContain("Arguments:");

    // TurnStarted: controlOnly + inputSource + workflowLaunch.
    const turnStarted = events.find((e) => e.type === SessionEventType.TurnStarted);
    expect(turnStarted?.payload).toMatchObject({
      executionKind: "controlOnly",
      inputSource: "workflow_launch",
      workflowLaunch: { runId: "dwfrun-ok", name: "reporter", scope: "project" },
    });
    expect(events.some((e) => e.type === SessionEventType.TurnComplete)).toBe(true);

    // Tracking: a synthesized CreateWorkflow descriptor → BackgroundTaskStarted (workflow panel, cancellable, subject=name).
    const started = events.find((e) => e.type === SessionEventType.BackgroundTaskStarted);
    expect(started?.payload).toMatchObject({
      cancellable: true,
      description: "reporter",
      status: "running",
      taskId: "dwfrun-ok",
      taskKind: "workflow",
      toolCallId,
      toolName: "CreateWorkflow",
    });
    expect(runtime.hasRunningBackgroundTasks()).toBe(true);

    // Session title = the workflow name (first_input).
    expect(store.createdSessions[0]?.title).toBe("reporter");
    expect(store.createdSessions[0]?.titleSource).toBe("first_input");
  });

  it("有实参：submit.args + 元数据 args + 消息正文附 JSON 块", async () => {
    const cwd = makeDir("dwf-launch-cwd-");
    seed(cwd, "review", OK_SCRIPT, {
      description: "Review a PR",
      args: { pr: { type: "string", required: true }, deep: { type: "boolean", default: false } },
    });
    const { runtime, events, store, submitCalls } = makeRuntime({
      name: "ok-args",
      cwd,
      submit: () => ({ ok: true, runId: "dwfrun-args" }),
    });

    const result = await runtime.startSavedWorkflowRun({ name: "review", args: { pr: "42" } });

    expect(result.ok).toBe(true);
    // validateWorkflowArgs backfills the default deep=false.
    expect(submitCalls[0]!.args).toEqual({ pr: "42", deep: false });

    const launchMessage = store.savedMessages.find((m) => m.source === "workflow_launch");
    expect(launchMessage?.metadata?.workflowLaunch).toMatchObject({
      args: { pr: "42", deep: false },
    });
    const part = store.savedParts.find(
      (p) => p.messageID === launchMessage?.id && p.type === "text",
    );
    expect((part as { text?: string } | undefined)?.text).toContain("Arguments:");
    expect((part as { text?: string } | undefined)?.text).toContain('"pr": "42"');

    const turnStarted = events.find((e) => e.type === SessionEventType.TurnStarted);
    const startedPayload = turnStarted?.payload as
      | { workflowLaunch?: { args?: unknown } }
      | undefined;
    expect(startedPayload?.workflowLaunch?.args).toEqual({
      pr: "42",
      deep: false,
    });
  });
});
