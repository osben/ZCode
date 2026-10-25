import { describe, expect, it } from "vitest";
import { resolveWebRemoteControlRoutePath } from "#src/web-remote-control/index.js";

describe("resolveWebRemoteControlRoutePath", () => {
  it("when the route variable is injected, the page entry is fixed to /remote/v4 and the resource base may carry a version directory", () => {
    expect(
      resolveWebRemoteControlRoutePath({
        VITE_WEB_REMOTE_CONTROL_ROUTE_PATH: "/remote/v4",
        BASE_URL: "/remote/v4/3.13.0/",
      }),
    ).toBe("/remote/v4");
    expect(
      resolveWebRemoteControlRoutePath({
        VITE_WEB_REMOTE_CONTROL_ROUTE_PATH: "/remote/v4/",
        BASE_URL: "/remote/v4/latest/",
      }),
    ).toBe("/remote/v4");
  });

  it("when not injected or blank, falls back to deriving from BASE_URL, keeping Docker, v3, and the dev entry unchanged", () => {
    expect(resolveWebRemoteControlRoutePath({ BASE_URL: "/remote/v4/" })).toBe("/remote/v4");
    expect(
      resolveWebRemoteControlRoutePath({
        VITE_WEB_REMOTE_CONTROL_ROUTE_PATH: "   ",
        BASE_URL: "/remote/v3/",
      }),
    ).toBe("/remote/v3");
    expect(resolveWebRemoteControlRoutePath({ BASE_URL: "/" })).toBe("/remote");
  });
});
