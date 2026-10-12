import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFileService,
  FileExistenceCache,
  isSkippableWorkspaceFileListError,
} from "../src/file/fileService.js";
import { setDataBaseDir } from "../src/paths.js";
import {
  unpackWorkspaceFileEntries,
} from "@zcode/shared/workspaceFileEntriesCodec";
import type { IFileService } from "../src/file/file.js";

// Pull the full listing in chunks (semantically equivalent to the old single-call listWorkspaceFiles).
async function readAllPacked(service: IFileService, rootPath: string): Promise<string> {
  const total = await service.listWorkspaceFilesLength({ rootPath });
  let packed = "";
  for (let offset = 0; offset < total; offset += 1000) {
    packed += await service.listWorkspaceFilesRange({ rootPath, offset, length: 1000 });
  }
  return packed;
}

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  setDataBaseDir(null);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("FileExistenceCache", () => {
  it("写入新条目前主动删除所有过期条目", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const cache = new FileExistenceCache();

    try {
      cache.set("expired-a.pdf", true);
      cache.set("expired-b.pdf", false);
      expect(cache.size).toBe(2);

      now.mockReturnValue(61_001);
      cache.set("fresh.pdf", true);

      expect(cache.size).toBe(1);
      expect(cache.get("expired-a.pdf")).toBeUndefined();
      expect(cache.get("expired-b.pdf")).toBeUndefined();
      expect(cache.get("fresh.pdf")).toBe(true);
    } finally {
      now.mockRestore();
    }
  });

  it("最多保留 100 条并按 LRU 淘汰", () => {
    const cache = new FileExistenceCache();
    for (let index = 0; index < 100; index += 1) {
      cache.set(`file-${index}.pdf`, false);
    }

    expect(cache.get("file-0.pdf")).toBe(false);
    cache.set("file-100.pdf", true);

    expect(cache.size).toBe(100);
    expect(cache.get("file-0.pdf")).toBe(false);
    expect(cache.get("file-1.pdf")).toBeUndefined();
    expect(cache.get("file-100.pdf")).toBe(true);
  });
});

