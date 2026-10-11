// Cron scheduler process manager on the desktop main side.
// Responsibilities: start/stop the persistent scheduler process; route scheduler dispatch requests
// to a local Host (as CronRun); and return Host CronRunResult responses to the scheduler for settlement.
// The scheduler accesses only tasks-index; createTask runs in the Host domain.
import { utilityProcess as electronUtilityProcess } from "electron";
import type { UtilityProcess as ElectronUtilityProcess } from "electron";
import { HostMessageTypes } from "@zcode/shared";
import { buildHostProcessEnv, schedulerModulePath } from "./desktopRuntimeEnv.js";
import { ingestSchedulerSelfResourceSample } from "./processResourceSelfHeapSource.js";
import { registerSchedulerProcess, unregisterSchedulerProcess } from "./resourceManagerWindow.js";
import type {
  MainToSchedulerMessage,
  SchedulerToMainMessage,
} from "../scheduler/schedulerProtocol.js";

export interface CronRunResultPayload {
  runId: string;
  ok: boolean;
  taskId?: string;
  sessionId?: string;
  error?: string;
  failureKind?: "transient" | "permanent";
}

/** Idle-task dispatch result from Host → main (separate from cron messages). */
export interface OffPeakRunResultPayload {
  offPeakTaskId: string;
  ok: boolean;
  conversationId?: string;
  sessionId?: string;
  error?: string;
  failureKind?: "transient" | "permanent";
}

interface CronSchedulerDeps {
  hostProcessLocalEnv: Record<string, string>;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  /** Select a Host that can dispatch for a local workspace; return null when none is available (scheduler retries with backoff). */
  resolveDispatchHost: () => ElectronUtilityProcess | null;
  /** Idle-task execution count changed (keep-awake: main adjusts powerSaveBlocker based on this). */
  onOffPeakActiveCountChanged?: (count: number) => void;
}

export interface CronSchedulerHandle {
  /** Called when Host reports a dispatch result; forward it to the scheduler for settlement. */
  handleCronRunResult: (result: CronRunResultPayload) => void;
  /** Called when Host reports an idle-task dispatch result; forward it to the scheduler for settlement. */
  handleOffPeakRunResult: (result: OffPeakRunResultPayload) => void;
  /** Wake the scheduler immediately after a manual run is persisted instead of waiting for the next poll. */
  wake: (automationId: string) => void;
  /** Gracefully shut down before app exit (tell the scheduler to release claims and close the DB; force-kill as a fallback). */
  dispose: () => Promise<void>;
}

const DISPOSE_FORCE_KILL_MS = 1_500;

