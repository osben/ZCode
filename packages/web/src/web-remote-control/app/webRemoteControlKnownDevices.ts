import type { WebRemoteControlDeviceGroup, KnownDevice } from "#src/web-remote-control/contract.js";

// The key name keeps the legacy "device name" cache name, so old [mid, name] entries can be read directly.
export const KNOWN_DEVICES_KEY = "zcode-web-remote-device-names";
/** Records are only display preferences; a cap prevents localStorage from growing without bound, and the least recently updated entries are evicted when exceeded. */
export const KNOWN_DEVICES_LIMIT = 50;

type KnownDeviceStorage = Pick<Storage, "getItem" | "setItem">;

function toKnownDevice(name: string, platform: string | undefined): KnownDevice | null {
  const trimmedName = name.trim();
  const trimmedPlatform = platform?.trim();
  if (!trimmedName && !trimmedPlatform) return null;
  return {
    ...(trimmedName ? { name: trimmedName } : {}),
    ...(trimmedPlatform ? { platform: trimmedPlatform } : {}),
  };
}

/**
 * Reads the locally remembered MID → device name/platform.
 * The relay carries the hostname and platform through auth_init.meta only while the device is online; the meta of offline records is empty,
 * so this cache is the only source of offline device names and platforms. A read failure or corrupted content is treated as "no device remembered".
 */
export function readKnownDevices(storage: KnownDeviceStorage): Map<string, KnownDevice> {
  const devices = new Map<string, KnownDevice>();
  try {
    const raw = storage.getItem(KNOWN_DEVICES_KEY);
    if (!raw) return devices;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return devices;
    for (const item of parsed) {
      // The old version only wrote [mid, name]; the new version writes [mid, name, platform] when a platform is available.
      if (!Array.isArray(item) || (item.length !== 2 && item.length !== 3)) continue;
      const [mid, name, platform] = item as unknown[];
      if (typeof mid !== "string" || !mid || typeof name !== "string") continue;
      if (platform !== undefined && typeof platform !== "string") continue;
      const device = toKnownDevice(name, platform);
      if (device) devices.set(mid, device);
    }
  } catch {
    // Environments such as iOS private mode may disable storage, or old content may not be valid JSON; this does not block list display.
    devices.clear();
  }
  return devices;
}

/**
 * Writes back to the cache the device entries from this refresh that have an online connection and a name or platform.
 * The Map's insertion order is the "most recently updated" order: delete-then-set moves a device to the end, and eviction starts from the head.
 * Write failures are silently ignored; the caller already has this projection and is not affected.
 */
export function rememberKnownDevices(
  storage: KnownDeviceStorage,
  known: Map<string, KnownDevice>,
  groups: readonly WebRemoteControlDeviceGroup[],
): void {
  let touched = false;
  for (const group of groups) {
    if (group.onlineConnections.length === 0) continue;
    const device = toKnownDevice(group.name ?? "", group.platform);
    if (!device) continue;
    known.delete(group.deviceMid);
    known.set(group.deviceMid, device);
    touched = true;
  }
  if (!touched) return;
  while (known.size > KNOWN_DEVICES_LIMIT) {
    const oldest = known.keys().next().value;
    if (oldest === undefined) break;
    known.delete(oldest);
  }
  try {
    storage.setItem(
      KNOWN_DEVICES_KEY,
      JSON.stringify(
        [...known].map(([mid, device]) =>
          device.platform ? [mid, device.name ?? "", device.platform] : [mid, device.name ?? ""],
        ),
      ),
    );
  } catch {
    // A failure to persist preferences does not affect this display and does not modify business state isolated by SID.
  }
}
