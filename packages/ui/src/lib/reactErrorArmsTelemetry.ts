import {
  redactTelemetryText,
  type ArmsCustomEventPayload,
  type IPlatformService,
} from "@zcode/shared";
import { logger } from "@/logger.js";

/** ARMS custom event name for renderer exceptions caught by React error boundaries. */
export const REACT_ERROR_ARMS_EVENT_NAME = "perf_react_error";
/** ARMS business grouping. */
export const REACT_ERROR_ARMS_GROUP = "react_error";

/**
 * Maximum length for truncating stack / componentStack.
 * React component stacks and error stacks can be long, and ARMS may truncate/reject oversized fields;
 * truncating proactively to this limit ensures the critical beginning (the component that threw most recently) is included.
 */
export const REACT_ERROR_STACK_MAX_LEN = 4000;

type ArmsReporter = Pick<IPlatformService, "reportArmsCustomEvent">;

let armsReporter: ArmsReporter | null = null;

/**
 * Inject the ARMS reporter.
 *
 * Inject this before createRoot at the renderer entry point; do not rely on a Root effect.
 * The root AppErrorBoundary exists to catch rendering crashes in Root itself. If the reporter is injected from
 * a Root effect and Root crashes on its first frame, the effect never runs and the root error is still lost.
 */
export function setReactErrorArmsReporter(reporter: ArmsReporter | null): void {
  armsReporter = reporter;
}

export function clearReactErrorArmsReporterForTest(): void {
  armsReporter = null;
}

/**
 * Redact the reporting copy first: renderer stack and componentStack include `file:///Users/<username>/...`
 * paths on desktop, and error.message may also contain workspace paths or user content. Reuse `redactTelemetryText`, as with ARMS's automatic exception events;
 * local logs and fallback recovery continue using the original values. Keep the 4000-character truncation limit
 * so the most recent throwing component is included.
 */
function redactStack(value: string): string {
  return redactTelemetryText(value, { maxLength: REACT_ERROR_STACK_MAX_LEN });
}

function buildReactErrorArmsPayload(params: {
  error: Error;
  componentStack: string;
  scope?: string;
}): ArmsCustomEventPayload {
  const errorStack = params.error.stack ? redactStack(params.error.stack) : undefined;
  const componentStack = params.componentStack ? redactStack(params.componentStack) : undefined;
  return {
    name: REACT_ERROR_ARMS_EVENT_NAME,
    group: REACT_ERROR_ARMS_GROUP,
    value: 1,
    properties: {
      error_name: params.error.name,
      error_message: redactTelemetryText(params.error.message),
      error_stack: errorStack || undefined,
      component_stack: componentStack || undefined,
      // Root boundaries have no scope, so label them app; scoped boundaries use their scope to distinguish sidebar/chat/settings, etc.
      boundary_scope: params.scope ?? "app",
    },
  };
}

/**
 * Report exceptions caught by React error boundaries to ARMS RUM.
 *
 * React error boundaries intercept rendering exceptions in their subtree and prevent them from bubbling to window.onerror,
 * while the Browser RUM SDK collects automatically through window.onerror / unhandledrejection.
 * As a result, RUM cannot see boundary-caught errors by default, leaving only local logs. Forward them through
 * the same ARMS custom event channel as perf_crash to fill this gap.
 */
export function reportReactErrorToArms(params: {
  error: Error;
  componentStack: string;
  scope?: string;
}): void {
  if (!armsReporter) {
    return;
  }

  try {
    const payload = buildReactErrorArmsPayload(params);
    void Promise.resolve(armsReporter.reportArmsCustomEvent(payload)).catch((error) => {
      // ARMS is an observability path; telemetry failure must not interrupt fallback recovery in the error boundary.
      logger.warn("[react-error] ARMS 自定义事件上报失败", {
        scope: params.scope ?? "app",
        error: error instanceof Error ? error.message : String(error),
      });
    });
  } catch (error) {
    logger.warn("[react-error] ARMS 自定义事件上报异常", {
      scope: params.scope ?? "app",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
