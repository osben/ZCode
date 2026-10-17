import { basename, join, resolve } from "node:path";

import type { ModelTextContentBlock } from "@zcode/contracts";
import type { Model, ModelInputMessage, SessionInfo, TraceContext } from "../deps.js";
import {
  systemReminderAttachmentEntry,
  type RuntimeAttachmentEntry,
} from "../../agent/message-history.js";
import {
  acquireDreamLock,
  buildMemoryDreamPrompt,
  collectDreamTouchedPaths,
  evaluateAutoDreamTiming,
  readDreamLastConsolidatedAt,
  restoreDreamLockAfterFailure,
  writeDreamConsolidatedAt,
} from "../../memory/dream.js";
import { runMemoryAgentLoop } from "../../memory/memory-agent-loop.js";
import { findLatestReadFileState } from "../../tool/read-file-state.js";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  buildProjectMemoryAgentProviderMessages,
  captureProjectMemoryAgentContext,
  createProjectMemoryAgentToolExecutor,
  type ProjectMemoryAgentContext,
} from "./project-memory-agent.js";
import { invalidateProjectMemoryRecallPaths } from "./project-memory-recall.js";
import { isMainMemoryTaskType, resolveEnabledProjectMemoryRoot } from "./project-memory.js";

const AUTO_DREAM_MINIMUM_TRANSCRIPT_SESSIONS = 5;
const MANUAL_DREAM_MINIMUM_TRANSCRIPT_SESSIONS = 1;
const DREAM_MAX_TURNS = 50;

export type ProjectMemoryDreamSkipReason =
  | "memory-disabled"
  | "remote-workspace"
  | "lock-held"
  | "no-fresh-transcripts"
  /** Auto-mode only: the 24h minimum interval or the 10-minute scan throttle closed the window. */
  | "auto-timing";

export type ProjectMemoryDreamOutcome =
  | { status: "consolidated"; summary: string; touchedPaths: readonly string[] }
  | { status: "skipped"; reason: ProjectMemoryDreamSkipReason }
  | { status: "failed"; error: unknown };

export interface ProjectMemoryUpdate {
  inContextPaths: string[];
  paths: string[];
  source: "dream";
  summary: string;
}

export function selectProjectDreamSessions(input: {
  currentSessionId: AgentRuntimeInternal["sessionId"];
  sessions: readonly SessionInfo[];
  workspacePath: string;
  workspaceIdentity?: string;
}): SessionInfo[] {
  const workspaceIdentity = input.workspaceIdentity?.trim();
  const workspacePath = workspaceIdentity ? undefined : resolve(input.workspacePath);

  return input.sessions.filter((session) => {
    if (session.id === input.currentSessionId) return false;
    if (!isMainMemoryTaskType(session.taskType)) return false;
    if (workspaceIdentity) return session.workspaceID === workspaceIdentity;
    return resolve(session.directory) === workspacePath;
  });
}

// 当前产品链路不自动触发 Dream；保留可等待的 handler，待 project transcript 隔离方案确定后再接线。
export async function runProjectMemoryDream(
  runtime: AgentRuntimeInternal,
  input: { traceContext: TraceContext },
): Promise<void> {
  const memoryRoot = resolveEnabledProjectMemoryRoot(runtime.config, runtime.workspaceRoot);
  if (!memoryRoot) return;
  if (runtime.isRemoteWorkspace()) return;
  if (!runtime.sessionStore || !runtime.fileSystemPort) return;
  if (!runtime.modelIoDir) return;

  const context = captureProjectMemoryAgentContext(runtime, {
    memoryRoot,
    operation: "project_memory_dream",
    traceContext: input.traceContext,
  });
  await executeProjectMemoryDream(runtime, context, { mode: "auto" });
}

/** Manual `/dream` command path: every skip is a visible outcome instead of a silent return. */
export async function runManualProjectMemoryDream(
  runtime: AgentRuntimeInternal,
  input: { abortSignal?: AbortSignal; model?: Model; traceContext: TraceContext },
): Promise<ProjectMemoryDreamOutcome> {
  const memoryRoot = resolveEnabledProjectMemoryRoot(runtime.config, runtime.workspaceRoot);
  if (!memoryRoot || !runtime.sessionStore || !runtime.fileSystemPort || !runtime.modelIoDir) {
    return { status: "skipped", reason: "memory-disabled" };
  }
  if (runtime.isRemoteWorkspace()) {
    return { status: "skipped", reason: "remote-workspace" };
  }

  const context = captureProjectMemoryAgentContext(runtime, {
    memoryRoot,
    model: input.model,
    operation: "project_memory_dream",
    traceContext: input.traceContext,
  });
  return executeProjectMemoryDream(runtime, context, {
    abortSignal: input.abortSignal,
    mode: "manual",
  });
}

