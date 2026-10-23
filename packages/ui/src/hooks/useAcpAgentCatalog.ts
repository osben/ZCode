// The options an ACP agent offered in its last handshake (specs/acp-agent-runtime.md "S6 readiness"). The composer
// shows them before a session exists; the host reads the fork-owned catalog file, never a session projection.
import { useEffect, useState } from "react";
import type { ExternalAgentConfigOption } from "@zcode/shared/zcode-protocol-v4";
import { useServices } from "@/hooks/useServices.js";

export interface AcpAgentCatalogState {
  /** Undefined while the read is pending; null when the agent has no catalog or ACP is unsupported here. */
  readonly options: readonly ExternalAgentConfigOption[] | null | undefined;
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

export function useAcpAgentCatalog(agentId: string | null): AcpAgentCatalogState {
  const { providerSettingsService } = useServices();
  const [state, setState] = useState<AcpAgentCatalogState>({ options: undefined });

  useEffect(() => {
    if (agentId === null) {
      setState({ options: null });
      return;
    }
    let current = true;
    setState({ options: undefined });
    providerSettingsService
      .getAcpAgentCatalog({ agentId })
      .then((result) => {
        if (current) {
          setState({
            options: result.supported && result.options ? copyCatalogOptions(result.options) : null,
          });
        }
      })
      .catch(() => {
        if (current) setState({ options: null });
      });
    return () => {
      current = false;
    };
  }, [agentId, providerSettingsService]);

  return state;
}
