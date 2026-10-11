// Control-message protocol between scheduler (utilityProcess) and main. Both sides run in Electron and
// communicate through parentPort.postMessage.
// Unlike host↔main CronRun/CronRunResult (see @zcode/shared channels and validation), this is a private
// channel between main and the persistent cron scheduler. Main maps dispatch requests to CronRun before
// forwarding them to the host.
import type { ModelSelection, NodeSelfResourceSample } from "@zcode/shared";

/** scheduler → main */
export type SchedulerToMainMessage =
  | {
      type: "cron-dispatch-request";
      automationId: string;
      runId: string;
      prompt: string;
      targetTaskId?: string;
      modelSelection?: ModelSelection;
      mode?: string;
      workspacePath: string;
      workspaceIdentity?: string;
    }
  | {
      // Off-peak task dispatch is separate from cron messages. The first run omits conversationId/sessionId
      // so host createTask creates a session; retries and recovery include both to resume the same session.
      type: "offpeak-dispatch-request";
      offPeakTaskId: string;
      prompt: string;
      permissionMode: string;
      modelSelection: ModelSelection;
      conversationId?: string;
      sessionId?: string;
      serverTicketId?: string;
      workspacePath: string;
      workspaceIdentity?: string;
    }
  | {
      type: "scheduler-log";
      level: "info" | "warn" | "error";
      message: string;
    }
  | {
      // Off-peak running-count change. Main combines this with the keepAwakeWhileRunning setting to decide
      // whether to enable powerSaveBlocker. Report the current value after each tick (idempotent).
      type: "offpeak-active-count";
      count: number;
    }
  | {
      // The scheduler process's self-sampled metrics, sent every 60 seconds.
      // Main uses only the heap value for scheduler-role events; getAppMetrics remains the source for CPU and RSS.
      type: "scheduler-resource-sample";
      sample: NodeSelfResourceSample;
    };

/** main → scheduler */
export type MainToSchedulerMessage =
  | {
      type: "cron-dispatch-result";
      runId: string;
      ok: boolean;
      taskId?: string;
      sessionId?: string;
      error?: string;
      failureKind?: "transient" | "permanent";
    }
  | {
      // Off-peak task dispatch result. Late results can be settled by offPeakTaskId alone, even without
      // inFlight context, and settlement is idempotent.
      type: "offpeak-dispatch-result";
      offPeakTaskId: string;
      ok: boolean;
      conversationId?: string;
      sessionId?: string;
      error?: string;
      failureKind?: "transient" | "permanent";
    }
  | {
      // Main asks the scheduler to shut down gracefully before exit (release claims and close the database).
      type: "scheduler-dispose";
    }
  | {
      // A manual run was submitted; trigger a tick immediately. automationId is only for log correlation.
      type: "scheduler-wake";
      automationId: string;
    };
