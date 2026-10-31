// The host the ACP group of Model Settings configures (specs/acp-agent-runtime.md "Settings:
// workspace host"): the host that owns the active workspace, resolved the way the composer resolves
// it, so Settings edits the same sidecars the composer reads. Called once per page; every ACP hook
// and component receives its `providerSettingsService`, so the group never mixes two hosts.
// Generic provider configuration stays on the Local Host (useModelProviders).
import { useMemo } from "react";
import type { IProviderSettingsService, ProviderSettingsView } from "@zcode/services";
import { useProviderSettingsServiceView } from "@/hooks/useProviderSettingsView.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";

export interface AcpSettingsHost {
  readonly providerSettingsService: IProviderSettingsService;
  /** That host's provider settings view (ACP providers' enabled state, launch config, conflicts); null until read. */
  readonly view: ProviderSettingsView | null;
  /** Commits the view an ACP write returned; never the Local Host's view. */
  readonly commitView: (view: ProviderSettingsView) => void;
  /** False while a remote attachment is pending: no ACP call may be sent yet. */
  readonly rpcReady: boolean;
  readonly isRemote: boolean;
  /** `workspaceIdentity?.trim() || workspacePath`; keys per-host UI state such as the agent detail form. */
  readonly hostKey: string;
}

export function useAcpSettingsHost(
  workspacePath: string,
  workspaceIdentity?: string,
): AcpSettingsHost {
  const resolution = useWorkspaceServicesResolution(workspacePath, null, workspaceIdentity);
  const providerSettingsService = resolution.services.providerSettingsService;
  const viewRead = useProviderSettingsServiceView(providerSettingsService);
  const view = viewRead.state.status === "ready" ? viewRead.state.view : null;
  const hostKey = workspaceIdentity?.trim() || workspacePath;
  return useMemo(
    () => ({
      providerSettingsService,
      view,
      commitView: viewRead.commit,
      rpcReady: resolution.rpcReady,
      isRemote: resolution.isRemoteTarget,
      hostKey,
    }),
    [
      hostKey,
      providerSettingsService,
      resolution.isRemoteTarget,
      resolution.rpcReady,
      view,
      viewRead.commit,
    ],
  );
}
