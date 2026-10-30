// Probe of an Ollama server for the Model Settings Ollama entry
// (specs/ollama-local-provider.md). The probe runs on the host that owns the workspace: services
// are resolved for the workspace target, so a remote workspace probes its own machine, while the
// provider mutations keep the local Host (model configuration is a local global fact). One probe
// per call; only the newest response writes state (OL9), and an address edit drops the result and
// any in-flight probe (OL10), so Save requires a detection of the shown address.
import { useCallback, useRef, useState } from "react";
import type { OllamaDetectionResult } from "@zcode/services";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";

interface OllamaDetectionState {
  readonly loading: boolean;
  readonly result: OllamaDetectionResult | null;
}

export function useOllamaDetection(
  workspacePath: string,
  workspaceIdentity?: string,
): OllamaDetectionState & {
  detect: (baseUrl: string) => Promise<void>;
  /** Drops the current result and any in-flight probe; the shown address changed. */
  reset: () => void;
} {
  const { providerSettingsService } = useWorkspaceServices(workspacePath, null, workspaceIdentity);
  const [state, setState] = useState<OllamaDetectionState>({ loading: false, result: null });
  const sequenceRef = useRef(0);
  const detect = useCallback(
    async (baseUrl: string) => {
      const sequence = ++sequenceRef.current;
      setState((current) => ({ ...current, loading: true }));
      let result: OllamaDetectionResult;
      try {
        result = await providerSettingsService.detectOllama({ baseUrl });
      } catch (error) {
        logger.warn("[OllamaDetail] detection failed", error);
        result = {
          reachable: false,
          baseUrl,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      if (sequence === sequenceRef.current) setState({ loading: false, result });
    },
    [providerSettingsService],
  );
  const reset = useCallback(() => {
    sequenceRef.current += 1;
    setState({ loading: false, result: null });
  }, []);
  return { ...state, detect, reset };
}
