import type {
  ZCodeAutomationIntervalUnit,
  ZCodeAutomationScheduleRule,
  ZCodeAutomationUpdateParams,
} from "@zcode/shared";

/** Controlled limit for session-side custom recurrence carriers; do not tighten the domain limit for historical management-page scheduleRules. */
const MAX_SESSION_AUTOMATION_INTERVAL = 200;

/** Validation failed for the pairing, range, or mutual exclusion of a session-side custom recurrence carrier. */
export class InvalidAutomationIntervalCarrierError extends Error {
  constructor(message: string) {
    super(`非法的自定义重复入参：${message}`);
    this.name = "InvalidAutomationIntervalCarrierError";
  }
}

/**
 * Validate the interval carrier shared by the session Cron tool and UI.
 *
 * intervalUnit + interval is controlled input, so the service layer must validate it again. This prevents older clients or internal calls from bypassing
 * the contract/protocol and persisting an interval outside the UI semantics. `scheduleRule: null` explicitly clears a rule on update
 * and cannot be combined with a carrier, or it would be unclear whether the intent is to create or clear a rule.
 */
export function assertValidAutomationIntervalCarrier(input: {
  intervalUnit?: ZCodeAutomationIntervalUnit;
  interval?: number;
  scheduleRule?: ZCodeAutomationScheduleRule | null;
  relativeDelayMinutes?: number;
  recurring?: boolean;
  maxRuns?: number | null;
}): void {
  const { intervalUnit, interval, scheduleRule, relativeDelayMinutes, recurring, maxRuns } = input;
  if ((intervalUnit === undefined) !== (interval === undefined)) {
    throw new InvalidAutomationIntervalCarrierError(
      "intervalUnit 与 interval 必须同时提交或同时省略",
    );
  }
  if (
    interval !== undefined &&
    (!Number.isInteger(interval) || interval < 1 || interval > MAX_SESSION_AUTOMATION_INTERVAL)
  ) {
    throw new InvalidAutomationIntervalCarrierError("interval 必须是 1-200 的整数");
  }
  if (intervalUnit !== undefined && relativeDelayMinutes !== undefined) {
    throw new InvalidAutomationIntervalCarrierError(
      "intervalUnit 是周期 carrier，不能与一次性 relativeDelayMinutes 同时提交",
    );
  }
  if (intervalUnit !== undefined && scheduleRule !== undefined) {
    throw new InvalidAutomationIntervalCarrierError(
      "intervalUnit carrier 不能与直传 scheduleRule 同时提交",
    );
  }
  // The carrier represents an infinite recurrence. Allowing recurring=false or maxRuns would make the repository
  // end it as a one-time or finite task after the first dispatch, leaving scheduleRule inconsistent with the lifecycle mode.
  if (intervalUnit !== undefined && recurring === false) {
    throw new InvalidAutomationIntervalCarrierError("intervalUnit carrier 必须使用 recurring=true");
  }
  if (intervalUnit !== undefined && typeof maxRuns === "number") {
    throw new InvalidAutomationIntervalCarrierError(
      "intervalUnit carrier 不能与有限 maxRuns 同时提交",
    );
  }
}

/** A carrier update must atomically switch to infinite recurrence so scheduleRule and the lifecycle mode stay aligned. */
export function forceIntervalCarrierRecurring(
  params: ZCodeAutomationUpdateParams,
): ZCodeAutomationUpdateParams {
  return { ...params, recurring: true, maxRuns: null };
}