describe("fileService", () => {
  // ── readdir ──────────────────────────────────────────────────────

  describe("readdir", () => {
    it("lists directory entries, filters hidden files, sorts directories first then alphabetically", async () => {
      const rootPath = makeTempDir("zcode-readdir-");
      mkdirSync(join(rootPath, "src"));
      mkdirSync(join(rootPath, "assets"));
      mkdirSync(join(rootPath, ".hidden-dir"));
      writeFileSync(join(rootPath, "readme.md"), "# Hello");
      writeFileSync(join(rootPath, "package.json"), "{}");
      writeFileSync(join(rootPath, ".gitignore"), "node_modules");

      const service = createFileService();
      const entries = await service.readdir({ path: rootPath });

      expect(entries).toEqual([
        {
          name: "assets",
          path: join(rootPath, "assets"),
          type: "directory",
          isSymbolicLink: false,
        },
        {
          name: "src",
          path: join(rootPath, "src"),
          type: "directory",
          isSymbolicLink: false,
        },
        {
          name: "package.json",
          path: join(rootPath, "package.json"),
          type: "file",
          isSymbolicLink: false,
        },
        {
          name: "readme.md",
          path: join(rootPath, "readme.md"),
          type: "file",
          isSymbolicLink: false,
        },
      ]);
    });

    it("includes hidden files when requested", async () => {
      const rootPath = makeTempDir("zcode-readdir-hidden-");
      mkdirSync(join(rootPath, ".github"));
      mkdirSync(join(rootPath, "src"));
      writeFileSync(join(rootPath, ".gitignore"), "node_modules");
      writeFileSync(join(rootPath, "readme.md"), "# Hello");

      const service = createFileService();
      const entries = await service.readdir({ path: rootPath, includeHidden: true });

      expect(entries).toEqual([
        {
          name: ".github",
          path: join(rootPath, ".github"),
          type: "directory",
          isSymbolicLink: false,
        },
        {
          name: "src",
          path: join(rootPath, "src"),
          type: "directory",
          isSymbolicLink: false,
        },
        {
          name: ".gitignore",
          path: join(rootPath, ".gitignore"),
          type: "file",
          isSymbolicLink: false,
        },
        {
          name: "readme.md",
          path: join(rootPath, "readme.md"),
          type: "file",
          isSymbolicLink: false,
        },
      ]);
    });

    it("classifies symlinks to directories as directories", async () => {
      const rootPath = makeTempDir("zcode-readdir-symlink-dir-");
      const targetPath = join(rootPath, "target");
      const linkPath = join(rootPath, "linked-dir");
      mkdirSync(targetPath);
      symlinkSync(targetPath, linkPath, process.platform === "win32" ? "junction" : "dir");

      const service = createFileService();
      const entries = await service.readdir({ path: rootPath });

      expect(entries).toContainEqual({
        name: "linked-dir",
        path: linkPath,
        type: "directory",
        isSymbolicLink: true,
      });
    });

    it("marks symlink metadata for directory entries", async () => {
      const rootPath = makeTempDir("zcode-readdir-symlink-meta-");
      const targetPath = join(rootPath, "target");
      const linkPath = join(rootPath, "linked-dir");
      mkdirSync(targetPath);
      symlinkSync(targetPath, linkPath, process.platform === "win32" ? "junction" : "dir");

      const service = createFileService();
      const entries = await service.readdir({ path: rootPath });

      expect(entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "target",
            type: "directory",
            isSymbolicLink: false,
          }),
          expect.objectContaining({
            name: "linked-dir",
            type: "directory",
            isSymbolicLink: true,
          }),
        ]),
      );
    });

    it("returns empty array for an empty directory", async () => {
      const rootPath = makeTempDir("zcode-readdir-empty-");
      const service = createFileService();
      const entries = await service.readdir({ path: rootPath });
      expect(entries).toEqual([]);
    });
  });

  // ── stat ─────────────────────────────────────────────────────────

  describe("stat", () => {
    it("distinguishes files from directories", async () => {
      const rootPath = makeTempDir("zcode-stat-");
      const filePath = join(rootPath, "readme.md");
      writeFileSync(filePath, "# Hello");

      const service = createFileService();

      await expect(service.stat({ path: rootPath })).resolves.toEqual({
        path: rootPath,
        type: "directory",
      });
      await expect(service.stat({ path: filePath })).resolves.toEqual({
        path: filePath,
        type: "file",
        size: 7,
        mtimeMs: expect.any(Number),
      });
    });
  });

  describe("checkFilesExist", () => {
    it("并发返回文件存在性并把目录和缺失路径判为不可预览", async () => {
      const rootPath = makeTempDir("zcode-file-exists-");
      const filePath = join(rootPath, "report.pdf");
      const directoryPath = join(rootPath, "docs");
      const missingPath = join(rootPath, "missing.pdf");
      writeFileSync(filePath, "pdf");
      mkdirSync(directoryPath);

      await expect(
        createFileService().checkFilesExist({
          paths: [filePath, directoryPath, missingPath],
        }),
      ).resolves.toEqual([
        { path: filePath, exists: true },
        { path: directoryPath, exists: false },
        { path: missingPath, exists: false },
      ]);
    });

    it("正负结果缓存一分钟，过期后重新读取文件状态", async () => {
      const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
      const rootPath = makeTempDir("zcode-file-exists-cache-");
      const filePath = join(rootPath, "later.pdf");
      const service = createFileService();

      await expect(service.checkFilesExist({ paths: [filePath] })).resolves.toEqual([
        { path: filePath, exists: false },
      ]);
      writeFileSync(filePath, "created");

      now.mockReturnValue(60_999);
      await expect(service.checkFilesExist({ paths: [filePath] })).resolves.toEqual([
        { path: filePath, exists: false },
      ]);

      now.mockReturnValue(61_001);
      await expect(service.checkFilesExist({ paths: [filePath] })).resolves.toEqual([
        { path: filePath, exists: true },
      ]);
      now.mockRestore();
    });

    it("拒绝超过单批 15 个路径", async () => {
      const service = createFileService();
      await expect(
        service.checkFilesExist({
          paths: Array.from({ length: 16 }, (_, index) => `/tmp/file-${index}.pdf`),
        }),
      ).rejects.toThrow("15");
    });
  });

  // ── ensureConversationWorkspace ──────────────────────────────────

  describe("ensureConversationWorkspace", () => {
    it("creates the managed conversation workspace under the configured data root", async () => {
      const dataBaseDir = makeTempDir("zcode-conversation-workspace-");
      setDataBaseDir(dataBaseDir);
      const service = createFileService();
      const workspacePath = join(dataBaseDir, ".zcode", "workspace", "default");

      await expect(service.ensureConversationWorkspace()).resolves.toEqual({
        path: workspacePath,
        created: true,
        workspacePurpose: "conversation",
      });
      await expect(service.ensureConversationWorkspace()).resolves.toEqual({
        path: workspacePath,
        created: false,
        workspacePurpose: "conversation",
      });
      await expect(service.stat({ path: workspacePath })).resolves.toEqual({
        path: workspacePath,
        type: "directory",
      });
    });

    it("rejects a file collision without returning a half-created workspace", async () => {
      const dataBaseDir = makeTempDir("zcode-conversation-workspace-file-");
      setDataBaseDir(dataBaseDir);
      const workspaceRoot = join(dataBaseDir, ".zcode", "workspace");
      mkdirSync(workspaceRoot, { recursive: true });
      writeFileSync(join(workspaceRoot, "default"), "not a directory");

      await expect(createFileService().ensureConversationWorkspace()).rejects.toThrow(
        "Workspace path is not a directory",
      );
    });
  });

  // ── createScratchWorkspace ───────────────────────────────────────

  describe("createScratchWorkspace", () => {
    const scratchRoot = join(homedir(), "ZCodeProject");
    const testWorkspaceName = `zcode-file-service-test-${Date.now()}`;
    const testWorkspacePath = join(scratchRoot, testWorkspaceName);

    afterEach(() => {
      rmSync(testWorkspacePath, { recursive: true, force: true });
      rmSync(`${testWorkspacePath}-file`, { force: true });
    });

    it("creates a missing scratch workspace directory", async () => {
      const service = createFileService();

      await expect(service.createScratchWorkspace({ name: testWorkspaceName })).resolves.toEqual({
        path: testWorkspacePath,
      });
      await expect(service.stat({ path: testWorkspacePath })).resolves.toEqual({
        path: testWorkspacePath,
        type: "directory",
      });
      await expect(
        service.readdir({ path: testWorkspacePath, includeHidden: true }),
      ).resolves.toEqual([]);
    });

    it("succeeds idempotently when the directory already exists", async () => {
      mkdirSync(testWorkspacePath, { recursive: true });
      const service = createFileService();

      await expect(service.createScratchWorkspace({ name: testWorkspaceName })).resolves.toEqual({
        path: testWorkspacePath,
      });
    });

    it("throws when the target path conflicts with a file", async () => {
      const fileWorkspaceName = `${testWorkspaceName}-file`;
      const fileWorkspacePath = `${testWorkspacePath}-file`;
      mkdirSync(scratchRoot, { recursive: true });
      writeFileSync(fileWorkspacePath, "not a directory");
      const service = createFileService();

      await expect(service.createScratchWorkspace({ name: fileWorkspaceName })).rejects.toThrow();
    });
  });

  // ── readTextFile ─────────────────────────────────────────────────

  describe("readTextFile", () => {
    it("reads full content of a small text file", async () => {
      const rootPath = makeTempDir("zcode-readtext-");
      const filePath = join(rootPath, "hello.txt");
      writeFileSync(filePath, "Hello, world!");

      const service = createFileService();
      const result = await service.readTextFile({ path: filePath });

      expect(result.content).toBe("Hello, world!");
      expect(result.offset).toBe(0);
      expect(result.bytesRead).toBe(13);
      expect(result.totalBytes).toBe(13);
      expect(result.truncated).toBe(false);
      expect(result.isBinary).toBe(false);
    });

    it("returns empty content when offset exceeds file size", async () => {
      const rootPath = makeTempDir("zcode-readtext-offset-");
      const filePath = join(rootPath, "small.txt");
      writeFileSync(filePath, "abc");

      const service = createFileService();
      const result = await service.readTextFile({ path: filePath, offset: 100 });

      expect(result.content).toBe("");
      expect(result.bytesRead).toBe(0);
      expect(result.totalBytes).toBe(3);
      expect(result.truncated).toBe(false);
      expect(result.isBinary).toBe(false);
    });

    it("reads a slice with offset and length", async () => {
      const rootPath = makeTempDir("zcode-readtext-slice-");
      const filePath = join(rootPath, "data.txt");
      writeFileSync(filePath, "abcdefghij");

      const service = createFileService();
      const result = await service.readTextFile({ path: filePath, offset: 3, length: 4 });

      expect(result.content).toBe("defg");
      expect(result.offset).toBe(3);
      expect(result.bytesRead).toBe(4);
      expect(result.totalBytes).toBe(10);
      // Offset 3 + 4 bytes read = 7, total file size 10, more remains
      expect(result.truncated).toBe(true);
    });

    it("detects binary files and returns empty content", async () => {
      const rootPath = makeTempDir("zcode-readtext-binary-");
      const filePath = join(rootPath, "image.bin");
      // Build binary content containing many null bytes
      const binaryContent = Buffer.alloc(64, 0);
      writeFileSync(filePath, binaryContent);

      const service = createFileService();
      const result = await service.readTextFile({ path: filePath });

      expect(result.content).toBe("");
      expect(result.isBinary).toBe(true);
      expect(result.totalBytes).toBe(64);
    });

    it("truncates when file is larger than default read size", async () => {
      const rootPath = makeTempDir("zcode-readtext-large-");
      const filePath = join(rootPath, "large.txt");
      // Default read cap is 128KB; write 256KB of content
      const largeContent = "x".repeat(256 * 1024);
      writeFileSync(filePath, largeContent);

      const service = createFileService();
      const result = await service.readTextFile({ path: filePath });

      expect(result.bytesRead).toBe(128 * 1024);
      expect(result.totalBytes).toBe(256 * 1024);
      expect(result.truncated).toBe(true);
      expect(result.isBinary).toBe(false);
    });

    it("clamps length to MAX_TEXT_READ_BYTES (256KB)", async () => {
      const rootPath = makeTempDir("zcode-readtext-clamp-");
      const filePath = join(rootPath, "huge.txt");
      const content = "y".repeat(512 * 1024);
      writeFileSync(filePath, content);

      const service = createFileService();
      // Requesting 512KB; it should be truncated to 256KB
      const result = await service.readTextFile({ path: filePath, length: 512 * 1024 });

      expect(result.bytesRead).toBe(256 * 1024);
      expect(result.truncated).toBe(true);
    });

    it("throws when path is not a file", async () => {
      const rootPath = makeTempDir("zcode-readtext-dir-");

      const service = createFileService();
      await expect(service.readTextFile({ path: rootPath })).rejects.toThrow(/not a file/);
    });
  });

  // ── readFileRange ────────────────────────────────────────────────

  describe("readFileRange", () => {
    it("reads raw bytes at the requested offset", async () => {
      const rootPath = makeTempDir("zcode-readrange-");
      const filePath = join(rootPath, "doc.pdf");
      writeFileSync(filePath, Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]));

      const service = createFileService();
      const result = await service.readFileRange({ path: filePath, offset: 2, length: 4 });

      expect(result).toBeInstanceOf(Uint8Array);
      expect(Array.from(result)).toEqual([0x44, 0x46, 0x2d, 0x31]);
    });

    it("returns a short array when the range crosses EOF", async () => {
      const rootPath = makeTempDir("zcode-readrange-eof-");
      const filePath = join(rootPath, "doc.pdf");
      writeFileSync(filePath, Buffer.alloc(10, 7));

      const service = createFileService();
      const result = await service.readFileRange({ path: filePath, offset: 6, length: 64 });

      expect(result.length).toBe(4);
    });

    it("returns an empty array when offset exceeds file size", async () => {
      const rootPath = makeTempDir("zcode-readrange-offset-");
      const filePath = join(rootPath, "doc.pdf");
      writeFileSync(filePath, Buffer.alloc(3, 1));

      const service = createFileService();
      const result = await service.readFileRange({ path: filePath, offset: 100, length: 8 });

      expect(result.length).toBe(0);
    });

    it("clamps length to MAX_BINARY_READ_BYTES (1MB)", async () => {
      const rootPath = makeTempDir("zcode-readrange-clamp-");
      const filePath = join(rootPath, "large.pdf");
      writeFileSync(filePath, Buffer.alloc(1536 * 1024, 2));

      const service = createFileService();
      const result = await service.readFileRange({
        path: filePath,
        offset: 0,
        length: 2 * 1024 * 1024,
      });

      expect(result.length).toBe(1024 * 1024);
    });

    it("throws when path is not a file", async () => {
      const rootPath = makeTempDir("zcode-readrange-dir-");

      const service = createFileService();
      await expect(service.readFileRange({ path: rootPath, offset: 0, length: 8 })).rejects.toThrow(
        /not a file/,
      );
    });
  });

  // ── readMediaPreview ────────────────────────────────────────────

  describe("readMediaPreview", () => {
    it("reads image files as base64 previews with inferred media type", async () => {
      const rootPath = makeTempDir("zcode-readmedia-");
      const filePath = join(rootPath, "preview.png");
      writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

      const service = createFileService();
      const result = await service.readMediaPreview({ path: filePath });

      expect(result).toEqual({
        path: filePath,
        mediaType: "image/png",
        dataBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"),
        totalBytes: 4,
      });
    });

    it("rejects media previews that exceed the configured size limit", async () => {
      const rootPath = makeTempDir("zcode-readmedia-large-");
      const filePath = join(rootPath, "large.png");
      writeFileSync(filePath, Buffer.alloc(32, 1));

      const service = createFileService();
      await expect(service.readMediaPreview({ path: filePath, maxBytes: 16 })).rejects.toThrow(
        /too large/,
      );
    });

    it.each([
      ["clip.mp4", "video/mp4"],
      ["clip.mov", "video/quicktime"],
      ["clip.webm", "video/webm"],
      ["clip.m4v", "video/x-m4v"],
      ["song.mp3", "audio/mpeg"],
      ["song.wav", "audio/wav"],
      ["song.m4a", "audio/mp4"],
      ["song.ogg", "audio/ogg"],
      ["song.opus", "audio/opus"],
      ["song.flac", "audio/flac"],
      ["song.weba", "audio/webm"],
    ])("infers %s as %s", async (filename, mediaType) => {
      const rootPath = makeTempDir("zcode-readmedia-format-");
      const filePath = join(rootPath, filename);
      writeFileSync(filePath, Buffer.from([1, 2, 3]));

      const result = await createFileService().readMediaPreview({ path: filePath });

      expect(result.mediaType).toBe(mediaType);
    });
  });

  // ── readBinaryPreview ───────────────────────────────────────────

  describe("readBinaryPreview", () => {
    it("reads bounded binary files as base64 previews", async () => {
      const rootPath = makeTempDir("zcode-readbinary-");
      const filePath = join(rootPath, "workbook.xlsx");
      const content = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
      writeFileSync(filePath, content);

      const service = createFileService();
      const result = await service.readBinaryPreview({ path: filePath });

      expect(result).toEqual({
        path: filePath,
        dataBase64: content.toString("base64"),
        totalBytes: content.byteLength,
      });
    });

    it("rejects binary previews before reading files above the configured limit", async () => {
      const rootPath = makeTempDir("zcode-readbinary-large-");
      const filePath = join(rootPath, "large.docx");
      writeFileSync(filePath, Buffer.alloc(32, 1));

      const service = createFileService();

      await expect(service.readBinaryPreview({ path: filePath, maxBytes: 16 })).rejects.toThrow(
        /too large/,
      );
    });

    it("clamps custom binary preview limits to the 25 MB hard limit", async () => {
      const rootPath = makeTempDir("zcode-readbinary-hard-limit-");
      const filePath = join(rootPath, "oversized.xlsx");
      writeFileSync(filePath, Buffer.alloc(25 * 1024 * 1024 + 1, 1));

      const service = createFileService();

      await expect(
        service.readBinaryPreview({
          path: filePath,
          maxBytes: Number.MAX_SAFE_INTEGER,
        }),
      ).rejects.toThrow(/too large/);
    });

    it("rejects directories", async () => {
      const rootPath = makeTempDir("zcode-readbinary-dir-");
      const service = createFileService();

      await expect(service.readBinaryPreview({ path: rootPath })).rejects.toThrow(/not a file/);
    });
  });

  // ── listWorkspaceFiles ───────────────────────────────────────────

  describe("listWorkspaceFiles", () => {
    it("classifies unreadable or disappearing directories as skippable mention index errors", () => {
      for (const code of ["EACCES", "EPERM", "ENOENT"]) {
        expect(isSkippableWorkspaceFileListError({ code })).toBe(true);
      }

      expect(isSkippableWorkspaceFileListError({ code: "EIO" })).toBe(false);
      expect(isSkippableWorkspaceFileListError(new Error("boom"))).toBe(false);
    });

    it("traverses hidden directories while keeping default excluded directories pruned", async () => {
      const rootPath = makeTempDir("zcode-file-service-");
      mkdirSync(join(rootPath, "src"));
      mkdirSync(join(rootPath, "node_modules"));
      mkdirSync(join(rootPath, ".git"));
      mkdirSync(join(rootPath, ".github", "workflows"), { recursive: true });
      writeFileSync(join(rootPath, "package.json"), "{}");
      writeFileSync(join(rootPath, ".gitignore"), "dist/\n");
      writeFileSync(join(rootPath, ".env"), "SECRET=123");
      writeFileSync(join(rootPath, ".env.local"), "SECRET=456");
      writeFileSync(join(rootPath, "src", "index.ts"), "export {};");
      writeFileSync(join(rootPath, "node_modules", "ignore-me.js"), "");
      writeFileSync(join(rootPath, ".git", "HEAD"), "ref: refs/heads/main");
      writeFileSync(join(rootPath, ".github", "workflows", "release.yml"), "name: release");

      const service = createFileService();
      const entries = unpackWorkspaceFileEntries(await readAllPacked(service, rootPath), rootPath);

      expect(entries).toEqual([
        {
          name: "src",
          path: join(rootPath, "src"),
          relativePath: "src",
          type: "directory",
        },
        {
          name: "release.yml",
          path: join(rootPath, ".github", "workflows", "release.yml"),
          relativePath: ".github/workflows/release.yml",
          type: "file",
        },
        {
          name: ".gitignore",
          path: join(rootPath, ".gitignore"),
          relativePath: ".gitignore",
          type: "file",
        },
        {
          name: "package.json",
          path: join(rootPath, "package.json"),
          relativePath: "package.json",
          type: "file",
        },
        {
          name: "index.ts",
          path: join(rootPath, "src", "index.ts"),
          relativePath: "src/index.ts",
          type: "file",
        },
      ]);
    });

    it("skips common generated cache and dependency directories across ecosystems", async () => {
      const rootPath = makeTempDir("zcode-file-service-generated-dirs-");
      const skippedDirectories = [
        ["__pycache__", "module.cpython-312.pyc"],
        ["coverage", "lcov.info"],
        ["htmlcov", "index.html"],
        ["lcov-report", "index.html"],
        ["bower_components", "dependency.js"],
        ["jspm_packages", "dependency.js"],
        ["Pods", "Manifest.lock"],
        ["CMakeFiles", "compiler_depend.make"],
        ["cmake-build-debug", "CMakeCache.txt"],
        ["bazel-out", "artifact.o"],
        ["DerivedData", "Build.db"],
        ["storybook-static", "iframe.html"],
        ["playwright-report", "index.html"],
        ["test-results", "trace.zip"],
        ["allure-results", "result.json"],
        ["allure-report", "index.html"],
        ["cdk.out", "manifest.json"],
        ["eggs", "package.egg"],
        ["pip-wheel-metadata", "metadata.json"],
        ["wheels", "package.whl"],
        ["package.egg-info", "PKG-INFO"],
        ["package.dist-info", "METADATA"],
      ];
      mkdirSync(join(rootPath, "src"));
      writeFileSync(join(rootPath, "src", "index.ts"), "export {};");
      for (const [directoryName, fileName] of skippedDirectories) {
        mkdirSync(join(rootPath, directoryName), { recursive: true });
        writeFileSync(join(rootPath, directoryName, fileName), "");
      }

      const service = createFileService();
      const entries = unpackWorkspaceFileEntries(await readAllPacked(service, rootPath), rootPath);

      expect(entries).toEqual([
        {
          name: "src",
          path: join(rootPath, "src"),
          relativePath: "src",
          type: "directory",
        },
        {
          name: "index.ts",
          path: join(rootPath, "src", "index.ts"),
          relativePath: "src/index.ts",
          type: "file",
        },
      ]);
    });

    it("skips standalone compiled and cache file artifacts", async () => {
      const rootPath = makeTempDir("zcode-file-service-generated-files-");
      const skippedFileNames = [
        "module.pyc",
        "module.pyo",
        "Main.class",
        "object.o",
        "library.obj",
        "archive.a",
        "library.lib",
        "addon.node",
        "library.so",
        "library.dylib",
        "library.dll",
        "program.exe",
        "program.pdb",
        "coverage.gcda",
        "coverage.profraw",
        "coverage.out",
        "lcov.info",
        "package.jar",
        "package.war",
        "package.aar",
        "package.nupkg",
        "package.gem",
        "module.beam",
        "module.hi",
        "library.rlib",
        "tsconfig.tsbuildinfo",
      ];
      writeFileSync(join(rootPath, "src.ts"), "export {};");
      for (const fileName of skippedFileNames) {
        writeFileSync(join(rootPath, fileName), "");
      }

      const service = createFileService();
      const entries = unpackWorkspaceFileEntries(await readAllPacked(service, rootPath), rootPath);

      expect(entries.map((entry) => entry.relativePath)).toEqual(["src.ts"]);
    });

    it("keeps user-maintained directories and distributable assets searchable", async () => {
      const rootPath = makeTempDir("zcode-file-service-user-maintained-");
      const includedDirectories = [
        "vendor",
        "env",
        "dist",
        "build",
        "out",
        "target",
        "bin",
        "obj",
        "classes",
        "_build",
        "deps",
        "dist-newstyle",
        "renv",
      ];
      for (const directoryName of includedDirectories) {
        mkdirSync(join(rootPath, directoryName));
        writeFileSync(join(rootPath, directoryName, "kept.txt"), "");
      }
      for (const fileName of ["bundle.js.map", "app.min.js", "style.min.css"]) {
        writeFileSync(join(rootPath, fileName), "");
      }

      const service = createFileService();
      const entries = unpackWorkspaceFileEntries(await readAllPacked(service, rootPath), rootPath);
      const relativePaths = entries.map((entry) => entry.relativePath);

      for (const directoryName of includedDirectories) {
        expect(relativePaths).toContain(directoryName);
        expect(relativePaths).toContain(`${directoryName}/kept.txt`);
      }
      expect(relativePaths).toEqual(
        expect.arrayContaining(["bundle.js.map", "app.min.js", "style.min.css"]),
      );
    });

    it("classifies directory symlinks before filtering without traversing them", async () => {
      const rootPath = makeTempDir("zcode-file-service-symlink-");
      const targetPath = makeTempDir("zcode-file-service-symlink-target-");
      const linkPath = join(rootPath, "linked-dir");
      writeFileSync(join(targetPath, "outside.ts"), "");
      symlinkSync(targetPath, linkPath, process.platform === "win32" ? "junction" : "dir");
      const evaluatedTypes: string[] = [];

      const service = createFileService({
        workspaceFileSearchFilter: {
          evaluate: (entry) => {
            evaluatedTypes.push(entry.type);
            return { include: true, traverse: true };
          },
        },
      });
      const entries = unpackWorkspaceFileEntries(await readAllPacked(service, rootPath), rootPath);

      expect(evaluatedTypes).toEqual(["directory"]);
      expect(entries).toEqual([
        {
          name: "linked-dir",
          path: linkPath,
          relativePath: "linked-dir",
          type: "directory",
        },
      ]);
    });

    it("uses an injected filter as a complete replacement for the default filter", async () => {
      const rootPath = makeTempDir("zcode-file-service-custom-filter-");
      mkdirSync(join(rootPath, "node_modules"));
      writeFileSync(join(rootPath, "node_modules", "package.js"), "");
      writeFileSync(join(rootPath, ".env"), "SECRET=123");
      // A preset empty .zcodeignore isolates the ignore-rule layer: this test specifically covers the
      // legacy contract of "an injected filter fully replacing builtin filtering"; .zcodeignore pruning
      // is covered by separate tests.
      writeFileSync(join(rootPath, ".zcodeignore"), "\n");

      const service = createFileService({
        workspaceFileSearchFilter: {
          evaluate: (entry) => ({
            include: true,
            traverse: entry.type === "directory",
          }),
        },
      });
      const entries = unpackWorkspaceFileEntries(await readAllPacked(service, rootPath), rootPath);

      expect(entries.map((entry) => entry.relativePath)).toEqual([
        "node_modules",
        ".env",
        "node_modules/package.js",
      ]);
    });

    it("allows an injected filter to exclude every entry", async () => {
      const rootPath = makeTempDir("zcode-file-service-exclude-filter-");
      mkdirSync(join(rootPath, "src"));
      writeFileSync(join(rootPath, "src", "index.ts"), "");

      const service = createFileService({
        workspaceFileSearchFilter: {
          evaluate: () => ({ include: false, traverse: false }),
        },
      });

      expect(unpackWorkspaceFileEntries(await readAllPacked(service, rootPath), rootPath)).toEqual([]);
    });

    it("returns empty array when hidden directory descendants and env files provide no candidates", async () => {
      const rootPath = makeTempDir("zcode-file-service-hidden-");
      mkdirSync(join(rootPath, ".vscode"));
      writeFileSync(join(rootPath, ".env"), "SECRET=123");

      const service = createFileService();
      const entries = unpackWorkspaceFileEntries(await readAllPacked(service, rootPath), rootPath);

      expect(entries).toEqual([]);
    });

    it("sorts results by relativePath", async () => {
      const rootPath = makeTempDir("zcode-file-service-sort-");
      mkdirSync(join(rootPath, "b"));
      mkdirSync(join(rootPath, "a"));
      writeFileSync(join(rootPath, "b", "z.ts"), "");
      writeFileSync(join(rootPath, "a", "x.ts"), "");
      writeFileSync(join(rootPath, "root.ts"), "");

      const service = createFileService();
      const entries = unpackWorkspaceFileEntries(await readAllPacked(service, rootPath), rootPath);
      const relativePaths = entries.map((e) => e.relativePath);

      expect(relativePaths).toEqual(["a", "b", "a/x.ts", "b/z.ts", "root.ts"]);
    });

    // .zcodeignore single source of truth (spec addendum 2026-09-15): the only source of directory-exclusion rules.
    describe(".zcodeignore", () => {
      it("prunes gitignored build directories like obj and bin (ZCT-2096811705629528064)", async () => {
        const rootPath = makeTempDir("zcode-file-service-dotnet-");
        writeFileSync(join(rootPath, ".gitignore"), "obj/\nbin/\n");
        mkdirSync(join(rootPath, "obj", "Debug"), { recursive: true });
        mkdirSync(join(rootPath, "bin", "Release"), { recursive: true });
        mkdirSync(join(rootPath, "src"));
        writeFileSync(join(rootPath, "obj", "Debug", "fake.pdb"), "");
        writeFileSync(join(rootPath, "obj", "Debug", "marker.cs"), "");
        writeFileSync(join(rootPath, "bin", "Release", "app.dll"), "");
        writeFileSync(join(rootPath, "src", "Program.cs"), "");

        const service = createFileService();
        const entries = unpackWorkspaceFileEntries(await readAllPacked(service, rootPath), rootPath);

        // Auto-creation is temporarily disabled; the in-memory gitignore + default rules still prune obj/bin.
        expect(entries.map((e) => e.relativePath)).toEqual([
          "src",
          ".gitignore",
          "src/Program.cs",
        ]);
        // The rule file itself is tool configuration and does not become a candidate.
        expect(existsSync(join(rootPath, ".zcodeignore"))).toBe(false);
      });

      it("uses .gitignore plus builtin defaults without creating .zcodeignore", async () => {
        const rootPath = makeTempDir("zcode-file-service-create-");
        writeFileSync(join(rootPath, ".gitignore"), "dist/\n");
        mkdirSync(join(rootPath, "node_modules", "pkg"), { recursive: true });
        mkdirSync(join(rootPath, "dist"));
        writeFileSync(join(rootPath, "node_modules", "pkg", "index.js"), "");
        writeFileSync(join(rootPath, "dist", "bundle.js"), "");

        const service = createFileService();
        const entries = unpackWorkspaceFileEntries(await readAllPacked(service, rootPath), rootPath);

        // .gitignore does not declare node_modules: the in-memory default section still prunes it (behavior compatible).
        expect(entries.map((e) => e.relativePath)).toEqual([".gitignore"]);
        expect(existsSync(join(rootPath, ".zcodeignore"))).toBe(false);
      });

      it("dedupes builtin defaults against gitignore rules on creation", async () => {
        const rootPath = makeTempDir("zcode-file-service-create-dedupe-");
        // .gitignore declares node_modules/ (one test entry per trailing-slash spelling variant).
        writeFileSync(join(rootPath, ".gitignore"), "node_modules/\ncoverage\n");
        mkdirSync(join(rootPath, "node_modules"));
        writeFileSync(join(rootPath, "node_modules", "x.js"), "");
        writeFileSync(join(rootPath, "keep.ts"), "");

        const service = createFileService();
        const preview = await service.readWorkspaceFileSearchIgnore({ rootPath });
        await service.writeWorkspaceFileSearchIgnore({ rootPath, content: preview.content });
        const entries = unpackWorkspaceFileEntries(await readAllPacked(service, rootPath), rootPath);

        // Dedup: the gitignore section already has node_modules/ and coverage, so the default section
        // does not repeat them — at most one copy of each rule in the file; deleting the gitignore-section
        // line fully re-enables it.
        const created = readFileSync(join(rootPath, ".zcodeignore"), "utf8");
        expect(created.match(/^node_modules\/$/gm)).toHaveLength(1);
        expect(created.match(/^coverage\/?$/gm)).toHaveLength(1);
        // Pruning still applies (the gitignore-section rule is doing the work); .gitignore itself stays searchable.
        expect(entries.map((e) => e.relativePath)).toEqual([".gitignore", "keep.ts"]);
      });

      it("uses builtin defaults without creating .zcodeignore when no .gitignore exists", async () => {
        const rootPath = makeTempDir("zcode-file-service-create-no-gitignore-");
        mkdirSync(join(rootPath, "node_modules"));
        writeFileSync(join(rootPath, "node_modules", "x.js"), "");
        writeFileSync(join(rootPath, "keep.ts"), "");

        const service = createFileService();
        const entries = unpackWorkspaceFileEntries(await readAllPacked(service, rootPath), rootPath);

        expect(entries.map((e) => e.relativePath)).toEqual(["keep.ts"]);
        expect(existsSync(join(rootPath, ".zcodeignore"))).toBe(false);
      });

      it("honors gitignore semantics: negation, anchored patterns and directory suffix", async () => {
        const rootPath = makeTempDir("zcode-file-service-semantics-");
        mkdirSync(join(rootPath, "logs"));
        mkdirSync(join(rootPath, "sub", "build"), { recursive: true });
        mkdirSync(join(rootPath, "build"));
        writeFileSync(
          join(rootPath, ".zcodeignore"),
          ["logs/*", "!logs/keep.log", "/build", "*.tmp"].join("\n"),
        );
        writeFileSync(join(rootPath, "logs", "keep.log"), "");
        writeFileSync(join(rootPath, "logs", "drop.log"), "");
        writeFileSync(join(rootPath, "build", "root-only.txt"), "");
        writeFileSync(join(rootPath, "sub", "build", "nested.txt"), "");
        writeFileSync(join(rootPath, "scratch.tmp"), "");
        writeFileSync(join(rootPath, "main.ts"), "");

        const service = createFileService();
        const entries = unpackWorkspaceFileEntries(await readAllPacked(service, rootPath), rootPath);

        // The ! negation restores logs/keep.log; the anchored /build only prunes the root build while
        // sub/build stays; *.tmp excludes files.
        // logs/* does not exclude the logs directory itself (git semantics: only matches its contents).
        expect(entries.map((e) => e.relativePath)).toEqual([
          "logs",
          "sub",
          "sub/build",
          "logs/keep.log",
          "main.ts",
          "sub/build/nested.txt",
        ]);
      });

      it("lets users re-include builtin defaults by editing .zcodeignore (single source of truth)", async () => {
        const rootPath = makeTempDir("zcode-file-service-reinclude-");
        mkdirSync(join(rootPath, "node_modules", "pkg"), { recursive: true });
        writeFileSync(join(rootPath, "node_modules", "pkg", "index.js"), "");
        // The user explicitly negates a builtin default exclusion: node_modules must become searchable again (no code-level union).
        writeFileSync(join(rootPath, ".zcodeignore"), "!node_modules/\n");

        const service = createFileService();
        const entries = unpackWorkspaceFileEntries(await readAllPacked(service, rootPath), rootPath);

        expect(entries.map((e) => e.relativePath)).toEqual([
          "node_modules",
          "node_modules/pkg",
          "node_modules/pkg/index.js",
        ]);
      });

      it("reads and writes the ignore file via service RPC methods", async () => {
        const rootPath = makeTempDir("zcode-file-service-rpc-");
        writeFileSync(join(rootPath, ".gitignore"), "out/\n");

        const service = createFileService();
        const initial = await service.readWorkspaceFileSearchIgnore({ rootPath });
        // Not yet persisted: preview the initial content (gitignore copy + default section).
        expect(initial.source).toBe("template");
        expect(initial.content).toContain("out/");
        expect(existsSync(join(rootPath, ".zcodeignore"))).toBe(false);

        await service.writeWorkspaceFileSearchIgnore({ rootPath, content: "custom/\n" });
        const afterWrite = await service.readWorkspaceFileSearchIgnore({ rootPath });
        expect(afterWrite.source).toBe("file");
        expect(afterWrite.content).toBe("custom/\n");

        mkdirSync(join(rootPath, "custom"));
        writeFileSync(join(rootPath, "custom", "x.txt"), "");
        writeFileSync(join(rootPath, "ok.txt"), "");
        const entries = unpackWorkspaceFileEntries(await readAllPacked(service, rootPath), rootPath);
        // custom/ is pruned by the written rule; .gitignore itself stays searchable (existing behavior).
        expect(entries.map((e) => e.relativePath)).toEqual([".gitignore", "ok.txt"]);
      });

      it("syncs only the gitignore section while keeping defaults and custom rules", async () => {
        const rootPath = makeTempDir("zcode-file-service-section-sync-");
        writeFileSync(join(rootPath, ".gitignore"), "out/\n");

        const service = createFileService();
        const initial = await service.readWorkspaceFileSearchIgnore({ rootPath });
        await service.writeWorkspaceFileSearchIgnore({ rootPath, content: initial.content });

        // The user removes node_modules/ from the defaults section (re-enabling it) and appends their own rule to the custom section.
        const edited = initial.content
          .replace("node_modules/\n", "")
          .concat("my-private-assets/\n");
        await service.writeWorkspaceFileSearchIgnore({ rootPath, content: edited });

        // Sync after a .gitignore update: only the gitignore section is rewritten.
        writeFileSync(join(rootPath, ".gitignore"), "out/\nnewdir/\n");
        const synced = await service.applyWorkspaceFileSearchIgnoreTransform({
          rootPath,
          transform: "sync-gitignore",
        });
        expect(synced.content).toContain("newdir/");
        // Both the user's defaults-section edit (node_modules re-enabled) and the custom rule must survive.
        expect(synced.content).not.toContain("node_modules/");
        expect(synced.content).toContain("my-private-assets/");
      });

      it("resets only the defaults section while keeping gitignore and custom rules", async () => {
        const rootPath = makeTempDir("zcode-file-service-section-reset-");
        writeFileSync(join(rootPath, ".gitignore"), "out/\n");

        const service = createFileService();
        const initial = await service.readWorkspaceFileSearchIgnore({ rootPath });
        const edited = initial.content
          .replace("node_modules/\n", "")
          .concat("my-private-assets/\n");
        await service.writeWorkspaceFileSearchIgnore({ rootPath, content: edited });

        const reset = await service.applyWorkspaceFileSearchIgnoreTransform({
          rootPath,
          transform: "reset-defaults",
        });
        // The defaults section resets to factory state (node_modules/ comes back).
        expect(reset.content).toContain("node_modules/");
        // The gitignore section and the custom section are kept as-is.
        expect(reset.content).toContain("out/");
        expect(reset.content).toContain("my-private-assets/");
      });

      it("reset re-adds builtin rule after it was removed from .gitignore", async () => {
        const rootPath = makeTempDir("zcode-file-service-reset-readd-");
        // At creation the gitignore declared node_modules/ → dedup kept it out of the defaults section.
        writeFileSync(join(rootPath, ".gitignore"), "node_modules/\n");
        const service = createFileService();
        const initial = await service.readWorkspaceFileSearchIgnore({ rootPath });
        expect(initial.content.match(/^node_modules\/$/gm)).toHaveLength(1);

        // After the user removes that line from .gitignore and resets defaults: the defaults section is
        // recomputed against the new gitignore and the builtin fallback is restored.
        writeFileSync(join(rootPath, ".gitignore"), "");
        await service.writeWorkspaceFileSearchIgnore({ rootPath, content: initial.content });
        const reset = await service.applyWorkspaceFileSearchIgnoreTransform({
          rootPath,
          transform: "reset-defaults",
        });
        expect(reset.content.match(/^node_modules\/$/gm)).toHaveLength(1);
      });

      it("falls back to full template rebuild when section markers are missing", async () => {
        const rootPath = makeTempDir("zcode-file-service-section-fallback-");
        writeFileSync(join(rootPath, ".gitignore"), "out/\n");
        // The user deleted the section markers (legacy format / manual cleanup), so sections cannot be located structurally.
        writeFileSync(join(rootPath, ".zcodeignore"), "legacy-rules/\n");

        const service = createFileService();
        const synced = await service.applyWorkspaceFileSearchIgnoreTransform({
          rootPath,
          transform: "sync-gitignore",
        });
        // Degrade to rebuilding the whole initial content (with new markers); MRs/docs note that marker lines must not be deleted.
        expect(synced.content).toContain("out/");
        expect(synced.content).toContain("node_modules/");
        expect(synced.content).not.toContain("legacy-rules/");
      });
    });
  });
});
