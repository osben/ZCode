import type { WebRemoteControlRelayV2Device } from "@zcode/shared/web-remote-relay";
import type { KnownDevice, WebRemoteControlDeviceGroup } from "#src/web-remote-control/contract.js";

/**
 * MID is only responsible for device display; all online SIDs are kept, while connections and business state remain isolated by SID.
 * knownDevices is the locally remembered MID → device name/platform: offline records have empty meta, so this is the only way to show the name and platform icon.
 */
export function groupWebRemoteControlDevices(
  records: WebRemoteControlRelayV2Device[],
  locale: string,
  knownDevices: ReadonlyMap<string, KnownDevice> = new Map(),
): WebRemoteControlDeviceGroup[] {
  const collator = new Intl.Collator(locale);
  // The display name prefers the record's own meta.name and falls back to the remembered name when missing; sorting and aggregation share the same rule.
  const displayName = (record: WebRemoteControlRelayV2Device) =>
    record.meta.name?.trim() || knownDevices.get(record.device_mid)?.name || "";
  const displayPlatform = (record: WebRemoteControlRelayV2Device) =>
    record.meta.platform?.trim() || knownDevices.get(record.device_mid)?.platform || "";
  const sorted = records.toSorted((a, b) => {
    const aName = displayName(a);
    const bName = displayName(b);
    return (
      Number(b.online) - Number(a.online) ||
      Number(!aName) - Number(!bName) ||
      collator.compare(aName, bName) ||
      collator.compare(a.device_mid, b.device_mid) ||
      collator.compare(a.device_sid, b.device_sid)
    );
  });
  const groups = new Map<string, WebRemoteControlDeviceGroup>();
  for (const record of sorted) {
    let group = groups.get(record.device_mid);
    if (!group) {
      group = {
        deviceMid: record.device_mid,
        name: displayName(record) || undefined,
        onlineConnections: [],
      };
      groups.set(record.device_mid, group);
    }
    // Online records come first; the platform is taken from the first record that can provide one. Missing fields are not written, keeping the old projection shape.
    if (!group.platform) {
      const platform = displayPlatform(record);
      if (platform) group.platform = platform;
    }
    // Historical offline registrations no longer generate device rows; online SIDs must not be deduplicated into one arbitrarily chosen connection target.
    if (record.online) group.onlineConnections.push(record);
  }
  return [...groups.values()];
}
