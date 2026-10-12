import { describe, expect, it } from "vitest";

import { sanitizeConversationShareIssues } from "../src/conversation-share/conversationShare.js";

describe("sanitizeConversationShareIssues", () => {
  it("保留正常 issue 的 artifactDisplayName", () => {
    const result = sanitizeConversationShareIssues([
      {
        code: "artifact_type_not_allowed",
        scope: "artifact",
        artifactDisplayName: "report.pdf",
        artifactType: "pdf",
        extension: "pdf",
        mimeType: "application/pdf",
      },
    ]);

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ artifactDisplayName: "report.pdf" });
    expect(result.omittedIssueCount).toBe(0);
  });

  // Bug root cause: when displayName contained a path/URL or was too long, the whole issue previously
  // returned null and got filtered out — sanitization exists to keep paths from leaking, not to drop the
  // entire diagnostic. Now only that field is stripped, preserving code/scope and other locating info.
  it.each([
    ["相对路径", "src/app.ts"],
    ["反斜杠路径", "src\\app.ts"],
    ["URL", "https://evil.example/report.pdf"],
    ["超过 128 字符", `${"a".repeat(129)}.pdf`],
  ])("displayName 是%s时只剥离该字段，不丢弃整条 issue", (_label, displayName) => {
    const result = sanitizeConversationShareIssues([
      {
        code: "artifact_type_not_allowed",
        scope: "artifact",
        artifactDisplayName: displayName,
        artifactType: "pdf",
        extension: "pdf",
        mimeType: "application/pdf",
      },
    ]);

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ code: "artifact_type_not_allowed", scope: "artifact" });
    expect(result.issues[0]).not.toHaveProperty("artifactDisplayName");
    expect(result.omittedIssueCount).toBe(0);
  });

  it("超过 5 条时仍按上限截断并报告省略数", () => {
    const issues = Array.from({ length: 7 }, (_, index) => ({
      code: "artifact_type_not_allowed" as const,
      scope: "artifact" as const,
      artifactDisplayName: `report-${index}.pdf`,
    }));
    const result = sanitizeConversationShareIssues(issues);

    expect(result.issues).toHaveLength(5);
    expect(result.issueCount).toBe(7);
    expect(result.omittedIssueCount).toBe(2);
  });
});
