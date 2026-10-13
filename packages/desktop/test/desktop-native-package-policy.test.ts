import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDesktopNativePackagePrunePatterns,
  findDesktopNativePackageViolations,
  isTargetTranscribePlatformPackage,
  parseAsarListWithPackState,
  removeNonTargetPlatformNativePackages,
} from "../scripts/desktop-native-package-policy.mjs";

describe("desktop native package policy", () => {
  it("应裁剪 Canvas、node-pty 安装机产物和所有非目标平台 prebuild", () => {
    const patterns = createDesktopNativePackagePrunePatterns("darwin-arm64");

    expect(patterns).toContain("!node_modules/@napi-rs/canvas/**");
    expect(patterns).toContain("!node_modules/@napi-rs/canvas-*/**");
    expect(patterns).toContain("!node_modules/@lydell/node-pty-*/**");
    expect(patterns).toContain("!node_modules/node-pty/build/**");
    expect(patterns).toContain("!node_modules/node-pty/bin/**");
    expect(patterns).toContain("!node_modules/node-pty/prebuilds/darwin-x64/**");
    expect(patterns).toContain("!node_modules/node-pty/prebuilds/win32-arm64/**");
    expect(patterns).not.toContain("!node_modules/node-pty/prebuilds/darwin-arm64/**");
  });

  it("应只保留目标平台的 transcribe-cpp 原生包与 koffi 二进制", () => {
    const patterns = createDesktopNativePackagePrunePatterns("darwin-arm64");

    // Bugfix: @transcribe-cpp 平台包名单个可达 60MB，koffi 单包携带全部平台二进制，
    // 都必须按目标平台裁剪（包名前缀 <os>-<arch>-，koffi 目录名用下划线）。
    expect(patterns).toContain("!node_modules/@transcribe-cpp/darwin-x64-*/**");
    expect(patterns).toContain("!node_modules/@transcribe-cpp/linux-x64-*/**");
    expect(patterns).toContain("!node_modules/@transcribe-cpp/win32-x64-*/**");
    expect(patterns).not.toContain("!node_modules/@transcribe-cpp/darwin-arm64-*/**");
    expect(patterns).toContain("!node_modules/koffi/build/koffi/**");
    expect(patterns).toContain("node_modules/koffi/build/koffi/darwin_arm64/**");
  });

  it("应接受仅包含目标平台且正确 unpack 的 native 资源", () => {
    const entries = parseAsarListWithPackState(
      [
        "unpack : /node_modules/node-pty/prebuilds/darwin-arm64/pty.node",
        "unpack : /node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper",
        "pack   : /node_modules/node-pty/package.json",
        "unpack : /node_modules/@transcribe-cpp/darwin-arm64-metal/libtranscribe.dylib",
        "unpack : /node_modules/@transcribe-cpp/darwin-arm64-metal/libggml.dylib",
        "pack   : /node_modules/@transcribe-cpp/darwin-arm64-metal/contract.json",
        "unpack : /node_modules/koffi/build/koffi/darwin_arm64/koffi.node",
        "pack   : /node_modules/koffi/index.js",
      ].join("\n"),
    );

    expect(findDesktopNativePackageViolations(entries, "darwin-arm64")).toEqual([]);
  });

  it("应同时拒绝跨平台包、安装机产物和仍留在 asar payload 的 native", () => {
    const entries = parseAsarListWithPackState(
      [
        "pack   : \\node_modules\\@napi-rs\\canvas-win32-x64-msvc\\skia.node",
        "unpack : /node_modules/@lydell/node-pty-linux-x64/prebuilds/linux-x64/pty.node",
        "unpack : /node_modules/node-pty/build/Release/pty.node",
        "unpack : /node_modules/node-pty/prebuilds/win32-x64/pty.node",
        "pack   : /node_modules/node-pty/prebuilds/darwin-arm64/pty.node",
      ].join("\n"),
    );

    expect(findDesktopNativePackageViolations(entries, "darwin-arm64")).toEqual([
      expect.stringContaining("Canvas native"),
      expect.stringContaining("平台源包"),
      expect.stringContaining("安装机生成"),
      expect.stringContaining("非目标平台"),
      expect.stringContaining("packed payload"),
    ]);
  });

  it("应拒绝非目标平台的 transcribe-cpp 原生包与 koffi 二进制", () => {
    const entries = parseAsarListWithPackState(
      [
        "unpack : /node_modules/@transcribe-cpp/win32-x64-cpu-vulkan/transcribe.dll",
        "unpack : /node_modules/@transcribe-cpp/linux-x64-cpu-vulkan/libtranscribe.so",
        "unpack : /node_modules/koffi/build/koffi/linux_x64/koffi.node",
        "pack   : /node_modules/@transcribe-cpp/darwin-arm64-metal/libtranscribe.dylib",
      ].join("\n"),
    );

    expect(findDesktopNativePackageViolations(entries, "darwin-arm64")).toEqual([
      expect.stringContaining("transcribe-cpp 包含非目标平台原生包"),
      expect.stringContaining("transcribe-cpp 包含非目标平台原生包"),
      expect.stringContaining("koffi 包含非目标平台二进制"),
      expect.stringContaining("packed payload"),
    ]);
  });

  it("依赖闭包按目标平台过滤 @transcribe-cpp 平台包", () => {
    expect(isTargetTranscribePlatformPackage("transcribe-cpp", "darwin-arm64")).toBe(true);
    expect(isTargetTranscribePlatformPackage("koffi", "darwin-arm64")).toBe(true);
    expect(
      isTargetTranscribePlatformPackage("@transcribe-cpp/darwin-arm64-metal", "darwin-arm64"),
    ).toBe(true);
    expect(
      isTargetTranscribePlatformPackage("@transcribe-cpp/win32-x64-cpu-vulkan", "darwin-arm64"),
    ).toBe(false);
  });

  it("注入 staging 目录会移除非目标平台的 transcribe-cpp 平台包与 koffi 二进制", () => {
    const stagingNodeModulesDir = mkdtempSync(join(tmpdir(), "zcode-native-policy-"));
    try {
      const transcribeTargetDir = join(
        stagingNodeModulesDir,
        "@transcribe-cpp",
        "darwin-arm64-metal",
      );
      const transcribeOtherDir = join(
        stagingNodeModulesDir,
        "@transcribe-cpp",
        "linux-x64-cpu-vulkan",
      );
      const koffiTargetDir = join(stagingNodeModulesDir, "koffi", "build", "koffi", "darwin_arm64");
      const koffiOtherDir = join(stagingNodeModulesDir, "koffi", "build", "koffi", "linux_x64");
      for (const dir of [transcribeTargetDir, transcribeOtherDir, koffiTargetDir, koffiOtherDir]) {
        mkdirSync(dir, { recursive: true });
      }

      removeNonTargetPlatformNativePackages({
        nodeModulesDir: stagingNodeModulesDir,
        targetPlatformKey: "darwin-arm64",
      });

      expect(existsSync(transcribeTargetDir)).toBe(true);
      expect(existsSync(transcribeOtherDir)).toBe(false);
      expect(existsSync(koffiTargetDir)).toBe(true);
      expect(existsSync(koffiOtherDir)).toBe(false);
    } finally {
      rmSync(stagingNodeModulesDir, { recursive: true, force: true });
    }
  });
});
