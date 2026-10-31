// The host the ACP group of Model Settings configures (specs/acp-agent-runtime.md "Settings:
// workspace host"): the host that owns the active workspace, resolved the way the composer resolves
// it, so Settings edits the same sidecars the composer reads. Called once per page; every ACP hook
// and component receives its `providerSettingsService`, so the group never mixes two hosts.
// Generic provider configuration stays on the Local Host (useModelProviders).
import { useMemo } from "react";
import type { IProviderSettingsService, ProviderSettingsView } from "@zcode/services";
import { useProviderSettingsServiceView } from "@/hooks/useProviderSettingsView.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";

export interface AcpSettingsHostTarget {
  readonly workspacePath: string;
  readonly workspaceIdentity?: string;
  /** The covered workspace tab's session and target, so a legacy remote tab without an identity resolves. */
  readonly remoteSessionId?: string;
  readonly remoteTarget?: unknown;
}

export interface AcpSettingsHost {
  readonly providerSettingsService: IProviderSettingsService;
  /** That host's provider settings view (ACP providers' enabled state, launch config, conflicts); null unless ready. */
  readonly view: ProviderSettingsView | null;
  /** No ACP write, form seed or status probe may run until the view is ready (WH7, WH8). */
  readonly viewStatus: "loading" | "ready" | "error";
  readonly viewError: Error | null;
  /** Rereads that host's view after a failed read. */
  readonly reloadView: () => void;
  /** Commits the view an ACP write returned; never the Local Host's view. */
  readonly commitView: (view: ProviderSettingsView) => void;
  /** False while a remote attachment is pending: no ACP call may be sent yet. */
  readonly rpcReady: boolean;
  readonly isRemote: boolean;
  /**
   * `workspaceIdentity?.trim() || workspacePath` plus the service instance's serial; keys per-host UI state
   * such as the agent detail form, so a replaced attachment with the same identity and path remounts it.
   */
  readonly hostKey: string;
}

const serviceSerials = new WeakMap<IProviderSettingsService, number>();
let nextServiceSerial = 0;

function serviceSerial(service: IProviderSettingsService): number {
  let serial = serviceSerials.get(service);
  if (serial === undefined) {
    serial = ++nextServiceSerial;
    serviceSerials.set(service, serial);
  }
  return serial;
}

export function useAcpSettingsHost(target: AcpSettingsHostTarget): AcpSettingsHost {
  const { workspacePath, workspaceIdentity, remoteSessionId, remoteTarget } = target;
  const resolution = useWorkspaceServicesResolution(
    workspacePath,
    remoteSessionId,
    workspaceIdentity,
    remoteTarget,
  );
  const providerSettingsService = resolution.services.providerSettingsService;
  const viewRead = useProviderSettingsServiceView(providerSettingsService);
  const viewState = viewRead.state;
  const view = viewState.status === "ready" ? viewState.view : null;
  const viewError = viewState.status === "error" ? viewState.error : null;
  const hostKey = `${workspaceIdentity?.trim() || workspacePath}#${serviceSerial(providerSettingsService)}`;
  return useMemo(
    () => ({
      providerSettingsService,
      view,
      viewStatus: viewState.status,
      viewError,
      reloadView: viewRead.reload,
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
      viewError,
      viewRead.commit,
      viewRead.reload,
      viewState.status,
    ],
  );
}
