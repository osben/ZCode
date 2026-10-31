import { useContext, useLayoutEffect } from "react";
import { StoreContext } from "@/store/StoreProvider.js";
import type { InterfaceMode } from "@/lib/interfaceMode.js";
import {
  BIGMODEL_PROVIDER_ID,
  BUILTIN_MODEL_PROVIDER_IDS,
  ZAI_PROVIDER_ID,
  collectTelemetryRendererContext,
  isZaiCodingPlanProviderId,
  sanitizeTelemetryEventDetail,
  type BuiltinModelProviderId,
  type IPlatformService,
  type TelemetryUiMode,
} from "@zcode/shared";
import { logger } from "@/logger.js";

export function resolveProviderTelemetryLabel(providerId: string): string {
  if (providerId === ZAI_PROVIDER_ID || isZaiCodingPlanProviderId(providerId)) {
    return "z.ai";
  }

  if (
    providerId === BIGMODEL_PROVIDER_ID ||
    providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan ||
    providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan ||
    providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan
  ) {
    return "bigmodel";
  }

  return providerId;
}

export function resolvePresetModelProviderTelemetryLabel(presetId: BuiltinModelProviderId): string {
  return resolveProviderTelemetryLabel(presetId);
}

type ReportTelemetryPlatform = Pick<IPlatformService, "reportTelemetryEvent">;

export async function reportAppTelemetryEvent(
  platform: ReportTelemetryPlatform,
  payload: {
    elementName: string;
    eventRegion: string;
    eventType: string;
    eventText?: string;
    eventExtraDetail: Record<string, string>;
    userId?: string;
    talkId?: string;
    messageId?: string;
  },
  scope: string,
): Promise<void> {
  try {
    const reportPayload = {
      context: collectTelemetryRendererContext(),
      ...payload,
      eventExtraDetail: sanitizeTelemetryEventDetail(payload.elementName, payload.eventExtraDetail),
    };

    // Cause of fix: Cleaning only in Core would let the original text pass through IPC/local logs first; record only the sanitized copy here.
    // Steps are on the same scale as messages; use debug for diagnostic output to avoid a persisted info copy.
    if (payload.elementName === "message_completion" || payload.elementName === "agent_step") {
      logger.debug(`[${scope}] ${payload.elementName} payload:`, reportPayload);
    }

    await platform.reportTelemetryEvent(reportPayload);
  } catch {
    // Desktop Main's TelemetryCore records the final failure as a redacted warning; the UI only preserves business isolation,
    // avoiding duplicate records and preventing raw IPC errors from entering production logs.
  }
}

/** Mapped only at the telemetry boundary; without an interaction source, do not assume a default coding mode. */
export function toTelemetryUiMode(mode: InterfaceMode | undefined): TelemetryUiMode {
  return mode === "office" ? "work" : mode === "coding" ? "code" : "unknown";
}

/** Sync the existing host context from the single store; creates no business events or extra polling. */
export function useInterfaceModeTelemetry(platform: IPlatformService, enabled: boolean): void {
  const store = useContext(StoreContext);
  useLayoutEffect(() => {
    if (!enabled || !store || !platform.syncTelemetryContext) return;
    const sync = () => {
      try {
        platform.syncTelemetryContext?.({
          ...collectTelemetryRendererContext(),
          uiMode: toTelemetryUiMode(store.getState().interfaceMode),
        });
      } catch {
        // A telemetry bridge failure must not interrupt startup, mode switching, or cross-window broadcast.
      }
    };
    sync();
    return store.subscribe((state, previous) => {
      if (state.interfaceMode !== previous.interfaceMode) sync();
    });
  }, [enabled, platform, store]);
}
