import type {
  ModelUsage,
  SessionId,
  SubagentTaskSnapshot,
  TraceContext,
  TurnId,
} from "@zcode/contracts";
import type { AgentOutput } from "@zcode/contracts";

// Keep local_dynamic_workflow and local_workflow separate: the latter is the legacy `Workflow` tool (not cancellable),
// while the former is a workflow run (cancellable through DynamicWorkflowRunPort.cancel). Combining the types would make cancellation dispatch ambiguous.
// local_dream = /dream memory consolidation: in-process promise (no port), cancellable via the runtime-held AbortController.
export type RuntimeTaskType =
  | "local_agent"
  | "local_bash"
  | "local_workflow"
  | "local_dynamic_workflow"
  | "local_dream"
  | "monitor_mcp";

export interface RuntimeTaskUsageSnapshot {
  durationMs?: number;
  modelUsage?: ModelUsage;
  toolUseCount?: number;
  totalTokens?: number;
}

export interface RuntimeTaskPendingMessage {
  id: string;
  isMeta?: boolean;
  message: string;
  origin?: {
    kind: "coordinator";
    toolCallId?: string;
  };
  queuedAt: Date;
  summary?: string;
  traceContext?: TraceContext;
}

export interface RuntimeTaskMessageSink {
  send(message: RuntimeTaskPendingMessage): Promise<"queued" | "steered">;
}

export interface RuntimeTaskSnapshot extends SubagentTaskSnapshot {
  /** 内存执行归属；重启不会恢复闲时后台任务。 */
  offPeakExecutionId?: string;
  offPeakCancelled?: boolean;
  /** Active conversation branch that owned the task when it was registered; used to fence late completions. */
  branchGeneration?: number;
  exitCode?: number;
  type: RuntimeTaskType;
  isBackgrounded?: boolean;
  messageSink?: RuntimeTaskMessageSink;
  output?: AgentOutput;
  parentSessionId?: SessionId;
  pendingMessages?: RuntimeTaskPendingMessage[];
  prompt?: string;
  /**
   * Serialized workflow run artifacts. TaskOutput can read only registry entries (DWF never writes
   * outputFile), so artifacts must be stored on the entry when the terminal state is updated.
   */
  resultText?: string;
  /**
   * Who requested this task to stop ("user" = GUI/background panel, "model" = TaskStop). The DWF stop branch records this
   * before calling the cancel port; the terminal notification reads it later when the waiter settles. Re-arming (resume as a new run) resets it during settlement.
   */
  stopInitiator?: "user" | "model";
  taskType?: RuntimeTaskType;
  traceContext?: TraceContext;
  turnId?: TurnId;
  usage?: RuntimeTaskUsageSnapshot;
}

