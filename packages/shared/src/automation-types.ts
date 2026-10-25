import type { ZCodeTaskMode } from "./zcode-task-types-core.js";
import type { ZCodeAutomationBotDeliveryTarget } from "./bots.js";
import type { ModelSelection } from "./model-selection.js";

// ---- Automation domain types ----
// automation / automation_runs are stored in tasks-index.sqlite.
// These camelCase domain types are shared across services / CLI / desktop / UI; SQLite column names are snake_case.

/** Maximum number of automation definitions retained by one local task index; all lifecycle states count toward the limit. */
export const AUTOMATION_CREATE_LIMIT = 20;
export const AUTOMATION_CREATE_LIMIT_ERROR_CODE = "AUTOMATION_CREATE_LIMIT_REACHED";

export function isAutomationCreateLimitError(error: unknown): boolean {
  const message = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  return message.includes(AUTOMATION_CREATE_LIMIT_ERROR_CODE);
}

/** Lifecycle of an automation. */
export type ZCodeAutomationLifecycleStatus = "active" | "completed" | "failed" | "paused";

/** Dispatch state for the current run of one automation (for UI/diagnostics). */
export type ZCodeAutomationDispatchStatus =
  | "idle"
  | "claimed"
  | "dispatched"
  | "failed_to_dispatch";

/** Workspace location; currently always local, with remote reserved for later. */
export type ZCodeAutomationLocationKind = "local" | "remote";

/** Trigger source: scheduled or run now. */
export type ZCodeAutomationTrigger = "schedule" | "manual";

/** Custom recurrence rule; cronExpr remains for compatible display, while this field is authoritative for scheduling. */
export interface ZCodeAutomationScheduleRule {
  unit: "minute" | "hourly" | "daily" | "weekly" | "monthly" | "yearly";
  interval: number;
  hour: number;
  minute: number;
  anchorAt: number;
  weekdays?: number[];
  monthDays?: number[];
  /** For yearly rules: human month numbers 1–12. Defaults to the month of anchorAt for older records without this field. */
  months?: number[];
  monthlyMode?: "date" | "weekday";
}

/**
 * Unit enum for the session-side long-interval recurrence carrier. It has the same values as
 * scheduleRule.unit, but the carrier is a controlled input (the model cannot write the full
 * scheduleRule); the service layer normalizes it into the authoritative scheduleRule.
 */
export type ZCodeAutomationIntervalUnit = ZCodeAutomationScheduleRule["unit"];

/** Dispatch result for one run (scheduler-authoritative and used for retries). skipped means the trigger window was missed. */
export type ZCodeAutomationRunDispatchStatus =
  | "claimed"
  | "dispatched"
  | "failed_to_dispatch"
  | "skipped";

/** Outcome after one run produces a session (written back by the session runtime and used only for display). */
export type ZCodeAutomationRunOutcome = "running" | "succeeded" | "failed" | "stopped";

