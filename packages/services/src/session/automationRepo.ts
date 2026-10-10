import {
  isTasksStorageMigrated,
  isTasksStoragePrepared,
} from "#src/session/tasksDatabase/prepared.js";
/* eslint-disable max-lines -- The automation repository centralizes the SQLite schema for automations / automation_runs,
   scheduler state-machine writes, and run history. Split by read/write responsibilities once these boundaries stabilize. */
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  AUTOMATION_CREATE_LIMIT,
  AUTOMATION_CREATE_LIMIT_ERROR_CODE,
  resolveWorkspaceKey,
  zcodeAutomationBotDeliveryTargetSchema,
  modelSelectionSchema,
  zcodeTaskModeSchema,
  type ZCodeAutomation,
  type ZCodeAutomationBotDeliveryTarget,
  type ZCodeAutomationCreateParams,
  type ZCodeAutomationDispatchStatus,
  type ZCodeAutomationLifecycleStatus,
  type ModelSelection,
  type ZCodeAutomationRun,
  type ZCodeAutomationRunDispatchStatus,
  type ZCodeAutomationRunOutcome,
  type ZCodeAutomationTrigger,
  type ZCodeAutomationUpdateParams,
} from "@zcode/shared";
import { getTasksIndexDatabasePath } from "#src/paths.js";
import { runTasksDatabaseMigrations } from "#src/session/tasksDatabase/migrations.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;

/** Backoff constants for dispatch failures. */
export const DISPATCH_RETRY_BASE_MS = 30_000;
export const DISPATCH_RETRY_CAP_MS = 15 * 60_000;
export const DISPATCH_MAX_ATTEMPTS = 5;
/** Claim timeout recovery: if running=1 remains unsettled beyond this duration, assume the owner crashed and allow a new claim. */
export const CLAIM_STALE_MS = 10 * 60_000;

/** The total exceeds the product creation limit; the error code is preserved in the message across RPC for UI detection. */
export class AutomationCreateLimitError extends Error {
  readonly code = AUTOMATION_CREATE_LIMIT_ERROR_CODE;

  constructor() {
    super(
      `[${AUTOMATION_CREATE_LIMIT_ERROR_CODE}] At most ${AUTOMATION_CREATE_LIMIT} automations may be retained. Delete an existing automation before creating another.`,
    );
    this.name = "AutomationCreateLimitError";
  }
}

