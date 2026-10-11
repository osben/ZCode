import { useEffect, useRef } from "react";
import type { ConversationTelemetrySupervisor } from "@/v4/telemetry/conversationTelemetrySupervisor.js";

const SESSION_SUBSCRIPTION_ERROR_SURFACE = "session_subscription_error";
const FALLBACK_SUBSCRIPTION_ERROR_CODE = "fault.subscribe.unknown";
const STANDALONE_REASON_CODE_PATTERN = /^fault\.[A-Za-z0-9._-]+$/;
const SUFFIX_REASON_CODE_PATTERN = /\((fault\.[A-Za-z0-9._-]+)\)\s*$/;

type SubscriptionErrorReporter = Pick<ConversationTelemetrySupervisor, "reportVisibleChatError">;

export function resolveSessionSubscriptionErrorCode(message: string): string {
  const trimmedMessage = message.trim();
  // Bug cause: recovery fail-closed writes a bare reasonCode directly to lastError, while the old logic recognized only
  // the "message (reasonCode)" form, causing structured errors to be incorrectly grouped as fault.subscribe.unknown.
  return (
    STANDALONE_REASON_CODE_PATTERN.exec(trimmedMessage)?.[0] ??
    SUFFIX_REASON_CODE_PATTERN.exec(trimmedMessage)?.[1] ??
    FALLBACK_SUBSCRIPTION_ERROR_CODE
  );
}

export function useSessionSubscriptionErrorTelemetry(params: {
  supervisor: SubscriptionErrorReporter | null;
  sessionId: string | null;
  lastError: string | null;
  visible: boolean;
}): void {
  const reportedKeysRef = useRef(new Set<string>());

  useEffect(() => {
    if (!params.visible || !params.supervisor || !params.sessionId || !params.lastError) {
      return;
    }
    const errorCode = resolveSessionSubscriptionErrorCode(params.lastError);
    const errorKey = `${params.sessionId}:${errorCode}:${params.lastError}`;
    if (reportedKeysRef.current.has(errorKey)) return;
    reportedKeysRef.current.add(errorKey);

    // Bug cause: after the store converts a subscription failure into a visible error state, it is no longer thrown to ErrorBoundary
    // and bypasses Composer's error-banner telemetry. Reuse chat_error_banner here to record the visible impression.
    params.supervisor.reportVisibleChatError({
      surface: SESSION_SUBSCRIPTION_ERROR_SURFACE,
      errorKey,
      displayMessage: params.lastError,
      error: {
        code: errorCode,
        message: params.lastError,
        taskId: params.sessionId,
      },
    });
  }, [params.lastError, params.sessionId, params.supervisor, params.visible]);
}