export function consumePendingProjectMemoryUpdate(
  runtime: AgentRuntimeInternal,
): RuntimeAttachmentEntry | undefined {
  const update = runtime.pendingMemoryUpdate;
  if (!update) return undefined;
  runtime.pendingMemoryUpdate = undefined;
  return systemReminderAttachmentEntry("memory_update", formatProjectMemoryUpdate(update));
}

async function executeProjectMemoryDream(
  runtime: AgentRuntimeInternal,
  context: ProjectMemoryAgentContext,
  options: { abortSignal?: AbortSignal; mode: "auto" | "manual" },
): Promise<ProjectMemoryDreamOutcome> {
  const telemetry = runtime.agentTelemetry.detached({
    causation: context.causation,
    executionKind: "background",
    operation: "project_memory_dream",
    targetKind: "project_memory",
    traceContext: context.traceContext,
    trigger: options.mode === "manual" ? "user" : "scheduler",
  });

  let outcome: ProjectMemoryDreamOutcome | undefined;
  await telemetry.run(async () => {
    let acquiredPriorMtimeMs: number | undefined;
    try {
      const nowMs = runtime.now().getTime();
      const lastConsolidatedAtMs = await readDreamLastConsolidatedAt(context.memoryRoot);
      if (options.mode === "auto") {
        const timing = evaluateAutoDreamTiming({
          lastConsolidatedAtMs,
          lastScanAtMs: runtime.memoryDreamLastScanAtMs,
          nowMs,
        });
        if (timing.decision === "skip") {
          outcome = { status: "skipped", reason: "auto-timing" };
          telemetry.setResultType("metadata");
          telemetry.finishCompleted();
          return;
        }
        runtime.memoryDreamLastScanAtMs = nowMs;
      }
      const sessions = selectProjectDreamSessions({
        currentSessionId: runtime.sessionId,
        sessions: await runtime.sessionStore!.listSessions(),
        workspacePath: context.workspaceRoot,
        workspaceIdentity: runtime.config.memory?.workspaceIdentity,
      });
      const transcriptSessionIds = await recentModelIoSessionIds(
        runtime,
        sessions,
        context,
        lastConsolidatedAtMs,
      );
      const minimumTranscriptSessions =
        options.mode === "manual"
          ? MANUAL_DREAM_MINIMUM_TRANSCRIPT_SESSIONS
          : AUTO_DREAM_MINIMUM_TRANSCRIPT_SESSIONS;
      if (transcriptSessionIds.length < minimumTranscriptSessions) {
        outcome = { status: "skipped", reason: "no-fresh-transcripts" };
        telemetry.setResultType("metadata");
        telemetry.finishCompleted();
        return;
      }

      const priorMtimeMs = await acquireDreamLock({ memoryRoot: context.memoryRoot, nowMs });
      if (priorMtimeMs === null) {
        outcome = { status: "skipped", reason: "lock-held" };
        telemetry.setResultType("metadata");
        telemetry.finishCompleted();
        return;
      }
      acquiredPriorMtimeMs = priorMtimeMs;

      const prompt = buildMemoryDreamPrompt({
        memoryRoot: context.memoryRoot,
        sessionIds: transcriptSessionIds,
        transcriptRoot: runtime.modelIoDir!,
      });
      const providerMessages = buildProjectMemoryAgentProviderMessages(runtime, context, prompt);
      const executor = createProjectMemoryAgentToolExecutor(runtime, context);
      const touchedPaths = new Set<string>();

      const loopResult = await runMemoryAgentLoop({
        abortSignal: options.abortSignal,
        executeTool: (toolCall, loopOptions) => {
          collectDreamTouchedPaths(touchedPaths, {
            rootDir: context.memoryRoot,
            toolCall,
            workingDirectory: context.workingDirectory,
            workspaceRoot: context.workspaceRoot,
          });
          return executor.execute(toolCall, {
            signal: loopOptions.abortSignal,
            traceContext: context.traceContext,
          });
        },
        maxTurns: DREAM_MAX_TURNS,
        messages: providerMessages,
        model: context.model,
        rootDir: context.memoryRoot,
        tools: context.tools,
        workingDirectory: context.workingDirectory,
        workspaceRoot: context.workspaceRoot,
      });

      const paths = [...touchedPaths];
      if (paths.length > 0) {
        runtime.pendingMemoryUpdate = createProjectMemoryUpdate(runtime, paths);
        invalidateProjectMemoryRecallPaths(runtime, paths);
      }
      // Stamp completion only for runs that reached this point without throwing; the lock's own
      // mtime starts at run start and survives crashes, so it cannot back "last successful dream".
      await writeDreamConsolidatedAt(context.memoryRoot);
      outcome = {
        status: "consolidated",
        summary: finalAssistantText(loopResult.messages) ?? memoryUpdateSummary(paths),
        touchedPaths: paths,
      };
      telemetry.finishCompleted();
    } catch (error) {
      telemetry.finishFailed("execute", "internal", error);
      if (acquiredPriorMtimeMs !== undefined) {
        try {
          await restoreDreamLockAfterFailure({
            memoryRoot: context.memoryRoot,
            priorMtimeMs: acquiredPriorMtimeMs,
          });
        } catch {
          // Dream 已失败；lock 恢复失败不改变前台 turn，也不追加第二套恢复机制。
        }
      }
      outcome = { status: "failed", error };
    }
  });
  return outcome ?? { status: "failed", error: new Error("Dream outcome was not produced") };
}

