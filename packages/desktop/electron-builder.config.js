/* eslint-disable max-lines -- Electron Builder config keeps related packaging hooks together so build order stays explicit. */
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { runCommand, runCommandAndReadStdout } from "../../scripts/spawn-command.mjs";
import { loadBuiltinProviderConfig } from "../../scripts/builtin-provider-config.mjs";
import { noticesFileName, stageElectronNotices } from "../../scripts/third-party-notices.mjs";
import { resolveNativeSearchReleasePlan } from "../../scripts/native-search-tools-config.mjs";
import { getBuildMetadata } from "./scripts/build-metadata.mjs";
import { collectRuntimeModuleClosureEntries } from "./scripts/runtime-dependency-closure.mjs";
import {
  resolvePackagedNodePtyPrebuildPath,
  restoreTargetNodePtyPrebuild,
} from "./scripts/node-pty-package-assets.mjs";
import { cleanupPackagedSourcemaps } from "./scripts/packaged-sourcemap-cleanup.mjs";
import { getTargetPlatform } from "./scripts/target-platform.mjs";
import {
  resolveDesktopArtifactSuffix,
  resolveDesktopProductIdentity,
} from "./scripts/desktop-product-identity.mjs";
import { verifyStagedKoffi } from "./scripts/koffi-package-assets.mjs";
const ELECTRON_BUILDER_ARCH = {
  1: "x64",
  3: "arm64",
};
function resolveElectronBuilderWindowsTarget({
  electronPlatformName,
  arch,
  configuredTargetPlatform,
}) {
  if (electronPlatformName !== "win32") {
    throw new Error(
      `[electron-builder.config] context platform is not win32: ${String(electronPlatformName)}`,
    );
  }
  const actualArch = ELECTRON_BUILDER_ARCH[arch];
  if (!actualArch) {
    throw new Error(
      `[electron-builder.config] unsupported electron-builder Windows architecture: ${String(arch)}`,
    );
  }
  const actualTarget = {
    os: "win32",
    arch: actualArch,
    key: `win32-${actualArch}`,
  };
  if (
    configuredTargetPlatform?.os !== actualTarget.os ||
    configuredTargetPlatform?.arch !== actualTarget.arch ||
    configuredTargetPlatform?.key !== actualTarget.key
  ) {
    throw new Error(
      `[electron-builder.config] configured target ${String(configuredTargetPlatform?.key)} does not match electron-builder target ${actualTarget.key}`,
    );
  }
  return actualTarget;
}
import {
  findDesktopNativePackageViolations,
  createDesktopNativePackagePrunePatterns,
  parseAsarListWithPackState,
} from "./scripts/desktop-native-package-policy.mjs";
import { replaceAppAsarFromStaging } from "./scripts/app-asar-repack.mjs";
import {
  patchNsisInstallSectionFile,
  restoreNsisInstallSectionFileSync,
} from "./scripts/patch-nsis-install-section.mjs";

const buildMetadata = getBuildMetadata();
const targetPlatform = getTargetPlatform();
const builtinProviderConfig = await loadBuiltinProviderConfig();
const desktopProductIdentity = resolveDesktopProductIdentity({
  ...process.env,
  ZCODE_ENV: builtinProviderConfig.environment,
});
const nativeSearchReleasePlan = resolveNativeSearchReleasePlan({
  platform: targetPlatform.os,
  arch: targetPlatform.arch,
});
const rawMacSigningIdentity = process.env.APPLE_SIGNING_IDENTITY || process.env.CSC_NAME;
const macSigningIdentity =
  rawMacSigningIdentity?.replace(/^Developer ID Application:\s*/, "") ?? null;
const shouldEnableMacSigning =
  process.env.ZCODE_ENABLE_MAC_SIGN === "1" && Boolean(macSigningIdentity);
