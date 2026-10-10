#!/usr/bin/env node
// Compile the macOS window-bounds helper, which provides snap targets for the CUA permission panel.
//
// Skip on non-darwin platforms: this binary is only used by the macOS TCC permission flow.
// If swiftc is unavailable (Xcode CLT is not installed), warn and continue. Snapping is a visual
// enhancement; without bounds, the panel falls back to the bottom of the screen and remains usable, so
// this should not fail the desktop build.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = join(packageRoot, "native", "macos-window-bounds", "main.swift");
const outputDir = join(packageRoot, "resources", "macos-window-bounds");
const outputPath = join(outputDir, "zcode-window-bounds");

if (process.platform !== "darwin") {
  console.log("[window-bounds] 跳过：仅 macOS 需要");
  process.exit(0);
}

if (!existsSync(sourcePath)) {
  console.error(`[window-bounds] 源文件缺失：${sourcePath}`);
  process.exit(1);
}

function hasSwiftc() {
  try {
    execFileSync("xcrun", ["--find", "swiftc"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

if (!hasSwiftc()) {
  console.warn("[window-bounds] 未找到 swiftc（需 Xcode Command Line Tools）；跳过构建。");
  console.warn("[window-bounds] 权限浮窗仍可用，但不会吸附到系统设置窗口。");
  process.exit(0);
}

mkdirSync(outputDir, { recursive: true });

try {
  // Build a universal binary for both arm64 and x86_64 so the release package works on either architecture.
  execFileSync(
    "xcrun",
    ["swiftc", "-O", "-target", "arm64-apple-macos11", sourcePath, "-o", `${outputPath}-arm64`],
    { stdio: "inherit" },
  );
  execFileSync(
    "xcrun",
    ["swiftc", "-O", "-target", "x86_64-apple-macos11", sourcePath, "-o", `${outputPath}-x86_64`],
    { stdio: "inherit" },
  );
  execFileSync(
    "lipo",
    ["-create", `${outputPath}-arm64`, `${outputPath}-x86_64`, "-output", outputPath],
    { stdio: "inherit" },
  );
  execFileSync("rm", ["-f", `${outputPath}-arm64`, `${outputPath}-x86_64`]);
  console.log(`[window-bounds] 已构建 universal 二进制：${outputPath}`);
} catch (error) {
  console.warn(
    "[window-bounds] 构建失败；权限浮窗仍可用但不会吸附：",
    error instanceof Error ? error.message : String(error),
  );
  process.exit(0);
}