export function spawnCronScheduler(deps: CronSchedulerDeps): CronSchedulerHandle {
  const child = electronUtilityProcess.fork(schedulerModulePath, [], {
    serviceName: "zcode-cron-scheduler",
    execArgv: ["--no-warnings"],
    env: {
      ...buildHostProcessEnv(deps.hostProcessLocalEnv),
      ZCODE_PROCESS_LABEL: "scheduler",
    },
  });

  deps.logger.info(`[cron-scheduler] forked scheduler process pid=${child.pid}`);
  // The spawn point is the only place that knows the scheduler PID for resource telemetry; register it in the process-role registry here.
  registerSchedulerProcess(child);
  let isDisposing = false;
  let disposePromise: Promise<void> | null = null;

  const postToScheduler = (message: MainToSchedulerMessage): void => {
    try {
      child.postMessage(message);
    } catch (error) {
      deps.logger.warn("[cron-scheduler] postMessage to scheduler failed:", error);
    }
  };

  child.on("message", (raw: unknown) => {
    const msg = raw as SchedulerToMainMessage;
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "scheduler-log") {
      const level = msg.level === "warn" ? "warn" : msg.level === "error" ? "error" : "info";
      deps.logger[level](`[cron-scheduler] ${msg.message}`);
      return;
    }

    if (msg.type === "offpeak-active-count") {
      deps.onOffPeakActiveCountChanged?.(msg.count);
      return;
    }

    // Scheduler self-samples every 60 seconds; main uses only heap for the scheduler-role event's
    // heap dimension. Invalid samples are dropped at the entry point by schema validation.
    if (msg.type === "scheduler-resource-sample") {
      ingestSchedulerSelfResourceSample(msg.sample);
      return;
    }

    if (msg.type === "cron-dispatch-request") {
      if (isDisposing) {
        // Cron and Host shut down in parallel during app exit. Dispatching after entering disposing
        // would send new tasks to a Host that is closing. Reject dispatch explicitly rather than
        // adding another 1.5-second shutdown delay to preserve serialization.
        postToScheduler({
          type: "cron-dispatch-result",
          runId: msg.runId,
          ok: false,
          failureKind: "transient",
          error: "app is shutting down",
        });
        return;
      }
      const host = deps.resolveDispatchHost();
      if (!host) {
        // No local Host is available for dispatch (no window/not ready): return a transient result so the scheduler retries with backoff.
        postToScheduler({
          type: "cron-dispatch-result",
          runId: msg.runId,
          ok: false,
          failureKind: "transient",
          error: "no local host available",
        });
        return;
      }
      try {
        host.postMessage({
          type: HostMessageTypes.CronRun,
          automationId: msg.automationId,
          runId: msg.runId,
          prompt: msg.prompt,
          targetTaskId: msg.targetTaskId,
          modelSelection: msg.modelSelection,
          mode: msg.mode,
          workspacePath: msg.workspacePath,
          workspaceIdentity: msg.workspaceIdentity,
        });
      } catch (error) {
        deps.logger.warn("[cron-scheduler] forward CronRun to host failed:", error);
        postToScheduler({
          type: "cron-dispatch-result",
          runId: msg.runId,
          ok: false,
          failureKind: "transient",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (msg.type === "offpeak-dispatch-request") {
      const host = deps.resolveDispatchHost();
      if (!host) {
        // No Host is available: return a transient result so the scheduler retries with its separate off-peak backoff (defer, do not discard).
        postToScheduler({
          type: "offpeak-dispatch-result",
          offPeakTaskId: msg.offPeakTaskId,
          ok: false,
          failureKind: "transient",
          error: "no local host available",
        });
        return;
      }
      try {
        host.postMessage({
          type: HostMessageTypes.OffPeakRun,
          offPeakTaskId: msg.offPeakTaskId,
          prompt: msg.prompt,
          permissionMode: msg.permissionMode,
          modelSelection: msg.modelSelection,
          conversationId: msg.conversationId,
          sessionId: msg.sessionId,
          serverTicketId: msg.serverTicketId,
          workspacePath: msg.workspacePath,
          workspaceIdentity: msg.workspaceIdentity,
        });
      } catch (error) {
        deps.logger.warn("[cron-scheduler] forward OffPeakRun to host failed:", error);
        postToScheduler({
          type: "offpeak-dispatch-result",
          offPeakTaskId: msg.offPeakTaskId,
          ok: false,
          failureKind: "transient",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  });

  child.on("exit", (code) => {
    unregisterSchedulerProcess(child);
    deps.logger.info(`[cron-scheduler] scheduler process exited code=${code}`);
  });

  return {
    handleCronRunResult(result) {
      postToScheduler({ type: "cron-dispatch-result", ...result });
    },
    handleOffPeakRunResult(result) {
      postToScheduler({ type: "offpeak-dispatch-result", ...result });
    },
    wake(automationId) {
      if (isDisposing) return;
      postToScheduler({ type: "scheduler-wake", automationId });
    },
    dispose() {
      if (disposePromise) return disposePromise;
      isDisposing = true;
      postToScheduler({ type: "scheduler-dispose" });
      disposePromise = new Promise<void>((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          try {
            child.kill();
          } catch {
            // Ignore.
          }
          done();
        }, DISPOSE_FORCE_KILL_MS);
        child.once("exit", done);
      });
      return disposePromise;
    },
  };
}