const workspaceRoot = resolve(import.meta.dirname, "../..");
const desktopPackageRoot = import.meta.dirname;
const runtimeModuleLookupRoots = [
  desktopPackageRoot,
  workspaceRoot,
  resolve(desktopPackageRoot, "node_modules", ".pnpm", "node_modules"),
  resolve(workspaceRoot, "node_modules", ".pnpm", "node_modules"),
];
const desktopDistDir = process.env.ZCODE_DESKTOP_DIST_DIR || "dist";
const DEFAULT_ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/";
// `pnpm exec asar` relies on `.bin/asar`, but when @electron/asar is only an electron-builder transitive dependency,
// Linux CI with pnpm hoisting often cannot resolve the binary, so `asar list` exits 1 without running.
// Declare @electron/asar explicitly and run its CLI through Node to avoid platform-specific shim resolution.
const requireFromConfig = createRequire(import.meta.url);
let nsisInstallSectionPatched = false;
let nsisInstallSectionOriginalSource = null;
let nsisInstallSectionPath = null;
const desktopElectronVersion = requireFromConfig("./package.json").devDependencies.electron;
const asarCliPath = resolve(
  dirname(requireFromConfig.resolve("@electron/asar/package.json")),
  "bin",
  "asar.js",
);
const REQUIRED_ASAR_RUNTIME_MODULES = [
  "module-details-from-path",
  "@opentelemetry/api-logs",
  // Bugfix: the telemetry OTLP exporter loads sdk-metrics during startup. pnpm development can resolve it from
  // the workspace root, but electron-builder does not reliably copy this hoisted dependency, causing packaged startup to crash.
  // Inject sdk-metrics as a dependency-closure root and recursively include its OpenTelemetry runtime dependencies.
  "@opentelemetry/sdk-metrics",
  // Dependency-closure root for the OTLP proto export chain: recursively include otlp-transformer/protobufjs and their dependencies,
  // or a hoisted layout missing protobufjs makes the installed app fail at startup with Cannot find module 'protobufjs/minimal'.
  "@opentelemetry/exporter-trace-otlp-proto",
  "@opentelemetry/exporter-metrics-otlp-proto",
  "pngjs",
  // The proxy connectivity check in @zcode/services dynamically requires "undici" to get ProxyAgent.
  // Although tsup bundles services into the main/host artifacts, it does not inline this runtime require,
  // and electron-builder may omit the hoisted undici package, causing the installed macOS app to fail at startup with Cannot find module "undici".
  // Force undici into app.asar like the other fallback dependencies to prevent the installed app's main process from crashing.
  "undici",
  // node-forge was only listed in bundle.mjs validation and left to electron-builder to include in app.asar.
  // This has the same risk as yauzl missing pend: required modules must be explicitly included. node-forge has no dependencies,
  // and afterPack skips it when already present, so existing package output is unchanged.
  "node-forge",
  // Since 2.7.0, services has used yazl for feedback-log compression, adding a startup dependency that 2.6.0 did not have.
  // In pnpm-hoisted layouts, yazl may reach app.asar while its buffer-crc32 dependency is omitted.
  // Inject yazl as a closure root so recursive dependency collection includes the ZIP packaging dependencies.
  "yazl",
  // After yauzl became a direct production dependency of desktop/services, pnpm list --prod deduplicated the top-level yauzl node
  // into an empty node with no dependencies. electron-builder's pnpm collector keeps the first empty node and
  // skips the later one with the full dependency tree, leaving yauzl in app.asar without its runtime dependency pend;
  // bundle validation then reports that pend is missing. Inject yauzl as a closure root, matching bundle.mjs validation,
  // so recursive dependency collection also includes pend.
  "yauzl",
  // Bugfix: after the Feishu SDK is externalized from Desktop main/host, the packaged app must resolve it from app.asar at runtime.
  // Inject the scoped package explicitly to avoid a development-only success followed by Cannot find module in production.
  "@larksuiteoapi/node-sdk",
  // In production, ssh2 may be included in app.asar while electron-builder intermittently omits part of its dependency chain.
  // A production error has reported Cannot find module 'asn1' (Require stack: ssh2 keyParser).
  // Inject ssh2's critical dependencies to prevent remote SSH connections from failing in installed apps.
  "asn1",
  "bcrypt-pbkdf",
  "tweetnacl",
  // electron-updater → builder-util-runtime → debug dynamically requires "ms" at runtime.
  // With pnpm hoisting, electron-builder sometimes omits this leaf dependency. Version 3.4.0 (built by ci/cua-v0.3.17)
  // triggered a production startup error: Cannot find module 'ms' (Require stack: debug/src/common.js),
  // which broke the auto-update path. Inject the leaf package explicitly so debug resolves it reliably from app.asar.
  "ms",
];
// pacman dependencies must use package names from the official Arch repositories. electron-builder's historical defaults include
// removed packages such as libappindicator-gtk3/http-parser and omit libraries Electron actually needs; explicitly
// maintain the minimal runtime closure to prevent pacman -U resolution failures and missing libraries at startup.
const PACMAN_RUNTIME_DEPENDENCIES = [
  "gtk3",
  "nss",
  "libxss",
  "libxtst",
  "libnotify",
  "alsa-lib",
  "mesa",
  "xdg-utils",
];

