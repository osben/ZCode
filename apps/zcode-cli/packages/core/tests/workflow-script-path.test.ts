// Model-facing path rendering for script files (docs/dynamic-workflow/launch.md "Script files").
//
// This pure function is pinned separately because the three model-facing surfaces (terminal notification, GetWorkflowRun, tool response) must all state
// **the same** path: whatever the model reads is what the next `Edit` and `AmendWorkflow`'s `path` will be. Once the relativization
// criterion drifts, the model edits a nonexistent file or receives an absolute path it cannot understand.
//
// All paths are built with `path.join` / `path.resolve`, so this set of cases pins the same rule on POSIX and Windows
// (separators and drive letters come from node:path itself).

import path from "node:path";
import { describe, expect, it } from "vitest";
import { describeWorkflowScriptPath } from "../src/tool/handlers/workflow-script-path.js";

const CWD = path.resolve(path.sep, "repo");

describe("describeWorkflowScriptPath", () => {
  it("工作目录之下：给工作区相对路径（模型接下来 Edit 用的就是这一种）", () => {
    const absolute = path.join(CWD, ".zcode", "workflow-drafts", "audit.dwf.ts");
    expect(describeWorkflowScriptPath(absolute, CWD)).toBe(
      path.join(".zcode", "workflow-drafts", "audit.dwf.ts"),
    );
  });

  it("工作目录之外：原样给绝对路径（相对写法会读起来像工作区里有这么个东西）", () => {
    const outside = path.resolve(path.sep, "elsewhere", "shared", "audit.dwf.ts");
    expect(describeWorkflowScriptPath(outside, CWD)).toBe(outside);
  });

  it("同级的兄弟目录也算目录外：`..` 开头的结果一律退回绝对路径", () => {
    const sibling = path.resolve(CWD, "..", "other-repo", "audit.dwf.ts");
    expect(describeWorkflowScriptPath(sibling, CWD)).toBe(sibling);
  });

  it("cwd 缺席或为空：无从相对化，原样给绝对路径", () => {
    const absolute = path.join(CWD, "audit.dwf.ts");
    expect(describeWorkflowScriptPath(absolute, undefined)).toBe(absolute);
    expect(describeWorkflowScriptPath(absolute, "")).toBe(absolute);
  });

  it("路径恰好等于工作目录：空串不是一个能 Edit 的文件名，退回绝对路径", () => {
    expect(describeWorkflowScriptPath(CWD, CWD)).toBe(CWD);
  });

  it("嵌套更深的工作目录：相对写法从工作目录起算，而不是从仓库根", () => {
    const nested = path.join(CWD, "apps", "cli");
    const absolute = path.join(nested, ".zcode", "workflow-drafts", "audit.dwf.ts");
    expect(describeWorkflowScriptPath(absolute, nested)).toBe(
      path.join(".zcode", "workflow-drafts", "audit.dwf.ts"),
    );
    // Same file, an outer working directory: the relative rendering grows accordingly while the absolute path stays unchanged — the journal stores the latter.
    expect(describeWorkflowScriptPath(absolute, CWD)).toBe(
      path.join("apps", "cli", ".zcode", "workflow-drafts", "audit.dwf.ts"),
    );
  });

  // Windows cross-drive: `path.relative` returns an absolute path, and the function's second criterion falls back to the original value on that basis.
  // Meaningful only when run on Windows (POSIX `path.relative` does not know drive letters).
  it.runIf(process.platform === "win32")("Windows 跨盘符：退回绝对路径", () => {
    expect(describeWorkflowScriptPath("D:\\\\drafts\\\\audit.dwf.ts", "C:\\\\repo")).toBe(
      "D:\\\\drafts\\\\audit.dwf.ts",
    );
  });
});