export interface RuntimeTaskRegistry {
  subscribe?(listener: () => void): () => void;
  setOffPeakExecutionId?(executionId: string | undefined): void;
  all(): Record<string, RuntimeTaskSnapshot>;
  get(id: string): RuntimeTaskSnapshot | undefined;
  drainMessages(id: string): RuntimeTaskPendingMessage[];
  queueMessage(id: string, message: RuntimeTaskPendingMessage): RuntimeTaskSnapshot | undefined;
  register(task: RuntimeTaskSnapshot): void;
  remove(id: string): void;
  requestBackground(id: string): boolean;
  setActiveBranchGeneration?(generation: number): void;
  update(
    id: string,
    patcher: (task: RuntimeTaskSnapshot) => RuntimeTaskSnapshot,
  ): RuntimeTaskSnapshot | undefined;
  waitForBackgroundRequest(
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<RuntimeTaskSnapshot | undefined>;
  waitForTerminal(
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<RuntimeTaskSnapshot | undefined>;
}

interface RuntimeTaskWaiter {
  onAbort?: () => void;
  reject: (error: unknown) => void;
  resolve: (task: RuntimeTaskSnapshot | undefined) => void;
  signal?: AbortSignal;
}

const TERMINAL_STATUSES = new Set<RuntimeTaskSnapshot["status"]>([
  "completed",
  "failed",
  "cancelled",
  "killed",
  "stopped",
  "lost",
]);

export class InMemoryRuntimeTaskRegistry implements RuntimeTaskRegistry {
  private offPeakExecutionId: string | undefined;
  private readonly listeners = new Set<() => void>();
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  setOffPeakExecutionId(executionId: string | undefined): void {
    this.offPeakExecutionId = executionId;
  }
  private changed(): void {
    for (const listener of this.listeners) listener();
  }
  private activeBranchGeneration = 0;
  private readonly backgroundWaiters = new Map<string, Set<RuntimeTaskWaiter>>();
  private readonly tasks = new Map<string, RuntimeTaskSnapshot>();
  private readonly terminalWaiters = new Map<string, Set<RuntimeTaskWaiter>>();

  register(task: RuntimeTaskSnapshot): void {
    const stamped = {
      ...task,
      ...((task.offPeakExecutionId ?? this.offPeakExecutionId)
        ? { offPeakExecutionId: task.offPeakExecutionId ?? this.offPeakExecutionId }
        : {}),
      branchGeneration: task.branchGeneration ?? this.activeBranchGeneration,
    };
    this.tasks.set(stamped.taskId, stamped);
    this.resolveIfTerminal(stamped.taskId, stamped);
    this.resolveIfBackgrounded(stamped.taskId, stamped);
    this.changed();
  }

  setActiveBranchGeneration(generation: number): void {
    this.activeBranchGeneration = generation;
  }

  update(
    id: string,
    patcher: (task: RuntimeTaskSnapshot) => RuntimeTaskSnapshot,
  ): RuntimeTaskSnapshot | undefined {
    const current = this.tasks.get(id);
    if (!current) return undefined;
    const next = patcher(current);
    this.tasks.set(id, next);
    this.resolveIfTerminal(id, next);
    this.resolveIfBackgrounded(id, next);
    this.changed();
    return next;
  }

  requestBackground(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || isTerminalRuntimeTask(task)) return false;
    const next: RuntimeTaskSnapshot = { ...task, isBackgrounded: true };
    this.tasks.set(id, next);
    this.resolveBackgroundWaiters(id, next);
    this.changed();
    return true;
  }

  remove(id: string): void {
    this.tasks.delete(id);
    this.resolveTerminalWaiters(id, undefined);
    this.resolveBackgroundWaiters(id, undefined);
    this.changed();
  }

  get(id: string): RuntimeTaskSnapshot | undefined {
    return this.tasks.get(id);
  }

  all(): Record<string, RuntimeTaskSnapshot> {
    return Object.fromEntries(this.tasks);
  }

  queueMessage(id: string, message: RuntimeTaskPendingMessage): RuntimeTaskSnapshot | undefined {
    return this.update(id, (task) => ({
      ...task,
      pendingMessages: [...(task.pendingMessages ?? []), message],
    }));
  }

  drainMessages(id: string): RuntimeTaskPendingMessage[] {
    const task = this.tasks.get(id);
    if (!task || !task.pendingMessages || task.pendingMessages.length === 0) return [];
    const messages = task.pendingMessages;
    this.tasks.set(id, { ...task, pendingMessages: [] });
    this.changed();
    return messages;
  }

  waitForBackgroundRequest(
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<RuntimeTaskSnapshot | undefined> {
    const current = this.tasks.get(id);
    if (!current || current.isBackgrounded || isTerminalRuntimeTask(current)) {
      return Promise.resolve(current?.isBackgrounded ? current : undefined);
    }
    return this.waitFor(this.backgroundWaiters, id, options);
  }

  waitForTerminal(
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<RuntimeTaskSnapshot | undefined> {
    const current = this.tasks.get(id);
    if (!current || isTerminalRuntimeTask(current)) return Promise.resolve(current);
    return this.waitFor(this.terminalWaiters, id, options);
  }

  private waitFor(
    waitersByTask: Map<string, Set<RuntimeTaskWaiter>>,
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<RuntimeTaskSnapshot | undefined> {
    const signal = options?.signal;
    if (signal?.aborted) return Promise.reject(abortReason(signal));

    return new Promise((resolve, reject) => {
      const waiter: RuntimeTaskWaiter = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          this.removeWaiter(waitersByTask, id, waiter);
          reject(abortReason(signal));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      let waiters = waitersByTask.get(id);
      if (!waiters) {
        waiters = new Set();
        waitersByTask.set(id, waiters);
      }
      waiters.add(waiter);
    });
  }

  private resolveIfBackgrounded(id: string, task: RuntimeTaskSnapshot): void {
    if (task.isBackgrounded) {
      this.resolveBackgroundWaiters(id, task);
    }
  }

  private resolveIfTerminal(id: string, task: RuntimeTaskSnapshot): void {
    if (isTerminalRuntimeTask(task)) {
      this.resolveTerminalWaiters(id, task);
      this.resolveBackgroundWaiters(id, undefined);
    }
  }

  private resolveBackgroundWaiters(id: string, task: RuntimeTaskSnapshot | undefined): void {
    this.resolveWaiters(this.backgroundWaiters, id, task);
  }

  private resolveTerminalWaiters(id: string, task: RuntimeTaskSnapshot | undefined): void {
    this.resolveWaiters(this.terminalWaiters, id, task);
  }

  private resolveWaiters(
    waitersByTask: Map<string, Set<RuntimeTaskWaiter>>,
    id: string,
    task: RuntimeTaskSnapshot | undefined,
  ): void {
    const waiters = waitersByTask.get(id);
    if (!waiters) return;
    waitersByTask.delete(id);
    for (const waiter of waiters) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.resolve(task);
    }
  }

  private removeWaiter(
    waitersByTask: Map<string, Set<RuntimeTaskWaiter>>,
    id: string,
    waiter: RuntimeTaskWaiter,
  ): void {
    const waiters = waitersByTask.get(id);
    if (!waiters) return;
    waiters.delete(waiter);
    if (waiters.size === 0) waitersByTask.delete(id);
  }
}

export function isTerminalRuntimeTask(task: Pick<RuntimeTaskSnapshot, "status">): boolean {
  return TERMINAL_STATUSES.has(task.status);
}

export function hasRunningBackgroundRuntimeTask(registry: RuntimeTaskRegistry): boolean {
  return Object.values(registry.all()).some(
    (task) => task.isBackgrounded === true && task.status === "running",
  );
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("Runtime task wait aborted");
}
