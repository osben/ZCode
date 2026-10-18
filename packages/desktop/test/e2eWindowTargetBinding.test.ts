import { describe, expect, it } from "vitest";

import { collectE2EWebDriverPageHandleCandidates } from "./e2e/helpers/e2e-window-target.js";

describe("desktop e2e window target binding", () => {
  it("only admits page targets owned by the current ChromeDriver handle table", () => {
    expect(
      collectE2EWebDriverPageHandleCandidates(
        ["app-error-handle", "renderer-handle"],
        [
          {
            id: "app-error-handle",
            type: "app",
            url: "chrome-error://chromewebdata/",
          },
          {
            id: "renderer-handle",
            type: "page",
            url: "file:///repo/packages/desktop/out/renderer/index.html",
          },
          {
            id: "stale-cdp-target",
            type: "page",
            url: "file:///repo/packages/desktop/out/renderer/index.html",
          },
        ],
      ),
    ).toEqual([
      {
        handle: "renderer-handle",
        targetUrl: "file:///repo/packages/desktop/out/renderer/index.html",
      },
    ]);
  });

  it("does not promote a CDP-only page target to a WebDriver handle", () => {
    expect(
      collectE2EWebDriverPageHandleCandidates(
        ["app-error-handle"],
        [
          {
            id: "renderer-target",
            type: "page",
            url: "file:///repo/packages/desktop/out/renderer/index.html",
          },
        ],
      ),
    ).toEqual([]);
  });
});
