import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractPrebuiltArchive,
  resolveTarExtractInvocation,
} from "../../../scripts/prebuilt-binary-extract.mjs";

const driveSpecPattern = /^[A-Za-z]:/u;

describe("resolveTarExtractInvocation", () => {
  it("keeps the drive letter out of the win32 archive argument across drives", () => {
    // Fork release run 41171314864: npm cache on D:, temporary cwd on C:.
    const invocation = resolveTarExtractInvocation({
      archivePath: "D:\\a\\ZCode\\ZCode\\node_modules\\.cache\\zcode-bundled-npm\\npm-12.2.0.tgz",
      cwd: "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\zcode-bundled-npm-VgueWv",
      extractDir: "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\zcode-bundled-npm-VgueWv",
      platform: "win32",
    });

    expect(invocation).toEqual({
      args: [
        "-xzf",
        "npm-12.2.0.tgz",
        "-C",
        "C:/Users/RUNNER~1/AppData/Local/Temp/zcode-bundled-npm-VgueWv",
      ],
      cwd: "D:\\a\\ZCode\\ZCode\\node_modules\\.cache\\zcode-bundled-npm",
    });
    expect(driveSpecPattern.test(invocation.args[1])).toBe(false);
  });

  it("resolves a relative win32 extract dir against the caller's cwd", () => {
    const invocation = resolveTarExtractInvocation({
      archivePath: "C:\\Temp\\zcode-prebuilt-binary-x\\archive.tar.gz",
      cwd: "D:\\repo",
      extractDir: "out\\extract",
      platform: "win32",
    });

    expect(invocation).toEqual({
      args: ["-xzf", "archive.tar.gz", "-C", "D:/repo/out/extract"],
      cwd: "C:\\Temp\\zcode-prebuilt-binary-x",
    });
  });

  it("resolves a relative win32 archive path against the caller's cwd", () => {
    const invocation = resolveTarExtractInvocation({
      archivePath: "deps\\native-search\\rg.tar.gz",
      cwd: "D:\\repo",
      extractDir: "C:\\Temp\\extract",
      platform: "win32",
    });

    expect(invocation).toEqual({
      args: ["-xzf", "rg.tar.gz", "-C", "C:/Temp/extract"],
      cwd: "D:\\repo\\deps\\native-search",
    });
  });

  it("leaves POSIX invocations unchanged", () => {
    const invocation = resolveTarExtractInvocation({
      archivePath: "/repo/node_modules/.cache/zcode-bundled-npm/npm-12.2.0.tgz",
      cwd: "/tmp/zcode-bundled-npm-abc",
      extractDir: "/tmp/zcode-bundled-npm-abc",
      platform: "darwin",
    });

    expect(invocation).toEqual({
      args: [
        "-xzf",
        "/repo/node_modules/.cache/zcode-bundled-npm/npm-12.2.0.tgz",
        "-C",
        "/tmp/zcode-bundled-npm-abc",
      ],
      cwd: "/tmp/zcode-bundled-npm-abc",
    });
  });
});

describe.skipIf(process.platform === "win32")("extractPrebuiltArchive", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
    );
  });

  it("creates and extracts a relative extract dir under the caller's cwd", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-tar-invocation-"));
    tempRoots.push(root);
    const sourceDir = join(root, "source");
    await mkdir(sourceDir);
    await writeFile(join(sourceDir, "payload.txt"), "ok");
    const archivePath = join(root, "archive.tgz");
    execFileSync("tar", ["-czf", archivePath, "-C", sourceDir, "payload.txt"]);
    const relativeExtractDir = `extract-${process.pid}`;

    extractPrebuiltArchive({
      archiveExt: "tgz",
      archivePath,
      cwd: root,
      extractDir: relativeExtractDir,
    });

    expect(await readFile(join(root, relativeExtractDir, "payload.txt"), "utf8")).toBe("ok");
    expect(existsSync(join(process.cwd(), relativeExtractDir))).toBe(false);
  });
});
