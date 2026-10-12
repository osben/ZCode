// Host-side copy of "open dwf artifact as a file" (docs/dynamic-workflow/authoring.md "How the user sees them").
//
// ⚠ Terminology: artifact = the output a script publishes to the user via `artifact.*`, not the engine's `RunSettlement.artifact`.
//
// Pinning down four things:
//   1. Location: ~/.zcode/tmp/workflow-artifacts/<runId>-<digest>/<artifactId>-<digest>/v<N>/<name>, one copy per version;
//   2. Write only when the path is empty — the bytes of a version never change; an existing copy is either the same bytes or the user's own edit, and both are kept;
//   3. Every path segment provided by the renderer is sanitized, so nothing can be written outside this directory;
//   4. Shape and the cap (20 MiB, same as `artifact.file`) are validated once more on the host side.
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { dirname, join, relative, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setDataBaseDir } from "@zcode/services/node";
import {
  WORKFLOW_ARTIFACT_FILE_MAX_BYTES,
  materializeWorkflowArtifactFile,
} from "../src/main/workflowArtifactFile.js";

let tempRoot = "";

function artifactsRoot(): string {
  return join(tempRoot, ".zcode", "tmp", "workflow-artifacts");
}

/** run / artifact directory name: sanitized id plus the first 8 hex chars of the raw id's sha256 (same rule as the implementation). */
function segmentDir(id: string): string {
  return `${id}-${createHash("sha256").update(id, "utf8").digest("hex").slice(0, 8)}`;
}

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "zcode-dwf-artifact-file-"));
  setDataBaseDir(tempRoot);
});

afterEach(async () => {
  setDataBaseDir(null);
  await rm(tempRoot, { recursive: true, force: true });
});

