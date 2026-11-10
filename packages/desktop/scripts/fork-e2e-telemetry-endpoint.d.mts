export const FORK_E2E_TELEMETRY_REPORT_ENDPOINT: string;

export function applyForkE2ETelemetryReportEndpoint<T extends Record<string, string | undefined>>(
  env: T,
): T;
