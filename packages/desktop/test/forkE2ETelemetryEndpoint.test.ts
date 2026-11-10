import { describe, expect, it } from "vitest";
import {
  applyForkE2ETelemetryReportEndpoint,
  FORK_E2E_TELEMETRY_REPORT_ENDPOINT,
} from "../scripts/fork-e2e-telemetry-endpoint.mjs";
import { E2E_DESKTOP_BUILD_ENV_NAMES } from "../scripts/ensure-e2e-desktop-build.mjs";

describe("fork E2E telemetry report endpoint", () => {
  it("defaults to a reserved .invalid host that the capture specs recognise", () => {
    const env: Record<string, string | undefined> = {};
    applyForkE2ETelemetryReportEndpoint(env);
    expect(env.ZCODE_TELEMETRY_REPORT_ENDPOINT).toBe(FORK_E2E_TELEMETRY_REPORT_ENDPOINT);
    const url = new URL(FORK_E2E_TELEMETRY_REPORT_ENDPOINT);
    expect(url.hostname.endsWith(".invalid")).toBe(true);
    expect(url.pathname).toBe("/api/v1/event/report");
  });

  it("keeps an explicitly configured value, including an empty one", () => {
    const configured = { ZCODE_TELEMETRY_REPORT_ENDPOINT: "https://example.test/api/v1/event/report" };
    expect(applyForkE2ETelemetryReportEndpoint(configured).ZCODE_TELEMETRY_REPORT_ENDPOINT).toBe(
      "https://example.test/api/v1/event/report",
    );
    const disabled = { ZCODE_TELEMETRY_REPORT_ENDPOINT: "" };
    expect(applyForkE2ETelemetryReportEndpoint(disabled).ZCODE_TELEMETRY_REPORT_ENDPOINT).toBe("");
  });

  it("invalidates the E2E build cache when the endpoint changes", () => {
    expect(E2E_DESKTOP_BUILD_ENV_NAMES).toContain("ZCODE_TELEMETRY_REPORT_ENDPOINT");
  });
});