/** Last non-empty assistant text from the Memory agent loop, or undefined when the loop ended without one. */
function finalAssistantText(messages: readonly ModelInputMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "assistant") continue;
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((block): block is ModelTextContentBlock => block.type === "text")
            .map((block) => block.text)
            .join("");
    const trimmed = text.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

async function recentModelIoSessionIds(
  runtime: AgentRuntimeInternal,
  sessions: readonly SessionInfo[],
  context: ProjectMemoryAgentContext,
  lastConsolidatedAtMs: number,
): Promise<string[]> {
  const sessionIds = await Promise.all(
    sessions.map(async (session) => {
      try {
        const result = await runtime.fileSystemPort!.stat({
          path: join(runtime.modelIoDir!, `model-io-${session.id}.jsonl`),
          trace: context.traceContext,
        });
        // 修复原因：gate 以真实 transcript mtime 为准；SessionStore.updated 只描述
        // durable session，不能代替 transcript 是否在上次 consolidation 后发生变化。
        return result.kind === "file" &&
          result.mtimeMs !== undefined &&
          result.mtimeMs > lastConsolidatedAtMs
          ? String(session.id)
          : undefined;
      } catch {
        return undefined;
      }
    }),
  );
  return sessionIds.filter((sessionId): sessionId is string => sessionId !== undefined);
}

function createProjectMemoryUpdate(
  runtime: AgentRuntimeInternal,
  paths: string[],
): ProjectMemoryUpdate {
  const inContextPaths = paths.filter(
    (path) =>
      basename(path) === "MEMORY.md" ||
      runtime.memoryRecallState.recalledPaths.has(path) ||
      findLatestReadFileState(runtime.readFileState, path) !== undefined,
  );
  return {
    inContextPaths,
    paths,
    source: "dream",
    summary: memoryUpdateSummary(paths),
  };
}

/** Wording is pinned by the frozen memory-update fixture; keep it byte-identical. */
function memoryUpdateSummary(paths: readonly string[]): string {
  return `consolidated ${paths.length} memory file${paths.length === 1 ? "" : "s"}`;
}

function formatProjectMemoryUpdate(update: ProjectMemoryUpdate): string {
  const lines = [
    `Background memory consolidation updated your memory directory: ${update.summary}`,
  ];
  if (update.paths.length > 0) {
    lines.push(`Files changed: ${update.paths.join(", ")}`);
  }
  if (update.inContextPaths.length > 0) {
    lines.push(
      `Your loaded copy of ${update.inContextPaths.join(", ")} is now stale relative to disk — Read it again if you need current contents.`,
    );
  }
  lines.push(
    "This is ambient context — do not narrate it to the user unless they ask or it is directly relevant to their request.",
  );
  return lines.join("\n");
}