/** An automation definition and its scheduling state. */
export interface ZCodeAutomation {
  projectId?: string | null;
  hostId?: string;
  /** 创建定义时固化，之后不跟随虚拟项目 roots 编辑。 */
  additionalDirectories?: string[];
  automationId: string;
  title: string;
  /** Five-field cron expression in local time. */
  cronExpr: string;
  prompt: string;
  /** When absent, the Select phase continues following the Workspace preference; when present, it fixes the structured model intent. */
  modelSelection?: ModelSelection;
  /** Permission mode passed through to createTask during dispatch; defaults to the workspace setting. */
  mode?: ZCodeTaskMode;
  /** workspaceIdentity?.trim() || workspacePath */
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  /** A cron created in a session is bound to the current task; later triggers return to that task instead of creating sessions. */
  targetTaskId?: string;
  locationKind: ZCodeAutomationLocationKind;
  /** true = repeat indefinitely; false = run a finite number of times (with maxRuns). */
  recurring: boolean;
  maxRuns?: number;
  /** End time for custom recurrence (end of the selected local date, in milliseconds). */
  endAt?: number;
  scheduleRule?: ZCodeAutomationScheduleRule;
  /** Whether the user explicitly removed and reset a read-only schedule from a session in the management page. */
  scheduleEditedByUser?: boolean;
  runCount: number;
  enabled: boolean;
  lifecycleStatus: ZCodeAutomationLifecycleStatus;
  nextRunAt?: number;
  lastRunAt?: number;
  dispatchStatus: ZCodeAutomationDispatchStatus;
  dispatchAttempts: number;
  retryAt?: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

/** Parsed result of parseAutomationRunId; scheduledAt is present only for scheduled triggers. */
export interface ZCodeAutomationRunIdParts {
  automationId: string;
  trigger: ZCodeAutomationTrigger;
  /** The theoretical trigger time embedded in runId for this run (Unix milliseconds). */
  scheduledAt?: number;
}

/**
 * The only parser for the runId contract (see ZCodeAutomationRun.runId). Desktop host/scheduler and
 * CLI telemetry must not independently infer the format from strings. Return null for input that does
 * not match either declared format.
 */
export function parseAutomationRunId(runId: string): ZCodeAutomationRunIdParts | null {
  const separatorIndex = runId.indexOf(":");
  if (separatorIndex <= 0) return null;
  const automationId = runId.slice(0, separatorIndex);
  const rest = runId.slice(separatorIndex + 1);
  if (rest.startsWith("manual:")) {
    return rest.length > "manual:".length ? { automationId, trigger: "manual" } : null;
  }
  const scheduledAt = Number(rest);
  if (!Number.isSafeInteger(scheduledAt) || scheduledAt <= 0) return null;
  return { automationId, trigger: "schedule", scheduledAt };
}

/** Run history and runId idempotency ledger for one trigger. */
export interface ZCodeAutomationRun {
  /** automationId:scheduledAt / automationId:manual:uuid */
  runId: string;
  automationId: string;
  workspaceKey: string;
  scheduledAt?: number;
  trigger: ZCodeAutomationTrigger;
  /** Fixed after Select is converted to Submission; dispatch retries for the same run must not reread the Workspace preference. */
  modelSelection?: ModelSelection;
  dispatchStatus: ZCodeAutomationRunDispatchStatus;
  outcome?: ZCodeAutomationRunOutcome;
  /** Set after successful dispatch for history navigation. */
  sessionId?: string;
  error?: string;
  attempts: number;
  createdAt: number;
  updatedAt: number;
}

/** Automation creation parameters (workspace is injected by the caller from session context). */
export interface ZCodeAutomationCreateParams {
  projectId?: string | null;
  hostId?: string;
  /** 创建定义时固化，之后不跟随虚拟项目 roots 编辑。 */
  additionalDirectories?: string[];
  title: string;
  cronExpr: string;
  /** Used only during creation: the service layer derives cronExpr from the actual current time; this is not stored in the database. */
  relativeDelayMinutes?: number;
  prompt: string;
  modelSelection?: ModelSelection;
  mode?: ZCodeTaskMode;
  workspacePath: string;
  workspaceIdentity?: string;
  /** Injected by the runtime when created in the current session; not controlled by the model. */
  targetTaskId?: string;
  /** Injected by the Host when a Bot session is created; used only for scheduler terminal-state callbacks and omitted from the UI display model. */
  botDeliveryTarget?: ZCodeAutomationBotDeliveryTarget;
  recurring: boolean;
  maxRuns?: number;
  endAt?: number;
  scheduleRule?: ZCodeAutomationScheduleRule;
  /**
   * Session-side custom recurrence carrier. Each N minutes/hours/days/weeks/months/years submits
   * intervalUnit + interval together. The service layer normalizes the actual interval into the
   * authoritative scheduleRule; cronExpr is retained only for compatible display. Mutually exclusive
   * with scheduleRule and relativeDelayMinutes. undefined means the carrier is unused.
   */
  intervalUnit?: ZCodeAutomationIntervalUnit;
  /** Integer interval from 1 to 200, required together with intervalUnit. */
  interval?: number;
}

/** Mutable fields for updating an automation. */
export interface ZCodeAutomationUpdateParams {
  title?: string;
  cronExpr?: string;
  prompt?: string;
  /** undefined = unchanged; null = clear and fall back to the Workspace preference. */
  modelSelection?: ModelSelection | null;
  /** undefined = unchanged; null = clear and fall back to the workspace's default permission mode. */
  mode?: ZCodeTaskMode | null;
  recurring?: boolean;
  /** undefined = usually unchanged; when recurring=true, the domain layer clears the old limit automatically. Explicit null requires recurring=true too. */
  maxRuns?: number | null;
  /** undefined = unchanged; null = never ends. */
  endAt?: number | null;
  /** undefined = unchanged; null = revert to a regular cron schedule. */
  scheduleRule?: ZCodeAutomationScheduleRule | null;
  /**
   * Session-side custom recurrence carrier (same as creation). Submit intervalUnit + interval together;
   * the service layer normalizes them into the authoritative scheduleRule (anchorAt resets to the time
   * of this update). undefined means unchanged.
   */
  intervalUnit?: ZCodeAutomationIntervalUnit;
  /** Integer interval from 1 to 200, required together with intervalUnit. */
  interval?: number;
  /** Set only by the management page when the user actually changes the schedule; undefined preserves the original source state. */
  scheduleEditedByUser?: boolean;
}

/** Host 在定义创建时解析的执行目录；派发只读取此快照，不重新解析项目 roots。 */
export interface ProjectExecutionSnapshot {
  projectId: string | null;
  hostId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  additionalDirectories: string[];
}
