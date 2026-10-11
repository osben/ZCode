import type { StartPlanPreviewConfig } from "@zcode/shared";
import { useCallback, useEffect, useState } from "react";
import { useOptionalServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import { normalizeErrorMessage as normalizeCodingPlanErrorMessage } from "@/settings/model-provider-section/useCodingPlanProducts.js";

interface StartPlanPreviewState {
  preview: StartPlanPreviewConfig | null;
  loading: boolean;
  error: string | null;
}

const START_PLAN_PREVIEW_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
let previewCache: { preview: StartPlanPreviewConfig | null; expiresAt: number } | null = null;
let previewRequest: Promise<StartPlanPreviewConfig | null> | null = null;

export function useStartPlanPreview(options?: { enabled?: boolean }) {
  const services = useOptionalServices();
  const service = services?.codingPlanSubscriptionService;
  const enabled = options?.enabled !== false;
  const [state, setState] = useState<StartPlanPreviewState>({
    preview: previewCache?.preview ?? null,
    loading: enabled && Boolean(service) && !previewCache,
    error: null,
  });

  const refresh = useCallback(async () => {
    if (!enabled) {
      setState({
        preview: previewCache?.preview ?? null,
        loading: false,
        error: null,
      });
      return;
    }
    if (!service || typeof service.getStartPlanPreview !== "function") {
      setState({
        preview: null,
        loading: false,
        error: "service_unavailable",
      });
      return;
    }

    setState((current) => ({
      preview: current.preview,
      loading: true,
      error: null,
    }));

    try {
      const preview = await loadStartPlanPreview(service);
      setState({
        preview,
        loading: false,
        error: null,
      });
    } catch (error) {
      // Start Plan preview and the plan list share client/configs.
      // If the remote returns HTML/non-JSON, do not display the parsing error verbatim in the upgrade panel.
      const message = normalizeCodingPlanErrorMessage(error);
      logger.warn("[useStartPlanPreview] 读取 Start Plan 预览失败", {
        error: message,
      });
      setState({
        preview: null,
        loading: false,
        error: message,
      });
    }
  }, [enabled, service]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    ...state,
    refresh,
  };
}

export function clearStartPlanPreviewCacheForTest() {
  previewCache = null;
  previewRequest = null;
}

export function primeStartPlanPreviewCacheForTest(preview: StartPlanPreviewConfig | null) {
  previewCache = {
    preview,
    expiresAt: Date.now() + START_PLAN_PREVIEW_CACHE_TTL_MS,
  };
  previewRequest = null;
}

async function loadStartPlanPreview(
  service: NonNullable<ReturnType<typeof useOptionalServices>>["codingPlanSubscriptionService"],
): Promise<StartPlanPreviewConfig | null> {
  const now = Date.now();
  if (previewCache && previewCache.expiresAt > now) {
    return previewCache.preview;
  }
  if (previewRequest) {
    return previewRequest;
  }

  // Remote config changes infrequently, and the signed-out Settings page may mount repeatedly; deduplicate requests to avoid repeated calls to client/configs.
  previewRequest = service.getStartPlanPreview();
  try {
    const preview = await previewRequest;
    previewCache = {
      preview,
      expiresAt: now + START_PLAN_PREVIEW_CACHE_TTL_MS,
    };
    return preview;
  } finally {
    previewRequest = null;
  }
}
