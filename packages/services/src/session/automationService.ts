import type {
  ZCodeAutomation,
  ZCodeAutomationCreateParams,
  ZCodeAutomationRun,
  ZCodeAutomationScheduleRule,
  ZCodeAutomationUpdateParams,
} from "@zcode/shared";
import { resolveWorkspaceKey } from "@zcode/shared";
import { AutomationRepo } from "#src/session/automationRepo.js";
import {
  assertValidAutomationIntervalCarrier,
  forceIntervalCarrierRecurring,
} from "#src/session/automationIntervalCarrier.js";
export { InvalidAutomationIntervalCarrierError } from "#src/session/automationIntervalCarrier.js";
import {
  buildIntervalScheduleRule,
  buildRelativeDelaySchedule,
  computeInitialAutomationNextRunAt,
  computeAutomationNextRunAt,
  inferMinuteIntervalScheduleRule,
  isValidCronExpr,
  scheduleRuleDefinition,
} from "#src/session/automationCron.js";

/** Workspace ownership for write/single-read operations; used to enforce cross-workspace isolation. */
interface AutomationWorkspaceScope {
  workspacePath: string;
  workspaceIdentity?: string;
}

/** Map scope to workspaceKey; defaults to undefined (no ownership filter, for cross-workspace scheduler/host use). */
function resolveScopeKey(scope?: AutomationWorkspaceScope): string | undefined {
  if (!scope?.workspacePath) return undefined;
  return resolveWorkspaceKey({
    workspacePath: scope.workspacePath,
    workspaceIdentity: scope.workspaceIdentity,
  });
}

/** Invalid cron expression error (provides displayable information for the management layer to return to the UI). */
export class InvalidCronExprError extends Error {
  constructor(cronExpr: string) {
    super(`非法的 cron 表达式：${cronExpr}`);
    this.name = "InvalidCronExprError";
  }
}

/** Invalid finite-run update error; prevents writing contradictory state and incorrectly ending a task that is still running. */
class InvalidAutomationMaxRunsUpdateError extends Error {
  constructor(message = "清空 maxRuns 时必须在同一次更新中设置 recurring=true") {
    super(message);
    this.name = "InvalidAutomationMaxRunsUpdateError";
  }
}

/** Invalid custom schedule rule; a rule must pass domain validation before it can be written to the internal task store. */
class InvalidAutomationScheduleRuleError extends Error {
  constructor(message: string) {
    super(`非法的定时任务调度规则：${message}`);
    this.name = "InvalidAutomationScheduleRuleError";
  }
}

/** Relative delays are for one-time tasks only; the service generates the schedule rule from its actual clock. */
class InvalidAutomationRelativeDelayError extends Error {
  constructor(message: string) {
    super(`非法的相对时间定时任务：${message}`);
    this.name = "InvalidAutomationRelativeDelayError";
  }
}

const MAX_MONTHLY_AUTOMATION_SCHEDULE_INTERVAL = 1_200;
const AUTOMATION_SCHEDULE_RULE_UNITS = new Set([
  "minute",
  "hourly",
  "daily",
  "weekly",
  "monthly",
  "yearly",
]);

function hasOnlyIntegersInRange(values: number[] | undefined, min: number, max: number): boolean {
  return Boolean(
    values?.length &&
    values.every((value) => Number.isInteger(value) && value >= min && value <= max),
  );
}

