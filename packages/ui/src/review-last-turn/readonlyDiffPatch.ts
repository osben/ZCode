import type { V4ConversationFileChangesResult } from "@zcode/shared/zcode-protocol-v4";

type ReadonlyDiffHunks = V4ConversationFileChangesResult["items"][number]["patches"];

/** Unified patch text for one file's read-only turn hunks (code viewer and Review "Last turn"). */
export function formatReadonlyDiffPatch(path: string, patches: ReadonlyDiffHunks): string {
  if (patches.length === 0) return "";
  const lines = [`--- a/${path}`, `+++ b/${path}`];
  for (const patch of patches) {
    lines.push(
      `@@ -${patch.oldStart},${patch.oldLines} +${patch.newStart},${patch.newLines} @@`,
      ...patch.lines,
    );
  }
  return lines.join("\n");
}
