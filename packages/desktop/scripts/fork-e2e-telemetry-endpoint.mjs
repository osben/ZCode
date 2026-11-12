// Fork: upstream E2E builds bake the warehouse report endpoint from config/private/build-defaults.json,
// which the fork does not have. Without an endpoint telemetryCore drops every report before net.fetch,
// so the specs that capture /api/v1/event/report through a net.fetch mock see nothing. E2E builds get a
// reserved .invalid host instead: captured specs read the mocked calls, and anything unmocked fails DNS
// locally without leaving the machine. An explicitly set value (an empty string included) wins.
export const FORK_E2E_TELEMETRY_REPORT_ENDPOINT =
  "https://telemetry.e2e.invalid/api/v1/event/report";

export function applyForkE2ETelemetryReportEndpoint(env) {
  if (typeof env.ZCODE_TELEMETRY_REPORT_ENDPOINT !== "string") {
    env.ZCODE_TELEMETRY_REPORT_ENDPOINT = FORK_E2E_TELEMETRY_REPORT_ENDPOINT;
  }
  return env;
}
