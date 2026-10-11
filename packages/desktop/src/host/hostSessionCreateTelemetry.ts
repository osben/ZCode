import {
  HostResponseTypes,
  resolveWorkspaceTelemetryDetail,
  type AutomationSessionCreateTelemetry,
} from "@zcode/shared";

/** Call only from the dispatch branch that actually creates a session and completes its initial admission; do not infer creation from a recovery subscription. */
export function reportHostSessionCreate(
  port: { postMessage(message: unknown): void } | null | undefined,
  input: {
    sessionId: string;
    messageId: string;
    source: AutomationSessionCreateTelemetry["eventExtraDetail"]["create_source"];
    workspaceIdentity?: string;
  },
): void {
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions();
    const event: AutomationSessionCreateTelemetry = {
      elementName: "session_create",
      eventRegion: "app",
      eventType: "result",
      talkId: input.sessionId,
      messageId: input.messageId,
      context: {
        clientTimezone: locale.timeZone,
        clientLanguage: locale.locale,
        screenResolution: "",
      },
      eventExtraDetail: {
        create_source: input.source,
        client_kind: "desktop",
        ...resolveWorkspaceTelemetryDetail(input),
      },
    };
    port?.postMessage({ type: HostResponseTypes.SessionCreateTelemetry, event });
  } catch {
    // If Main has exited or IPC is unavailable, drop this side-channel report; do not misclassify an accepted dispatch as a failure.
  }
}
