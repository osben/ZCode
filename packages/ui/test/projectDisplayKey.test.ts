import { describe, expect, it } from "vitest";
import { buildProjectDisplayKey } from "../src/project-sidebar/projectDisplayKey.js";

describe("buildProjectDisplayKey", () => {
  it("scopes the key by host and project id", () => {
    expect(buildProjectDisplayKey({ id: "p1", hostId: "h1" })).toBe("project:h1:p1");
    expect(buildProjectDisplayKey({ id: "p1", hostId: "h2" })).not.toBe(
      buildProjectDisplayKey({ id: "p1", hostId: "h1" }),
    );
  });
});
