/**
 * git.diff path validation: a pathspec that starts with `:` is git pathspec magic (`:/x`, `:(top)x`, `:!x`) and can
 * reach outside the workspace even after `--`. The path is refused before git runs. The Rust port
 * (`crates/workflow/src/world_git.rs`) carries the same rule, so the two stay in parity (ocr #563).
 */

import { describe, expect, it, vi } from "vitest";
import { gitDiffArgv } from "../src/app/workflow-git-world-read.js";

// The pure argv builder needs only the error class. Stubbing it keeps this unit test independent of the package build.
vi.mock("@zcode/dynamic-workflow", () => ({
  WorkflowError: class WorkflowError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));

describe("git.diff pathspec magic is refused", () => {
  it.each([":/x", ":(top)x", ":!x", ":"])("refuses the path %s before git runs", (path) => {
    expect(() => gitDiffArgv(undefined, path)).toThrow(/starts with ':'/u);
  });

  it("still accepts an ordinary workspace path", () => {
    expect(gitDiffArgv(undefined, "src/a.ts")).toEqual(["diff", "--relative", "HEAD", "--", "src/a.ts"]);
  });
});