const WINDOWS_INSTALL_MANIFEST_NAME = ".zcode-install-manifest";

async function writeWindowsInstallManifest(context) {
  if (context.electronPlatformName !== "win32") return;

  const root = context.appOutDir;
  const files = [];
  const visit = async (directory, relativeDirectory = "") => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        files.push(relativePath.replaceAll("/", "\\"));
      }
    }
  };

  await visit(root);
  files.sort();
  await writeFile(join(root, WINDOWS_INSTALL_MANIFEST_NAME), `${files.join("\r\n")}\r\n`, "utf8");
}

function resolveElectronDownloadMirror(env = process.env) {
  const existingMirror =
    env.ZCODE_ELECTRON_RUNTIME_MIRROR ||
    env.NPM_CONFIG_ELECTRON_MIRROR ||
    env.npm_config_electron_mirror ||
    env.npm_package_config_electron_mirror ||
    env.ELECTRON_MIRROR;
  if (existingMirror?.trim()) {
    return existingMirror.trim();
  }

  return DEFAULT_ELECTRON_MIRROR;
}

const commandStdoutMaxBuffer = 64 * 1024 * 1024;
// The artifact suffix marks only the backend environment (_TEST); productName distinguishes identity, so Preview packages using the production backend have no suffix.
const desktopArtifactEnvSuffix = resolveDesktopArtifactSuffix(process.env);

// Preview is an internal signing-test package. If CI explicitly enables macOS signing but identity is missing, fail before creating an unsigned package
// so that the mere presence of an artifact is not mistaken for completing the production signing flow.
if (
  desktopProductIdentity.flavor === "preview" &&
  process.env.ZCODE_ENABLE_MAC_SIGN === "1" &&
  !macSigningIdentity
) {
  throw new Error(
    "ZCode Preview macOS packaging requires APPLE_SIGNING_IDENTITY or CSC_NAME when ZCODE_ENABLE_MAC_SIGN=1",
  );
}

const PACKAGING_PRUNE_PATTERNS = [
  "!**/*.map",
  "!**/*.pdb",
  "!**/__tests__/**",
  "!**/test/**",
  "!**/tests/**",
  "!**/example/**",
  "!**/examples/**",
  "!**/README*",
  "!**/CHANGELOG*",
  "!**/CONTRIBUTING*",
  "!**/CODE_OF_CONDUCT*",
  "!**/SECURITY*",
];

function buildDesktopArtifactName(platformName, extension = "${ext}") {
  // Test-environment artifacts must have filenames distinct from production installers to prevent mix-ups during upload, download, or manual review.
  return `\${productName}-\${version}-${platformName}-\${arch}${desktopArtifactEnvSuffix}.${extension}`;
}

function runAsarCommand(args) {
  runCommand(process.execPath, [asarCliPath, ...args], {
    cwd: import.meta.dirname,
    env: process.env,
  });
}

