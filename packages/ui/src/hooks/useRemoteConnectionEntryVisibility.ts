import type { ZCodeEnv } from "@zcode/shared";

export function shouldShowRemoteConnectionEntry(params: {
  env: ZCodeEnv;
  isIntranet: boolean;
}): boolean {
  void params;
  return true;
}

export function useRemoteConnectionEntryVisibility(): boolean {
  // The SSH entry previously reused the internal-only gate, which also hid it in production
  // environments outside the intranet. SSH availability depends on the target machine, network,
  // and credentials, not on whether the current client is on the intranet. Remote connections are
  // general SSH functionality and should not be gated by a retired product's intranet policy.
  return true;
}
