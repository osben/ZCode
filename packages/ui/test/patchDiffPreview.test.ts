import { describe, expect, it, vi } from "vitest";
import {
  countPatchFileDiffs,
  getPlainTextPatchFallbackLines,
  getPlainTextPatchPreviewLines,
  parseTruncatedMarkerOmittedLineCount,
} from "@/lib/patchDiffPreview.js";

describe("getPlainTextPatchFallbackLines", () => {
  it("falls back for created files whose unknown suffix resolves to plain text", () => {
    const patch = [
      "--- /dev/null",
      "+++ b/test.123",
      "@@ -0,0 +1,1 @@",
      "+123",
    ].join("\n");

    expect(getPlainTextPatchFallbackLines(patch)).toEqual(["+123"]);
  });

  it("falls back for created structured files so expansion never renders blank", () => {
    const patch = [
      "--- /dev/null",
      "+++ b/demo.json",
      "@@ -0,0 +1,1 @@",
      "+{}",
    ].join("\n");

    expect(getPlainTextPatchFallbackLines(patch)).toEqual(["+{}"]);
  });

  it("falls back for oversized patches to keep UI responsive", () => {
    const changedLines = Array.from(
      { length: 1_300 },
      (_, index) => `+line-${index + 1}`,
    );
    const patch = [
      "--- a/demo.json",
      "+++ b/demo.json",
      "@@ -0,0 +1,1300 @@",
      ...changedLines,
    ].join("\n");

    const fallback = getPlainTextPatchFallbackLines(patch);
    expect(fallback).toBeTruthy();
    expect(fallback?.[0]).toBe("+line-1");
    const truncatedMarkerLine = fallback?.find(
      (line) => parseTruncatedMarkerOmittedLineCount(line) !== null,
    );
    expect(truncatedMarkerLine).toBeTruthy();
    expect(parseTruncatedMarkerOmittedLineCount(truncatedMarkerLine ?? "")).toBe(
      501,
    );
    expect(fallback?.at(-1)).toBe("+line-1300");
    expect(fallback?.length).toBe(800);
  });

  it("falls back when hunk line numbers are deep in large files", () => {
    const patch = [
      "--- a/demo.json",
      "+++ b/demo.json",
      "@@ -1499,3 +1499,3 @@",
      " line-1499",
      "-old",
      "+new",
      " line-1501",
    ].join("\n");

    expect(getPlainTextPatchFallbackLines(patch)).toEqual([
      " line-1499",
      "-old",
      "+new",
      " line-1501",
    ]);
  });

  it("falls back for multi-file patches because PatchDiff only supports one file", () => {
    const patch = [
      "diff --git a/one.ts b/one.ts",
      "--- a/one.ts",
      "+++ b/one.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/two.ts b/two.ts",
      "--- a/two.ts",
      "+++ b/two.ts",
      "@@ -1 +1 @@",
      "-before",
      "+after",
    ].join("\n");

    expect(countPatchFileDiffs(patch)).toBe(2);
    expect(getPlainTextPatchFallbackLines(patch)).toEqual(
      expect.arrayContaining(["+new", "+after"]),
    );
  });

  it("falls back for hunk-only patches without file headers", () => {
    const patch = ["@@ -1 +1 @@", "-old", "+new"].join("\n");

    expect(countPatchFileDiffs(patch)).toBe(0);
    expect(getPlainTextPatchFallbackLines(patch)).toEqual(["-old", "+new"]);
  });

  it("falls back for apply_patch payloads instead of sending them to PatchDiff", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: demo.ts",
      "@@",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n");

    expect(countPatchFileDiffs(patch)).toBe(0);
    expect(getPlainTextPatchFallbackLines(patch)).toEqual([
      "-old",
      "+new",
      "*** End Patch",
    ]);
  });

  it("does not treat hunk text that starts with file headers as new files", () => {
    const patch = [
      "--- a/readme.md",
      "+++ b/readme.md",
      "@@ -1,3 +1,3 @@",
      " title",
      "-before",
      "+--- not a file header",
      " context",
    ].join("\n");

    expect(countPatchFileDiffs(patch)).toBe(1);
    expect(getPlainTextPatchFallbackLines(patch)).toBeNull();
  });

  it("falls back when the renderer mistakes a deleted SQL comment for another file", () => {
    // Bugfix regression: in a unified diff, the deletion marker `-` concatenated with an SQL comment `--` becomes `--- `.
    // @pierre/diffs mistakes it for a second file header; even when our own count is still 1, it must not be handed to PatchDiff.
    const patch = [
      "--- a/schema.sql",
      "+++ b/schema.sql",
      "@@ -1,2 +1,2 @@",
      "--- old table comment",
      "+-- new table comment",
      " SELECT 1;",
    ].join("\n");

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(countPatchFileDiffs(patch)).toBe(1);
      expect(getPlainTextPatchFallbackLines(patch)).toEqual([
        "--- old table comment",
        "+-- new table comment",
        " SELECT 1;",
      ]);
      // Bugfix regression: parse failure is normal degraded control flow; the parsed file or code content must not be written to the console.
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("counts multi-file patches without diff --git headers (ZCT-202606-183BF216)", () => {
    // Bugfix reproduction: the model edits multiple files at once via Edit/Write tools, and the resulting unified diff
    // has no `diff --git` prefix (only --- a/ +++ b/), and the line count declared in the hunk header is 1 more than the actual body.
    // The extra quota swallows the next file's "--- a/x" (leading '-' counts as a deletion) and "+++ b/x" (leading '+'
    // counts as an addition) into the current hunk, so later file headers are mistakenly consumed by consumeHunkBody and 3 files are counted as 1.
    // Misjudged as a single file, no fallback kicks in → the whole multi-file patch is sent to @pierre/diffs' PatchDiff →
    // it throws "Provided patch must contain exactly 1 file diff" → a whole-page error boundary.
    const patch = [
      "--- a/IProviderAppService.java",
      "+++ b/IProviderAppService.java",
      "@@ -5,3 +5,3 @@",
      " import lombok.RequiredArgsConstructor;",
      "-import com.pnm.old.DeprecatedService;",
      "+import com.pnm.new.NetworkTierAssembler;",
      "--- a/ProviderAppServiceImpl.java",
      "+++ b/ProviderAppServiceImpl.java",
      "@@ -30,3 +30,3 @@",
      "     @Autowired",
      "-    private OldRepo oldRepo;",
      "+    private NetworkTierJpaRepository networkTierJpaRepo;",
      "--- a/ProviderMgmtController.java",
      "+++ b/ProviderMgmtController.java",
      "@@ -95,2 +95,2 @@",
      "     @Override",
      "-    public Response<Void> old() { return null; }",
      "+    public Response<List<NetworkTierDTO>> listNetworkTiers() { return ok(); }",
    ].join("\n");

    expect(countPatchFileDiffs(patch)).toBe(3);
    // 多文件 patch 必须走轻量高亮 diff（剥掉 +/-/@@ 协议 marker、保留增删配色与语法高亮），
    // 绝不能整体交给 @pierre/diffs 的 PatchDiff——它只支持单文件，会抛 "exactly 1 file diff"。
    expect(getPlainTextPatchFallbackLines(patch)).not.toBeNull();
  });

  it("does not split a hunk when only a lone --- line appears in the body", () => {
    // Boundary guard: the body genuinely contains a line starting with `--- ` (but the next line is not `+++ `),
    // which does not form a file header pair, so it must still be counted as a single file and must not be hit by the new early-exit logic.
    const patch = [
      "--- a/doc.md",
      "+++ b/doc.md",
      "@@ -1,3 +1,3 @@",
      " heading",
      "-old text",
      "+--- a dash-prefixed sentence, not a header",
      " trailing",
    ].join("\n");

    expect(countPatchFileDiffs(patch)).toBe(1);
  });

  it("counts two-file patches without diff --git headers when hunk counts are exact", () => {
    // Even when the hunk line counts match the body exactly (no off-by-one), adjacent file headers should still be correctly recognized as a new file.
    const patch = [
      "--- a/first.ts",
      "+++ b/first.ts",
      "@@ -1,2 +1,2 @@",
      " keep",
      "-old",
      "+new",
      "--- a/second.ts",
      "+++ b/second.ts",
      "@@ -1,2 +1,2 @@",
      " keep",
      "-before",
      "+after",
    ].join("\n");

    expect(countPatchFileDiffs(patch)).toBe(2);
    // Also goes through the lightweight highlighted diff, not PatchDiff.
    expect(getPlainTextPatchFallbackLines(patch)).not.toBeNull();
  });

  it("can always build lightweight plain-text preview lines", () => {
    const patch = [
      "--- a/demo.json",
      "+++ b/demo.json",
      "@@ -2,3 +2,3 @@",
      " line-2",
      "-old",
      "+new",
      " line-4",
    ].join("\n");

    expect(getPlainTextPatchPreviewLines(patch)).toEqual([
      " line-2",
      "-old",
      "+new",
      " line-4",
    ]);
  });

  it("falls back for deleted plain text files and strips patch metadata", () => {
    const patch = [
      "--- a/demo.txt",
      "+++ /dev/null",
      "@@ -1,1 +0,0 @@",
      "-hello",
      "",
    ].join("\n");

    expect(getPlainTextPatchFallbackLines(patch)).toEqual(["-hello"]);
  });

  it("keeps created-file content lines whose text starts with plus markers", () => {
    const patch = [
      "--- /dev/null",
      "+++ b/demo.txt",
      "@@ -0,0 +1,3 @@",
      "+++ keep me",
      "++++ keep me too",
      "+plain",
    ].join("\n");

    expect(getPlainTextPatchFallbackLines(patch)).toEqual([
      "+++ keep me",
      "++++ keep me too",
      "+plain",
    ]);
  });

  it("keeps deleted-file content lines whose text starts with minus markers", () => {
    const patch = [
      "--- a/demo.txt",
      "+++ /dev/null",
      "@@ -1,3 +0,0 @@",
      "--- keep me",
      "---- keep me too",
      "-plain",
    ].join("\n");

    expect(getPlainTextPatchFallbackLines(patch)).toEqual([
      "--- keep me",
      "---- keep me too",
      "-plain",
    ]);
  });

  it("falls back for rename-only patches without hunks", () => {
    const patch = [
      "diff --git a/old.ts b/new.ts",
      "similarity index 100%",
      "rename from old.ts",
      "rename to new.ts",
      "",
    ].join("\n");

    expect(getPlainTextPatchFallbackLines(patch)).toEqual([
      "similarity index 100%",
      "rename from old.ts",
      "rename to new.ts",
    ]);
  });

  it("falls back for mode-only patches without hunks", () => {
    const patch = [
      "diff --git a/script.sh b/script.sh",
      "old mode 100644",
      "new mode 100755",
      "",
    ].join("\n");

    expect(getPlainTextPatchFallbackLines(patch)).toEqual([
      "old mode 100644",
      "new mode 100755",
    ]);
  });

  it("falls back for package manager lockfiles", () => {
    const patch = [
      "diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml",
      "--- a/pnpm-lock.yaml",
      "+++ b/pnpm-lock.yaml",
      "@@ -1,3 +1,3 @@",
      " lockfileVersion: '9.0'",
      "-pkg: 1.0.0",
      "+pkg: 1.0.1",
    ].join("\n");

    expect(getPlainTextPatchFallbackLines(patch)).toEqual([
      " lockfileVersion: '9.0'",
      "-pkg: 1.0.0",
      "+pkg: 1.0.1",
    ]);
  });

  it("falls back for shell script patches in packaged builds", () => {
    const patch = [
      "diff --git a/scripts/publish-release.sh b/scripts/publish-release.sh",
      "--- a/scripts/publish-release.sh",
      "+++ b/scripts/publish-release.sh",
      "@@ -1,3 +1,4 @@",
      " #!/usr/bin/env bash",
      " set -euo pipefail",
      "+pnpm build",
      " echo done",
    ].join("\n");

    expect(getPlainTextPatchFallbackLines(patch)).toEqual([
      " #!/usr/bin/env bash",
      " set -euo pipefail",
      "+pnpm build",
      " echo done",
    ]);
  });

  it("falls back for modified Gradle patches opened from edit file chips", () => {
    const patch = [
      "diff --git a/test.gradle b/test.gradle",
      "--- a/test.gradle",
      "+++ b/test.gradle",
      "@@ -1,3 +1,3 @@",
      " plugins {",
      "-    id 'java'",
      "+    id 'application'",
      " }",
    ].join("\n");

    expect(getPlainTextPatchFallbackLines(patch)).toEqual([
      " plugins {",
      "-    id 'java'",
      "+    id 'application'",
      " }",
    ]);
  });

  it("falls back for Gradle patches with unified diff timestamps", () => {
    const patch = [
      "diff --git a/test.gradle b/test.gradle",
      "--- a/test.gradle\t2026-05-13 16:00:00",
      "+++ b/test.gradle\t2026-05-13 16:01:00",
      "@@ -1,3 +1,3 @@",
      " plugins {",
      "-    id 'java'",
      "+    id 'application'",
      " }",
    ].join("\n");

    expect(getPlainTextPatchFallbackLines(patch)).toEqual([
      " plugins {",
      "-    id 'java'",
      "+    id 'application'",
      " }",
    ]);
  });
});