function runAsarCommandAndReadStdout(args) {
  return runCommandAndReadStdout(process.execPath, [asarCliPath, ...args], {
    cwd: import.meta.dirname,
    env: process.env,
    // The current Desktop app.asar is large, so asar list output may exceed the default buffer and trigger ENOBUFS.
    // Increase the buffer explicitly to avoid failing packaging while checking whether injection is needed.
    maxBuffer: commandStdoutMaxBuffer,
    stdio: ["ignore", "pipe", "inherit"],
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

function resolveAppAsarPath(context) {
  if (context.electronPlatformName === "darwin") {
    const appName = `${context.packager?.appInfo?.productFilename ?? "ZCode"}.app`;
    return resolve(context.appOutDir, appName, "Contents", "Resources", "app.asar");
  }

  return resolve(context.appOutDir, "resources", "app.asar");
}

function resolvePackagedResourcesDir(context) {
  if (context.electronPlatformName === "darwin") {
    const appName = `${context.packager?.appInfo?.productFilename ?? "ZCode"}.app`;
    return resolve(context.appOutDir, appName, "Contents", "Resources");
  }

  return resolve(context.appOutDir, "resources");
}

function normalizeAsarEntry(entry) {
  return entry.trim().replaceAll("\\", "/");
}

function resolveMissingRuntimeModules(appAsarPath) {
  const asarEntries = runAsarCommandAndReadStdout(["list", appAsarPath])
    .split("\n")
    .map(normalizeAsarEntry)
    .filter(Boolean);
  const asarEntrySet = new Set(asarEntries);

  const runtimeModules = collectRuntimeModuleClosureEntries(
    REQUIRED_ASAR_RUNTIME_MODULES,
    runtimeModuleLookupRoots,
  );
  const resolvableRuntimeModules = runtimeModules.filter((entry) => {
    if (!entry.sourceModulePath) {
      // Depending on the platform and install layout, some runtime dependencies may be pruned or absent from this packaging workspace.
      // Throwing during copy used to stop packaging for the entire platform. Now warn and skip that module,
      // so afterPack handles only dependencies resolvable in the current environment and CI does not fail for one optional package.
      console.warn(
        `[afterPack] runtime module not found, skip injection: ${entry.moduleName}; searched=${runtimeModuleLookupRoots
          .map((lookupRoot) => resolve(lookupRoot, "node_modules", entry.moduleName))
          .join(", ")}`,
      );
      return false;
    }
    return true;
  });
  return resolvableRuntimeModules.filter((entry) => {
    const { moduleName } = entry;
    const moduleRoot = `/node_modules/${moduleName}`;
    if (asarEntrySet.has(moduleRoot)) {
      return false;
    }
    for (const entry of asarEntrySet) {
      if (entry.startsWith(`${moduleRoot}/`)) {
        return false;
      }
    }
    return true;
  });
}

async function injectHoistedRuntimeModulesIntoAsar(context) {
  const appAsarPath = resolveAppAsarPath(context);
  if (!existsSync(appAsarPath)) {
    throw new Error(`打包产物缺少 app.asar: ${appAsarPath}`);
  }

  const missingRuntimeModules = runTimedSync("afterPack:scan-missing-runtime-modules", () =>
    resolveMissingRuntimeModules(appAsarPath),
  );
  if (missingRuntimeModules.length === 0) {
    // Previously, afterPack fully extracted and repacked app.asar on every run, even when all runtime dependencies were present.
    // This added tens of seconds to every package. Scan for missing dependencies first and rewrite only when a package is missing.
    console.log("[afterPack] runtime modules already complete, skip app.asar rewrite");
    return;
  }
  console.log(`[afterPack] missing runtime modules count=${missingRuntimeModules.length}`);

  // CI points TMPDIR at the project-local .tmp directory, which GitLab get_sources/clean may remove before this script starts.
  // Rewriting app.asar in afterPack also uses mkdtempSync, so create the parent directory here to prevent the later signing stage from finding no .app.
  mkdirSync(tmpdir(), { recursive: true });
  const stagingDir = mkdtempSync(resolve(tmpdir(), "zcode-app-asar-"));
  try {
    runTimedSync("afterPack:asar-extract", () =>
      runAsarCommand(["extract", appAsarPath, stagingDir]),
    );

    const stagingNodeModulesDir = resolve(stagingDir, "node_modules");
    mkdirSync(stagingNodeModulesDir, { recursive: true });

    runTimedSync("afterPack:copy-runtime-modules", () => {
      for (const runtimeModule of missingRuntimeModules) {
        const { moduleName, sourceModulePath } = runtimeModule;
        const targetModulePath = resolve(stagingNodeModulesDir, moduleName);

        if (!sourceModulePath) {
          throw new Error(
            `未找到运行时依赖 ${moduleName}，已搜索: ${runtimeModuleLookupRoots
              .map((lookupRoot) => resolve(lookupRoot, "node_modules", moduleName))
              .join(", ")}`,
          );
        }

        // With pnpm hoisting, electron-builder may package the main module into app.asar but omit runtime dependencies
        // that it still resolves from the root node_modules directory.
        // require-in-the-middle previously missed module-details-from-path; now @fiahfy/icns has missed pngjs.
        // Both cause Cannot find module in installed apps and crash the main process at startup.
        // Recursively complete the dependency closure from package.json to avoid fixing one missing package at a time and discovering its child later.
        // Explicit package.json dependencies, this package's node_modules mirror, and files includes did not reliably put it in asar,
        // so rewrite app.asar in afterPack to add these runtime packages before signing and packaging.
        mkdirSync(dirname(targetModulePath), { recursive: true });
        rmSync(targetModulePath, { force: true, recursive: true });
        cpSync(sourceModulePath, targetModulePath, { recursive: true });
      }
    });

    await runTimedAsync("afterPack:asar-pack", () =>
      replaceAppAsarFromStaging({
        sourceDir: stagingDir,
        appAsarPath,
        targetPlatformKey: targetPlatform.key,
        runAsarCommand,
      }),
    );
  } finally {
    rmSync(stagingDir, { force: true, recursive: true });
  }
}

async function stripPackagedSourcemapReferences(context) {
  // electron-builder's files rules can exclude .map files but cannot remove trailing source map comments from JS/CSS.
  // Injecting runtime dependencies in afterPack may also reintroduce third-party sourceMappingURL entries.
  // Clean app.asar and unpacked/extraResources here so release packages do not expose source map path entries.
  await cleanupPackagedSourcemaps({
    appAsarPath: resolveAppAsarPath(context),
    resourcesDir: resolvePackagedResourcesDir(context),
    runAsarCommand,
    runTimedSync,
    runTimedAsync,
    replaceAppAsarFromStaging: ({ sourceDir, appAsarPath }) =>
      replaceAppAsarFromStaging({
        sourceDir,
        appAsarPath,
        targetPlatformKey: targetPlatform.key,
        runAsarCommand,
      }),
  });
}

function assertPackagedNativeResourcePolicy(context) {
  const appAsarPath = resolveAppAsarPath(context);
  const entries = parseAsarListWithPackState(
    runAsarCommandAndReadStdout(["list", "--is-pack", appAsarPath]),
  );
  const violations = findDesktopNativePackageViolations(entries, targetPlatform.key);
  if (violations.length > 0) {
    // supportedArchitectures lets the workspace prepare dependencies for multiple platforms, but an installer must contain only target-platform resources.
    // Other-platform Canvas and node-pty native files were previously included in asar/unpacked, adding hundreds of MiB to the package.
    throw new Error(`桌面 native 资源边界校验失败:\n- ${violations.join("\n- ")}`);
  }
}

function assertPackagedNodePtyPrebuild(context) {
  const targetBinaryPath = resolvePackagedNodePtyPrebuildPath({
    resourcesDir: resolvePackagedResourcesDir(context),
    platformKey: targetPlatform.key,
  });
  if (!existsSync(targetBinaryPath))
    throw new Error(`node-pty 预编译产物缺失: ${targetBinaryPath}`);
}

/** @type {import("electron-builder").Configuration} */
export default {
  appId: desktopProductIdentity.appId,
  // Linux deb packaging (fpm) validates homepage, author.email, and maintainer in package metadata.
  // If these fields are missing in CI, packaging fails at the artifact stage. Set them in the build config instead of relying on external injection.
  extraMetadata: {
    version: buildMetadata.appVersion,
    zcodeProductFlavor: desktopProductIdentity.flavor,
    homepage: "https://zcode.z.ai",
    author: {
      name: "ZCode",
      email: "dev@zcode.z.ai",
    },
  },
  // During macOS signing, each language package under Electron Framework is signed individually.
  // Keeping every default locale creates many locale.pak signing calls and significantly increases packaging time.
  // Retain only the locales required by this product to reduce the number of signed files and total CI time.
  electronLanguages: ["en-US", "zh-CN", "uk"],
  // In a pnpm workspace with a semver range (such as ^41.0.3), electron-builder
  // sometimes cannot reliably infer the Electron version from the dependency tree and stops bundling.
  // Specify the current Desktop Electron version explicitly to avoid unreliable guesses during packaging.
  electronVersion: "41.0.3",
  electronDownload: {
    // ELECTRON_MIRROR is a global @electron/get environment variable and overrides mirrorOptions passed by dmg-builder and other
    // generic artifacts, causing builder helper packages to be resolved from the Electron runtime mirror directory.
    // Use electron-builder's dedicated setting here so it affects only Electron runtime ZIP downloads.
    mirror: resolveElectronDownloadMirror(),
  },
  productName: desktopProductIdentity.productName,
  directories: {
    // macOS arm64/x64 CI jobs may package concurrently in the same checkout.
    // Allow output roots to be isolated by architecture so one job cannot remove another job's .app during signing when it cleans dist.
    output: desktopDistDir,
    buildResources: "build",
  },
  files: [
    "out/**/*",
    "package.json",
    // app.asar includes the Desktop runtime node_modules, which would also include package .map files and READMEs in the installer by default.
    // Prune non-runtime files at the package level while retaining LICENSE files.
    ...PACKAGING_PRUNE_PATTERNS,
    ...createDesktopNativePackagePrunePatterns(targetPlatform.key),
    "!node_modules/@zcode/**",
    "!node_modules/react/**",
    "!node_modules/react-dom/**",
  ],
  asarUnpack: [
    // node-pty target prebuilds also contain helper executables such as spawn-helper / winpty-agent.exe,
    // so the entire target directory must be unpacked; files rules already prune other platform directories.
    `node_modules/node-pty/prebuilds/${targetPlatform.key}/**`,
  ],
  beforePack: async (context) => {
    runTimedSync("beforePack:restoreTargetNodePtyPrebuild", () =>
      restoreTargetNodePtyPrebuild({ desktopPackageRoot, targetPlatform }),
    );
    if (context.electronPlatformName !== "win32" || nsisInstallSectionPatched) {
      return;
    }

    nsisInstallSectionPath = resolve(
      dirname(requireFromConfig.resolve("app-builder-lib/package.json")),
      "templates",
      "nsis",
      "installSection.nsh",
    );
    const patchResult = await runTimedAsync("beforePack:patchNsisInstallSection", () =>
      patchNsisInstallSectionFile(nsisInstallSectionPath),
    );
    nsisInstallSectionPatched = true;
    nsisInstallSectionOriginalSource = patchResult.originalSource;
    if (patchResult.changed) {
      // electron-builder compiles NSIS later in the current process. Restore the upstream template in node_modules
      // after the entire build process exits so a one-time packaging customization is not left in development dependencies.
      process.once("exit", () => {
        restoreNsisInstallSectionFileSync({
          filePath: nsisInstallSectionPath,
          originalSource: nsisInstallSectionOriginalSource,
        });
      });
    }
  },
  afterExtract: async (context) => {
    // Fix: the macOS rename stage removes the archive's top-level license; preserve the target platform's original license in afterExtract.
    const framework = context.packager.info.framework;
    const resources =
      context.electronPlatformName === "darwin"
        ? resolve(context.appOutDir, framework.distMacOsAppName, "Contents", "Resources")
        : resolve(context.appOutDir, "resources");
    await stageElectronNotices(context.appOutDir, resources, framework.version);
  },
  afterPack: async (context) => {
    const actualWindowsTarget =
      context.electronPlatformName === "win32"
        ? resolveElectronBuilderWindowsTarget({
            electronPlatformName: context.electronPlatformName,
            arch: context.arch,
            configuredTargetPlatform: targetPlatform,
          })
        : null;
    await runTimedAsync("afterPack:injectHoistedRuntimeModulesIntoAsar", () =>
      injectHoistedRuntimeModulesIntoAsar(context),
    );
    await runTimedAsync("afterPack:stripPackagedSourcemapReferences", () =>
      stripPackagedSourcemapReferences(context),
    );
    runTimedSync("afterPack:assertPackagedNativeResourcePolicy", () =>
      assertPackagedNativeResourcePolicy(context),
    );
    runTimedSync("afterPack:assertPackagedNodePtyPrebuild", () =>
      assertPackagedNodePtyPrebuild(context),
    );
    if (actualWindowsTarget) {
      await runTimedAsync("afterPack:writeWindowsInstallManifest", () =>
        writeWindowsInstallManifest(context),
      );
    }
  },
  extraResources: [
    { from: resolve(workspaceRoot, noticesFileName), to: noticesFileName },
    ...(targetPlatform.os === "darwin"
      ? [
          {
            // The snap-position source for the CUA permission popover (CGWindowListCopyWindowInfo; no TCC permissions required).
            // The main process resolves it through process.resourcesPath; if missing, the watcher fails open and the popover still works,
            // just without snapping, so do not assert that the file exists here.
            from: "resources/macos-window-bounds/zcode-window-bounds",
            to: "macos-window-bounds/zcode-window-bounds",
          },
        ]
      : []),
    {
      // Release packages cannot rely on the repository directory for built-in fallback configuration such as community and feedback settings.
      // Include these files in resources/config, matching the main process's process.resourcesPath resolution.
      from: resolve(workspaceRoot, "config/default.json"),
      to: "config/default.json",
    },
    {
      // The Provider Registry's ZCode Built-in Config is the only built-in source of static Provider/Model facts.
      // Include it in the package so the production Host does not fall back to hardcoded legacy Catalog/Preset data.
      from: builtinProviderConfig.sourcePath,
      to: "config/provider/zcode-builtin.json",
    },
    {
      // Application icon: packaging places it in the resources directory, where the main process loads it through process.resourcesPath.
      from: "build/icon.png",
      to: "icon.png",
    },
    ...(targetPlatform.os === "linux"
      ? [
          {
            // AppImage user-level hicolor icon installation uses the actual 512x512 resource so the declared directory size matches the PNG IHDR.
            from: "build/icons/512x512.png",
            to: "icon_512x512.png",
          },
        ]
      : []),
    {
      // Separate Windows icon: use the same taskbar/window icon resource in development and packaged builds.
      from: "build/icon_windows.png",
      to: "icon_windows.png",
    },
    ...(targetPlatform.os === "win32"
      ? [
          {
            // Windows tray icon: in packaged builds, Tray can reliably read only a separate resource under resources.
            // Do not reuse the window PNG, which would become blurry when scaled in the notification area at high DPI.
            from: "build/icon.ico",
            to: "tray_icon.ico",
          },
        ]
      : []),
    {
      // Agent runtime assets are packaged under resources/glm.
      // Desktop bundles the Agent JS bundle (glm/zcode.cjs, generated by prepare:agent-bundle).
      // The Host process uses the app's Electron Node runtime (ELECTRON_RUN_AS_NODE) to run `zcode.cjs app-server --stdio`,
      // so a separate Node binary is no longer packaged. Remote SSH/WSL still uses native binaries (without Electron).
      from: `bundled-agents/${targetPlatform.key}/glm`,
      to: "glm",
      filter: ["**/*", "!**/*.map"],
    },
    {
      // The Agent shell previously relied entirely on the host system PATH, which often omitted the user's rg installation when launched from the GUI.
      // Package ripgrep as a Desktop runtime tool under resources/tools.
      // Host/server later append that directory to PATH; the user's version takes precedence, with the bundled rg as a fallback.
      from: `bundled-tools/${targetPlatform.key}/ripgrep`,
      to: "tools/ripgrep",
      filter: ["**/*"],
    },
    ...nativeSearchReleasePlan.extraResourceToolIds.map((toolId) => ({
      from: `bundled-tools/${targetPlatform.key}/${toolId}`,
      to: `tools/${toolId}`,
      filter: ["**/*"],
    })),
  ],
  // postinstall first reuses node-pty's Windows prebuild; other platforms run electron-rebuild as needed.
  // Packaging reuses the native files prepared during installation to avoid another uncontrolled local compile in electron-builder.
  npmRebuild: false,
  // OAuth deep-link protocol registration (packaged macOS builds must declare CFBundleURLTypes in Info.plist).
  protocols: [
    {
      // The protocol handler's display name used to be the lowercase scheme, so the packaged protocol description did not show the product name.
      // The display name now follows the package identity; the scheme remains zcode, so the app registered last becomes the default handler.
      name: desktopProductIdentity.productName,
      schemes: ["zcode"],
    },
  ],
  mac: {
    target: ["dmg", "zip"],
    category: "public.app-category.developer-tools",
    artifactName: buildDesktopArtifactName("mac"),
    extendInfo: {
      NSAppleEventsUsageDescription: `${desktopProductIdentity.productName} needs Apple Events access to coordinate local automation workflows with user-approved desktop apps.`,
    },
    // The pre-signing script uses native codesign and requires the full "Developer ID Application: ..." identity string,
    // but electron-builder 26.x rejects names with that prefix in mac.identity.
    // Normalize the prefix only for electron-builder so local pre-signing and final .app signing do not conflict.
    // z-code previously had only local unsigned packaging configuration. Even when CI supplied certificate variables,
    // electron-builder did not automatically enable hardened runtime and entitlements for release packaging.
    // Gate these settings explicitly so local development is not tied to signing configuration and CI can enable them for releases.
    identity: shouldEnableMacSigning ? macSigningIdentity : null,
    // macOS artifacts use a two-stage pipeline: signing during build, followed by a separate notarization stage.
    // If electron-builder's built-in notarization is not explicitly disabled, it reads Apple credentials and attempts notarization during build,
    // requiring APPLE_APP_SPECIFIC_PASSWORD and failing before the DMG is produced.
    notarize: false,
    hardenedRuntime: shouldEnableMacSigning,
    gatekeeperAssess: false,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.inherit.plist",
    // Runtime executables are signed in a separate pre-signing stage before packaging.
    // Deep-scanning these directories while electron-builder signs the main app significantly increases macOS codesign time.
    // Match absolute paths using any prefix plus Contents/Resources so the pattern works in CI, unlike ^Contents/....
    // Skip repeated signing/scanning of already signed directories while retaining signatures for the main app and frameworks.
    // The CUA Helper is already Developer ID signed and notarized in a separate job.
    // If electron-builder signs the nested Helper again, its CDHash changes and invalidates the staple in the final user package.
    signIgnore: [
      "[/\\\\]Contents[/\\\\]Resources[/\\\\]glm([/\\\\]|$)",
      "[/\\\\]Contents[/\\\\]Resources[/\\\\]tools([/\\\\]|$)",
    ],
  },
  win: {
    target: ["nsis"],
    artifactName: buildDesktopArtifactName("win"),
  },
  linux: {
    target: ["AppImage", "deb", "rpm", "pacman"],
    artifactName: buildDesktopArtifactName("linux"),
    // The Desktop package name is scoped (@zcode/desktop), so electron-builder defaults the
    // Linux executable/Icon name to @zcodedesktop. Some desktop environments cannot find a hicolor icon by that name
    // and fall back to a system gear. Set a stable lowercase name so Icon=zcode
    // matches /usr/share/icons/hicolor/*/apps/zcode.png.
    executableName: desktopProductIdentity.linuxExecutableName,
    category: "Development",
    maintainer: "ZCode <dev@zcode.z.ai>",
  },
  deb: {
    // Production and Preview must be separate dpkg packages; changing only the executable name still makes the installer replace the other version as an upgrade.
    packageName: desktopProductIdentity.linuxPackageName,
  },
  pacman: {
    // Keep flavor isolation consistent with deb/rpm so pacman does not treat Preview and Production as the same package.
    packageName: desktopProductIdentity.linuxPackageName,
    // List Electron runtime dependencies resolvable from official Arch repositories, replacing electron-builder's
    // outdated defaults to avoid installation failures caused by removed package names.
    depends: PACMAN_RUNTIME_DEPENDENCIES,
    // Electron Builder defaults pacman targets to .pacman; the standard extension for native Arch packages is .pkg.tar.zst.
    artifactName: buildDesktopArtifactName("linux", "pkg.tar.zst"),
  },
  rpm: {
    // As with deb, Production and Preview must be separate rpm packages; otherwise dnf treats the other flavor as an upgrade.
    // RPMs target RHEL 8+ (glibc 2.28). node-pty prebuild and bfs/ugrep raise the package glibc floor to 2.28;
    // the Electron 41 main binary requires only 2.25. fpm requires rpmbuild and xz on the build host.
    packageName: desktopProductIdentity.linuxPackageName,
    // electron-builder's default RPM Requires (gtk3/nss/libXtst, etc.) omit mesa-libgbm and alsa-lib from Electron ELF's
    // DT_NEEDED list. A minimal rockylinux:8 container confirmed that the installed app fails to start with libgbm.so.1 missing.
    // Use fpm to append -d after the default Requires; do not use depends, which replaces the entire default Requires set.
    fpm: ["-d", "mesa-libgbm", "-d", "alsa-lib"],
  },
  dmg: {
    // Runtime resources in the current installer, especially agent node_modules, exceed the default DMG size estimate.
    // With automatic sizing, the DMG volume was only about 1.9 GiB; copying .app ran out of space and
    // omitted the Electron Framework main binary, causing DYLD Library missing after installation.
    // Increase the DMG size explicitly to prevent a truncated copy that leaves the Framework directory without its core file.
    size: "3200m",
    // Use a custom installer background image.
    background: "build/dmg_background.png",
    // Use a dedicated installer-disk icon instead of reusing the application icon, which is less recognizable in the installer.
    icon: "build/icon_installer.icns",
    contents: [
      // Experimental adjustment: set explicit icon coordinates for hidden resource files to move them toward the corners.
      { x: 640, y: 56, type: "file", path: ".background.tiff" },
      { x: 640, y: 56, type: "file", path: ".VolumeIcon.icns" },
      { x: 130, y: 220 },
      { x: 410, y: 220, type: "link", path: "/Applications" },
    ],
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    // Use a separate icon for the Windows installer, independent of the application's runtime icon.
    installerIcon: "build/icon_installer.ico",
    uninstallerIcon: "build/icon_installer.ico",
    installerHeaderIcon: "build/icon_installer.ico",
  },
  detectUpdateChannel: false,
  publish: {
    provider: "generic",
    // The current OSS/CDN returns 206 for multi-range requests but keeps Content-Type as application/x-msdownload.
    // electron-updater falls back to a full download when multipart/byteranges is missing. Disabling multiple ranges still uses differential updates,
    // fetching changed blocks sequentially with single-range requests and avoiding a Windows update growing from about 15 MB to a 300 MB+ full package.
    useMultipleRangeRequest: false,
    // New clients use the server manifest provider at runtime. Keep only electron-builder's required
    // generic publish placeholder so the package no longer carries a configurable legacy stable feed.
    url: "http://localhost:8081",
  },
};
