import { describe, expect, it } from "vitest";
import { exampleGenUiPrepare } from "./contract.example.js";
import { IGenUiService } from "./contract.js";

describe("gen-ui-service contract", () => {
  it("binds the service descriptor to the gen-ui channel", () => {
    expect(IGenUiService.channelName).toBe("gen-ui");
  });

  it("provides a valid prepare-sandbox example", () => {
    expect(exampleGenUiPrepare).toMatchObject({
      workspacePath: "/workspace",
      sessionId: "session",
      path: "/workspace/chart.html",
      ownerWebContentsId: 1,
      instanceKey: "message-1",
    });
    expect(exampleGenUiPrepare.html).toContain('<div id="chart">');
  });
});
