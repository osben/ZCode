// The options an ACP agent offered in its last handshake (specs/acp-agent-runtime.md "S6 readiness"). The composer
// shows them before a session exists; the host reads the fork-owned catalog file, never a session projection.
// The same read carries the model values hidden in Settings ("Settings: models and Advanced").
import { useCallback, useEffect, useState } from "react";
import type { ExternalAgentConfigOption } from "@zcode/shared/zcode-protocol-v4";
import { useServices } from "@/hooks/useServices.js";

export interface AcpAgentCatalogState {
  /** Undefined while the read is pending; null when the agent has no catalog or ACP is unsupported here. */
  readonly options: readonly ExternalAgentConfigOption[] | null | undefined;
  /** Model values hidden from the composer; undefined while pending or when nothing is hidden. */
  readonly hiddenModels?: readonly string[];
}

export interface AcpAgentCatalogHandle extends AcpAgentCatalogState {
  /** Rereads the catalog (after a Settings Test wrote a new one); the previous state stays until it settles. */
  readonly reload: () => void;
}

/** A mutable copy in the turn contract's shape (the service returns readonly arrays). */
function copyCatalogOptions(
  options: NonNullable<
    Awaited<
      ReturnType<ReturnType<typeof useServices>["providerSettingsService"]["getAcpAgentCatalog"]>
    >["options"]
  >,
): ExternalAgentConfigOption[] {
  return options.map((option) => ({
    ...option,
    options: option.options.map((value) => ({ ...value })),
  }));
}

export function useAcpAgentCatalog(agentId: string | null): AcpAgentCatalogHandle {
  const { providerSettingsService } = useServices();
  const [state, setState] = useState<AcpAgentCatalogState>({ options: undefined });
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((value) => value + 1), []);

  // A new agent starts from the pending state; a reload of the same agent keeps the shown state until it settles.
  useEffect(() => {
    setState({ options: agentId === null ? null : undefined });
  }, [agentId]);

  useEffect(() => {
    if (agentId === null) return;
    let current = true;
    providerSettingsService
      .getAcpAgentCatalog({ agentId })
      .then((result) => {
        if (current) {
          setState({
            options: result.supported && result.options ? copyCatalogOptions(result.options) : null,
            ...(result.supported && result.hiddenModels?.length
              ? { hiddenModels: [...result.hiddenModels] }
              : {}),
          });
        }
      })
      .catch(() => {
        if (current) setState({ options: null });
      });
    return () => {
      current = false;
    };
  }, [agentId, providerSettingsService, revision]);

  return { ...state, reload };
}
