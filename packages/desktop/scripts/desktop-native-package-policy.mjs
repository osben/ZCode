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
    // Bugfix: 语音转写（transcribe-cpp）的平台原生包名为 `@transcribe-cpp/<os>-<arch>-<后缀>`
    // （如 darwin-arm64-metal、linux-x64-cpu-vulkan），单个非目标平台包可达 60MB。
    // 只保留目标平台前缀的包，其余平台包不得进入安装包。
    ...SUPPORTED_DESKTOP_PLATFORM_KEYS.filter((key) => key !== targetPlatformKey).map(
      (key) => `!node_modules/@transcribe-cpp/${key}-*/**`,
    ),
    // Bugfix: koffi 在单一包内携带全部平台二进制（build/koffi/<os>_<arch>/koffi.node，目录名用下划线）。
    // 先整体排除再按目标平台放行，避免枚举平台目录清单在 koffi 升级新增平台时遗漏裁剪。
    "!node_modules/koffi/build/koffi/**",
    `node_modules/koffi/build/koffi/${targetPlatformKey.replaceAll("-", "_")}/**`,
  ];
}

function normalizeAsarPath(path) {
  const normalized = path.trim().replaceAll("\\", "/");
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

// Bugfix: transcribe-cpp 的 @transcribe-cpp 平台包是 optionalDependencies，闭包收集会把全部平台包
// 当作运行时依赖。非目标平台包既不注入也不应出现在 app.asar（由 files 裁剪与越界校验负责），
// 依赖闭包注入与 bundle 校验都必须按目标平台前缀过滤，只保留目标平台包。
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

    // Bugfix: 与 files 裁剪规则对称，校验语音转写只携带目标平台原生包与 koffi 二进制，
    // 防止 @transcribe-cpp（单个平台包可达 60MB）或 koffi 的全平台二进制重新进入安装包。
    const transcribePlatformPackageMatch = /^\/node_modules\/@transcribe-cpp\/([^/]+)/.exec(path);
    if (
      transcribePlatformPackageMatch &&
      !transcribePlatformPackageMatch[1].startsWith(`${targetPlatformKey}-`)
    ) {
      violations.push(`transcribe-cpp 包含非目标平台原生包: ${path}`);
      continue;
    }

    const koffiPlatformDirMatch = /^\/node_modules\/koffi\/build\/koffi\/([^/]+)/.exec(path);
    if (
      koffiPlatformDirMatch &&
      koffiPlatformDirMatch[1] !== targetPlatformKey.replaceAll("-", "_")
    ) {
      violations.push(`koffi 包含非目标平台二进制: ${path}`);
      continue;
    }

    if (isNativeRuntimeFile(path, targetPlatformKey) && packState !== "unpack") {
      violations.push(`native 文件仍作为 packed payload 留在 app.asar: ${path}`);
    }
  }

  return violations;
}

// Bugfix: afterPack 注入运行时依赖时按源包整目录复制，会绕过 files 裁剪规则，把
// @transcribe-cpp 的全部平台包和 koffi 的全平台二进制带进 app.asar。注入后在 staging
// 目录按同一平台边界裁剪，与 createDesktopNativePackagePrunePatterns 保持一致。
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