describe("materializeWorkflowArtifactFile", () => {
  it("按 run / 产物 / 版本分目录写出这一版的字节", async () => {
    const result = await materializeWorkflowArtifactFile({
      runId: "dwfrun-1",
      artifactId: "report",
      version: 2,
      fileName: "report.md",
      bytes: bytesOf("# v2"),
    });

    expect(result.localPath).toBe(
      join(artifactsRoot(), segmentDir("dwfrun-1"), segmentDir("report"), "v2", "report.md"),
    );
    await expect(readFile(result.localPath, "utf8")).resolves.toBe("# v2");
  });

  it("路径已有文件时不覆盖：用户在外部编辑过的副本保留，再次打开还是同一个文件", async () => {
    const request = {
      runId: "dwfrun-1",
      artifactId: "report",
      version: 1,
      fileName: "report.md",
      bytes: bytesOf("# published"),
    };
    const first = await materializeWorkflowArtifactFile(request);
    await writeFile(first.localPath, "# edited by the user");

    const second = await materializeWorkflowArtifactFile(request);

    expect(second.localPath).toBe(first.localPath);
    await expect(readFile(second.localPath, "utf8")).resolves.toBe("# edited by the user");
  });

  it("同一版并发两次：两边拿到同一个路径，文件是完整的一份，不留临时文件", async () => {
    const request = {
      runId: "dwfrun-1",
      artifactId: "book",
      version: 1,
      fileName: "book.pdf",
      bytes: bytesOf("%PDF-1.7 whole"),
    };
    const [a, b] = await Promise.all([
      materializeWorkflowArtifactFile(request),
      materializeWorkflowArtifactFile(request),
    ]);

    expect(a.localPath).toBe(b.localPath);
    await expect(readFile(a.localPath, "utf8")).resolves.toBe("%PDF-1.7 whole");
    await expect(readdir(dirname(a.localPath))).resolves.toEqual(["book.pdf"]);
  });

  it("不同版本各落一份，互不覆盖", async () => {
    const v1 = await materializeWorkflowArtifactFile({
      runId: "dwfrun-1",
      artifactId: "report",
      version: 1,
      fileName: "report.md",
      bytes: bytesOf("one"),
    });
    const v2 = await materializeWorkflowArtifactFile({
      runId: "dwfrun-1",
      artifactId: "report",
      version: 2,
      fileName: "report.md",
      bytes: bytesOf("two"),
    });

    expect(v1.localPath).not.toBe(v2.localPath);
    await expect(readFile(v1.localPath, "utf8")).resolves.toBe("one");
    await expect(readFile(v2.localPath, "utf8")).resolves.toBe("two");
  });

  it("渲染器给的路径片段一律清洗：写不出 workflow-artifacts 目录", async () => {
    const result = await materializeWorkflowArtifactFile({
      runId: "../../escape",
      artifactId: "..",
      version: 1,
      fileName: "../../../etc/evil.md",
      bytes: bytesOf("x"),
    });

    expect(result.localPath.startsWith(artifactsRoot() + sep)).toBe(true);
    const segments = relative(artifactsRoot(), result.localPath).split(sep);
    expect(segments).toHaveLength(4);
    // No segment is `.` / `..`, and there are no hidden directories.
    expect(segments.every((segment) => !segment.startsWith("."))).toBe(true);
    expect(segments.at(-1)).toBe("evil.md");
  });

  it("文件名保留 Unicode 与扩展名，只替换各平台的非法字符", async () => {
    const result = await materializeWorkflowArtifactFile({
      runId: "dwfrun-1",
      artifactId: "sheet",
      version: 1,
      fileName: "季度:报告<草稿>?.xlsx",
      bytes: bytesOf("x"),
    });

    expect(result.localPath.endsWith(`${sep}季度_报告_草稿__.xlsx`)).toBe(true);
  });

  it("Windows 保留名与空文件名换成可用的名字", async () => {
    const reserved = await materializeWorkflowArtifactFile({
      runId: "dwfrun-1",
      artifactId: "a",
      version: 1,
      fileName: "CON.md",
      bytes: bytesOf("x"),
    });
    const empty = await materializeWorkflowArtifactFile({
      runId: "dwfrun-1",
      artifactId: "b",
      version: 1,
      fileName: "   ",
      bytes: bytesOf("x"),
    });

    expect(reserved.localPath.endsWith(`${sep}_CON.md`)).toBe(true);
    expect(empty.localPath.endsWith(`${sep}b`)).toBe(true);
  });

  // Reason for the fix (MR !2837 review CR-02): the directory name used to be just the sanitized artifact id. Two ids the engine
  // considers different could land in the same directory — macOS / Windows filesystems are case-insensitive by default (`Report` vs `report`),
  // and sanitization strips leading dots (`.notes` vs `notes`) — so a same-named file would hit the other's copy with EEXIST,
  // opening a different artifact (along with the user's edits).
  it("引擎认为不同的产物 id 各落各的目录：大小写不同、只差开头的点", async () => {
    for (const [first, second] of [
      ["Report", "report"],
      [".notes", "notes"],
    ] as const) {
      const a = await materializeWorkflowArtifactFile({
        runId: "dwfrun-1",
        artifactId: first,
        version: 1,
        fileName: "same.md",
        bytes: bytesOf(first),
      });
      const b = await materializeWorkflowArtifactFile({
        runId: "dwfrun-1",
        artifactId: second,
        version: 1,
        fileName: "same.md",
        bytes: bytesOf(second),
      });

      expect(a.localPath.toLowerCase()).not.toBe(b.localPath.toLowerCase());
      await expect(readFile(a.localPath, "utf8")).resolves.toBe(first);
      await expect(readFile(b.localPath, "utf8")).resolves.toBe(second);
    }
  });

  // The same rule also covers runId: ids minted by the CLI are `dwfrun-<uuid>` and cannot collide; but the IPC boundary only
  // validates a non-empty string, and directory uniqueness should not rely on that comment.
  it("只差大小写的两个 run id 各落各的目录", async () => {
    const a = await materializeWorkflowArtifactFile({
      runId: "Run-1",
      artifactId: "report",
      version: 1,
      fileName: "report.md",
      bytes: bytesOf("upper"),
    });
    const b = await materializeWorkflowArtifactFile({
      runId: "run-1",
      artifactId: "report",
      version: 1,
      fileName: "report.md",
      bytes: bytesOf("lower"),
    });

    expect(a.localPath.toLowerCase()).not.toBe(b.localPath.toLowerCase());
    await expect(readFile(a.localPath, "utf8")).resolves.toBe("upper");
    await expect(readFile(b.localPath, "utf8")).resolves.toBe("lower");
  });

  it("超过 20 MiB 的字节拒绝写（与 artifact.file 的上限同级）", async () => {
    await expect(
      materializeWorkflowArtifactFile({
        runId: "dwfrun-1",
        artifactId: "big",
        version: 1,
        fileName: "big.bin",
        bytes: new Uint8Array(WORKFLOW_ARTIFACT_FILE_MAX_BYTES + 1),
      }),
    ).rejects.toThrow(/too large/u);
  });

  it("形状不对的请求在碰磁盘之前就拒绝", async () => {
    const valid = {
      runId: "dwfrun-1",
      artifactId: "report",
      version: 1,
      fileName: "report.md",
      bytes: bytesOf("x"),
    };
    for (const bad of [
      { ...valid, version: 0 },
      { ...valid, version: 1.5 },
      { ...valid, runId: "" },
      { ...valid, artifactId: 3 },
      { ...valid, bytes: "not bytes" },
    ]) {
      await expect(materializeWorkflowArtifactFile(bad as unknown as typeof valid)).rejects.toThrow(
        /invalid/u,
      );
    }
    await expect(readdir(join(tempRoot, ".zcode"))).rejects.toThrow();
  });
});
