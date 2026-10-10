/* eslint-disable max-lines -- The off-peak orchestration service keeps create/cancel/pause/continue/delete,
   polling sync (offPeakTaskSync), terminal settlement outbox, and 3102 continuation ticket renewal together until they can be split by responsibility. */
/* Off-peak task orchestration service (host domain, modeled after automationService).
   Responsibilities:
   - Request a ticket on creation (persist only after POST /ticket succeeds); throw typed 3103/3101 errors for the UI.
   - Orchestrate state guards for cancel/pause/continue/delete/edit.
   - offPeakTaskSync: batch-poll /ticket/status only when non-terminal tasks exist (polling triggers server promotion),
     write back schedulable/position/next_poll_at; automatically request a new ticket for expired tasks that are not paused.
   - Terminal settlement outbox: settle on terminal state, retry failures with poll cycles, and scan at startup.
   - 3102 continuation: after host terminal writeback recognizes the marker, call handleTicketExpiredDuringRun → requeue and request a new ticket. */
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import {
  isOffPeakTerminalStatus,
  resolveWorkspaceKey,
  type OffPeakCodingPlanSupport,
  type OffPeakTaskCreateErrorCategory,
  type OffPeakTaskCreateFailureStage,
  type OffPeakTaskCreateResult,
  type ZCodeOffPeakTask,
  type ZCodeOffPeakTaskCreateParams,
} from "@zcode/shared";
import type { ServiceLogger } from "../logger/serviceLogger.js";
import { isOffPeakBoundSessionConflict, type OffPeakTaskRepo } from "./offPeakTaskRepo.js";
import type { IOffPeakTaskService, OffPeakUpdateTaskParams } from "./offPeakTask.js";
import { OffPeakServerError, type OffPeakServerClient } from "./offPeakServerClient.js";
import type { ModelSelection, ModelSelectionValidation } from "@zcode/provider";

/** Polling minimum/maximum and failure backoff (prefer server next_poll_after and clamp it to avoid over-polling/starvation). */
const OFF_PEAK_SYNC_MIN_INTERVAL_MS = 5_000;
const OFF_PEAK_SYNC_MAX_INTERVAL_MS = 5 * 60_000;
const SYNC_FAILURE_BASE_MS = 10_000;

interface OffPeakTaskServiceDeps {
  repo: OffPeakTaskRepo;
  client: OffPeakServerClient;
  /** Redacted result from the resolver shared with ticket/runtime, used to gate creation in the renderer. */
  resolveCodingPlanSupport: () => Promise<OffPeakCodingPlanSupport>;
  /** Return only a safe hostname; return an empty string on failure without affecting task creation. */
  resolveTelemetryProviderName: () => Promise<string>;
  /** Resolve and validate the fixed Off-Peak Provider selection against the current complete Registry. */
  resolveModelSelection: (input: {
    readonly modelId?: string;
    readonly reasoningLevel?: string;
  }) => Promise<
    | { readonly ok: true; readonly selection: ModelSelection }
    | { readonly ok: false; readonly validation: ModelSelectionValidation }
  >;
  logger: ServiceLogger;
  /** Wake the scheduler tick immediately when schedulable becomes true (otherwise wait for the default 20s poll). */
  requestSchedulerWake?: () => void;
  /** Abort the agent loop when cancelling a running task (injected by host; best effort). */
  stopRunningTask?: (params: {
    conversationId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }) => Promise<void>;
  /** Broadcast hook for list changes (refresh UI). */
  onTasksChanged?: () => void;
  /** Clock injected by tests. */
  now?: () => number;
  /** Additional cleanup during disposeAll (for example, close the mock gateway). */
  onDispose?: () => void;
}

const VALID_CREATE_PERMISSION_MODES = new Set([
  "yolo",
  "plan",
  "edit",
  "auto",
  "autoEdit",
  "build",
]);

function isValidCreateParams(params: ZCodeOffPeakTaskCreateParams): boolean {
  return (
    typeof params.title === "string" &&
    params.title.trim().length > 0 &&
    typeof params.prompt === "string" &&
    params.prompt.trim().length > 0 &&
    typeof params.workspacePath === "string" &&
    params.workspacePath.trim().length > 0 &&
    typeof params.permissionMode === "string" &&
    VALID_CREATE_PERMISSION_MODES.has(params.permissionMode)
  );
}

function classifyOffPeakCreateFailure(
  error: unknown,
  failureStage: OffPeakTaskCreateFailureStage,
): Pick<
  Extract<OffPeakTaskCreateResult, { ok: false }>,
  "failureStage" | "errorCategory" | "errorCode"
