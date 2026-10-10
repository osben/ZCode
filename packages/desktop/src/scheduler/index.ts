// Persistent cron scheduler process, started by desktop main through electronUtilityProcess.fork.
// Responsibilities (tasks-index ownership model):
//   - Poll automations in tasks-index and transactionally claim due tasks
//     (AutomationRepo.claimDue: BEGIN IMMEDIATE + running 0→1).
//   - Poll manual runs in automation_runs. Manual triggers increment run_count but do not advance
//     next_run_at / max_runs / lifecycle.
//   - Maintain the dispatch state machine: skip misfires, claim single-flight runs, settle successes,
//     and retry failures with backoff.
//   - Send due-task dispatch requests to main, which maps them to CronRun and forwards them to the
//     workspace host to run createTask+sendPrompt.
//   - Settle automation and automation_runs after receiving the result from main.
//   - Off-peak tasks (off_peak_tasks): recover interrupted tasks at startup and claim schedulable=1
//     queued tasks for dispatch. These use separate tables, messages, and constants from automations.
//     They do not skip misfires; overdue work is deferred rather than discarded.
// This process reads and writes only tasks-index, not the UI or agent runtime. createTask runs in the host domain.
import {
  AutomationRepo,
  computeAutomationNextRunAt,
  isOneShotAutomation,
  OffPeakTaskRepo,
} from "@zcode/services/node";
import {
  resolveWorkspaceKey,
  type ZCodeAutomation,
  type ZCodeAutomationTrigger,
  type ZCodeAutomationRun,
  type ZCodeOffPeakTask,
} from "@zcode/shared";
import type { MainToSchedulerMessage, SchedulerToMainMessage } from "./schedulerProtocol.js";
import { settleManualClaimForDispatchResult } from "./manualClaimRelease.js";
import { settleOffPeakDispatchResult } from "./offPeakDispatchSettlement.js";
import {
  startSchedulerResourceTelemetry,
  type SchedulerResourceTelemetry,
} from "./schedulerResourceTelemetry.js";

/** Polling interval: cron's minimum granularity is one minute, so polling every 20 seconds is timely and inexpensive. */
const POLL_INTERVAL_MS = 20_000;
/**
 * Misfire grace period: if next_run_at is older than now by more than this value, treat it as a window
 * missed during shutdown, sleep, or exit; mark it skipped instead of replaying it.
 * Keep it well above normal polling latency to avoid classifying an on-time task as a misfire, while
 * still covering brief stalls.
 */
const MISFIRE_GRACE_MS = 5 * 60_000;

const { parentPort } = process;

type InFlight = {
  automationId: string;
  workspaceKey: string;
  trigger: ZCodeAutomationTrigger;
};

const repo = new AutomationRepo();
/** runId → in-flight dispatch context, settled after main reports back. If a scheduler restart loses it, claimDue reclaims the orphan. */
const inFlight = new Map<string, InFlight>();

// ---- Off-peak tasks ----
const offPeakRepo = new OffPeakTaskRepo();
/** In-process backoff table: offPeakTaskId → next allowed dispatch time / failure count. Resetting it on scheduler restart is safe. */
const offPeakRetryAt = new Map<string, number>();
const offPeakRetryAttempts = new Map<string, number>();
/** In-flight dispatch set, used only to release claims on shutdown. Late results can be settled by offPeakTaskId alone. */
const offPeakInFlight = new Set<string>();

let ticking = false;
let tickRequested = false;
let schedulerReady = false;
let disposed = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
/** Resource telemetry: the only self-sampling timer in this process. */
let resourceTelemetry: SchedulerResourceTelemetry | null = null;

function log(level: "info" | "warn" | "error", message: string): void {
  const msg: SchedulerToMainMessage = { type: "scheduler-log", level, message };
  parentPort?.postMessage(msg);
  // Fallback: preserve a diagnostic when parentPort is unavailable (for example, during non-utilityProcess debugging).
  if (!parentPort) {
    // eslint-disable-next-line no-console -- scheduler debugging fallback
    console[level === "error" ? "error" : "log"](`[scheduler] ${message}`);
  }
}

