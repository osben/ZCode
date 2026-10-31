import { useEffect } from "react";
import { useServices } from "@/hooks/useServices.js";
import { useMcpStore } from "@/store/mcpStore.js";

export function useEnsureWorkspaceMcpLoaded(
  workspaceAbsPath: string,
  workspaceIdentity: string | undefined,
  rpcReady: boolean,
) {
  const services = useServices();

  // Fix note: this hook used to install the current tab's mcpSyncService as the store's global catalog
  // service, so writes from the settings page landed on the current tab's device even when Scope
  // selected another one. The catalog service is now bound per target via ensureLoadedForWorkspace;
  // there is no global service anymore.
  useEffect(() => {
    if (!rpcReady) {
      // When restoring a remote tab, App first receives a disconnected proxy. Reading the MCP directory immediately would
      // merely swallow the disconnection inside the store without respecting the workspace RPC isolation boundary.
      // Wait until the real services are registered; do not cache or replay across transports.
      return;
    }
    void useMcpStore
      .getState()
      .ensureLoadedForWorkspace(workspaceAbsPath, services.mcpSyncService, workspaceIdentity);
  }, [rpcReady, services.mcpSyncService, workspaceAbsPath, workspaceIdentity]);
}
