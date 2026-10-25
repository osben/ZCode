import { describe, expect, it } from "vitest";

import { statusPanelInsightsModule } from "./module.js";

// Contract tests import only the contract and the manifest, never the implementation.
describe("status-panel-insights contract", () => {
  it("declares its module manifest", () => {
    expect(statusPanelInsightsModule.id).toBe("status-panel-insights");
    expect(statusPanelInsightsModule.requires).toContain("review-last-turn");
  });
});
