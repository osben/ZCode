import { createHash } from "node:crypto";
import { buildRemoteEnvironmentKey, type RemoteTarget } from "@zcode/shared";

/** Remote environments with the same configuration must not be merged; send only a hash of the canonical environment identity, never the raw address, through telemetry. */
export function resolveResourceTelemetryEnvironmentKey(target: RemoteTarget): string {
  return createHash("sha256").update(buildRemoteEnvironmentKey(target)).digest("hex");
}
