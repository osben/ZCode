#!/usr/bin/env node
// Compile the Apple Foundation Models bridge used by voice-dictation post-processing.
//
// Optional by design: the feature is only offered when the helper exists and reports the on-device
// model as available, so a missing toolchain (or non-darwin build) must never fail the desktop build.
// The Swift source uses the framework only behind #available, so a low deployment target keeps the
// binary loadable on older macOS (it then reports "unsupportedOS").

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = join(packageRoot, "native", "apple-fm", "main.swift");
const outputDir = join(packageRoot, "resources", "apple-fm");
const outputPath = join(outputDir, "zcode-apple-fm");

if (process.platform !== "darwin") {
  console.log("[apple-fm] skipped: macOS only");
  process.exit(0);
}

if (!existsSync(sourcePath)) {
  console.error(`[apple-fm] missing source: ${sourcePath}`);
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
  console.warn("[apple-fm] swiftc not found (Xcode Command Line Tools required); skipping build.");
  console.warn("[apple-fm] Post-processing with the system model will be unavailable.");
  process.exit(0);
}

mkdirSync(outputDir, { recursive: true });

try {
  for (const arch of ["arm64", "x86_64"]) {
    execFileSync(
      "xcrun",
      [
        "swiftc",
        "-O",
        "-target",
        `${arch}-apple-macos11`,
        sourcePath,
        "-o",
        `${outputPath}-${arch}`,
      ],
      { stdio: "inherit" },
    );
  }
  execFileSync(
    "lipo",
    ["-create", `${outputPath}-arm64`, `${outputPath}-x86_64`, "-output", outputPath],
    { stdio: "inherit" },
  );
  execFileSync("rm", ["-f", `${outputPath}-arm64`, `${outputPath}-x86_64`]);
  console.log(`[apple-fm] built universal binary: ${outputPath}`);
} catch (error) {
  console.warn(
    "[apple-fm] build failed; system-model post-processing will be unavailable:",
    error instanceof Error ? error.message : String(error),
  );
  process.exit(0);
}