/** Dispatch timestamp: prefer next_run_at (stable across retries, keeping runId stable), then retry_at, then now. */
function resolveScheduledAt(automation: ZCodeAutomation, now: number): number {
  return automation.nextRunAt ?? automation.retryAt ?? now;
}

function buildRunId(automationId: string, scheduledAt: number): string {
  return `${automationId}:${scheduledAt}`;
}

async function tick(): Promise<void> {
  if (disposed || !schedulerReady || ticking) return;
  ticking = true;
  try {
    do {
      tickRequested = false;
      try {
        const now = Date.now();
        const claimed = await repo.claimDue(now);
        for (const automation of claimed) {
          await handleClaimed(automation, now);
        }
        const manualRuns = await repo.claimManualRuns(now);
        for (const manualRun of manualRuns) {
          await handleClaimedManual(manualRun.automation, manualRun.run);
        }
        const offPeakClaimed = await offPeakRepo.claimDue(now);
        for (const task of offPeakClaimed) {
          await handleOffPeakClaimed(task, now);
        }
        // Keep-awake: report the running count; main combines it with settings to decide whether to use powerSaveBlocker.
        await reportOffPeakActiveCount();
      } catch (error) {
        log("error", `tick failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      // A manual-run wakeup can overlap the current tick. Dropping it because ticking=true would make
      // the user wait for the next 20-second poll. Mark it pending and run it as soon as this tick finishes.
    } while (tickRequested && !disposed);
  } finally {
    ticking = false;
  }
}

function requestTick(): void {
  if (disposed) return;
  if (!schedulerReady || ticking) {
    tickRequested = true;
    return;
  }
  void tick();
}

async function handleClaimed(automation: ZCodeAutomation, now: number): Promise<void> {
  const scheduledAt = resolveScheduledAt(automation, now);
  const runId = buildRunId(automation.automationId, scheduledAt);
  const workspaceKey = resolveWorkspaceKey({
    workspacePath: automation.workspacePath,
    workspaceIdentity: automation.workspaceIdentity,
  });
  const isRetry = automation.dispatchAttempts > 0;

  // Misfire: on the first attempt (not a retry), if the scheduled time is far behind now, skip the
  // missed window instead of replaying it.
  const missed =
    !isRetry && automation.nextRunAt != null && automation.nextRunAt <= now - MISFIRE_GRACE_MS;
  if (missed) {
    // After a one-time task (such as a minute scheduleRule created from delayMinutes) misses its window,
    // the general recalculation would produce the next anchorAt + k*interval occurrence and keep running
    // a "run once" reminder in later periods. A one-time task has a specific target time; missing it is
    // terminal and must not create another scheduled execution.
    const finalize = isOneShotAutomation(automation);
    const nextRunAt = finalize ? null : computeAutomationNextRunAt(automation, now);
    await repo.skipAndReschedule({
      automationId: automation.automationId,
      runId,
      workspaceKey,
      scheduledAt,
      reason: "computer_asleep_or_app_not_running",
      nextRunAt,
      finalize,
    });
    log(
      "info",
      `skip missed window automation=${automation.automationId} scheduledAt=${scheduledAt}${finalize ? " finalized=one-shot" : ""}`,
    );
    return;
  }

  // Normal dispatch: record or update the run ledger as claimed, then send the request to main.
  await repo.upsertRunClaimed({
    runId,
    automationId: automation.automationId,
    workspaceKey,
    scheduledAt,
    trigger: "schedule",
    // Pass the original intent in the dispatch request; the target Host fixes the first effective choice.
    // Do not freeze it earlier here.
  });
  inFlight.set(runId, {
    automationId: automation.automationId,
    workspaceKey,
    trigger: "schedule",
  });
  const run = await repo.getRun(runId);
  postDispatchRequest(automation, runId, run?.modelSelection);
}

function postDispatchRequest(
  automation: ZCodeAutomation,
  runId: string,
  fixedSelection?: ZCodeAutomationRun["modelSelection"],
): void {
  const request: SchedulerToMainMessage = {
    type: "cron-dispatch-request",
    automationId: automation.automationId,
    runId,
    prompt: automation.prompt,
    ...(automation.targetTaskId ? { targetTaskId: automation.targetTaskId } : {}),
    ...((fixedSelection ?? automation.modelSelection)
      ? { modelSelection: fixedSelection ?? automation.modelSelection }
      : {}),
    ...(automation.mode ? { mode: automation.mode } : {}),
    workspacePath: automation.workspacePath,
    ...(automation.workspaceIdentity ? { workspaceIdentity: automation.workspaceIdentity } : {}),
  };
  parentPort?.postMessage(request);
}

async function handleClaimedManual(
  automation: ZCodeAutomation,
  run: ZCodeAutomationRun,
): Promise<void> {
  inFlight.set(run.runId, {
    automationId: automation.automationId,
    workspaceKey: resolveWorkspaceKey({
      workspacePath: automation.workspacePath,
      workspaceIdentity: automation.workspaceIdentity,
    }),
    trigger: "manual",
  });
  postDispatchRequest(automation, run.runId, run.modelSelection);
}

/** Report the running count for keep-awake only when it changes to reduce noise. */
let lastOffPeakActiveCount = -1;
async function reportOffPeakActiveCount(): Promise<void> {
  try {
    const count = await offPeakRepo.countActive();
    if (count === lastOffPeakActiveCount) return;
    lastOffPeakActiveCount = count;
    const msg: SchedulerToMainMessage = { type: "offpeak-active-count", count };
    parentPort?.postMessage(msg);
  } catch (error) {
    log(
      "warn",
      `off-peak active count report failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// ---- Off-peak task dispatch ----

/**
 * Dispatch a claimed off-peak task. Immediately release tasks in backoff and wait for the next poll.
 * Backoff is stored in-process, so each poll writes once for claim and once for release. The task count is
 * small and this cost is negligible with WAL; if backoff tasks become numerous, move backoff into claimDue.
 */
async function handleOffPeakClaimed(task: ZCodeOffPeakTask, now: number): Promise<void> {
  const retryAt = offPeakRetryAt.get(task.offPeakTaskId) ?? 0;
  if (retryAt > now) {
    await offPeakRepo.releaseClaim(task.offPeakTaskId, { now });
    return;
  }
  offPeakInFlight.add(task.offPeakTaskId);
  const request: SchedulerToMainMessage = {
    type: "offpeak-dispatch-request",
    offPeakTaskId: task.offPeakTaskId,
    prompt: task.prompt,
    permissionMode: task.permissionMode,
    modelSelection: task.modelSelection,
    ...(task.conversationId ? { conversationId: task.conversationId } : {}),
    ...(task.sessionId ? { sessionId: task.sessionId } : {}),
    ...(task.serverTicketId ? { serverTicketId: task.serverTicketId } : {}),
    workspacePath: task.workspacePath,
    ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
  };
  parentPort?.postMessage(request);
  log("info", `off-peak dispatch requested task=${task.offPeakTaskId}`);
}

async function settleDispatchResult(
  msg: Extract<MainToSchedulerMessage, { type: "cron-dispatch-result" }>,
): Promise<void> {
  const context = inFlight.get(msg.runId);
  inFlight.delete(msg.runId);
  const now = Date.now();
  // Recover automationId from runId when the context is lost, such as when a late result arrives after a scheduler restart.
  const automationId = context?.automationId ?? msg.runId.split(":")[0]!;
  const workspaceKey = context?.workspaceKey;
  const trigger: ZCodeAutomationTrigger =
    context?.trigger ?? (msg.runId.includes(":manual:") ? "manual" : "schedule");
  const settleManualClaim = async (ok: boolean): Promise<void> => {
    await settleManualClaimForDispatchResult({
      repo,
      automationId,
      runId: msg.runId,
      workspaceKey,
      ok,
      logError: (message) => log("error", message),
    });
  };

  if (msg.ok) {
    if (trigger === "manual") {
      await repo.markManualRunDispatched({
        runId: msg.runId,
        sessionId: msg.sessionId ?? null,
        dispatchedAt: now,
      });
      await settleManualClaim(true);
      return;
    }
    await repo.markRunDispatch({
      runId: msg.runId,
      dispatchStatus: "dispatched",
      sessionId: msg.sessionId ?? null,
    });
    const automation = await repo.get(automationId);
    const nextRunAt = automation ? computeAutomationNextRunAt(automation, now) : null;
    await repo.markDispatched(automationId, { dispatchedAt: now, nextRunAt });
    return;
  }

  await repo.markRunDispatch({
    runId: msg.runId,
    dispatchStatus: "failed_to_dispatch",
    error: msg.error ?? "dispatch failed",
  });
  if (trigger === "manual") {
    await settleManualClaim(false);
    return;
  }
  const kind = msg.failureKind ?? "transient";
  await repo.markDispatchFailed(automationId, {
    failedAt: now,
    error: msg.error ?? "dispatch failed",
    kind,
    // Once transient retries reach the limit, move a recurring task to its next regular next_run_at.
    nextRunAt: await repo
      .get(automationId)
      .then((automation) => (automation ? computeAutomationNextRunAt(automation, now) : null)),
  });
}

async function dispose(): Promise<void> {
  if (disposed) return;
  disposed = true;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  resourceTelemetry?.stop();
  resourceTelemetry = null;
  // Release claims still in flight in this process so the next startup does not wait for CLAIM_STALE to reclaim them.
  for (const [, context] of inFlight) {
    try {
      if (context.trigger === "manual") {
        await repo.releaseManualClaim(context.automationId, context.workspaceKey);
      } else {
        await repo.releaseClaim(context.automationId);
      }
    } catch {
      // Ignore: shutdown cleanup is best-effort.
    }
  }
  inFlight.clear();
  for (const offPeakTaskId of offPeakInFlight) {
    try {
      await offPeakRepo.releaseClaim(offPeakTaskId);
    } catch {
      // Ignore: shutdown cleanup is best-effort.
    }
  }
  offPeakInFlight.clear();
  try {
    repo.close();
  } catch {
    // Ignore.
  }
  try {
    offPeakRepo.close();
  } catch {
    // Ignore.
  }
  process.exit(0);
}

parentPort?.on("message", (event: Electron.MessageEvent) => {
  const msg = event.data as MainToSchedulerMessage;
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "scheduler-dispose") {
    void dispose();
    return;
  }
  if (msg.type === "cron-dispatch-result") {
    void settleDispatchResult(msg)
      .then(() => {
        // A manual run may be temporarily unclaimable while a dispatch for the same automation is in flight.
        // Tick immediately after the previous result releases the single-flight lock instead of waiting
        // for another 20-second poll.
        requestTick();
      })
      .catch((error) => {
        log(
          "error",
          `settle dispatch result failed runId=${msg.runId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    return;
  }
  if (msg.type === "offpeak-dispatch-result") {
    offPeakInFlight.delete(msg.offPeakTaskId);
    void settleOffPeakDispatchResult(
      {
        repo: offPeakRepo,
        retryAt: offPeakRetryAt,
        retryAttempts: offPeakRetryAttempts,
        now: Date.now,
        log,
      },
      msg,
    ).catch((error) => {
      log(
        "error",
        `settle off-peak dispatch result failed task=${msg.offPeakTaskId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    return;
  }
  if (msg.type === "scheduler-wake") {
    log("info", `manual run wake requested automation=${msg.automationId}`);
    requestTick();
  }
});

async function main(): Promise<void> {
  await repo.ensureReady();
  // Recover interrupted off-peak tasks: the scheduler is an app singleton and starts before any dispatch,
  // so any running rows in the database belong to the previous app instance. Safely return them to
  // queued while preserving their sessions for resume.
  try {
    const recovered = await offPeakRepo.recoverInterrupted(Date.now());
    if (recovered > 0) {
      log("info", `off-peak recovered ${recovered} interrupted task(s) back to queued`);
    }
  } catch (error) {
    log(
      "error",
      `off-peak recoverInterrupted failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  schedulerReady = true;
  log("info", "cron scheduler started");
  requestTick();
  pollTimer = setInterval(requestTick, POLL_INTERVAL_MS);
  // Resource telemetry: sample CPU/memory every 60 seconds and send it to main; only this process can read its heap.
  resourceTelemetry = startSchedulerResourceTelemetry({
    postMessage: (message) => parentPort?.postMessage(message),
  });
}

void main().catch((error) => {
  log(
    "error",
    `scheduler bootstrap failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
