#!/usr/bin/env node

/* eslint-disable max-lines */
// This script brings together packaging entry points, retry policy, timing, and artifact validation.
// Splitting it up now could affect CI stability; keep it consolidated until it can be divided into
// argument parsing, build execution, and artifact validation modules.

import { spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import process from "node:process";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { collectRuntimeModuleClosureEntries } from "./runtime-dependency-closure.mjs";
import { resolveDesktopProductIdentity } from "./desktop-product-identity.mjs";
import {
  findDesktopNativePackageViolations,
  isTargetTranscribePlatformPackage,
  parseAsarListWithPackState,
} from "./desktop-native-package-policy.mjs";
import {
  resolveSpawnRuntimeOptions,
  runCommand,
  runCommandAndReadStdout,
} from "../../../scripts/spawn-command.mjs";
import { resolveIntranetDepsBaseUrl } from "../../../scripts/intranetDefaults.mjs";
import { stampMacosUpdateManifests } from "./macos-update-manifest.mjs";

const desktopRoot = resolve(import.meta.dirname, "..");
const workspaceRoot = resolve(desktopRoot, "../..");
const requireFromBundle = createRequire(import.meta.url);
const asarCliPath = resolve(
  dirname(requireFromBundle.resolve("@electron/asar/package.json")),
  "bin",
  "asar.js",
);
const runtimeModuleLookupRoots = [
  desktopRoot,
  workspaceRoot,
  resolve(desktopRoot, "node_modules", ".pnpm", "node_modules"),
  resolve(workspaceRoot, "node_modules", ".pnpm", "node_modules"),
];
const pnpmCommand = "pnpm";
const DEFAULT_TARGET_OS = "mac";
const DEFAULT_TARGET_ARCH = "arm64";
const desktopDistDir = process.env.ZCODE_DESKTOP_DIST_DIR || "dist";
const desktopDistRoot = resolve(desktopRoot, desktopDistDir);
const desktopProductIdentity = resolveDesktopProductIdentity(process.env);

const osAliasMap = new Map([
  ["mac", "mac"],
  ["macos", "mac"],
  ["darwin", "mac"],
  ["osx", "mac"],
  ["win", "win"],
  ["windows", "win"],
  ["win32", "win"],
  ["linux", "linux"],
]);

const archAliasMap = new Map([
  ["x64", "x64"],
  ["amd64", "x64"],
  ["x86_64", "x64"],
  ["arm64", "arm64"],
  ["aarch64", "arm64"],
]);

const osBuilderFlagMap = {
  mac: "--mac",
  win: "--win",
  linux: "--linux",
};

const archBuilderFlagMap = {
  x64: "--x64",
  arm64: "--arm64",
};

const artifactExtensionsByOs = {
  mac: [".dmg", ".zip"],
  win: [".exe"],
  linux: [".AppImage", ".deb", ".rpm", ".pkg.tar.zst"],
};
const artifactArchHintsByArch = {
  x64: ["x64", "x86_64", "amd64"],
  arm64: ["arm64", "aarch64"],
};
const commandStdoutMaxBuffer = 64 * 1024 * 1024;
const requiredRuntimeModules = [
  "module-details-from-path",
  "pngjs",
  // Bug fix: the telemetry OTLP exporter depends on sdk-metrics at startup. Development hoisting can
  // hide an electron-builder packaging omission, so mechanically validate this dependency closure in
  // the final artifact to prevent shipping an installer that builds but cannot start.
  "@opentelemetry/sdk-metrics",
  // Match the afterPack injection list: verify that the OTLP proto export chain
  // (exporter → otlp-transformer → protobufjs) is fully packaged; a missing module fails the build
  // right away instead of crashing on startup after installation.
  "@opentelemetry/exporter-trace-otlp-proto",
  "@opentelemetry/exporter-metrics-otlp-proto",
  // Bugfix: @arms/rum-core continues to require('@babel/runtime/helpers/*') at runtime from its CJS entry.
  // It declares @babel/runtime as a peer dependency, which pnpm workspace development can usually
  // resolve. If the production package omits that peer runtime from app.asar, the installed app crashes
  // during main-process startup. Include it in the bundle checks to prevent shipping a broken package.
  "@babel/runtime",
  // Proxy detection in services requires("undici") at runtime.
  // Checking only pngjs/ssh2 here would let a package build successfully and then fail at main-process
  // startup because undici is missing. Include undici in the mechanical bundle checks.
  "undici",
  // The app uses node-forge to generate a self-signed CA. Its dynamic require("crypto") breaks when
  // inlined into the ESM main bundle, so keep it external and verify that app.asar contains it.
  "node-forge",
  // Keep this aligned with tsup externals to preserve the ZIP extractor's CommonJS runtime boundary.
  "yauzl",
  // Bug fix: keep the Feishu SDK external to avoid Electron ESM dynamic-require crashes, and verify
  // that the scoped package is present in app.asar.
  "@larksuiteoapi/node-sdk",
  // The 26.17.0 pnpm collector can still miss deduped transitive deps; the final package validates the full closure from the updater entry.
  "electron-updater",
  // If ssh2's critical dependencies (asn1/bcrypt-pbkdf/tweetnacl) are missing, connecting to a remote
  // workspace throws MODULE_NOT_FOUND during key parsing. Include this dependency chain in validation.
  "asn1",
  "bcrypt-pbkdf",
  "tweetnacl",
  // Bug fix: voice dictation keeps transcribe-cpp external in the Host bundle, so the installed app
  // must resolve it (plus koffi, unified to 2.15.6 by the pnpm override) from app.asar at runtime.
  // The @transcribe-cpp platform packages are covered by the native package policy checks.
  "transcribe-cpp",
  "koffi",
];
const electronBuilderRetryCount = 3;
const electronBuilderRetryDelayMs = 5_000;
const electronBuilderHeartbeatIntervalMs = 30_000;
export const DEFAULT_ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/";
export const NPMMIRROR_ELECTRON_BUILDER_BINARIES_MIRROR =
  "https://registry.npmmirror.com/-/binary/electron-builder-binaries/";
export const OFFICIAL_ELECTRON_BUILDER_BINARIES_MIRROR =
  "https://github.com/electron-userland/electron-builder-binaries/releases/download/";

function isMisconfiguredNpmMirrorElectronRuntimeMirror(mirror) {
  return mirror
    .trim()
    .replace(/\/+$/, "")
    .toLowerCase()
    .includes("npmmirror.com/binaries/electron");
}

export function resolveElectronMirror(env = process.env) {
  const existingMirror =
    env.NPM_CONFIG_ELECTRON_MIRROR ||
    env.npm_config_electron_mirror ||
    env.npm_package_config_electron_mirror ||
    env.ELECTRON_MIRROR;
  if (existingMirror?.trim()) {
    return existingMirror.trim();
  }

  return DEFAULT_ELECTRON_MIRROR;
}

export function createElectronRuntimeMirrorEnv(mirror) {
  return {
    ZCODE_ELECTRON_RUNTIME_MIRROR: mirror,
    // @electron/get reads Electron runtime environment variables globally.
    // Passing them to the electron-builder process overrides mirrorOptions for generic artifacts such
    // as dmg-builder.
    ELECTRON_MIRROR: "",
    NPM_CONFIG_ELECTRON_MIRROR: "",
    npm_config_electron_mirror: "",
    npm_package_config_electron_mirror: "",
  };
}

function resolveDefaultElectronBuilderBinariesMirror(env = process.env) {
  // Fix: when no internal dependency mirror is configured (e.g. open-source builds), resolving the
  // internal host throws and packaging fails outright; fall back to the official electron-builder
  // release download URL then. Internal builds are unchanged.
  try {
    return `${resolveIntranetDepsBaseUrl(env)}/electron-builder-binaries/`;
  } catch {
    return OFFICIAL_ELECTRON_BUILDER_BINARIES_MIRROR;
  }
}

export function resolveElectronBuilderBinariesMirror(env = process.env) {
  const existingMirror =
    env.NPM_CONFIG_ELECTRON_BUILDER_BINARIES_MIRROR ||
    env.npm_config_electron_builder_binaries_mirror ||
    env.npm_package_config_electron_builder_binaries_mirror ||
    env.ELECTRON_BUILDER_BINARIES_MIRROR;
  if (existingMirror?.trim()) {
    if (isMisconfiguredNpmMirrorElectronRuntimeMirror(existingMirror)) {
      // If the electron-builder binaries mirror points to the Electron runtime mirror, the resource
      // directory layouts differ and dmg-builder is requested from the runtime directory, causing 404s.
      return NPMMIRROR_ELECTRON_BUILDER_BINARIES_MIRROR;
    }

    return existingMirror.trim();
  }

  return resolveDefaultElectronBuilderBinariesMirror(env);
}

export function createElectronBuilderBinariesMirrorEnv(mirror) {
  return {
    // 26.17.0 rejects non-localhost HTTP tool mirrors by default. Allow it only for the explicit
    // HTTP builder subprocess; when HTTPS, clear the parent environment's permissive switch so
    // it does not spread to other download paths.
    ELECTRON_BUILDER_BINARIES_ALLOW_HTTP: /^http:\/\//i.test(mirror.trim()) ? "true" : "",
    // electron-builder's DOWNLOAD_OVERRIDE_URL takes precedence over the mirror.
    // If CI points it at the Electron runtime directory, it bypasses the mirror fallback and still gets 404s.
    ELECTRON_BUILDER_BINARIES_DOWNLOAD_OVERRIDE_URL: "",
    ELECTRON_BUILDER_BINARIES_MIRROR: mirror,
    NPM_CONFIG_ELECTRON_BUILDER_BINARIES_DOWNLOAD_OVERRIDE_URL: "",
    NPM_CONFIG_ELECTRON_BUILDER_BINARIES_MIRROR: mirror,
    npm_config_electron_builder_binaries_download_override_url: "",
    npm_config_electron_builder_binaries_mirror: mirror,
    npm_package_config_electron_builder_binaries_download_override_url: "",
    npm_package_config_electron_builder_binaries_mirror: mirror,
  };
}

export function createBundleProcessEnvs({ os, arch, electronMirror, electronBuilderMirror }) {
  const commonEnv = {
    ZCODE_TARGET_OS: os,
    ZCODE_TARGET_ARCH: arch,
    ...createElectronRuntimeMirrorEnv(electronMirror),
  };
  const clearedElectronBuilderEnv = createElectronBuilderBinariesMirrorEnv("");

  return {
    // Asset preparation and regular compilation must not inherit Builder's HTTP authorization or tool mirror.
    buildEnv: {
      ...commonEnv,
      ...clearedElectronBuilderEnv,
    },
    electronBuilderEnv: {
      ...commonEnv,
      ...createElectronBuilderBinariesMirrorEnv(electronBuilderMirror),
    },
  };
}

export function shouldFallbackElectronBuilderBinariesMirror(output, mirror, env = process.env) {
  const normalizedOutput = output.toLowerCase();
  const normalizedMirror = mirror.trim().replace(/\/+$/, "");
  const normalizedDefaultMirror = resolveDefaultElectronBuilderBinariesMirror(env).replace(
    /\/+$/,
    "",
  );
  const isMissingBuilderBinary =
    normalizedOutput.includes("status code 404") || normalizedOutput.includes("response code 404");
  const isDefaultDepsMirror = normalizedMirror === normalizedDefaultMirror;
  // With 26.17 + @electron/get, concurrent download failures aggregated by AsyncTaskManager
  // surface only as a generic "HTTPError: Response code 404" without the full mirror URL; when
  // the default intranet mirror lacks a new tool directory, switching to the public mirror for
  // a retry must stay possible, or the failure only surfaces as Cannot cleanup at ZIP/DMG stage.
  const isDefaultDepsMirrorMissing =
    isDefaultDepsMirror && normalizedOutput.includes("electron-builder-binaries/");
  const isDefaultDepsMirrorGenericTool404 = isDefaultDepsMirror && isMissingBuilderBinary;
  const isMisconfiguredNpmMirrorElectronRuntime =
    normalizedOutput.includes("npmmirror.com/binaries/electron/") &&
    !normalizedOutput.includes("electron-builder-binaries/");

  return (
    isMissingBuilderBinary &&
    (isDefaultDepsMirrorMissing ||
      isDefaultDepsMirrorGenericTool404 ||
      isMisconfiguredNpmMirrorElectronRuntime)
  );
}

export function resolveElectronBuilderBinariesFallbackMirror(output, mirror, env = process.env) {
  if (!shouldFallbackElectronBuilderBinariesMirror(output, mirror, env)) {
    return null;
  }

  // CI once pointed ELECTRON_BUILDER_BINARIES_MIRROR at the Electron runtime mirror, which lacks
  // builder helpers such as dmg-builder, appimage, and nsis. The registry.npmmirror binary path for
  // electron-builder-binaries includes these files, so prefer it to avoid macOS packaging cache misses.
  return NPMMIRROR_ELECTRON_BUILDER_BINARIES_MIRROR;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function artifactNameMatchesArch(fileName, archHint) {
  // Some environments append a suffix after the architecture (for example, mac-arm64_TEST.dmg).
  // The size audit must accept "_" as a separator after the architecture, or it will fail to find an
  // artifact that was successfully built.
  return new RegExp(`-${escapeRegExp(archHint.toLowerCase())}(?:[._-])`, "i").test(fileName);
}

function printHelp() {
  console.log(`桌面端打包脚本

用法:
  pnpm bundle:desktop
  pnpm bundle:desktop -- --os mac --arch x64
  pnpm bundle:desktop -- linux arm64

参数:
  --os, -o <mac|win|linux>     目标操作系统，默认 mac
  --arch, -a <x64|arm64>       目标 CPU 架构，默认 arm64
  --skip-prepare               跳过 prepare:runtime-assets
  --skip-build                 跳过 pnpm build
  --dry-run                    只打印最终命令，不执行打包
  -h, --help                   查看帮助

环境变量:
  ZCODE_TARGET_OS              与 --os 等价
  ZCODE_TARGET_ARCH            与 --arch 等价
`);
}

function normalizeOs(rawOs) {
  const normalizedOs = osAliasMap.get(rawOs.toLowerCase());
  if (!normalizedOs) {
    throw new Error(`不支持的目标操作系统: ${rawOs}`);
  }
  return normalizedOs;
}

function normalizeArch(rawArch) {
  const normalizedArch = archAliasMap.get(rawArch.toLowerCase());
  if (!normalizedArch) {
    throw new Error(`不支持的目标 CPU 架构: ${rawArch}`);
  }
  return normalizedArch;
}

function parseArgs(argv) {
  const options = {
    os: process.env.ZCODE_TARGET_OS ?? null,
    arch: process.env.ZCODE_TARGET_ARCH ?? null,
    skipPrepare: process.env.ZCODE_SKIP_PREPARE === "1",
    skipBuild: process.env.ZCODE_SKIP_BUILD === "1",
    dryRun: false,
    positionals: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--") {
      continue;
    }

    if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    }

    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    if (arg === "--skip-prepare") {
      options.skipPrepare = true;
      continue;
    }

    if (arg === "--skip-build") {
      options.skipBuild = true;
      continue;
    }

    if (arg === "-o" || arg === "--os") {
      options.os = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (arg.startsWith("--os=")) {
      options.os = arg.slice("--os=".length);
      continue;
    }

    if (arg === "-a" || arg === "--arch") {
      options.arch = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (arg.startsWith("--arch=")) {
      options.arch = arg.slice("--arch=".length);
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`不支持的参数: ${arg}`);
    }

    options.positionals.push(arg);
  }

  const positionalOs = options.positionals[0];
  const positionalArch = options.positionals[1];

  if (options.positionals.length > 2) {
    throw new Error(`参数过多: ${options.positionals.join(" ")}`);
  }

  const resolvedOs = normalizeOs(options.os ?? positionalOs ?? DEFAULT_TARGET_OS);
  const resolvedArch = normalizeArch(options.arch ?? positionalArch ?? DEFAULT_TARGET_ARCH);

  return {
    os: resolvedOs,
    arch: resolvedArch,
    skipPrepare: options.skipPrepare,
    skipBuild: options.skipBuild,
    dryRun: options.dryRun,
  };
}

function run(command, args, envPatch = {}) {
  console.log(`[bundle] > ${command} ${args.join(" ")}`);

  runCommand(command, args, {
    cwd: desktopRoot,
    env: {
      ...process.env,
      ...envPatch,
    },
  });
}

function findBuiltArtifact(os, arch) {
  const distRoot = desktopDistRoot;
  const extensions = artifactExtensionsByOs[os] ?? [];
  const candidates = [];

  const archHints = artifactArchHintsByArch[arch] ?? [arch];

  for (const entry of readdirSync(distRoot, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }

    const fullPath = join(distRoot, entry.name);
    const lowerName = entry.name.toLowerCase();
    const matchesExtension = extensions.some((extension) =>
      lowerName.endsWith(extension.toLowerCase()),
    );
    const matchesArch = archHints.some((archHint) => artifactNameMatchesArch(lowerName, archHint));

    if (!matchesExtension || !matchesArch) {
      continue;
    }

    candidates.push({
      path: fullPath,
      mtimeMs: statSync(fullPath).mtimeMs,
    });
  }

  if (candidates.length === 0) {
    throw new Error(`未找到 ${os}/${arch} 的打包产物文件，无法执行体积审计`);
  }

  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0].path;
}
function runAndReadStdout(command, args) {
  return runCommandAndReadStdout(command, args, {
    cwd: desktopRoot,
    env: process.env,
    // `asar list app.asar` prints many file paths for the current desktop package. Node.js spawnSync's
    // default 1 MiB stdout buffer is too small and throws ENOBUFS. Increase it explicitly so validation
    // does not report a successful package as failed because it could not read its own output.
    maxBuffer: commandStdoutMaxBuffer,
    stdio: ["ignore", "pipe", "inherit"],
  });
}