function assertValidAutomationScheduleRule(rule: ZCodeAutomationScheduleRule): void {
  if (!AUTOMATION_SCHEDULE_RULE_UNITS.has(rule.unit)) {
    throw new InvalidAutomationScheduleRuleError("unit 不受支持");
  }
  if (!Number.isInteger(rule.interval) || rule.interval < 1) {
    throw new InvalidAutomationScheduleRuleError("interval 必须是正整数");
  }
  if (rule.unit === "monthly" && rule.interval > MAX_MONTHLY_AUTOMATION_SCHEDULE_INTERVAL) {
    throw new InvalidAutomationScheduleRuleError(
      `monthly interval 不能超过 ${MAX_MONTHLY_AUTOMATION_SCHEDULE_INTERVAL}`,
    );
  }
  if (!Number.isInteger(rule.hour) || rule.hour < 0 || rule.hour > 23) {
    throw new InvalidAutomationScheduleRuleError("hour 必须是 0-23 的整数");
  }
  if (!Number.isInteger(rule.minute) || rule.minute < 0 || rule.minute > 59) {
    throw new InvalidAutomationScheduleRuleError("minute 必须是 0-59 的整数");
  }
  if (
    rule.monthlyMode !== undefined &&
    rule.monthlyMode !== "date" &&
    rule.monthlyMode !== "weekday"
  ) {
    throw new InvalidAutomationScheduleRuleError("monthlyMode 不受支持");
  }
  if (rule.weekdays && !hasOnlyIntegersInRange(rule.weekdays, 0, 6)) {
    throw new InvalidAutomationScheduleRuleError("weekdays 必须是 0-6 的非空整数数组");
  }
  if (rule.unit === "weekly" && !hasOnlyIntegersInRange(rule.weekdays, 0, 6)) {
    throw new InvalidAutomationScheduleRuleError("weekly 规则必须包含有效的 weekdays");
  }
  if (rule.unit === "monthly") {
    if (rule.monthlyMode === "weekday" && !hasOnlyIntegersInRange(rule.weekdays, 0, 6)) {
      throw new InvalidAutomationScheduleRuleError("monthly weekday 规则必须包含有效的 weekdays");
    }
    if (rule.monthlyMode !== "weekday" && !hasOnlyIntegersInRange(rule.monthDays, 1, 31)) {
      throw new InvalidAutomationScheduleRuleError("monthly date 规则必须包含有效的 monthDays");
    }
  }
  if (rule.months && !hasOnlyIntegersInRange(rule.months, 1, 12)) {
    throw new InvalidAutomationScheduleRuleError("months 必须是 1-12 的非空整数数组");
  }
  if (rule.monthDays && !hasOnlyIntegersInRange(rule.monthDays, 1, 31)) {
    throw new InvalidAutomationScheduleRuleError("monthDays 必须是 1-31 的非空整数数组");
  }
}

/**
 * Automation management service: wraps AutomationRepo and owns cron semantics (validation/next-time calculation) and lifecycle recalculation.
 * The repository only stores data; this service handles cron-related business rules such as calculating next_run_at on create,
 * recalculating after cron_expr changes, recalculating lifecycle after recurring/max_runs changes, and recalculating on restart,
 * for use by the UI management surface and RPC.
 */
export class AutomationService {
  constructor(private readonly repo: AutomationRepo = new AutomationRepo()) {}