> {
  let errorCategory: OffPeakTaskCreateErrorCategory = "unknown";
  let errorCode = "";
  if (failureStage === "client_validation") {
    errorCategory = "client_validation";
  } else if (failureStage === "local_persist") {
    errorCategory = "local_persist";
  } else if (error instanceof OffPeakServerError) {
    errorCode = error.bizCode === undefined ? "" : String(error.bizCode);
    if (error.bizCode === 3101) errorCategory = "eligibility_3101";
    else if (error.bizCode === 3103) errorCategory = "quota_3103";
  } else if (error instanceof ZodError) {
    errorCategory = "invalid_response";
  } else {
    // Credentials/RPC/fetch/abort inside the ticket client may throw ordinary Errors across layers;
    // they still belong to ticket_request and must not be classified by guessing from raw messages or exposing server responses.
    errorCategory = "network";
  }
  return { failureStage, errorCategory, errorCode };
}

const OFF_PEAK_SESSION_BOUND_FAILURE = {
  failureStage: "client_validation",
  errorCategory: "client_validation",
  errorCode: "session_bound",
} as const;

export class OffPeakTaskService implements IOffPeakTaskService {
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private syncRunning = false;
  private syncStopped = true;
  private consecutiveSyncFailures = 0;

  constructor(private readonly deps: OffPeakTaskServiceDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private emitChanged(): void {
    try {
      this.deps.onTasksChanged?.();
    } catch (error) {
      this.deps.logger.warn("off-peak onTasksChanged 回调失败:", error);
    }
  }

  // ---- Management operations ----

  async getCodingPlanSupport(): Promise<OffPeakCodingPlanSupport> {
    return this.deps.resolveCodingPlanSupport();
  }

  /** Narrow check before Host dispatch; the target Agent ModelFactory still performs final validation. */
  async validateDispatchModelSelection(selection: ModelSelection): Promise<boolean> {
    const resolved = await this.deps.resolveModelSelection({
      modelId: selection.modelId,
      ...(selection.options?.reasoningLevel
        ? { reasoningLevel: selection.options.reasoningLevel }
        : {}),
    });
    return (
      resolved.ok &&
      resolved.selection.providerId === selection.providerId &&
      resolved.selection.modelId === selection.modelId
    );
  }

  async getTakeNumberAvailability() {
    return this.deps.client.getTakeNumberAvailability();
  }

  /** Request a ticket at creation time (persist only on success); failures return only a stable category, never a raw error over RPC. */
  async createTask(params: ZCodeOffPeakTaskCreateParams): Promise<OffPeakTaskCreateResult> {
    let providerName = "";
    try {
      providerName = await this.deps.resolveTelemetryProviderName();
    } catch {
      // provider_name is only a telemetry dimension; resolution failures must not affect creation, toast, or task execution.
    }
    if (!isValidCreateParams(params)) {
      return {
        ok: false,
        ...classifyOffPeakCreateFailure(undefined, "client_validation"),
        providerName,
      };
    }
    const selection = await this.deps.resolveModelSelection({
      modelId: params.modelSelection.modelId,
      ...(params.modelSelection.options?.reasoningLevel
        ? { reasoningLevel: params.modelSelection.options.reasoningLevel }
        : {}),
    });
    if (!selection.ok) {
      return {
        ok: false,
        ...classifyOffPeakCreateFailure(undefined, "client_validation"),
        providerName,
      };
    }
    const normalizedParams: ZCodeOffPeakTaskCreateParams = {
      ...params,
      modelSelection: selection.selection,
    };
    // Reject when the bound session already has a non-terminal task, before requesting a ticket to avoid wasting quota;
    // idx_off_peak_bound_active rejects a concurrent request that passed precheck during INSERT (see the local_persist branch below).
    if (
      params.boundSessionId &&
      (await this.deps.repo.hasActiveBoundTask(
        resolveWorkspaceKey({
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
        }),
        params.boundSessionId,
      ))
    ) {
      return { ok: false, ...OFF_PEAK_SESSION_BOUND_FAILURE, providerName };
    }
    const offPeakTaskId = `offpeak-${randomUUID()}`;
    let ticket;
    try {
      ticket = await this.deps.client.takeTicket(offPeakTaskId);
    } catch (error) {
      return {
        ok: false,
        ...classifyOffPeakCreateFailure(error, "ticket_request"),
        providerName,
      };
    }
    let created: ZCodeOffPeakTask;
    try {
      created = await this.deps.repo.create(normalizedParams, {
        offPeakTaskId,
        serverTicketId: ticket.ticketId,
        registeredAt: ticket.registeredAt,
        ...(ticket.position !== undefined ? { queuePosition: ticket.position } : {}),
        // Dispatch immediately when the ticket is ready at request time (off-peak is idle and promotion is immediate).
        schedulable: ticket.state === "ready",
      });
      if (ticket.nextPollAfterMs !== undefined) {
        await this.deps.repo.updateSchedulingSnapshot(created.offPeakTaskId, {
          nextPollAt: this.now() + ticket.nextPollAfterMs,
        });
      }
    } catch (error) {
      if (isOffPeakBoundSessionConflict(error)) {
        // The requested ticket becomes invalid with the task and the server reclaims it on expiry; do not add a release endpoint for this.
        return { ok: false, ...OFF_PEAK_SESSION_BOUND_FAILURE, providerName };
      }
      return {
        ok: false,
        ...classifyOffPeakCreateFailure(error, "local_persist"),
        providerName,
      };
    }
    this.deps.logger.info(
      `off-peak task created id=${offPeakTaskId} ticket=${ticket.ticketId} state=${ticket.state}`,
    );
    this.emitChanged();
    this.ensureSyncScheduled(0);
    if (ticket.state === "ready") {
      try {
        this.deps.requestSchedulerWake?.();
      } catch (error) {
        this.deps.logger.warn("off-peak scheduler wake failed after create:", error);
      }
    }
    return {
      ok: true,
      task: created,
      ticketInitialState: ticket.state,
      ...(ticket.position !== undefined ? { queuePosition: ticket.position } : {}),
      providerName,
    };
  }

  /**
   * Cancel (any non-terminal state): persist the terminal state before stopping the loop, so a late stopped writeback
   * is rejected by the terminal-state guard and cannot overwrite cancelled (idempotent).
   */
  async cancelTask(offPeakTaskId: string): Promise<ZCodeOffPeakTask | null> {
    const existing = await this.deps.repo.get(offPeakTaskId);
    if (!existing || isOffPeakTerminalStatus(existing.status)) return existing;
    const cancelled = await this.deps.repo.markTerminal(offPeakTaskId, {
      status: "cancelled",
      endedAt: this.now(),
    });
    if (!cancelled) return this.deps.repo.get(offPeakTaskId);
    if (existing.status === "running" && existing.conversationId && this.deps.stopRunningTask) {
      try {
        await this.deps.stopRunningTask({
          conversationId: existing.conversationId,
          workspacePath: existing.workspacePath,
          ...(existing.workspaceIdentity ? { workspaceIdentity: existing.workspaceIdentity } : {}),
        });
      } catch (error) {
        this.deps.logger.warn(`off-peak cancel stop loop failed task=${offPeakTaskId}:`, error);
      }
    }
    this.emitChanged();
    void this.settleOne(cancelled);
    return cancelled;
  }

  /** Pause: stop local dispatch while the ticket remains queued on the server. */
  async pauseTask(offPeakTaskId: string): Promise<ZCodeOffPeakTask | null> {
    const paused = await this.deps.repo.setPaused(offPeakTaskId, true, {
      now: this.now(),
    });
    if (paused) this.emitChanged();
    return paused;
  }

  /**
   * Continue: if the ticket is active, resume dispatch (no cost); if it is invalid (expired/not_found/no ticket), manually
   * request a new one now and rejoin the queue (quota use must be triggered explicitly by the user).
   */
  async continueTask(offPeakTaskId: string): Promise<ZCodeOffPeakTask | null> {
    const resumed = await this.deps.repo.setPaused(offPeakTaskId, false, {
      now: this.now(),
    });
    if (!resumed) return null;
    let ticketAlive = false;
    if (resumed.serverTicketId) {
      try {
        const status = await this.deps.client.batchStatus([resumed.serverTicketId]);
        // Match by ticketId; do not use tickets[0], because batch response order/content is not guaranteed to match the request.
        const entry = status.tickets.find((t) => t.ticketId === resumed.serverTicketId);
        ticketAlive =
          entry !== undefined && entry.state !== "expired" && entry.state !== "not_found";
        if (entry && ticketAlive) {
          await this.deps.repo.updateSchedulingSnapshot(offPeakTaskId, {
            schedulable: entry.state === "ready",
            queuePosition: entry.position ?? null,
            now: this.now(),
          });
        }
      } catch (error) {
        // Treat a failed status query as an active ticket and let polling handle it; do not waste a ticket request during Continue.
        this.deps.logger.warn(
          `off-peak continue status check failed task=${offPeakTaskId}:`,
          error,
        );
        ticketAlive = true;
      }
    }
    if (!ticketAlive) {
      await this.retakeTicket(offPeakTaskId);
    }
    this.emitChanged();
    this.ensureSyncScheduled(0);
    return this.deps.repo.get(offPeakTaskId);
  }

  /** Delete: cancel non-terminal tasks first (stop loop + settle), then delete the row; delete terminal tasks directly. */
  async deleteTask(offPeakTaskId: string): Promise<void> {
    const existing = await this.deps.repo.get(offPeakTaskId);
    if (!existing) return;
    if (!isOffPeakTerminalStatus(existing.status)) {
      await this.cancelTask(offPeakTaskId);
    }
    await this.deps.repo.delete(offPeakTaskId);
    this.emitChanged();
  }

  /** Delete history: write only a local visibility marker; retain the task and session. */
  async deleteHistory(offPeakTaskId: string): Promise<ZCodeOffPeakTask | null> {
    const updated = await this.deps.repo.markHistoryDeleted(offPeakTaskId, {
      now: this.now(),
    });
    if (updated) this.emitChanged();
    return updated;
  }

  /** Edit (all fields are editable while queued/paused; the ticket locks only queue identity, and prompt is read at dispatch). */
  async updateTask(
    offPeakTaskId: string,
    params: OffPeakUpdateTaskParams,
  ): Promise<ZCodeOffPeakTask | null> {
    const existing = await this.deps.repo.get(offPeakTaskId);
    if (!existing) return null;
    if (existing.status !== "queued" && existing.status !== "paused") {
      // Running locks editing (only cancellation remains); terminal tasks are read-only.
      return null;
    }
    // Off-peak tasks must save an explicit model resolvable by the current Registry; clearing the model must not fall back to
    // “choose the first one later,” or the selection shown during editing may differ from the model actually dispatched.
    if (params.modelSelection === null) return null;
    const candidate = params.modelSelection ?? existing.modelSelection;
    if (!candidate) return null;
    const selection = await this.deps.resolveModelSelection({
      modelId: candidate.modelId,
      ...(candidate.options?.reasoningLevel
        ? { reasoningLevel: candidate.options.reasoningLevel }
        : {}),
    });
    if (!selection.ok) return null;
    const normalizedParams: OffPeakUpdateTaskParams = {
      ...params,
      modelSelection: selection.selection,
    };
    const updated = await this.deps.repo.updateEditableFields(offPeakTaskId, normalizedParams, {
      now: this.now(),
    });
    if (updated) this.emitChanged();
    return updated;
  }

  async list(): Promise<ZCodeOffPeakTask[]> {
    return this.projectModelSelectionIssues(await this.deps.repo.list());
  }

  async get(offPeakTaskId: string): Promise<ZCodeOffPeakTask | null> {
    const task = await this.deps.repo.get(offPeakTaskId);
    if (!task) return null;
    return (await this.projectModelSelectionIssues([task]))[0] ?? null;
  }

  /**
   * Derive diagnostics for the current configuration only; do not write to the database. Legacy fields are handled only by migration.
   */
  private async projectModelSelectionIssues(
    tasks: readonly ZCodeOffPeakTask[],
  ): Promise<ZCodeOffPeakTask[]> {
    const repaired: ZCodeOffPeakTask[] = [];
    for (const task of tasks) {
      if (task.modelSelection) {
        // Writing NULL when the current account is unavailable during a read would permanently discard the original choice and trigger rebinding from legacy fields.
        // The new structure derives diagnostics only and does not write the task or ticket; terminal tasks no longer use a model and need no recheck.
        const usable =
          isOffPeakTerminalStatus(task.status) ||
          (await this.validateDispatchModelSelection(task.modelSelection));
        repaired.push(
          usable
            ? task
            : {
                ...task,
                schedulable: false,
                modelSelectionIssue: {
                  code: "repair-required",
                  legacyModelId: task.modelSelection.modelId,
                  legacyReasoningLevel: task.modelSelection.options?.reasoningLevel,
                },
              },
        );
        continue;
      }
      // Keep the provider absent when database migration cannot determine the legacy Provider; reads do not perform migration or rebind the ticket.
      repaired.push({ ...task, schedulable: false });
    }
    return repaired;
  }

  // ---- 3102 continuation (called after host terminal writeback recognizes the marker) ----

  /** Ticket expired (active 3h limit/invalid ready ticket): requeue while keeping the session → request a new ticket for the same task_id. */
  async handleTicketExpiredDuringRun(offPeakTaskId: string): Promise<void> {
    const requeued = await this.deps.repo.requeueForContinuation(offPeakTaskId, {
      now: this.now(),
    });
    if (!requeued) {
      this.deps.logger.info(
        `off-peak ticket-expired requeue dropped (not running) task=${offPeakTaskId}`,
      );
      return;
    }
    await this.retakeTicket(offPeakTaskId);
    this.emitChanged();
    this.ensureSyncScheduled(0);
  }

  /** Request a new ticket for the same task_id (multiple requests are confirmed as allowed); let the polling cycle retry failures. */
  private async retakeTicket(offPeakTaskId: string): Promise<void> {
    try {
      const ticket = await this.deps.client.takeTicket(offPeakTaskId);
      await this.deps.repo.updateSchedulingSnapshot(offPeakTaskId, {
        serverTicketId: ticket.ticketId,
        registeredAt: ticket.registeredAt,
        schedulable: ticket.state === "ready",
        queuePosition: ticket.position ?? null,
        ...(ticket.nextPollAfterMs !== undefined
          ? { nextPollAt: this.now() + ticket.nextPollAfterMs }
          : {}),
        now: this.now(),
      });
      if (ticket.state === "ready") this.deps.requestSchedulerWake?.();
      this.deps.logger.info(
        `off-peak re-take ticket task=${offPeakTaskId} ticket=${ticket.ticketId} state=${ticket.state}`,
      );
    } catch (error) {
      // Do not terminalize on ticket request failure (quota/network); leave the task queued so the next poll can request a ticket if none is valid.
      this.deps.logger.warn(`off-peak re-take ticket failed task=${offPeakTaskId}:`, error);
    }
  }

  // ---- offPeakTaskSync: batch polling + promotion writeback + settlement outbox ----

  startSync(): void {
    if (!this.syncStopped) return;
    this.syncStopped = false;
    // Scan for unsettled terminal tasks once at startup (host startup scan).
    this.ensureSyncScheduled(0);
  }

  stopSync(): void {
    this.syncStopped = true;
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
  }

  /** disposeServiceResources hook: clean up on host exit (stop polling + additional cleanup). */
  disposeAll(): void {
    this.stopSync();
    try {
      this.deps.onDispose?.();
    } catch (error) {
      this.deps.logger.warn("off-peak onDispose 清理失败:", error);
    }
  }

  private ensureSyncScheduled(delayMs: number): void {
    if (this.syncStopped) return;
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      void this.runSyncCycle();
    }, delayMs);
    // Node timers do not prevent process exit (the host lifecycle is managed externally).
    this.syncTimer.unref?.();
  }

  /** One sync cycle; explicit calls (tests/startup scan) are unaffected by stopSync, which controls only automatic rescheduling. */
  async runSyncCycle(): Promise<void> {
    if (this.syncRunning) return;
    this.syncRunning = true;
    let nextDelay = OFF_PEAK_SYNC_MAX_INTERVAL_MS;
    try {
      // 1) Retry settlement outbox items opportunistically (no additional timer).
      await this.flushSettleOutbox();
      // 2) Poll only when non-terminal tasks exist.
      const nonTerminal = await this.projectModelSelectionIssues(
        await this.deps.repo.listNonTerminal(),
      );
      const withTickets = nonTerminal.filter((task) => task.serverTicketId);
      // Re-request tickets for queued tasks without a ticket (left behind by an earlier failed request).
      for (const task of nonTerminal) {
        if (!task.serverTicketId && task.status === "queued") {
          await this.retakeTicket(task.offPeakTaskId);
        }
      }
      if (withTickets.length === 0 && nonTerminal.length === 0) {
        // No tasks: stop automatic rescheduling and wait for the next create/continue action.
        this.consecutiveSyncFailures = 0;
        return;
      }
      if (withTickets.length > 0) {
        const status = await this.deps.client.batchStatus(
          withTickets.map((task) => task.serverTicketId!),
        );
        let anyBecameSchedulable = false;
        for (const task of withTickets) {
          const entry = status.tickets.find((t) => t.ticketId === task.serverTicketId);
          if (!entry) continue;
          anyBecameSchedulable =
            (await this.applyTicketStatus(task, entry.state, entry.position)) ||
            anyBecameSchedulable;
        }
        if (anyBecameSchedulable) this.deps.requestSchedulerWake?.();
        if (status.nextPollAfterMs !== undefined) {
          nextDelay = status.nextPollAfterMs;
        } else {
          nextDelay = OFF_PEAK_SYNC_MIN_INTERVAL_MS;
        }
        this.emitChanged();
      } else {
        nextDelay = OFF_PEAK_SYNC_MIN_INTERVAL_MS;
      }
      this.consecutiveSyncFailures = 0;
    } catch (error) {
      // Retry polling with backoff after failure; do not dispatch during backoff, and do not affect running tasks.
      this.consecutiveSyncFailures += 1;
      nextDelay = Math.min(
        SYNC_FAILURE_BASE_MS * 2 ** Math.max(0, this.consecutiveSyncFailures - 1),
        OFF_PEAK_SYNC_MAX_INTERVAL_MS,
      );
      this.deps.logger.warn(
        `off-peak sync cycle failed (attempt ${this.consecutiveSyncFailures}):`,
        error,
      );
    } finally {
      this.syncRunning = false;
      const clamped = Math.min(
        Math.max(nextDelay, OFF_PEAK_SYNC_MIN_INTERVAL_MS),
        OFF_PEAK_SYNC_MAX_INTERVAL_MS,
      );
      this.ensureSyncScheduled(clamped);
    }
  }

  /** Map one ticket state across the two axes; return whether it became dispatchable. */
  private async applyTicketStatus(
    task: ZCodeOffPeakTask,
    state: string,
    position: number | undefined,
  ): Promise<boolean> {
    const now = this.now();
    switch (state) {
      case "ready": {
        const became = task.schedulable !== true && task.status === "queued";
        await this.deps.repo.updateSchedulingSnapshot(task.offPeakTaskId, {
          schedulable: true,
          queuePosition: position ?? null,
          nextPollAt: now + OFF_PEAK_SYNC_MIN_INTERVAL_MS,
          now,
        });
        return became;
      }
      case "queued":
        await this.deps.repo.updateSchedulingSnapshot(task.offPeakTaskId, {
          schedulable: false,
          queuePosition: position ?? null,
          now,
        });
        return false;
      case "active":
        // The client loop is running (or dispatch is in flight); the snapshot does not change the state machine, only clears the displayed position.
        await this.deps.repo.updateSchedulingSnapshot(task.offPeakTaskId, {
          queuePosition: null,
          now,
        });
        return false;
      case "expired": {
        // Any expired ticket requests a new ticket for the same task_id and rejoins the queue (consistent rule).
        // Exception: paused tasks wait for manual Continue; the 3h expiry for running tasks is handled by the messages 400/3102 path,
        // so this handles only invalid tickets in the queue.
        if (task.status === "queued") {
          await this.deps.repo.updateSchedulingSnapshot(task.offPeakTaskId, {
            schedulable: false,
            queuePosition: null,
            now,
          });
          await this.retakeTicket(task.offPeakTaskId);
        }
        return false;
      }
      case "settled":
      case "not_found":
      default:
        return false;
    }
  }

  /** Retry settlement for terminal tasks (idempotent; permanent failure is harmless because the server silently reclaims after timeout). */
  private async flushSettleOutbox(): Promise<void> {
    const unsettled = await this.deps.repo.listUnsettledTerminal();
    for (const task of unsettled) {
      await this.settleOne(task);
    }
  }

  private async settleOne(task: ZCodeOffPeakTask): Promise<void> {
    if (!task.serverTicketId) {
      // No ticket (mock-first or ticket was never requested): nothing can be settled, so mark it directly to prevent the outbox from stalling forever.
      await this.deps.repo.markSettled(task.offPeakTaskId, this.now());
      return;
    }
    try {
      await this.deps.client.settle(task.serverTicketId);
      await this.deps.repo.markSettled(task.offPeakTaskId, this.now());
    } catch (error) {
      if (error instanceof OffPeakServerError && error.httpStatus < 500) {
        // Treat 4xx responses (such as unknown ticket) as idempotent acknowledgments: the server has no such ticket left to release.
        await this.deps.repo.markSettled(task.offPeakTaskId, this.now());
        return;
      }
      // Network/5xx: keep it unsettled and retry opportunistically in the next cycle (no additional timer).
      this.deps.logger.warn(`off-peak settle failed ticket=${task.serverTicketId}:`, error);
    }
  }
}
