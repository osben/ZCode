#!/usr/bin/env node
// Compile the Apple Foundation Models bridge used by voice-dictation post-processing.
//
// Optional by design: the feature is only offered when the helper exists and reports the on-device
// model as available, so a missing toolchain (or non-darwin build) must never fail the desktop build.
// The Swift source uses the framework only behind #available, so a low deployment target keeps the
// binary loadable on older macOS (it then reports "unsupportedOS").

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
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

// A previous build must never be packaged after a failed one.
const slices = { arm64: `${outputPath}-arm64`, x86_64: `${outputPath}-x86_64` };
for (const path of [outputPath, ...Object.values(slices)]) rmSync(path, { force: true });

function compile(arch) {
  execFileSync(
    "xcrun",
    ["swiftc", "-O", "-target", `${arch}-apple-macos11`, sourcePath, "-o", slices[arch]],
    { stdio: "inherit" },
  );
}

function cleanSlices() {
  for (const path of Object.values(slices)) rmSync(path, { force: true });
}

function warn(message, error) {
  console.warn(message, error instanceof Error ? error.message : String(error));
}

try {
  compile("arm64");
} catch (error) {
  cleanSlices();
  warn("[apple-fm] arm64 build failed; system-model post-processing will be unavailable:", error);
  process.exit(0);
}

try {
  compile("x86_64");
  execFileSync("lipo", ["-create", slices.arm64, slices.x86_64, "-output", outputPath], {
    stdio: "inherit",
  });
  console.log(`[apple-fm] built universal binary: ${outputPath}`);
} catch (error) {
  // Apple Intelligence needs Apple silicon, so an arm64-only helper still serves every machine that can use it.
  rmSync(outputPath, { force: true });
  renameSync(slices.arm64, outputPath);
  warn("[apple-fm] universal build failed; using an arm64-only helper:", error);
} finally {
  cleanSlices();
}
