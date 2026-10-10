export interface RemoteAssetNetworkPort {
  fetch: typeof globalThis.fetch;
}

export function resolveRemoteAssetFetch(
  network: RemoteAssetNetworkPort | undefined,
): typeof globalThis.fetch {
  // Remote asset downloads in Desktop Host previously used global fetch directly, bypassing the proxy configured in Settings.
  // A standalone server has no Desktop settings authority, so preserve the existing direct-connection contract when none is injected.
  return network?.fetch ?? globalThis.fetch.bind(globalThis);
}
