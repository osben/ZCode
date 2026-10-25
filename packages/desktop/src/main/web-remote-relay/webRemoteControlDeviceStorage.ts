import type { AppSettings } from "@zcode/shared";

import type { WebRemoteControlDeviceStorage } from "#src/main/web-remote-relay/contract.js";

/**
 * Persists the V2 device identity and discards pre-V2 pairing data.
 * clearLegacy() resolves to true when pre-V2 pairing material was present and removed, so the
 * manager can tell the user that every phone must pair again (no silent failure).
 */
export function createWebRemoteControlDeviceStorage(dependencies: {
  loadSettings(): Promise<AppSettings>;
  patchSettings(patch: Partial<AppSettings>): Promise<void>;
  /** Returns true when a legacy pass-hash credential existed and was deleted. */
  deleteLegacyCredential(): Promise<boolean>;
}): WebRemoteControlDeviceStorage {
  // Concurrent callers share one in-flight cleanup; a settled cleanup is not cached, so each call
  // reports only what it actually removed (a repeat call finds nothing and resolves to false).
  let inFlight: Promise<boolean> | undefined;
  return {
    load: async () => (await dependencies.loadSettings()).webRemoteControlRelayV2Device,
    save: (device) => dependencies.patchSettings({ webRemoteControlRelayV2Device: device }),
    clearLegacy: () => {
      inFlight ??= (async () => {
        const settings = await dependencies.loadSettings();
        const hadLegacyDevice = settings?.webRemoteControlExternalRelayDevice !== undefined;
        const hadLegacyCredential = await dependencies.deleteLegacyCredential();
        // Idempotent: always clear the legacy settings field so a retry after a failed write converges.
        await dependencies.patchSettings({ webRemoteControlExternalRelayDevice: undefined });
        return hadLegacyDevice || hadLegacyCredential;
      })().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
  };
}