  async create(params: ZCodeAutomationCreateParams): Promise<ZCodeAutomation> {
    const createdAt = Date.now();
    const relativeDelayMinutes = params.relativeDelayMinutes;
    if (
      relativeDelayMinutes !== undefined &&
      (!Number.isInteger(relativeDelayMinutes) ||
        relativeDelayMinutes < 1 ||
        relativeDelayMinutes > 525_600)
    ) {
      throw new InvalidAutomationRelativeDelayError("delayMinutes 必须是 1-525600 的整数");
    }
    if (relativeDelayMinutes !== undefined && params.recurring) {
      throw new InvalidAutomationRelativeDelayError("相对延迟任务必须设置 recurring=false");
    }
    if (relativeDelayMinutes !== undefined && params.maxRuns !== undefined) {
      throw new InvalidAutomationRelativeDelayError("相对延迟任务固定只运行一次，不能设置 maxRuns");
    }
    if (relativeDelayMinutes !== undefined && params.scheduleRule) {
      throw new InvalidAutomationRelativeDelayError("不能同时提交 delayMinutes 和 scheduleRule");
    }
    const intervalUnit = params.intervalUnit;
    const interval = params.interval;
    assertValidAutomationIntervalCarrier({
      intervalUnit,
      interval,
      scheduleRule: params.scheduleRule,
      relativeDelayMinutes,
      recurring: params.recurring,
      maxRuns: params.maxRuns,
    });
    // The carrier is used only for this normalization and must not be passed to the repository as an undefined persisted field.
    const {
      relativeDelayMinutes: _relativeDelayMinutes,
      intervalUnit: _intervalUnit,
      interval: _interval,
      ...persistedParams
    } = params;
    // When the model knows only the date, it guesses the current time and may turn "in 3 minutes" into two hours later or a time in the past.
    // The domain layer must anchor relative times to the actual Date.now(); do not trust the model's conversion to an absolute cron.
    const relativeNormalizedParams =
      relativeDelayMinutes === undefined
        ? persistedParams
        : {
            ...persistedParams,
            ...buildRelativeDelaySchedule(relativeDelayMinutes, createdAt),
            recurring: false,
          };
    // Normalize the session-side custom recurrence carrier: combine intervalUnit+interval with compatible cron fields into the authoritative scheduleRule.
    // scheduleRule carries the actual interval; cronExpr is for display only. Anchor it to the service's actual creation time, as with relativeDelay.
    const normalizedParams =
      intervalUnit !== undefined && interval !== undefined
        ? {
            ...relativeNormalizedParams,
            // The carrier must recur forever so older clients/internal calls cannot persist contradictory state that completes after the first dispatch.
            recurring: true,
            maxRuns: undefined,
            scheduleRule: buildIntervalScheduleRule(
              intervalUnit,
              interval,
              relativeNormalizedParams.cronExpr,
              createdAt,
            ),
          }
        : relativeNormalizedParams;
    if (!isValidCronExpr(normalizedParams.cronExpr)) {
      throw new InvalidCronExprError(normalizedParams.cronExpr);
    }
    // computeScheduleRuleNextRunAt used to silently correct interval=0 and return null for excessively large intervals,
    // allowing invalid rules to be persisted as active. Reject them in the domain layer before writing; do not rely on the UI selector as a fallback.
    if (normalizedParams.scheduleRule) {
      assertValidAutomationScheduleRule(normalizedParams.scheduleRule);
    }
    // A standard `*/N` cron aligns to wall-clock intervals, so creating "every 10 minutes" at 11:46 would trigger early at 11:50.
    // Product semantics count from the creation time, so add a minute anchor in the domain layer when there is no explicit rule.
    const scheduleRule = normalizedParams.scheduleRule
      ? { ...normalizedParams.scheduleRule, anchorAt: createdAt }
      : inferMinuteIntervalScheduleRule(normalizedParams.cronExpr, createdAt);
    const createParams = scheduleRule ? { ...normalizedParams, scheduleRule } : normalizedParams;
    // Five-field cron has no year; if a one-time fixed month/day task just misses its target minute during creation,
    // ordinary nextRun rolls it into next year. On the initial calculation, compensate only for a cross-minute error under one minute; reject stale targets before writing.
    const nextRunAt = computeInitialAutomationNextRunAt(createParams, createdAt);
    const endedBeforeFirstRun =
      createParams.endAt !== undefined && (nextRunAt ?? Infinity) > createParams.endAt;
    return this.repo.create(createParams, {
      nextRunAt: endedBeforeFirstRun ? null : nextRunAt,
      ...(endedBeforeFirstRun ? { lifecycleStatus: "completed" as const } : {}),
    });
  }

