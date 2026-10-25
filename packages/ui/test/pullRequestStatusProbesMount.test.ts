import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("PullRequestStatusProbes mount", () => {
  it("is mounted exactly once in the shell layout", () => {
    const source = readFileSync(
      new URL("../src/app-shell/WorkspaceShellLayout.tsx", import.meta.url),
      "utf8",
    );
    expect(source.match(/<PullRequestStatusProbes\b/g)).toHaveLength(1);
  });
});
