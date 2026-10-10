/**
 * Device identifier — singleton cache within the renderer process.
 *
 * Generation strategy:
 * - Desktop: use deviceMid from the main process (stable and unique SHA-256 based on the userData path).
 * - Mobile (Web remote control): use a hardware-property fingerprint (browserPlatform + screen.width/height + colorDepth),
 *   resistant to browser/network/language/time-zone changes and changes only when the phone changes.
 */
import { createUuid } from "@zcode/shared";

let cachedStreamClientId: string | null = null;

/**
 * Set the stable device ID (provided by platform.getDeviceId()).
 * Must be called before the first getStreamClientId() call.
 */
export function setStreamClientId(deviceId: string): void {
  const normalizedDeviceId = deviceId.trim();
  if (!normalizedDeviceId) {
    // If deviceId injection fails and we store an empty string, all instances share "renderer:",
    // causing owner/observer filtering to mistake them for the same client. Fall back to a stable random value within the process to prevent collisions between instances.
    cachedStreamClientId = cachedStreamClientId ?? `renderer:fallback-${createUuid()}`;
    return;
  }
  cachedStreamClientId = `renderer:${normalizedDeviceId}`;
}

/**
 * Generate a mobile hardware-property fingerprint.
 * Used by mobile to create a stable device ID before platform.getDeviceId() returns.
 */
export function generateMobileDeviceFingerprint(): string {
  const nav = globalThis.navigator as Navigator & { platform?: string };
  const platform = nav?.platform ?? "";
  const screenWidth = globalThis.screen?.width;
  const screenHeight = globalThis.screen?.height;
  const colorDepth = globalThis.screen?.colorDepth;
  const parts = [
    platform,
    screenWidth !== undefined ? String(screenWidth) : "",
    screenHeight !== undefined ? String(screenHeight) : "",
    colorDepth !== undefined ? String(colorDepth) : "",
  ];
  return parts.filter(Boolean).join("|");
}
