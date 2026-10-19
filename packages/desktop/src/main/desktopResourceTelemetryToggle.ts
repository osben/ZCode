import {
  registerDesktopResourceTelemetry,
  stopDesktopResourceTelemetry,
} from "./desktopResourceTelemetry.js";

type ResourceTelemetryLogger = Parameters<typeof registerDesktopResourceTelemetry>[0];

/**
 * Applies the `resourceTelemetryEnabled` fork setting (specs/resource-telemetry-toggle.md), off by
 * default. Disabling drops partial windows instead of flushing them: the user asked for no
 * reporting. A repeated enable restarts the timers rather than stacking them.
 */
export function setDesktopResourceTelemetryEnabled(
  enabled: boolean,
  logger: ResourceTelemetryLogger,
): void {
  if (enabled) {
    registerDesktopResourceTelemetry(logger);
    return;
  }
  stopDesktopResourceTelemetry();
  logger.info("[resource] sampling stopped by setting");
}