function sleep(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function runTimedSync(label, fn) {
  const startMs = Date.now();
  console.log(`[ci][timer] ${label} start`);
  try {
    return fn();
  } finally {
    console.log(`[ci][timer] ${label} end duration_ms=${Date.now() - startMs}`);
  }
}

async function runTimedAsync(label, fn) {
  const startMs = Date.now();
  console.log(`[ci][timer] ${label} start`);
  try {
    return await fn();
  } finally {
    console.log(`[ci][timer] ${label} end duration_ms=${Date.now() - startMs}`);
  }
}

function shouldRetryElectronBuilderFailure(output) {
  const normalizedOutput = output.toLowerCase();
  const transientSignals = [
    "github.com/electron-userland/electron-builder-binaries/releases/download",
    "electron-builder-binaries/",
    "nsis-resources-",
    'get "https://',
    " eof",
    "read: connection reset by peer",
    "connection reset by peer",
    "connectex",
    "timed out",
    "timeout",
    "socket hang up",
    "unexpected end of file",
    "err_electron_builder_cannot_execute",
  ];

  return transientSignals.some((signal) => normalizedOutput.includes(signal));
}

async function runElectronBuilderWithRetry(args, envPatch) {
  const retryEnvPatch = { ...envPatch };
  let didFallbackElectronBuilderMirror = false;

  for (let attempt = 1; attempt <= electronBuilderRetryCount; attempt += 1) {
    console.log(
      `[bundle] > ${pnpmCommand} ${args.join(" ")} ${attempt > 1 ? `(retry ${attempt}/${electronBuilderRetryCount})` : ""}`.trim(),
    );

    const mergedEnv = {
      ...process.env,
      ...retryEnvPatch,
    };
    const result = await new Promise((resolvePromise) => {
      const child = spawn(pnpmCommand, args, {
        cwd: desktopRoot,
        env: mergedEnv,
        stdio: ["inherit", "pipe", "pipe"],
        // spawn-command no longer exports resolveSpawnCommand, and pnpm should not be rewritten to *.cmd
        // here. Reuse the same runtime options so Windows still resolves the shim through the shell and
        // both CI dry runs and real packaging avoid a module-load crash.
        ...resolveSpawnRuntimeOptions(pnpmCommand),
      });

      let outputBuffer = "";
      const startedAt = Date.now();
      let lastOutputAt = startedAt;
      const heartbeatTimer = setInterval(() => {
        const now = Date.now();
        // macOS code signing can produce no stdout/stderr for a long time, making CI look stuck.
        // Periodic heartbeat logs confirm the process is running and show total and silent durations.
        console.log(
          `[bundle][heartbeat] electron-builder running elapsed_ms=${now - startedAt} idle_ms=${now - lastOutputAt}`,
        );
      }, electronBuilderHeartbeatIntervalMs);
      const appendOutput = (chunk, writeFn) => {
        const text = chunk.toString();
        outputBuffer += text;
        lastOutputAt = Date.now();
        writeFn(text);
      };

      child.stdout?.on("data", (chunk) =>
        appendOutput(chunk, (text) => process.stdout.write(text)),
      );
      child.stderr?.on("data", (chunk) =>
        appendOutput(chunk, (text) => process.stderr.write(text)),
      );

      child.on("error", (error) => {
        clearInterval(heartbeatTimer);
        resolvePromise({
          status: null,
          error,
          combinedOutput: `${outputBuffer}\n${error.message}`,
        });
      });

      child.on("close", (status) => {
        clearInterval(heartbeatTimer);
        resolvePromise({
          status,
          error: null,
          combinedOutput: outputBuffer,
        });
      });
    });

    if (!result.error && result.status === 0) {
      return;
    }

    const failureOutput = [
      result.combinedOutput,
      result.error?.message,
      typeof result.status === "number"
        ? `${pnpmCommand} ${args.join(" ")} failed with code ${result.status}`
        : null,
    ]
      .filter(Boolean)
      .join("\n");

    const currentElectronBuilderMirror = retryEnvPatch.ELECTRON_BUILDER_BINARIES_MIRROR ?? "";
    const fallbackElectronBuilderMirror = resolveElectronBuilderBinariesFallbackMirror(
      failureOutput,
      currentElectronBuilderMirror,
      process.env,
    );
    if (
      attempt < electronBuilderRetryCount &&
      !didFallbackElectronBuilderMirror &&
      fallbackElectronBuilderMirror
    ) {
      // A custom mirror may not have synced a new architecture's resources, or CI may point the builder
      // mirror at the Electron runtime mirror. A 404 in these cases is not a build-code error. Fall back
      // to registry.npmmirror only for known missing-file or misconfigured-mirror cases; preserve other
      // explicitly configured mirrors.
      Object.assign(
        retryEnvPatch,
        createElectronBuilderBinariesMirrorEnv(fallbackElectronBuilderMirror),
      );
      didFallbackElectronBuilderMirror = true;
      console.warn(
        `[bundle] electron-builder 二进制镜像缺文件，切换到 registry.npmmirror 后重试 (${attempt}/${electronBuilderRetryCount})`,
      );
      await sleep(electronBuilderRetryDelayMs);
      continue;
    }

    const shouldRetry =
      attempt < electronBuilderRetryCount && shouldRetryElectronBuilderFailure(failureOutput);
    if (!shouldRetry) {
      if (result.error) {
        throw result.error;
      }

      throw new Error(
        `${pnpmCommand} ${args.join(" ")} failed with code ${result.status ?? "unknown"}`,
      );
    }

    // On Windows build machines, GitHub connections occasionally drop while downloading NSIS resources.
    // electron-builder folds these transient network errors into ERR_ELECTRON_BUILDER_CANNOT_EXECUTE,
    // causing CI to mistake recoverable network noise for a configuration failure. Retry only download
    // failures a limited number of times to improve first-run cache-miss reliability without hiding real
    // build errors indefinitely.
    console.warn(
      `[bundle] electron-builder 下载资源失败，${electronBuilderRetryDelayMs}ms 后重试 (${attempt}/${electronBuilderRetryCount})`,
    );
    await sleep(electronBuilderRetryDelayMs);
  }
}

function resolveAppAsarPath(os, arch) {
  if (os === "mac") {
    return resolve(
      desktopRoot,
      desktopDistDir,
      arch === "arm64" ? "mac-arm64" : "mac",
      `${desktopProductIdentity.productName}.app`,
      "Contents",
      "Resources",
      "app.asar",
    );
  }

  if (os === "win") {
    return resolve(
      desktopRoot,
      desktopDistDir,
      arch === "arm64" ? "win-arm64-unpacked" : "win-unpacked",
      "resources",
      "app.asar",
    );
  }

  if (os === "linux") {
    return resolve(
      desktopRoot,
      desktopDistDir,
      arch === "arm64" ? "linux-arm64-unpacked" : "linux-unpacked",
      "resources",
      "app.asar",
    );
  }

  throw new Error(`不支持的目标操作系统: ${os}`);
}

function verifyPackagedRuntimeDependencies(os, arch) {
  const appAsarPath = resolveAppAsarPath(os, arch);
  if (!existsSync(appAsarPath)) {
    throw new Error(`打包产物缺少 app.asar: ${appAsarPath}`);
  }

  // With pnpm's hoisted dependency layout, electron-builder may put runtime code in app.asar while
  // omitting a child dependency that the code still resolves from the root node_modules directory.
  // We previously missed module-details-from-path, and @fiahfy/icns was later missing pngjs. In both
  // cases, packaging succeeded but the main process crashed at startup with Cannot find module.
  // Mechanically validate the bundle here to prevent shipping a broken package.
  const asarEntriesWithPackState = parseAsarListWithPackState(
    // pnpm exec mixes workspace engine warnings into stdout, which makes strict asar line parsing fail.
    // Run the pinned CLI directly so stdout contains only asar pack state instead of weakening the parser
    // to ignore unknown output.
    runAndReadStdout(process.execPath, [asarCliPath, "list", "--is-pack", appAsarPath]),
  );
  const asarEntries = asarEntriesWithPackState.map((entry) => entry.path);

  const targetPlatformKey = `${os === "mac" ? "darwin" : os === "win" ? "win32" : os}-${arch}`;
  const nativePackageViolations = findDesktopNativePackageViolations(
    asarEntriesWithPackState,
    targetPlatformKey,
  );
  if (nativePackageViolations.length > 0) {
    // Mechanically validate the final unpacked artifact after afterPack as well, to catch later hooks or
    // the builder reintroducing another platform's native files or writing unpacked files back into
    // the app.asar payload.
    throw new Error(`打包产物包含越界 native 资源:\n- ${nativePackageViolations.join("\n- ")}`);
  }

  const runtimeModules = collectRuntimeModuleClosureEntries(
    requiredRuntimeModules,
    runtimeModuleLookupRoots,
  ).filter((entry) => isTargetTranscribePlatformPackage(entry.moduleName, targetPlatformKey));
  const resolvableRuntimeModules = runtimeModules.filter((entry) => {
    if (!entry.sourceModulePath) {
      // afterPack injects dependencies that are actually resolvable on the current platform, so bundle
      // validation must use the same criteria. Otherwise some CI install layouts report a hard failure
      // even though the injection step correctly skipped the dependency.
      console.warn(
        `[bundle] runtime module not found in workspace, skip verify: ${entry.moduleName}; searched=${runtimeModuleLookupRoots
          .map((lookupRoot) => resolve(lookupRoot, "node_modules", entry.moduleName))
          .join(", ")}`,
      );
      return false;
    }
    return true;
  });

  for (const { moduleName } of resolvableRuntimeModules) {
    const moduleRoot = `/node_modules/${moduleName}`;
    // On Windows, @electron/asar uses path.join to emit paths with backslashes. Exact POSIX-path matching
    // incorrectly reported modules as missing even when they were in app.asar. Normalize paths to
    // forward slashes first so Windows build machines pass this mechanical check.
    const hasModule = asarEntries.some(
      (entry) => entry === moduleRoot || entry.startsWith(`${moduleRoot}/`),
    );

    if (!hasModule) {
      // Expand validation through the dependency closure too, so the bundle step fails if afterPack
      // misses a child dependency.
      throw new Error(`打包产物缺少运行时依赖 ${moduleName}: ${appAsarPath}`);
    }
  }
}

async function main() {
  const { os, arch, skipPrepare, skipBuild, dryRun } = parseArgs(process.argv.slice(2));
  const buildArgs = [
    "exec",
    "electron-builder",
    "--config",
    "electron-builder.config.js",
    osBuilderFlagMap[os],
    archBuilderFlagMap[arch],
  ];

  console.log(`[bundle] target=${os}/${arch}`);
  console.log(`[bundle] skipPrepare=${skipPrepare} skipBuild=${skipBuild}`);

  const { buildEnv, electronBuilderEnv } = createBundleProcessEnvs({
    os,
    arch,
    electronMirror: resolveElectronMirror(),
    electronBuilderMirror: resolveElectronBuilderBinariesMirror(),
  });

  if (dryRun) {
    console.log(`[bundle] dry-run: ${pnpmCommand} ${buildArgs.join(" ")}`);
    process.exit(0);
  }

  if (!skipPrepare) {
    run(pnpmCommand, ["prepare:runtime-assets"], buildEnv);
  }

  if (!skipBuild) {
    run(pnpmCommand, ["build"], buildEnv);
  }

  await runTimedAsync("bundle:electron-builder", () =>
    runElectronBuilderWithRetry(buildArgs, electronBuilderEnv),
  );

  await stampMacosUpdateManifests({ outputDir: desktopDistRoot, platform: os });

  runTimedSync("bundle:verify-runtime-dependencies", () =>
    verifyPackagedRuntimeDependencies(os, arch),
  );

  const artifactPath = findBuiltArtifact(os, arch);
  runTimedSync("bundle:audit-bundle-size", () =>
    run(process.execPath, [
      resolve(desktopRoot, "scripts", "audit-bundle-size.mjs"),
      "--artifact-path",
      artifactPath,
    ]),
  );
}

const entryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entryHref === import.meta.url) {
  try {
    await main();
  } catch (error) {
    console.error(`[bundle] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