interface AutomationRow {
  automation_id: string;
  title: string;
  cron_expr: string;
  prompt: string;
  model: string | null;
  provider: string | null;
  mode: string | null;
  thought_level: string | null;
  model_selection: string | null;
  workspace_key: string;
  workspace_path: string;
  workspace_identity: string | null;
  target_task_id: string | null;
  bot_delivery_target: string | null;
  location_kind: string;
  recurring: number;
  max_runs: number | null;
  end_at: number | null;
  schedule_rule: string | null;
  schedule_edited_by_user: number;
  run_count: number;
  scheduled_run_count: number;
  enabled: number;
  lifecycle_status: string;
  next_run_at: number | null;
  last_run_at: number | null;
  running: number;
  claimed_at: number | null;
  dispatch_status: string;
  dispatch_attempts: number;
  retry_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

interface AutomationRunRow {
  run_id: string;
  automation_id: string;
  workspace_key: string;
  scheduled_at: number | null;
  trigger: string;
  model_selection: string | null;
  dispatch_status: string;
  outcome: string | null;
  session_id: string | null;
  error: string | null;
  attempts: number;
  created_at: number;
  updated_at: number;
}

interface ClaimedManualAutomationRun {
  automation: ZCodeAutomation;
  run: ZCodeAutomationRun;
}

function rowToAutomation(row: AutomationRow): ZCodeAutomation {
  const modelSelection = readAutomationModelSelection(row);
  return {
    automationId: row.automation_id,
    title: row.title,
    cronExpr: row.cron_expr,
    prompt: row.prompt,
    ...(modelSelection ? { modelSelection } : {}),
    // Earlier versions wrote an empty string to mode, and the old reader cast it directly to the enum, causing
    // a single malformed row could fail protocol validation for the entire automation/list array. Treat legacy invalid values as unset.
    mode: normalizeAutomationMode(row.mode),
    workspaceKey: row.workspace_key,
    workspacePath: row.workspace_path,
    workspaceIdentity: row.workspace_identity ?? undefined,
    targetTaskId: row.target_task_id ?? undefined,
    locationKind: row.location_kind === "remote" ? "remote" : "local",
    recurring: row.recurring === 1,
    maxRuns: row.max_runs ?? undefined,
    endAt: row.end_at ?? undefined,
    scheduleRule: row.schedule_rule
      ? (JSON.parse(row.schedule_rule) as ZCodeAutomation["scheduleRule"])
      : undefined,
    ...(row.schedule_edited_by_user === 1 ? { scheduleEditedByUser: true } : {}),
    runCount: row.run_count,
    enabled: row.enabled === 1,
    lifecycleStatus: row.lifecycle_status as ZCodeAutomationLifecycleStatus,
    nextRunAt: row.next_run_at ?? undefined,
    lastRunAt: row.last_run_at ?? undefined,
    dispatchStatus: row.dispatch_status as ZCodeAutomationDispatchStatus,
    dispatchAttempts: row.dispatch_attempts,
    retryAt: row.retry_at ?? undefined,
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function readAutomationModelSelection(row: AutomationRow): ZCodeAutomation["modelSelection"] {
  // Legacy fields may be read only through the dedicated importer; a corrupt or explicitly cleared new field must not revive an old selection.
  return readSerializedModelSelection(row.model_selection);
}

function serializeAutomationModelSelection(
  selection: ZCodeAutomation["modelSelection"],
): string | null {
  if (!selection) return null;
  const options = selection.options;
  const parsed = modelSelectionSchema.parse({
    providerId: selection.providerId,
    modelId: selection.modelId,
    ...(options && Object.keys(options).length > 0 ? { options } : {}),
  });
  return JSON.stringify(parsed);
}

function normalizeAutomationMode(mode: string | null): ZCodeAutomation["mode"] | undefined {
  const parsed = zcodeTaskModeSchema.safeParse(mode);
  return parsed.success ? parsed.data : undefined;
}

function assertValidAutomationMode(mode: unknown): void {
  if (mode === undefined || mode === null) return;
  if (!zcodeTaskModeSchema.safeParse(mode).success) {
    // Supporting reads of legacy malformed data does not permit writing malformed data; the repository is the final persistence boundary when RPC is bypassed.
    throw new Error(`Invalid automation mode: ${String(mode)}`);
  }
}

function rowToRun(row: AutomationRunRow): ZCodeAutomationRun {
  const modelSelection = readSerializedModelSelection(row.model_selection);
  return {
    runId: row.run_id,
    automationId: row.automation_id,
    workspaceKey: row.workspace_key,
    scheduledAt: row.scheduled_at ?? undefined,
    trigger: row.trigger as ZCodeAutomationTrigger,
    ...(modelSelection ? { modelSelection } : {}),
    dispatchStatus: row.dispatch_status as ZCodeAutomationRunDispatchStatus,
    outcome: (row.outcome as ZCodeAutomationRunOutcome | null) ?? undefined,
    sessionId: row.session_id ?? undefined,
    error: row.error ?? undefined,
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function readSerializedModelSelection(value: string | null): ModelSelection | undefined {
  if (!value) return undefined;
  try {
    const parsed = modelSelectionSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Backoff retry time: now + min(BASE * 2^(attempts-1), CAP). */
export function computeRetryAt(now: number, attempts: number): number {
  const backoff = Math.min(
    DISPATCH_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1),
    DISPATCH_RETRY_CAP_MS,
  );
  return now + backoff;
}

/**
 * Automation storage repository: automations (definitions + scheduling state) and automation_runs (run history + runId idempotency ledger),
 * stored in the same tasks-index.sqlite database as the task index (WAL, safe across processes).
 *
 * The repository handles storage and atomic state transitions only; callers (scheduler / management layer) parse cron expressions and calculate next_run_at
 * with a cron library, then pass the values in. The repository does not interpret cron semantics.
 */
export class AutomationRepo {
  private db: DatabaseSyncInstance | null = null;
  private dbPath: string | null = null;
  private initializePromise: Promise<void> | null = null;
  // Do not resolve the database path from the process-wide _dataBaseDir (getTasksIndexDatabasePath):
  // Vitest's thread pool runs multiple test files concurrently in one process, and each file's setDataBaseDir(tempDir)
  // can overwrite the others' global value, causing the repository and raw SQL operations to write to the real ~/.zcode/v2 during a race (historical malformed
  // /tmp/ws data was polluted this way). Fix dbPath at construction time instead; tests inject a temporary database path,
  // while production falls back to getTasksIndexDatabasePath when none is provided, preserving compatibility.
  private readonly resolvedDbPath: string | null;

  constructor(
    dbPath?: string,
    private readonly startupBusyTimeoutMs = 5000,
  ) {
    this.resolvedDbPath = dbPath?.trim() || null;
  }

  private resolveDbPath(): string {
    return this.resolvedDbPath ?? getTasksIndexDatabasePath();
  }

  async ensureReady(): Promise<void> {
    const path = this.resolveDbPath();
    if (this.dbPath && this.dbPath !== path) {
      this.close();
    }
    if (!this.initializePromise) {
      this.initializePromise = this.initialize(path).catch((error) => {
        this.close();
        throw error;
      });
    }
    await this.initializePromise;
  }

  close(options?: { throwOnError?: boolean }): void {
    let closeError: unknown;
    try {
      this.db?.close();
    } catch (error) {
      closeError = error;
      // ignore
    }
    this.db = null;
    this.dbPath = null;
    this.initializePromise = null;
    if (options?.throwOnError && closeError) throw closeError;
  }

  private async initialize(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    if (!this.db) {
      this.db = new DatabaseSync(path);
      this.dbPath = path;
      this.db.exec(`PRAGMA busy_timeout = ${this.startupBusyTimeoutMs}`);
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = NORMAL");
    }
    // The Worker already performed the initial preparation for this path; the business connection must not repeat the full-table repair.
    if (isTasksStoragePrepared(path, this.db)) return;
    if (!isTasksStorageMigrated(path, this.db)) runTasksDatabaseMigrations(this.db);
  }

  private getDatabase(): DatabaseSyncInstance {
    if (!this.db) {
      throw new Error("AutomationRepo 未初始化：请先 await ensureReady()");
    }
    return this.db;
  }

  // When workspaceKey is provided, enforce ownership validation (write/single-read paths prevent cross-workspace access); when omitted, apply no filter,
  // for scheduler/host state machines that operate across workspaces.
  private getRow(automationId: string, workspaceKey?: string): AutomationRow | null {
    const row = this.getDatabase()
      .prepare(
        `SELECT * FROM automations
        WHERE automation_id = @id
          AND (@workspace_key IS NULL OR workspace_key = @workspace_key)`,
      )
      .get({ id: automationId, workspace_key: workspaceKey ?? null }) as AutomationRow | undefined;
    return row ?? null;
  }

  // ---- Management CRUD ----

  async create(
    params: ZCodeAutomationCreateParams,
    options: { nextRunAt: number | null; lifecycleStatus?: ZCodeAutomationLifecycleStatus },
  ): Promise<ZCodeAutomation> {
    assertValidAutomationMode(params.mode);
    await this.ensureReady();
    const now = Date.now();
    const automationId = `automation-${randomUUID()}`;
    const workspaceKey = resolveWorkspaceKey({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
    });
    const db = this.getDatabase();
    // Listing first in the UI or outside a transaction would let concurrent requests from multiple windows/CronCreate pass the stale count.
    // BEGIN IMMEDIATE serializes the all-status count check and insert so the local task index cannot exceed 20 entries.
    db.exec("BEGIN IMMEDIATE");
    try {
      const countRow = db.prepare("SELECT COUNT(*) AS count FROM automations").get() as {
        count: number | bigint;
      };
      if (Number(countRow.count) >= AUTOMATION_CREATE_LIMIT) {
        throw new AutomationCreateLimitError();
      }
      db.prepare(
        `INSERT INTO automations (
          automation_id, title, cron_expr, prompt, model, provider, model_selection,
          workspace_key, workspace_path, workspace_identity, target_task_id, bot_delivery_target, location_kind,
          recurring, max_runs, end_at, schedule_rule, schedule_edited_by_user,
          run_count, enabled, lifecycle_status,
          next_run_at, last_run_at, running, claimed_at,
          dispatch_status, dispatch_attempts, retry_at, last_error,
          mode, thought_level,
          created_at, updated_at
        ) VALUES (
          @automation_id, @title, @cron_expr, @prompt, @model, @provider, @model_selection,
          @workspace_key, @workspace_path, @workspace_identity, @target_task_id, @bot_delivery_target, 'local',
          @recurring, @max_runs, @end_at, @schedule_rule, 0,
          0, @enabled, @lifecycle_status,
          @next_run_at, NULL, 0, NULL,
          'idle', 0, NULL, NULL,
          @mode, @thought_level,
          @created_at, @updated_at
        )`,
      ).run({
        automation_id: automationId,
        title: params.title,
        cron_expr: params.cronExpr,
        prompt: params.prompt,
        model: null,
        provider: null,
        // Distinguish an explicit empty task config from an unmigrated SQL NULL; preserve the frozen semantics of SQL NULL for runs.
        model_selection: serializeAutomationModelSelection(params.modelSelection) ?? "null",
        mode: params.mode ?? null,
        thought_level: null,
        workspace_key: workspaceKey,
        workspace_path: params.workspacePath,
        workspace_identity: params.workspaceIdentity ?? null,
        target_task_id: params.targetTaskId ?? null,
        bot_delivery_target: params.botDeliveryTarget
          ? JSON.stringify(params.botDeliveryTarget)
          : null,
        recurring: params.recurring ? 1 : 0,
        max_runs: params.maxRuns ?? null,
        end_at: params.endAt ?? null,
        schedule_rule: params.scheduleRule ? JSON.stringify(params.scheduleRule) : null,
        enabled: options.lifecycleStatus === "completed" ? 0 : 1,
        lifecycle_status: options.lifecycleStatus ?? "active",
        next_run_at: options.nextRunAt,
        created_at: now,
        updated_at: now,
      });
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return rowToAutomation(this.getRow(automationId)!);
  }

  async list(scope?: {
    workspacePath?: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeAutomation[]> {
    await this.ensureReady();
    const workspaceKey = scope?.workspacePath
      ? resolveWorkspaceKey({
          workspacePath: scope.workspacePath,
          workspaceIdentity: scope.workspaceIdentity,
        })
      : null;
    const rows = this.getDatabase()
      .prepare(
        `SELECT * FROM automations
        WHERE (@workspace_key IS NULL OR workspace_key = @workspace_key)
        ORDER BY created_at DESC`,
      )
      .all({ workspace_key: workspaceKey }) as unknown as AutomationRow[];
    return rows.map(rowToAutomation);
  }

  /** Read specifically for first dispatch: lists may show unbound tasks, but dispatch must not treat a corrupt value as following the default. */
  async getModelSelectionForDispatch(
    automationId: string,
    workspaceKey: string,
  ): Promise<ModelSelection | undefined> {
    await this.ensureReady();
    const row = this.getRow(automationId, workspaceKey);
    if (!row) throw new Error("Automation 不存在或不属于当前工作区");
    const selection = readAutomationModelSelection(row);
    if (selection) return selection;
    // Migration writes the old default as JSON null. SQL NULL means missing config; do not use the old column to determine the execution default.
    const followsWorkspace = row.model_selection === "null";
    if (!followsWorkspace) throw new Error("Automation 模型选择不可用，请重新选择模型与思考档位");
    return undefined;
  }

  /**
   * Read the Bot callback target for background dispatch only; this internal source information is not part of the automation display model.
   */
  async getBotDeliveryTarget(
    automationId: string,
    workspaceKey?: string,
  ): Promise<ZCodeAutomationBotDeliveryTarget | undefined> {
    await this.ensureReady();
    const raw = this.getRow(automationId, workspaceKey)?.bot_delivery_target;
    if (!raw) return undefined;
    try {
      const parsed = zcodeAutomationBotDeliveryTargetSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : undefined;
    } catch {
      // Bug: malformed JSON from legacy/external writes must not break the task list or scheduler; treat invalid sources as unconfigured.
      return undefined;
    }
  }

  async hasTaskBinding(scope: {
    workspacePath: string;
    workspaceIdentity?: string;
    targetTaskId: string;
  }): Promise<boolean> {
    await this.ensureReady();
    const workspaceKey = resolveWorkspaceKey(scope);
    // CronCreate previously read and serialized the full list to determine a session's ownership, so any unrelated
    // malformed display field could fail this security query. Query only the authorization criterion and strictly constrain workspaceKey.
    const row = this.getDatabase()
      .prepare(
        `SELECT 1 AS bound FROM automations
        WHERE workspace_key = @workspace_key AND target_task_id = @target_task_id
        LIMIT 1`,
      )
      .get({ workspace_key: workspaceKey, target_task_id: scope.targetTaskId }) as
      | { bound: number }
      | undefined;
    return row !== undefined;
  }

  async get(automationId: string, workspaceKey?: string): Promise<ZCodeAutomation | null> {
    await this.ensureReady();
    const row = this.getRow(automationId, workspaceKey);
    return row ? rowToAutomation(row) : null;
  }

  /** maxRuns lifecycle counts scheduled dispatches only; manual runs are included only in the Card's cumulative display. */
  async getScheduledRunCount(automationId: string, workspaceKey?: string): Promise<number | null> {
    await this.ensureReady();
    const row = this.getRow(automationId, workspaceKey);
    return row?.scheduled_run_count ?? null;
  }

  /**
   * Edit definition fields. Callers pass a recomputed nextRunAt when cron_expr changes and a new lifecycleStatus
   * when recurring/max_runs changes; the repository does not interpret cron semantics. Clear retry state when cron_expr changes.
   */
  async update(
    automationId: string,
    params: ZCodeAutomationUpdateParams,
    options?: {
      nextRunAt?: number | null;
      lifecycleStatus?: ZCodeAutomationLifecycleStatus;
      resetRetry?: boolean;
    },
    workspaceKey?: string,
  ): Promise<ZCodeAutomation | null> {
    assertValidAutomationMode(params.mode);
    await this.ensureReady();
    const existing = this.getRow(automationId, workspaceKey);
    if (!existing) return null;
    const now = Date.now();
    const next: AutomationRow = {
      ...existing,
      title: params.title ?? existing.title,
      cron_expr: params.cronExpr ?? existing.cron_expr,
      prompt: params.prompt ?? existing.prompt,
      // Keep the three legacy columns only for rollback; edits such as title changes must not clear an unmigrated old selection or use it for new runtime reads.
      model: existing.model,
      provider: existing.provider,
      model_selection:
        params.modelSelection === undefined
          ? existing.model_selection
          : (serializeAutomationModelSelection(params.modelSelection ?? undefined) ?? "null"),
      mode: params.mode === undefined ? existing.mode : params.mode,
      thought_level: existing.thought_level,
      recurring: params.recurring === undefined ? existing.recurring : params.recurring ? 1 : 0,
      max_runs: params.maxRuns === undefined ? existing.max_runs : params.maxRuns,
      end_at: params.endAt === undefined ? existing.end_at : params.endAt,
      schedule_rule:
        params.scheduleRule === undefined
          ? existing.schedule_rule
          : params.scheduleRule
            ? JSON.stringify(params.scheduleRule)
            : null,
      schedule_edited_by_user:
        params.scheduleEditedByUser === undefined
          ? existing.schedule_edited_by_user
          : params.scheduleEditedByUser
            ? 1
            : 0,
      next_run_at: options?.nextRunAt === undefined ? existing.next_run_at : options.nextRunAt,
      lifecycle_status: options?.lifecycleStatus ?? existing.lifecycle_status,
      dispatch_attempts: options?.resetRetry ? 0 : existing.dispatch_attempts,
      retry_at: options?.resetRetry ? null : existing.retry_at,
      dispatch_status: options?.resetRetry ? "idle" : existing.dispatch_status,
      // enabled is derived entirely from lifecycleStatus: update it only when the caller explicitly changes lifecycle
      // (active enters scheduling=1; completed/failed/paused leave scheduling=0); otherwise preserve the existing value.
      // Fix: the old implementation incorrectly retained existing.enabled for completed/failed tasks, allowing a completed task to be claimed by claimDue.
      enabled: options?.lifecycleStatus
        ? options.lifecycleStatus === "active"
          ? 1
          : 0
        : existing.enabled,
      updated_at: now,
    };
    this.writeRow(next);
    return rowToAutomation(next);
  }

  async delete(automationId: string, workspaceKey?: string): Promise<boolean> {
    await this.ensureReady();
    const result = this.getDatabase()
      .prepare(
        `DELETE FROM automations
        WHERE automation_id = @id
          AND (@workspace_key IS NULL OR workspace_key = @workspace_key)`,
      )
      .run({ id: automationId, workspace_key: workspaceKey ?? null });
    return result.changes > 0;
  }

  /** Pause / resume. paused ↔ active; preserve next_run_at / run_count. */
  async setEnabled(automationId: string, enabled: boolean, workspaceKey?: string): Promise<void> {
    await this.ensureReady();
    this.getDatabase()
      .prepare(
        `UPDATE automations
        SET enabled = @enabled,
            lifecycle_status = @lifecycle_status,
            updated_at = @now
        WHERE automation_id = @id
          AND (@workspace_key IS NULL OR workspace_key = @workspace_key)`,
      )
      .run({
        id: automationId,
        enabled: enabled ? 1 : 0,
        lifecycle_status: enabled ? "active" : "paused",
        now: Date.now(),
        workspace_key: workspaceKey ?? null,
      });
  }

  /** Manually rerun a terminal task: return to active and clear counters/retry state; the caller supplies a recomputed nextRunAt. */
  async restart(
    automationId: string,
    options: { nextRunAt: number | null },
    workspaceKey?: string,
  ): Promise<void> {
    await this.ensureReady();
    this.getDatabase()
      .prepare(
        `UPDATE automations
        SET lifecycle_status = 'active',
            enabled = 1,
            run_count = 0,
            scheduled_run_count = 0,
            dispatch_attempts = 0,
            retry_at = NULL,
            dispatch_status = 'idle',
            running = 0,
            claimed_at = NULL,
            next_run_at = @next_run_at,
            last_error = NULL,
            updated_at = @now
        WHERE automation_id = @id
          AND (@workspace_key IS NULL OR workspace_key = @workspace_key)`,
      )
      .run({
        id: automationId,
        next_run_at: options.nextRunAt,
        now: Date.now(),
        workspace_key: workspaceKey ?? null,
      });
  }

  /**
   * Run immediately: record a manual run owned directly by the current host without changing the automation's cron schedule/lifecycle.
   * The direct-dispatch path previously did not acquire the automation running lock, so repeated clicks could dispatch concurrently to the same target task
   * and make model-config revisions conflict. Reuse the scheduler's single-flight lock and release it after host dispatch settles.
   * attempts=1 means the run has been handed to the direct dispatcher; the scheduler performs crash recovery only after the claim times out.
   */
  async runNow(
    automationId: string,
    options: { now: number },
    workspaceKey?: string,
  ): Promise<ClaimedManualAutomationRun | null> {
    await this.ensureReady();
    const db = this.getDatabase();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        `UPDATE automations
        SET running = 0, claimed_at = NULL
        WHERE running = 1 AND claimed_at IS NOT NULL AND claimed_at <= @stale`,
      ).run({ stale: options.now - CLAIM_STALE_MS });

      const row = this.getRow(automationId, workspaceKey);
      if (!row) {
        db.exec("COMMIT");
        return null;
      }

      const claimed = db
        .prepare(
          `UPDATE automations
          SET running = 1, claimed_at = @now, updated_at = @now
          WHERE automation_id = @id
            AND running = 0
            AND (@workspace_key IS NULL OR workspace_key = @workspace_key)`,
        )
        .run({
          id: automationId,
          now: options.now,
          workspace_key: workspaceKey ?? null,
        });
      if (claimed.changes !== 1) {
        db.exec("COMMIT");
        return null;
      }

      const runId = `${automationId}:manual:${randomUUID()}`;
      db.prepare(
        `INSERT INTO automation_runs (
          run_id, automation_id, workspace_key, scheduled_at, trigger,
          model_selection, dispatch_status, attempts, created_at, updated_at
        ) VALUES (
          @run_id, @automation_id, @workspace_key, @scheduled_at, 'manual',
          @model_selection, 'claimed', 1, @now, @now
        )`,
      ).run({
        run_id: runId,
        automation_id: automationId,
        workspace_key: row.workspace_key,
        scheduled_at: options.now,
        // The claim has not yet been resolved by the target Host; the original intent remains in automation, and the run is fixed at first dispatch.
        model_selection: null,
        now: options.now,
      });
      db.exec("COMMIT");
      return {
        automation: rowToAutomation({
          ...row,
          running: 1,
          claimed_at: options.now,
          updated_at: options.now,
        }),
        run: rowToRun({
          run_id: runId,
          automation_id: automationId,
          workspace_key: row.workspace_key,
          scheduled_at: options.now,
          trigger: "manual",
          model_selection: null,
          dispatch_status: "claimed",
          outcome: null,
          session_id: null,
          error: null,
          attempts: 1,
          created_at: options.now,
          updated_at: options.now,
        }),
      };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  // ---- Scheduling state machine ----

  /**
   * Claim due items under single-flight: atomically transition running=0→1. Also recover zombie claims whose claimed_at has expired.
   * Due status considers both next_run_at and retry_at; an item is due when either has expired.
   */
  async claimDue(now: number): Promise<ZCodeAutomation[]> {
    await this.ensureReady();
    const db = this.getDatabase();
    db.exec("BEGIN IMMEDIATE");
    try {
      // The end date is a schedule boundary; move expired tasks to a terminal state before normal cron or retry can claim them again.
      db.prepare(
        `UPDATE automations
        SET lifecycle_status = 'completed', enabled = 0, next_run_at = NULL,
            retry_at = NULL, running = 0, claimed_at = NULL, updated_at = @now
        WHERE enabled = 1 AND end_at IS NOT NULL AND end_at < @now`,
      ).run({ now });
      // First recover zombie claims (the owner crashed, leaving running=1 with an expired claimed_at).
      db.prepare(
        `UPDATE automations
        SET running = 0, claimed_at = NULL
        WHERE running = 1 AND claimed_at IS NOT NULL AND claimed_at <= @stale`,
      ).run({ stale: now - CLAIM_STALE_MS });
      // Claim conditions: enabled and not already in flight.
      // - With retry_at (transient backoff): claim only when retry_at expires and ignore next_run_at;
      //   otherwise a next_run_at still in the past would bypass backoff and retry on every tick. Keep next_run_at unchanged
      //   so retries reuse the same runId (the scheduler uses next_run_at as scheduledAt).
      // - Without retry_at: claim when next_run_at expires.
      const dueRows = db
        .prepare(
          `SELECT * FROM automations
          WHERE enabled = 1 AND running = 0
            AND (
              (retry_at IS NOT NULL AND retry_at <= @now)
              OR (retry_at IS NULL AND next_run_at IS NOT NULL AND next_run_at <= @now)
            )`,
        )
        .all({ now }) as unknown as AutomationRow[];
      const claimed: ZCodeAutomation[] = [];
      const claim = db.prepare(
        `UPDATE automations
        SET running = 1, claimed_at = @now, dispatch_status = 'claimed', updated_at = @now
        WHERE automation_id = @id AND running = 0`,
      );
      for (const row of dueRows) {
        const res = claim.run({ id: row.automation_id, now });
        if (res.changes === 1) {
          claimed.push(
            rowToAutomation({
              ...row,
              running: 1,
              claimed_at: now,
              dispatch_status: "claimed",
            }),
          );
        }
      }
      db.exec("COMMIT");
      return claimed;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Claim a manual run created by the UI's Run Now action.
   * Run Now must not change next_run_at, or it would alter the cron schedule; manual runs use automation_runs
   * as a queue and briefly acquire the automation running lock to avoid concurrent dispatch of the same task with a scheduled run.
   */
  async claimManualRuns(now: number): Promise<ClaimedManualAutomationRun[]> {
    await this.ensureReady();
    const db = this.getDatabase();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        `UPDATE automations
        SET running = 0, claimed_at = NULL
        WHERE running = 1 AND claimed_at IS NOT NULL AND claimed_at <= @stale`,
      ).run({ stale: now - CLAIM_STALE_MS });

      const rows = db
        .prepare(
          `SELECT
            a.automation_id AS a_automation_id,
            a.title AS a_title,
            a.cron_expr AS a_cron_expr,
            a.prompt AS a_prompt,
            a.model AS a_model,
            a.provider AS a_provider,
            a.model_selection AS a_model_selection,
            a.mode AS a_mode,
            a.thought_level AS a_thought_level,
            a.workspace_key AS a_workspace_key,
            a.workspace_path AS a_workspace_path,
            a.workspace_identity AS a_workspace_identity,
            a.target_task_id AS a_target_task_id,
            a.location_kind AS a_location_kind,
            a.recurring AS a_recurring,
            a.max_runs AS a_max_runs,
            a.end_at AS a_end_at,
            a.schedule_rule AS a_schedule_rule,
            a.schedule_edited_by_user AS a_schedule_edited_by_user,
            a.run_count AS a_run_count,
            a.scheduled_run_count AS a_scheduled_run_count,
            a.enabled AS a_enabled,
            a.lifecycle_status AS a_lifecycle_status,
            a.next_run_at AS a_next_run_at,
            a.last_run_at AS a_last_run_at,
            a.running AS a_running,
            a.claimed_at AS a_claimed_at,
            a.dispatch_status AS a_dispatch_status,
            a.dispatch_attempts AS a_dispatch_attempts,
            a.retry_at AS a_retry_at,
            a.last_error AS a_last_error,
            a.bot_delivery_target AS a_bot_delivery_target,
            a.created_at AS a_created_at,
            a.updated_at AS a_updated_at,
            r.run_id AS r_run_id,
            r.automation_id AS r_automation_id,
            r.workspace_key AS r_workspace_key,
            r.scheduled_at AS r_scheduled_at,
            r.trigger AS r_trigger,
            r.model_selection AS r_model_selection,
            r.dispatch_status AS r_dispatch_status,
            r.outcome AS r_outcome,
            r.session_id AS r_session_id,
            r.error AS r_error,
            r.attempts AS r_attempts,
            r.created_at AS r_created_at,
            r.updated_at AS r_updated_at
          FROM automation_runs r
          JOIN automations a ON a.automation_id = r.automation_id
          WHERE r.trigger = 'manual'
            AND r.dispatch_status = 'claimed'
            AND a.running = 0
            AND (r.attempts = 0 OR r.updated_at <= @stale)
          ORDER BY r.created_at ASC`,
        )
        .all({ stale: now - CLAIM_STALE_MS }) as unknown as Array<Record<string, unknown>>;

      const claimed: ClaimedManualAutomationRun[] = [];
      const claimAutomation = db.prepare(
        `UPDATE automations
        SET running = 1, claimed_at = @now, updated_at = @now
        WHERE automation_id = @id AND running = 0`,
      );
      const claimRun = db.prepare(
        `UPDATE automation_runs
        SET attempts = attempts + 1, updated_at = @now
        WHERE run_id = @run_id AND trigger = 'manual' AND dispatch_status = 'claimed'`,
      );

      for (const row of rows) {
        const automationId = row["a_automation_id"] as string;
        const runId = row["r_run_id"] as string;
        const res = claimAutomation.run({ id: automationId, now });
        if (res.changes !== 1) continue;
        claimRun.run({ run_id: runId, now });
        claimed.push({
          automation: rowToAutomation({
            automation_id: automationId,
            title: row["a_title"] as string,
            cron_expr: row["a_cron_expr"] as string,
            prompt: row["a_prompt"] as string,
            model: (row["a_model"] as string | null) ?? null,
            provider: (row["a_provider"] as string | null) ?? null,
            model_selection: (row["a_model_selection"] as string | null) ?? null,
            mode: (row["a_mode"] as string | null) ?? null,
            thought_level: (row["a_thought_level"] as string | null) ?? null,
            workspace_key: row["a_workspace_key"] as string,
            workspace_path: row["a_workspace_path"] as string,
            workspace_identity: (row["a_workspace_identity"] as string | null) ?? null,
            target_task_id: (row["a_target_task_id"] as string | null) ?? null,
            location_kind: row["a_location_kind"] as string,
            recurring: row["a_recurring"] as number,
            max_runs: (row["a_max_runs"] as number | null) ?? null,
            end_at: (row["a_end_at"] as number | null) ?? null,
            schedule_rule: (row["a_schedule_rule"] as string | null) ?? null,
            schedule_edited_by_user: row["a_schedule_edited_by_user"] as number,
            run_count: row["a_run_count"] as number,
            scheduled_run_count: row["a_scheduled_run_count"] as number,
            enabled: row["a_enabled"] as number,
            lifecycle_status: row["a_lifecycle_status"] as string,
            next_run_at: (row["a_next_run_at"] as number | null) ?? null,
            last_run_at: (row["a_last_run_at"] as number | null) ?? null,
            running: 1,
            claimed_at: now,
            dispatch_status: row["a_dispatch_status"] as string,
            dispatch_attempts: row["a_dispatch_attempts"] as number,
            retry_at: (row["a_retry_at"] as number | null) ?? null,
            last_error: (row["a_last_error"] as string | null) ?? null,
            bot_delivery_target: (row["a_bot_delivery_target"] as string | null) ?? null,
            created_at: row["a_created_at"] as number,
            updated_at: now,
          }),
          run: rowToRun({
            run_id: runId,
            automation_id: row["r_automation_id"] as string,
            workspace_key: row["r_workspace_key"] as string,
            scheduled_at: (row["r_scheduled_at"] as number | null) ?? null,
            trigger: row["r_trigger"] as string,
            model_selection: (row["r_model_selection"] as string | null) ?? null,
            dispatch_status: row["r_dispatch_status"] as string,
            outcome: (row["r_outcome"] as string | null) ?? null,
            session_id: (row["r_session_id"] as string | null) ?? null,
            error: (row["r_error"] as string | null) ?? null,
            attempts: (row["r_attempts"] as number) + 1,
            created_at: row["r_created_at"] as number,
            updated_at: now,
          }),
        });
      }
      db.exec("COMMIT");
      return claimed;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Settle a successful dispatch: increment both the display total and scheduled-dispatch count, write last_run_at, clear retry state, and reset running;
   * recurring tasks return to active (the caller supplies nextRunAt recalculated from the actual dispatch time);
   * finite tasks reaching max_runs become completed (enabled=0, next_run_at=NULL).
   */
  async markDispatched(
    automationId: string,
    options: { dispatchedAt: number; nextRunAt: number | null },
  ): Promise<void> {
    await this.ensureReady();
    const row = this.getRow(automationId);
    if (!row) return; // Deleted; discard the callback to avoid reviving it.
    const runCount = row.run_count + 1;
    const scheduledRunCount = row.scheduled_run_count + 1;
    // Finite tasks (recurring=0) become completed when they reach the limit. If max_runs is not explicitly set, treat them as one-time tasks (default limit 1);
    // otherwise a one-time cron would remain active and be triggered repeatedly forever. Use the separate
    // scheduled_run_count here; run_count also includes manual runs and is only for the Card's cumulative display.
    const reachedMax = row.recurring === 0 && scheduledRunCount >= (row.max_runs ?? 1);
    const reachedEnd = row.end_at !== null && (options.nextRunAt ?? Infinity) > row.end_at;
    this.getDatabase()
      .prepare(
        `UPDATE automations
        SET run_count = @run_count,
            scheduled_run_count = @scheduled_run_count,
            last_run_at = @dispatched_at,
            dispatch_status = 'dispatched',
            dispatch_attempts = 0,
            retry_at = NULL,
            last_error = NULL,
            running = 0,
            claimed_at = NULL,
            lifecycle_status = @lifecycle_status,
            enabled = @enabled,
            next_run_at = @next_run_at,
            updated_at = @now
        WHERE automation_id = @id`,
      )
      .run({
        id: automationId,
        run_count: runCount,
        scheduled_run_count: scheduledRunCount,
        dispatched_at: options.dispatchedAt,
        lifecycle_status: reachedMax || reachedEnd ? "completed" : "active",
        enabled: reachedMax || reachedEnd ? 0 : 1,
        next_run_at: reachedMax || reachedEnd ? null : options.nextRunAt,
        now: options.dispatchedAt,
      });
  }

  /**
   * Dispatch failure: transient errors increment attempts and set retry_at with backoff; after the limit, recurring tasks skip this occurrence and advance to the next
   * next_run_at (provided by the caller), while finite tasks become failed. Permanent errors immediately become terminal failed and disabled.
   */
  async markDispatchFailed(
    automationId: string,
    options: {
      failedAt: number;
      error: string;
      kind: "transient" | "permanent";
      /** The next normal next_run_at for a recurring task after transient retries are exhausted (recomputed by the caller). */
      nextRunAt?: number | null;
    },
  ): Promise<void> {
    await this.ensureReady();
    const row = this.getRow(automationId);
    if (!row) return;
    const db = this.getDatabase();
    const now = options.failedAt;
    if (options.kind === "permanent") {
      db.prepare(
        `UPDATE automations
        SET dispatch_status = 'failed_to_dispatch', lifecycle_status = 'failed',
            enabled = 0, running = 0, claimed_at = NULL,
            last_error = @error, updated_at = @now
        WHERE automation_id = @id`,
      ).run({ id: automationId, error: options.error, now });
      return;
    }
    const attempts = row.dispatch_attempts + 1;
    if (attempts >= DISPATCH_MAX_ATTEMPTS) {
      if (row.recurring === 1) {
        // Recurring task: skip this occurrence, advance to the next normal next_run_at, and clear retry state back to idle.
        db.prepare(
          `UPDATE automations
          SET dispatch_status = 'idle', dispatch_attempts = 0, retry_at = NULL,
              running = 0, claimed_at = NULL, next_run_at = @next_run_at,
              last_error = @error, updated_at = @now
          WHERE automation_id = @id`,
        ).run({
          id: automationId,
          next_run_at: options.nextRunAt ?? null,
          error: options.error,
          now,
        });
      } else {
        db.prepare(
          `UPDATE automations
          SET dispatch_status = 'failed_to_dispatch', lifecycle_status = 'failed',
              enabled = 0, running = 0, claimed_at = NULL,
              last_error = @error, updated_at = @now
          WHERE automation_id = @id`,
        ).run({ id: automationId, error: options.error, now });
      }
      return;
    }
    // Below the attempt limit: write the backoff retry_at and reset running for the next claim.
    db.prepare(
      `UPDATE automations
      SET dispatch_status = 'failed_to_dispatch', dispatch_attempts = @attempts,
          retry_at = @retry_at, running = 0, claimed_at = NULL,
          last_error = @error, updated_at = @now
      WHERE automation_id = @id`,
    ).run({
      id: automationId,
      attempts,
      retry_at: computeRetryAt(now, attempts),
      error: options.error,
      now,
    });
  }

  /** Release claims on shutdown/exit: clear running, preserve next_run_at, and do not record a failure or advance the schedule. */
  async releaseClaim(automationId: string): Promise<void> {
    await this.ensureReady();
    this.getDatabase()
      .prepare(
        `UPDATE automations
        SET running = 0, claimed_at = NULL, dispatch_status = 'idle', updated_at = @now
        WHERE automation_id = @id AND running = 1`,
      )
      .run({ id: automationId, now: Date.now() });
  }

  /** After a manual run ends, release only the single-flight lock; do not change automation scheduling state. */
  async releaseManualClaim(automationId: string, workspaceKey: string): Promise<void> {
    await this.ensureReady();
    this.getDatabase()
      .prepare(
        `UPDATE automations
        SET running = 0, claimed_at = NULL, updated_at = @now
        WHERE automation_id = @id
          AND workspace_key = @workspace_key
          AND running = 1`,
      )
      .run({ id: automationId, workspace_key: workspaceKey, now: Date.now() });
  }

  /** Renew the claim while the host owns a queued/running manual run so the scheduler does not reclaim a long-running task as a zombie. */
  async touchManualClaim(automationId: string, workspaceKey: string): Promise<void> {
    await this.ensureReady();
    this.getDatabase()
      .prepare(
        `UPDATE automations
        SET claimed_at = @now, updated_at = @now
        WHERE automation_id = @id
          AND workspace_key = @workspace_key
          AND running = 1`,
      )
      .run({ id: automationId, workspace_key: workspaceKey, now: Date.now() });
  }

  /**
   * Missed trigger window: atomically record a skipped run, advance next_run_at to the next future occurrence, and reset the claim.
   * Do not increment run_count. Used when scheduler startup/recovery finds next_run_at far earlier than now and compensates by skipping.
   * finalize=true is for strictly one-time tasks: if the target time has passed, make the task terminal (completed + disabled + cleared schedule);
   * do not infer later occurrences from the compatibility scheduleRule.
   */
  async skipAndReschedule(params: {
    automationId: string;
    runId: string;
    workspaceKey: string;
    scheduledAt: number | null;
    reason: string;
    nextRunAt: number | null;
    finalize?: boolean;
  }): Promise<void> {
    await this.ensureReady();
    const db = this.getDatabase();
    const now = Date.now();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        `INSERT INTO automation_runs (
          run_id, automation_id, workspace_key, scheduled_at, trigger,
          dispatch_status, error, attempts, created_at, updated_at
        ) VALUES (@run_id, @automation_id, @workspace_key, @scheduled_at, 'schedule', 'skipped', @reason, 0, @now, @now)
        ON CONFLICT(run_id) DO UPDATE SET
          dispatch_status = 'skipped', error = excluded.error, updated_at = excluded.updated_at`,
      ).run({
        run_id: params.runId,
        automation_id: params.automationId,
        workspace_key: params.workspaceKey,
        scheduled_at: params.scheduledAt,
        reason: params.reason,
        now,
      });
      if (params.finalize) {
        db.prepare(
          `UPDATE automations
          SET lifecycle_status = 'completed', enabled = 0, next_run_at = NULL,
              running = 0, claimed_at = NULL,
              dispatch_status = 'idle', dispatch_attempts = 0, retry_at = NULL,
              updated_at = @now
          WHERE automation_id = @id`,
        ).run({ id: params.automationId, now });
      } else {
        db.prepare(
          `UPDATE automations
          SET next_run_at = @next_run_at, running = 0, claimed_at = NULL,
              dispatch_status = 'idle', dispatch_attempts = 0, retry_at = NULL,
              updated_at = @now
          WHERE automation_id = @id`,
        ).run({ id: params.automationId, next_run_at: params.nextRunAt, now });
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  // ---- automation_runs history ----

  /** Ensure run history exists. Fallback for host outcome updates; do not increment attempts or interfere with scheduler retry counts. */
  async ensureRunClaimed(params: {
    runId: string;
    automationId: string;
    workspaceKey: string;
    scheduledAt: number | null;
    trigger: ZCodeAutomationTrigger;
  }): Promise<void> {
    await this.ensureReady();
    const now = Date.now();
    this.getDatabase()
      .prepare(
        `INSERT INTO automation_runs (
          run_id, automation_id, workspace_key, scheduled_at, trigger,
          dispatch_status, attempts, created_at, updated_at
        ) VALUES (@run_id, @automation_id, @workspace_key, @scheduled_at, @trigger, 'claimed', 0, @now, @now)
        ON CONFLICT(run_id) DO NOTHING`,
      )
      .run({
        run_id: params.runId,
        automation_id: params.automationId,
        workspace_key: params.workspaceKey,
        scheduled_at: params.scheduledAt,
        trigger: params.trigger,
        now,
      });
  }

  /** Upsert a run row when claiming (a run_id conflict means this retry already exists; do not create another row). */
  async upsertRunClaimed(params: {
    runId: string;
    automationId: string;
    workspaceKey: string;
    scheduledAt: number | null;
    trigger: ZCodeAutomationTrigger;
    modelSelection?: ModelSelection;
  }): Promise<void> {
    await this.ensureReady();
    const now = Date.now();
    this.getDatabase()
      .prepare(
        `INSERT INTO automation_runs (
          run_id, automation_id, workspace_key, scheduled_at, trigger,
          model_selection, dispatch_status, attempts, created_at, updated_at
        ) VALUES (@run_id, @automation_id, @workspace_key, @scheduled_at, @trigger, @model_selection, 'claimed', 0, @now, @now)
        ON CONFLICT(run_id) DO UPDATE SET
          dispatch_status = 'claimed',
          model_selection = COALESCE(automation_runs.model_selection, excluded.model_selection),
          outcome = NULL,
          error = NULL,
          attempts = attempts + 1,
          updated_at = excluded.updated_at`,
      )
      .run({
        run_id: params.runId,
        automation_id: params.automationId,
        workspace_key: params.workspaceKey,
        scheduled_at: params.scheduledAt,
        trigger: params.trigger,
        model_selection: serializeAutomationModelSelection(params.modelSelection),
        now,
      });
  }

  /**
   * Atomically pin the run Selection when the Select first creates a Submission; later calls can only read the pinned value.
   * The old dispatch path reread Host preferred on every transient retry, causing the same run to switch models.
   */
  async fixRunModelSelection(runId: string, selection: ModelSelection): Promise<ModelSelection> {
    await this.ensureReady();
    const db = this.getDatabase();
    db.prepare(
      `UPDATE automation_runs
       SET model_selection = COALESCE(model_selection, @model_selection), updated_at = @now
       WHERE run_id = @run_id`,
    ).run({
      run_id: runId,
      model_selection: serializeAutomationModelSelection(selection),
      now: Date.now(),
    });
    const row = db
      .prepare(`SELECT model_selection FROM automation_runs WHERE run_id = @run_id`)
      .get({ run_id: runId }) as Pick<AutomationRunRow, "model_selection"> | undefined;
    const fixed = row ? readSerializedModelSelection(row.model_selection) : undefined;
    if (!fixed) throw new Error(`Automation run 不存在或无法固定模型选择: ${runId}`);
    return fixed;
  }

  /** Write the dispatch result to the run (set session_id for dispatched / record error for failed_to_dispatch). */
  async markRunDispatch(params: {
    runId: string;
    dispatchStatus: ZCodeAutomationRunDispatchStatus;
    sessionId?: string | null;
    error?: string | null;
  }): Promise<void> {
    await this.ensureReady();
    this.getDatabase()
      .prepare(
        `UPDATE automation_runs
        SET dispatch_status = @dispatch_status,
            session_id = COALESCE(@session_id, session_id),
            error = @error,
            updated_at = @now
        WHERE run_id = @run_id`,
      )
      .run({
        run_id: params.runId,
        dispatch_status: params.dispatchStatus,
        session_id: params.sessionId ?? null,
        error: params.error ?? null,
        now: Date.now(),
      });
  }

  /**
   * Settle a manual run's first successful dispatch: atomically update the run ledger and cumulative run count.
   * Previously, manual runs updated only automation_runs, so the Card's runCount included only scheduled triggers.
   * The same runId may be settled more than once by the direct host, scheduler crash recovery, or a late callback, so use
   * the first transition of dispatch_status to dispatched as the idempotency boundary. Manual runs do not advance cron/maxRuns/lifecycle
   * or release the single-flight claim; the actual turn terminal outcome releases the claim.
   */
  async markManualRunDispatched(params: {
    runId: string;
    sessionId?: string | null;
    dispatchedAt: number;
  }): Promise<boolean> {
    await this.ensureReady();
    const db = this.getDatabase();
    db.exec("BEGIN IMMEDIATE");
    try {
      const run = db
        .prepare(
          `SELECT automation_id, workspace_key, dispatch_status
          FROM automation_runs
          WHERE run_id = @run_id AND trigger = 'manual'`,
        )
        .get({ run_id: params.runId }) as
        | Pick<AutomationRunRow, "automation_id" | "workspace_key" | "dispatch_status">
        | undefined;
      if (!run || run.dispatch_status === "dispatched") {
        db.exec("COMMIT");
        return false;
      }

      db.prepare(
        `UPDATE automation_runs
        SET dispatch_status = 'dispatched',
            session_id = COALESCE(@session_id, session_id),
            error = NULL,
            updated_at = @now
        WHERE run_id = @run_id AND trigger = 'manual' AND dispatch_status <> 'dispatched'`,
      ).run({
        run_id: params.runId,
        session_id: params.sessionId ?? null,
        now: params.dispatchedAt,
      });
      const automationUpdate = db
        .prepare(
          `UPDATE automations
          SET run_count = run_count + 1,
              last_run_at = @dispatched_at,
              updated_at = @now
          WHERE automation_id = @automation_id AND workspace_key = @workspace_key`,
        )
        .run({
          automation_id: run.automation_id,
          workspace_key: run.workspace_key,
          dispatched_at: params.dispatchedAt,
          now: params.dispatchedAt,
        });
      db.exec("COMMIT");
      return automationUpdate.changes > 0;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Write the run outcome from the session runtime (running / succeeded / failed / stopped). */
  async markRunOutcome(
    runId: string,
    outcome: ZCodeAutomationRunOutcome,
    error?: string,
  ): Promise<void> {
    await this.ensureReady();
    this.getDatabase()
      .prepare(
        `UPDATE automation_runs
        SET outcome = CASE
              WHEN @outcome = 'running' AND outcome IS NOT NULL AND outcome <> 'running' THEN outcome
              ELSE @outcome
            END,
            error = CASE
              WHEN @outcome = 'running' AND outcome IS NOT NULL AND outcome <> 'running' THEN error
              ELSE COALESCE(@error, error)
            END,
            updated_at = @now
        WHERE run_id = @run_id`,
      )
      .run({ run_id: runId, outcome, error: error ?? null, now: Date.now() });
  }

  /** Missed trigger window: record a skipped run (session_id=null) without incrementing run_count. */
  async recordSkippedRun(params: {
    runId: string;
    automationId: string;
    workspaceKey: string;
    scheduledAt: number | null;
    trigger: ZCodeAutomationTrigger;
    reason: string;
  }): Promise<void> {
    await this.ensureReady();
    const now = Date.now();
    this.getDatabase()
      .prepare(
        `INSERT INTO automation_runs (
          run_id, automation_id, workspace_key, scheduled_at, trigger,
          dispatch_status, error, attempts, created_at, updated_at
        ) VALUES (@run_id, @automation_id, @workspace_key, @scheduled_at, @trigger, 'skipped', @reason, 0, @now, @now)
        ON CONFLICT(run_id) DO UPDATE SET
          dispatch_status = 'skipped', error = excluded.error, updated_at = excluded.updated_at`,
      )
      .run({
        run_id: params.runId,
        automation_id: params.automationId,
        workspace_key: params.workspaceKey,
        scheduled_at: params.scheduledAt,
        trigger: params.trigger,
        reason: params.reason,
        now,
      });
  }

  async listRuns(automationId: string, workspaceKey?: string): Promise<ZCodeAutomationRun[]> {
    await this.ensureReady();
    const rows = this.getDatabase()
      .prepare(
        `SELECT * FROM automation_runs
        WHERE automation_id = @id
          AND (@workspace_key IS NULL OR workspace_key = @workspace_key)
        ORDER BY created_at DESC`,
      )
      .all({
        id: automationId,
        workspace_key: workspaceKey ?? null,
      }) as unknown as AutomationRunRow[];
    return rows.map(rowToRun);
  }

  async getRun(runId: string): Promise<ZCodeAutomationRun | null> {
    await this.ensureReady();
    const row = this.getDatabase()
      .prepare(`SELECT * FROM automation_runs WHERE run_id = @run_id`)
      .get({ run_id: runId }) as AutomationRunRow | undefined;
    return row ? rowToRun(row) : null;
  }

  async deleteRun(runId: string, workspaceKey?: string): Promise<void> {
    await this.ensureReady();
    this.getDatabase()
      .prepare(
        `DELETE FROM automation_runs
        WHERE run_id = @run_id
          AND (@workspace_key IS NULL OR workspace_key = @workspace_key)`,
      )
      .run({ run_id: runId, workspace_key: workspaceKey ?? null });
  }

  /** Retention policy: delete run history older than maxAgeMs to prevent unbounded growth. */
  async pruneRuns(maxAgeMs: number): Promise<number> {
    await this.ensureReady();
    const res = this.getDatabase()
      .prepare(`DELETE FROM automation_runs WHERE created_at < ?`)
      .run(Date.now() - maxAgeMs);
    return Number(res.changes ?? 0);
  }

  private writeRow(row: AutomationRow): void {
    this.getDatabase()
      .prepare(
        `UPDATE automations SET
          title = @title, cron_expr = @cron_expr, prompt = @prompt, model = @model, provider = @provider,
          model_selection = @model_selection,
          mode = @mode, thought_level = @thought_level,
          recurring = @recurring, max_runs = @max_runs, end_at = @end_at,
          schedule_rule = @schedule_rule,
          schedule_edited_by_user = @schedule_edited_by_user,
          next_run_at = @next_run_at, lifecycle_status = @lifecycle_status,
          dispatch_attempts = @dispatch_attempts, retry_at = @retry_at, dispatch_status = @dispatch_status,
          enabled = @enabled, updated_at = @updated_at
        WHERE automation_id = @automation_id`,
      )
      .run({
        automation_id: row.automation_id,
        title: row.title,
        cron_expr: row.cron_expr,
        prompt: row.prompt,
        model: row.model,
        provider: row.provider,
        model_selection: row.model_selection,
        mode: row.mode,
        thought_level: row.thought_level,
        recurring: row.recurring,
        max_runs: row.max_runs,
        end_at: row.end_at,
        schedule_rule: row.schedule_rule,
        schedule_edited_by_user: row.schedule_edited_by_user,
        next_run_at: row.next_run_at,
        lifecycle_status: row.lifecycle_status,
        dispatch_attempts: row.dispatch_attempts,
        retry_at: row.retry_at,
        dispatch_status: row.dispatch_status,
        enabled: row.enabled,
        updated_at: row.updated_at,
      });
  }
}
