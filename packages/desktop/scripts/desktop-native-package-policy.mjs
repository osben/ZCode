import { existsSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const SUPPORTED_DESKTOP_PLATFORM_KEYS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-arm64",
  "win32-x64",
];

// sharp ships every platform binary variant through optionalDependencies. The electron-builder 26.17
// pnpm collector packs the variants from the full lockfile platform graph, so darwin/linux and cross-arch
// win32 variants (Mach-O/ELF, about 110MB uncompressed) all end up in app.asar. That inflates the installer
// and sends them through signApp on Windows signing, which triggered a chained 0x8010006a failure (CI
// observed 2026-10-26; the signing hook now skips files by PE magic). Each target platform keeps only the
// variant group the runtime actually resolves.
const SHARP_VARIANT_PACKAGES = [
  "sharp-win32-x64",
  "sharp-win32-arm64",
  "sharp-darwin-x64",
  "sharp-darwin-arm64",
  "sharp-libvips-darwin-x64",
  "sharp-libvips-darwin-arm64",
  "sharp-linux-x64",
  "sharp-linux-arm64",
  "sharp-libvips-linux-x64",
  "sharp-libvips-linux-arm64",
  "sharp-linuxmusl-x64",
  "sharp-linuxmusl-arm64",
  "sharp-libvips-linuxmusl-x64",
  "sharp-libvips-linuxmusl-arm64",
];

const SHARP_VARIANTS_BY_PLATFORM = {
  "win32-x64": ["sharp-win32-x64"],
  "win32-arm64": ["sharp-win32-arm64"],
  "darwin-x64": ["sharp-darwin-x64", "sharp-libvips-darwin-x64"],
  "darwin-arm64": ["sharp-darwin-arm64", "sharp-libvips-darwin-arm64"],
  "linux-x64": ["sharp-linux-x64", "sharp-libvips-linux-x64"],
  "linux-arm64": ["sharp-linux-arm64", "sharp-libvips-linux-arm64"],
};

function assertSupportedTargetPlatformKey(targetPlatformKey) {
  if (!SUPPORTED_DESKTOP_PLATFORM_KEYS.includes(targetPlatformKey)) {
    throw new Error(`不支持的桌面目标平台: ${targetPlatformKey}`);
  }
}

export function createDesktopNativePackagePrunePatterns(targetPlatformKey) {
  assertSupportedTargetPlatformKey(targetPlatformKey);

  return [
    // PDF preview is already bundled into the renderer by Vite. pdfjs-dist's optional Canvas dependency
    // is only used for Node rendering; the eight Canvas native packages installed by pnpm for other
    // platforms should not be included in the desktop installer.
    "!node_modules/@napi-rs/canvas/**",
    "!node_modules/@napi-rs/canvas-*/**",
    // beforePack copies the Linux prebuild into node-pty; the source platform package itself is not part
    // of the desktop runtime.
    "!node_modules/@lydell/node-pty-*/**",
    // The desktop runtime always uses the target prebuild. Do not include binaries compiled on the build
    // machine or ABI bin caches in cross-platform packages.
    "!node_modules/node-pty/build/**",
    "!node_modules/node-pty/bin/**",
    ...SUPPORTED_DESKTOP_PLATFORM_KEYS.filter((key) => key !== targetPlatformKey).map(
      (key) => `!node_modules/node-pty/prebuilds/${key}/**`,
    ),
    // Bugfix: transcribe-cpp platform native packages are named `@transcribe-cpp/<os>-<arch>-<suffix>`
    // (e.g. darwin-arm64-metal, linux-x64-cpu-vulkan); a single non-target platform package can reach 60MB.
    // Keep only packages with the target platform prefix — other platform packages must not enter the installer.
    ...SUPPORTED_DESKTOP_PLATFORM_KEYS.filter((key) => key !== targetPlatformKey).map(
      (key) => `!node_modules/@transcribe-cpp/${key}-*/**`,
    ),
    // Bugfix: koffi ships all platform binaries in a single package (build/koffi/<os>_<arch>/koffi.node,
    // directory names use underscores). Exclude the whole tree first, then re-allow the target platform,
    // so a koffi upgrade adding a new platform cannot escape pruning through an enumerated directory list.
    "!node_modules/koffi/build/koffi/**",
    `node_modules/koffi/build/koffi/${targetPlatformKey.replaceAll("-", "_")}/**`,
    // Prune @img/sharp variants for non-target platforms; the target variant is verified by the violation check below.
    ...SHARP_VARIANT_PACKAGES.filter(
      (name) => !SHARP_VARIANTS_BY_PLATFORM[targetPlatformKey].includes(name),
    ).map((name) => `!node_modules/@img/${name}/**`),
  ];
}

