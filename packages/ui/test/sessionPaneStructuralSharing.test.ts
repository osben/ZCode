import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("SessionPane workflow join tables", () => {
  it("keeps Map identity across streaming deltas via useStructurallySharedMemo", () => {
    const source = readFileSync(join(import.meta.dirname, "../src/v4/SessionPane.tsx"), "utf8");
    for (const builder of [
      "buildWorkflowGraphByToolCallId",
      "buildWorkflowFillGraphByRunId",
      "buildWorkflowDraftByToolCallId",
      "buildWorkflowSaveCandidatesByRunId",
    ]) {
      expect(source).toMatch(
        new RegExp(
          `useStructurallySharedMemo\\(\\s*${builder},\\s*snapshot\\?\\.rows\\.window`,
          "u",
        ),
      );
    }
  });
});
