import type { ArmsCustomEventPayload, IPlatformService } from "@zcode/shared";
import { logger } from "@/logger.js";

// ARMS sink for composer send-funnel telemetry.
// This event group uses ARMS only, not /event/report; Root.tsx installs the reporter according to isDesktop,
// and Web / mobile remote control has no reporter, so this group is silent there.

export const SEND_FUNNEL_ARMS_GROUP = "send_funnel";

export const SEND_FUNNEL_EVENT_INPUT_FOCUS = "send_input_focus";
export const SEND_FUNNEL_EVENT_SEND_CLICK = "send_click";
export const SEND_FUNNEL_EVENT_SEND_RESULT = "send_result";

type ArmsReporter = Pick<IPlatformService, "reportArmsCustomEvent">;

/** Reason code for the final send outcome. */
export type SendFunnelReasonCode =
  | "attachment_not_ready"
  | "blocked"
  | "rejected"
  | "stale"
  | "failed"
  | "render_timeout"
  | "transport_error"
  | "provider_not_ready"
  | "composer_error";

let armsReporter: ArmsReporter | null = null;

export function setSendFunnelArmsReporter(reporter: ArmsReporter | null): void {
  armsReporter = reporter;
}

export function clearSendFunnelArmsReporterForTest(): void {
  armsReporter = null;
}

// ARMS is an observability path; telemetry failure must not interrupt the send path.
function emit(payload: ArmsCustomEventPayload): void {
  if (!armsReporter) {
    return;
  }
  try {
    void Promise.resolve(armsReporter.reportArmsCustomEvent(payload)).catch((error) => {
      logger.warn("[send-funnel] ARMS 上报失败", { name: payload.name, error });
    });
  } catch (error) {
    logger.warn("[send-funnel] ARMS 上报异常", { name: payload.name, error });
  }
}

/** Session / draft state, distinguishing “send in an existing session” from “first send in a new task” funnels. */
export function composerScopeOf(sessionId: string | null | undefined): "session" | "draft" {
  return sessionId ? "session" : "draft";
}

/** Do not send properties for empty sessionId / commandId to avoid empty-string dimensions in ARMS. */
function optionalId(value: string | null | undefined): string | undefined {
  return value ? value : undefined;
}

/** Input focused (only for actual user focus; the composer filters out programmatic autofocus). */
export function reportSendFunnelInputFocus(params: {
  sessionId: string | null;
  focusTime: number;
}): void {
  emit({
    name: SEND_FUNNEL_EVENT_INPUT_FOCUS,
    group: SEND_FUNNEL_ARMS_GROUP,
    value: 1,
    properties: {
      focus_time: params.focusTime,
      composer_scope: composerScopeOf(params.sessionId),
      talk_id: optionalId(params.sessionId),
    },
  });
}

/** Send clicked / Enter submitted and passed the send gate. */
export function reportSendFunnelSendClick(params: {
  sessionId: string | null;
  sendClickId: string;
  sendTime: number;
  trigger: "button" | "shortcut";
  extraDetail: Record<string, string>;
}): void {
  emit({
    name: SEND_FUNNEL_EVENT_SEND_CLICK,
    group: SEND_FUNNEL_ARMS_GROUP,
    value: 1,
    properties: {
      ...params.extraDetail,
      send_click_id: params.sendClickId,
      input_send_time: params.sendTime,
      send_trigger: params.trigger,
      composer_scope: composerScopeOf(params.sessionId),
      talk_id: optionalId(params.sessionId),
    },
  });
}

/**
 * Final send outcome (shared by success and failure). value is send_cost_ms,
 * letting ARMS calculate avg/p50/p95/p99 directly for the event and split by status / reason_code.
 *
 * costMs is **end-to-end** duration: Send click → user message appears in conversation history.
 * ackCostMs separately measures “Send click → ACK received”; subtracting the two gives “streaming return + rendering” time.
 */
export function reportSendFunnelSendResult(params: {
  sessionId: string | null;
  commandId?: string;
  sendClickId: string;
  status: "success" | "fail";
  ackStatus?: string;
  reasonCode?: SendFunnelReasonCode;
  costMs: number;
  ackCostMs?: number;
  queueConfirmed: boolean;
  extraDetail: Record<string, string>;
}): void {
  const costMs = Math.max(0, Math.round(params.costMs));
  const ackCostMs =
    params.ackCostMs === undefined ? undefined : Math.max(0, Math.round(params.ackCostMs));
  emit({
    name: SEND_FUNNEL_EVENT_SEND_RESULT,
    group: SEND_FUNNEL_ARMS_GROUP,
    value: costMs,
    properties: {
      ...params.extraDetail,
      send_click_id: params.sendClickId,
      status: params.status,
      reason_code: params.reasonCode,
      ack_status: params.ackStatus,
      send_cost_ms: costMs,
      ack_cost_ms: ackCostMs,
      send_queue_confirmed: params.queueConfirmed,
      talk_id: optionalId(params.sessionId),
      message_id: optionalId(params.commandId),
    },
  });
}
