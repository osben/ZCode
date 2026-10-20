import { useEffect } from "react";
import { useServices } from "@/hooks/useServices.js";
import { setMcpStoreDirectoryService, useMcpStore } from "@/store/mcpStore.js";

export function useEnsureWorkspaceMcpLoaded(
  workspaceAbsPath: string,
  workspaceIdentity: string | undefined,
  rpcReady: boolean,
) {
  const services = useServices();

  useEffect(() => {
    if (!rpcReady) {
      return;
    }
    setMcpStoreDirectoryService(services.mcpSyncService);
    return () => {
      setMcpStoreDirectoryService(null);
    };
  }, [rpcReady, services.mcpSyncService]);

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