function normalizeAsarPath(path) {
  const normalized = path.trim().replaceAll("\\", "/");
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

// Bugfix: the @transcribe-cpp platform packages are optionalDependencies of transcribe-cpp, so closure
// collection treats every platform package as a runtime dependency. Non-target platform packages are
// neither injected nor allowed in app.asar (enforced by files pruning and the violation checks); both the
// dependency closure injection and the bundle verification must filter by target platform prefix.
export function isTargetTranscribePlatformPackage(moduleName, targetPlatformKey) {
  return (
    !moduleName.startsWith("@transcribe-cpp/") ||
    moduleName.startsWith(`@transcribe-cpp/${targetPlatformKey}-`)
  );
}

export function parseAsarListWithPackState(output) {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^(pack|unpack)\s*:\s*(.+)$/.exec(line);
      if (!match) {
        throw new Error(`无法解析 asar pack state: ${line}`);
      }
      return { packState: match[1], path: normalizeAsarPath(match[2]) };
    });
}

function isNativeRuntimeFile(path, targetPlatformKey) {
  if (/\.(?:node|dll|dylib|exe)$/i.test(path)) return true;
  return path === `/node_modules/node-pty/prebuilds/${targetPlatformKey}/spawn-helper`;
}

export function findDesktopNativePackageViolations(entries, targetPlatformKey) {
  assertSupportedTargetPlatformKey(targetPlatformKey);
  const violations = [];

  for (const entry of entries) {
    const { packState, path } = entry;

    if (
      path === "/node_modules/@napi-rs/canvas" ||
      path.startsWith("/node_modules/@napi-rs/canvas/") ||
      path.startsWith("/node_modules/@napi-rs/canvas-")
    ) {
      violations.push(`不应打包 renderer 无需的 Canvas native: ${path}`);
      continue;
    }

    // If a pruning rule leaks or the collector regresses, non-target @img/sharp variants must fail closed here.
    const sharpVariantMatch = /^\/node_modules\/@img\/(sharp-[a-z0-9-]+)(?:\/|$)/.exec(path);
    if (
      sharpVariantMatch &&
      !SHARP_VARIANTS_BY_PLATFORM[targetPlatformKey].includes(sharpVariantMatch[1])
    ) {
      violations.push(`sharp 包含非目标平台变体: ${sharpVariantMatch[1]} ${path}`);
      continue;
    }

    if (path.startsWith("/node_modules/@lydell/node-pty-")) {
      violations.push(`不应打包仅用于准备 prebuild 的平台源包: ${path}`);
      continue;
    }

    if (
      path.startsWith("/node_modules/node-pty/build/") ||
      path.startsWith("/node_modules/node-pty/bin/")
    ) {
      violations.push(`不应打包安装机生成的 node-pty 产物: ${path}`);
      continue;
    }

    const nodePtyPrebuildMatch = /^\/node_modules\/node-pty\/prebuilds\/([^/]+)/.exec(path);
    if (nodePtyPrebuildMatch && nodePtyPrebuildMatch[1] !== targetPlatformKey) {
      violations.push(`node-pty 包含非目标平台 prebuild: ${path}`);
      continue;
    }

    // Bugfix: symmetric with the files pruning rules — verify voice transcription ships only target
    // platform native packages and koffi binaries, preventing @transcribe-cpp (up to 60MB per platform
    // package) or koffi all-platform binaries from re-entering the installer.
    const transcribePlatformPackageMatch = /^\/node_modules\/@transcribe-cpp\/([^/]+)/.exec(path);
    if (
      transcribePlatformPackageMatch &&
      !transcribePlatformPackageMatch[1].startsWith(`${targetPlatformKey}-`)
    ) {
      violations.push(`transcribe-cpp contains non-target platform native package: ${path}`);
      continue;
    }

    const koffiPlatformDirMatch = /^\/node_modules\/koffi\/build\/koffi\/([^/]+)/.exec(path);
    if (
      koffiPlatformDirMatch &&
      koffiPlatformDirMatch[1] !== targetPlatformKey.replaceAll("-", "_")
    ) {
      violations.push(`koffi contains non-target platform binaries: ${path}`);
      continue;
    }

    if (isNativeRuntimeFile(path, targetPlatformKey) && packState !== "unpack") {
      violations.push(`native 文件仍作为 packed payload 留在 app.asar: ${path}`);
    }
  }

  return violations;
}

// Bugfix: afterPack injects runtime dependencies by copying each source package directory wholesale,
// which bypasses the files pruning rules and pulls every @transcribe-cpp platform package and all koffi
// platform binaries into app.asar. After injection, prune the staging directory to the same platform
// boundary as createDesktopNativePackagePrunePatterns.
export function removeNonTargetPlatformNativePackages({ nodeModulesDir, targetPlatformKey }) {
  assertSupportedTargetPlatformKey(targetPlatformKey);

  const transcribeScopeDir = resolve(nodeModulesDir, "@transcribe-cpp");
  if (existsSync(transcribeScopeDir)) {
    for (const entry of readdirSync(transcribeScopeDir)) {
      if (!entry.startsWith(`${targetPlatformKey}-`)) {
        rmSync(join(transcribeScopeDir, entry), { recursive: true, force: true });
      }
    }
  }

  const koffiNativeDir = resolve(nodeModulesDir, "koffi", "build", "koffi");
  if (existsSync(koffiNativeDir)) {
    const targetPlatformDir = targetPlatformKey.replaceAll("-", "_");
    for (const entry of readdirSync(koffiNativeDir)) {
      if (entry !== targetPlatformDir) {
        rmSync(join(koffiNativeDir, entry), { recursive: true, force: true });
      }
    }
  }
}