  async list(scope?: {
    workspacePath?: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeAutomation[]> {
    return this.repo.list(scope);
  }

  async hasTaskBinding(scope: {
    workspacePath: string;
    workspaceIdentity?: string;
    targetTaskId: string;
  }): Promise<boolean> {
    return this.repo.hasTaskBinding(scope);
  }

  async get(
    automationId: string,
    scope?: AutomationWorkspaceScope,
  ): Promise<ZCodeAutomation | null> {
    return this.repo.get(automationId, resolveScopeKey(scope));
  }

  async update(
    automationId: string,
    params: ZCodeAutomationUpdateParams,
    scope?: AutomationWorkspaceScope,
  ): Promise<ZCodeAutomation | null> {
    const workspaceKey = resolveScopeKey(scope);
    const existing = await this.repo.get(automationId, workspaceKey);
    if (!existing) return null;

    if (params.scheduleRule) assertValidAutomationScheduleRule(params.scheduleRule);

    // Validate custom recurrence carriers from the session side: intervalUnit+interval must be paired, limited to 1–200, and mutually exclusive with a directly supplied scheduleRule.
    const { intervalUnit, interval, scheduleRule: directScheduleRule, ...restParams } = params;
    // `undefined` means no change, while `null` explicitly clears an existing rule; do not conflate them during destructuring.
    // Merging with `??` would treat `scheduleRule: null` as omitted, preventing users from restoring ordinary cron scheduling.
    const hasDirectScheduleRule = directScheduleRule !== undefined;
    assertValidAutomationIntervalCarrier({
      intervalUnit,
      interval,
      scheduleRule: hasDirectScheduleRule ? directScheduleRule : undefined,
      recurring: restParams.recurring,
      maxRuns: restParams.maxRuns,
    });
    const hasIntervalCarrier = intervalUnit !== undefined && interval !== undefined;

    // Converting maxRuns=null to undefined and then calculating with the one-time task limit of 1
    // would silently mark an already-run finite task completed. Clearing the limit must be committed atomically with switching to an infinite loop.
    if (!hasIntervalCarrier && restParams.maxRuns === null && restParams.recurring !== true) {
      throw new InvalidAutomationMaxRunsUpdateError();
    }

    const nextRecurring = hasIntervalCarrier ? true : (restParams.recurring ?? existing.recurring);
    if (nextRecurring && typeof restParams.maxRuns === "number") {
      throw new InvalidAutomationMaxRunsUpdateError("无限循环任务不能设置有限次数 maxRuns");
    }

    // If a finite task submits only recurring=true, repo.update preserves the old maxRuns,
    // creating a contradictory hidden state of "infinite loop + finite limit". Set null in the domain layer to support old clients and atomically clear the old limit;
    // also repair existing data with the same issue.
    const normalizedParams: ZCodeAutomationUpdateParams = hasIntervalCarrier
      ? forceIntervalCarrierRecurring(restParams)
      : nextRecurring &&
          restParams.maxRuns === undefined &&
          (restParams.recurring === true || existing.maxRuns !== undefined)
        ? { ...restParams, maxRuns: null }
        : restParams;

    const options: {
      nextRunAt?: number | null;
      lifecycleStatus?: ZCodeAutomation["lifecycleStatus"];
      resetRetry?: boolean;
    } = {};

    // Update cron_expr: validate, recalculate next_run_at from now, and clear retry state.
    const cronChanged =
      normalizedParams.cronExpr !== undefined && normalizedParams.cronExpr !== existing.cronExpr;
    if (normalizedParams.cronExpr !== undefined && !isValidCronExpr(normalizedParams.cronExpr)) {
      throw new InvalidCronExprError(normalizedParams.cronExpr);
    }
    const updatedAt = Date.now();
    const effectiveCron = normalizedParams.cronExpr ?? existing.cronExpr;
    // Normalize the long-interval carrier from the session side: combine intervalUnit+interval and the compatible cron into the authoritative scheduleRule.
    // Carrier submissions must reset the anchor (anchorAt=updatedAt); the later explicitScheduleRule check to "preserve the old anchor if the rule is unchanged"
    // does not apply to carriers—submitting a carrier means the user wants a new interval, so always start timing from this save.
    const carrierScheduleRule = hasIntervalCarrier
      ? buildIntervalScheduleRule(intervalUnit, interval, effectiveCron, updatedAt)
      : undefined;
    const effectiveDirectScheduleRule = hasDirectScheduleRule
      ? directScheduleRule
      : carrierScheduleRule;
    const normalizedWithSchedule: ZCodeAutomationUpdateParams =
      effectiveDirectScheduleRule !== undefined
        ? { ...normalizedParams, scheduleRule: effectiveDirectScheduleRule }
        : normalizedParams;
    if (effectiveDirectScheduleRule) {
      assertValidAutomationScheduleRule(effectiveDirectScheduleRule);
    }
    const explicitScheduleRule = effectiveDirectScheduleRule
      ? {
          ...effectiveDirectScheduleRule,
          // Preserve the existing anchor when saving other fields without changing the rule; restart timing from this save only when the frequency changes.
          anchorAt:
            existing.scheduleRule &&
            scheduleRuleDefinition(existing.scheduleRule) ===
              scheduleRuleDefinition(effectiveDirectScheduleRule)
              ? existing.scheduleRule.anchorAt
              : updatedAt,
        }
      : effectiveDirectScheduleRule;
    // If cron changes without an explicit scheduleRule, the old rule must not keep overriding the new cron; minute intervals are re-anchored to this
    // update time, while other cron expressions clear the old rule and return to calendar-cron semantics.
    const inferredScheduleRule =
      cronChanged && effectiveDirectScheduleRule === undefined
        ? inferMinuteIntervalScheduleRule(effectiveCron, updatedAt)
        : undefined;
    const effectiveScheduleRule =
      effectiveDirectScheduleRule === undefined
        ? cronChanged
          ? inferredScheduleRule
          : existing.scheduleRule
        : (explicitScheduleRule ?? undefined);
    const updateParams =
      cronChanged && effectiveDirectScheduleRule === undefined
        ? { ...normalizedWithSchedule, scheduleRule: inferredScheduleRule ?? null }
        : effectiveDirectScheduleRule === undefined
          ? normalizedWithSchedule
          : { ...normalizedWithSchedule, scheduleRule: explicitScheduleRule ?? null };
    if (
      cronChanged ||
      normalizedParams.endAt !== undefined ||
      effectiveDirectScheduleRule !== undefined
    ) {
      options.nextRunAt = computeAutomationNextRunAt(
        {
          cronExpr: effectiveCron,
          scheduleRule: effectiveScheduleRule,
        },
        updatedAt,
      );
      options.resetRetry = true;
    }

    const effectiveEndAt =
      normalizedParams.endAt === undefined ? existing.endAt : (normalizedParams.endAt ?? undefined);
    if (
      effectiveEndAt !== undefined &&
      (options.nextRunAt ?? existing.nextRunAt ?? Infinity) > effectiveEndAt
    ) {
      options.nextRunAt = null;
      options.lifecycleStatus = "completed";
    } else if (
      normalizedParams.endAt !== undefined &&
      (existing.lifecycleStatus === "completed" || existing.lifecycleStatus === "failed")
    ) {
      options.lifecycleStatus = "active";
    }

    // Update recurring / max_runs: recalculate the lifecycle.
    if (normalizedParams.recurring !== undefined || normalizedParams.maxRuns !== undefined) {
      const nextMaxRuns =
        normalizedParams.maxRuns === undefined
          ? existing.maxRuns
          : (normalizedParams.maxRuns ?? undefined);
      // runCount is the cumulative number displayed on the Card and includes manual runs; using it to recalculate a finite schedule
      // could mark the task completed early when the user edits maxRuns after any manual run.
      const scheduledRunCount = await this.repo.getScheduledRunCount(automationId, workspaceKey);
      if (scheduledRunCount === null) return null;
      // Match markDispatched: a finite task without an explicit max_runs is treated as one-time (limit 1).
      const reachedMax = !nextRecurring && scheduledRunCount >= (nextMaxRuns ?? 1);
      if (reachedMax) {
        options.lifecycleStatus = "completed";
      } else if (
        existing.lifecycleStatus === "completed" ||
        existing.lifecycleStatus === "failed"
      ) {
        // Was terminal, but became runnable after editing → reactivate and recalculate next_run_at.
        options.lifecycleStatus = "active";
        if (options.nextRunAt === undefined) {
          options.nextRunAt = computeAutomationNextRunAt(
            {
              cronExpr: effectiveCron,
              scheduleRule: effectiveScheduleRule,
            },
            updatedAt,
          );
        }
      }
    }

    return this.repo.update(automationId, updateParams, options, workspaceKey);
  }

  async delete(automationId: string, scope?: AutomationWorkspaceScope): Promise<boolean> {
    return this.repo.delete(automationId, resolveScopeKey(scope));
  }

  /** Pause / resume. */
  async setEnabled(
    automationId: string,
    enabled: boolean,
    scope?: AutomationWorkspaceScope,
  ): Promise<void> {
    return this.repo.setEnabled(automationId, enabled, resolveScopeKey(scope));
  }

  /** Manually rerun a failed task: set it to active, clear counters, and recalculate the next time from cron. */
  async restart(automationId: string, scope?: AutomationWorkspaceScope): Promise<void> {
    const workspaceKey = resolveScopeKey(scope);
    const existing = await this.repo.get(automationId, workspaceKey);
    if (!existing) return;
    // completed is the terminal state after a finite schedule runs out and must not be revived by an old UI/RPC restart;
    // only failed represents a recoverable error that allows the user to manually reschedule the next run.
    if (existing.lifecycleStatus !== "failed") return;
    const nextRunAt = computeAutomationNextRunAt(existing);
    return this.repo.restart(automationId, { nextRunAt }, workspaceKey);
  }

  /** Run now: create a manual run for direct dispatch by the current host without modifying the original cron schedule. */
  async runNow(
    automationId: string,
    scope?: AutomationWorkspaceScope,
  ): Promise<{ automation: ZCodeAutomation; run: ZCodeAutomationRun } | null> {
    const workspaceKey = resolveScopeKey(scope);
    const existing = await this.repo.get(automationId, workspaceKey);
    if (!existing) return null;
    return this.repo.runNow(automationId, { now: Date.now() }, workspaceKey);
  }

  async listRuns(
    automationId: string,
    scope?: AutomationWorkspaceScope,
  ): Promise<ZCodeAutomationRun[]> {
    return this.repo.listRuns(automationId, resolveScopeKey(scope));
  }
  async deleteRun(runId: string, scope?: AutomationWorkspaceScope): Promise<void> {
    return this.repo.deleteRun(runId, resolveScopeKey(scope));
  }
}
