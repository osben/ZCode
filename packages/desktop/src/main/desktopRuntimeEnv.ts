/* eslint-disable max-lines -- Desktop runtime/env parsing centrally maintains startup boundaries for main/host/remote assets; splitting it would expand the remote-connection regression surface. */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, win32 } from "node:path";
import type { ConnectOptions } from "@zcode/server/remote";
import { listSSHConfigAliasesFromLocalConfig } from "@zcode/services/node";
import { DEV_HELPER_APP_NAME, HELPER_APP_NAME } from "@zcode/zcode-cua/broker/helperConstants";
import {
  ZCODE_APP_VERSION_ENV,
  ZCODE_BUILD_COMMIT_ID_ENV,
  ZCODE_AGENT_RUNTIME,
  ZCODE_COMMIT,
  ZCODE_DYNAMIC_WORKFLOW_MODE_ENV,
  ZCODE_ENV,
  ZCODE_PRODUCT_FLAVOR,
  ZCODE_RUNTIME_ENV_KEY,
  ZCODE_VERSION,
  buildZCodeToolEnvPassthroughEnv,
  resolveRuntimeZCodeEndpointOrigin,
  resolveZaiBusinessBaseUrl,
  resolveZaiOAuthClientId,
  resolveZaiOAuthOrigin,
  normalizeDynamicWorkflowMode,
  readZCodeAgentTelemetryEnv,
  sanitizeZCodeRuntimeEnv,
  type ZCodeRuntimeEnv,
} from "@zcode/shared";
import { resolvePlatformKeyForPackagedApp } from "../../scripts/target-platform.mjs";
import {
  getAppConfigDir,
  getDataBaseDir,
  ZCODE_CUA_BUNDLED_HELPER_APP_PATH_ENV,
  ZCODE_WINDOWS_APP_INSTALL_DIR_ENV,
} from "@zcode/services/node";
import {
  resolveRemoteCdnBaseUrls as resolveOrderedRemoteCdnBaseUrls,
  type ResolveRemoteCdnOptions,
} from "./remoteCdn.js";
import { getElectronAppPath, isElectronAppPackaged } from "./desktopElectronApp.js";

declare const __ZCODE_PACKAGED_AGENT_TELEMETRY_ENV__: Readonly<Record<string, string>> | undefined;

const isLocalDevelopmentRuntime = !isElectronAppPackaged();
export const desktopRuntimeEnv: ZCodeRuntimeEnv = isLocalDevelopmentRuntime
  ? "development"
  : "production";
// Determine identity from the compile-time flavor, not ZCODE_ENV: a production-backend build with
// ZCODE_PREVIEW_IDENTITY=1 is still Preview and needs a separate app name, Electron data directory,
// and Helper installation subdirectory to run alongside the production version.
export const isPreviewPackagedRuntime =
  !isLocalDevelopmentRuntime && ZCODE_PRODUCT_FLAVOR === "preview";

function readRuntimeEnvOverride(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

function isTruthyRuntimeEnvOverride(name: string): boolean {
  const value = readRuntimeEnvOverride(name)?.toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

// E2E runs a production build, which by default shares the local production ZCode app name/userData.
// Electron's single-instance lock then activates the existing window, preventing Chromedriver from
// taking over the test process. Allow tests to isolate runtime identity explicitly while preserving
// defaults for normal desktop/remote-control paths.
export const runtimeApplicationName =
  readRuntimeEnvOverride("ZCODE_DESKTOP_APPLICATION_NAME") ??
  (isLocalDevelopmentRuntime ? "ZCode Dev" : isPreviewPackagedRuntime ? "ZCode Preview" : "ZCode");
// Electron's app.getPath("home") does not necessarily follow a HOME override in the test process.
// E2E's default workspace depends on the home path, so provide an explicit override to avoid writing
// tests into the developer's real ~/ZCodeProject.
export const runtimeHomePath = readRuntimeEnvOverride("ZCODE_DESKTOP_HOME_DIR");
// When Chromedriver manages Electron, it injects a temporary userData; in E2E default-path mode,
// appData cannot be read early during module import.
export const shouldUseElectronDefaultUserDataPath = isTruthyRuntimeEnvOverride(
  "ZCODE_DESKTOP_USE_ELECTRON_DEFAULT_USER_DATA",
);
export const runtimeUserDataPath =
  readRuntimeEnvOverride("ZCODE_DESKTOP_USER_DATA_DIR") ??
  (shouldUseElectronDefaultUserDataPath
    ? undefined
    : join(getElectronAppPath("appData"), runtimeApplicationName));
export const runtimeSessionDataPath =
  readRuntimeEnvOverride("ZCODE_DESKTOP_SESSION_DATA_DIR") ??
  (runtimeUserDataPath ? join(runtimeUserDataPath, "session") : undefined);
// Chromedriver injects a temporary --user-data-dir and waits for DevToolsActivePort in that directory.
// If E2E then overrides userData/sessionData with app.setPath, the port file is written elsewhere,
// so Electron starts but the WebDriver session never initializes. Enable this flag in test mode to
// preserve Chromedriver's directory.
export const hostModulePath = join(import.meta.dirname, "../host/index.js");
export const schedulerModulePath = join(import.meta.dirname, "../scheduler/index.js");
export function getCredentialsDir() {
  return getAppConfigDir();
}

export type RemoteAssetDirs = Pick<
  ConnectOptions,
  "mockCdnDir" | "remoteCdnBaseUrl" | "remoteCdnBaseUrls" | "remoteCacheDir"
>;
type LocalRuntimeEnv = Record<string, string | undefined>;

export async function isDockerDaemonAvailable(): Promise<boolean> {
  const { isDockerAvailable } = await import("@zcode/server/remote");
  return isDockerAvailable();
}

export async function listAvailableWSLDistros() {
  const { listWSLDistros } = await import("@zcode/server/remote");
  return listWSLDistros();
}

export async function listAvailableDockerContainers() {
  const { listDockerContainers } = await import("@zcode/server/remote");
  return listDockerContainers();
}

export async function listSSHConfigAliases() {
  return await listSSHConfigAliasesFromLocalConfig();
}

function parseDotenv(content: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }

    const normalized = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const equalsIndex = normalized.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }

    const key = normalized.slice(0, equalsIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }

    let value = normalized.slice(equalsIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    values[key] = value;
  }

  return values;
}

function resolveWorkspaceRootForEnvFiles(): string | null {
  const workspaceRootCandidate = resolve(import.meta.dirname, "../../../..");
  return existsSync(join(workspaceRootCandidate, "pnpm-workspace.yaml"))
    ? workspaceRootCandidate
    : null;
}

export function loadHostProcessEnvFromLocalFiles(): Record<string, string> {
  if (isElectronAppPackaged()) {
    return resolvePackagedAgentTelemetryEnv();
  }

  const desktopRoot = resolve(import.meta.dirname, "../..");
  const workspaceRoot = resolveWorkspaceRootForEnvFiles();
  const fileCandidates = [
    ...(workspaceRoot
      ? [resolve(workspaceRoot, ".env"), resolve(workspaceRoot, ".env.local")]
      : []),
    // The development Host process does not run through Vite, so load the same .env files itself to keep OAuth configuration consistent.
    ...(workspaceRoot && isLocalDevelopmentRuntime
      ? [
          resolve(workspaceRoot, ".env.development"),
          resolve(workspaceRoot, ".env.development.local"),
        ]
      : []),
    resolve(desktopRoot, ".env"),
    resolve(desktopRoot, ".env.local"),
    ...(isLocalDevelopmentRuntime
      ? [resolve(desktopRoot, ".env.development"), resolve(desktopRoot, ".env.development.local")]
      : []),
  ];

  const merged: Record<string, string> = {};
  const seen = new Set<string>();

  for (const candidate of fileCandidates) {
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);

    if (!existsSync(candidate)) {
      continue;
    }

    // Previously, searching parent directories from cwd for .env could pick up a same-named file
    // outside the workspace. Restrict loading to the workspace root and desktop package directory
    // to avoid configuration-source drift.
    const parsed = parseDotenv(readFileSync(candidate, "utf-8"));
    Object.assign(merged, parsed);
  }

  return applySelectedZCodeEnvLinks(merged);
}

export function resolvePackagedAgentTelemetryEnv(
  compiledEnv:
    | Readonly<Record<string, string>>
    | undefined = typeof __ZCODE_PACKAGED_AGENT_TELEMETRY_ENV__ === "undefined"
    ? undefined
    : __ZCODE_PACKAGED_AGENT_TELEMETRY_ENV__,
): Record<string, string> {
  if (!compiledEnv) {
    return {};
  }

  // Fix rationale: dev builds inherit OTLP configuration from the launching process, but a packaged
  // installer launched from Finder/Start Menu has none of that runtime environment, so the Agent
  // silently fell back to Noop. Build-time defaults allow only connection fields into Main;
  // UID, device MID, and runtime surface are still generated by the Host's trusted runtime context.
  return readZCodeAgentTelemetryEnv({
    OTEL_EXPORTER_OTLP_ENDPOINT: compiledEnv.OTEL_EXPORTER_OTLP_ENDPOINT,
    OTEL_EXPORTER_OTLP_HEADERS: compiledEnv.OTEL_EXPORTER_OTLP_HEADERS,
    OTEL_SERVICE_NAME: compiledEnv.OTEL_SERVICE_NAME,
    ZCODE_TELEMETRY_RUNTIME_DISTRIBUTION: compiledEnv.ZCODE_TELEMETRY_RUNTIME_DISTRIBUTION,
  });
}

function resolveDevelopmentMockCdnDir(): string {
  return join(import.meta.dirname, "../../mock-cdn");
}

function resolveAvailableDevelopmentMockCdnDir(): string | undefined {
  const mockCdnDir = resolveDevelopmentMockCdnDir();
  const releaseDir = join(mockCdnDir, "releases", ZCODE_VERSION);
  // In development, mock-cdn is an optional offline cache. Passing mockCdnDir when the current
  // version directory does not exist makes WSL/SSH reconnects hit a guaranteed-missing local path
  // first, masking the existing CDN/cache fallback.
  return existsSync(releaseDir) ? mockCdnDir : undefined;
}

function isTruthyEnvFlag(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function shouldUseRemoteCdnInDevelopment(localEnv: LocalRuntimeEnv = {}): boolean {
  return isTruthyEnvFlag(resolveEnvValue("ZCODE_DEV_REMOTE_ASSET_USE_CDN", localEnv));
}

function resolveRemoteCdnBaseUrls(
  options: ResolveRemoteCdnOptions = {},
  localEnv: LocalRuntimeEnv = {},
): string[] {
  const raw = resolveEnvValue("ZCODE_REMOTE_ASSET_CDN_BASE_URL", localEnv);
  return resolveOrderedRemoteCdnBaseUrls({
    ...options,
    env: ZCODE_ENV,
    overrideBaseUrl: raw,
    version: ZCODE_VERSION,
  });
}

function resolveEnvValue(envName: string, localEnv: LocalRuntimeEnv = {}): string | undefined {
  return process.env[envName]?.trim() || localEnv[envName]?.trim() || undefined;
}

export function resolveZCodeEndpointEnvBaseOrigin(
  localEnv: LocalRuntimeEnv = {},
): string | undefined {
  const scopedEnvName =
    ZCODE_ENV === "production" ? "ZCODE_PRODUCTION_BASE_URL" : "ZCODE_TEST_BASE_URL";
  // Bugfix: when main temporarily validates the update service, it does not rewrite .env; a command-line endpoint must take precedence over the local file.
  return (
    process.env["ZCODE_BASE_URL"]?.trim() ||
    process.env["ZCODE_ENDPOINT_ORIGIN"]?.trim() ||
    process.env[scopedEnvName]?.trim() ||
    localEnv.ZCODE_BASE_URL?.trim() ||
    localEnv.ZCODE_ENDPOINT_ORIGIN?.trim() ||
    localEnv[scopedEnvName]?.trim() ||
    undefined
  );
}

function readDefinedProcessEnv(): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      values[key] = value;
    }
  }
  return values;
}

function applySelectedZCodeEnvLinks(env: Record<string, string>): Record<string, string> {
  const endpointEnv = {
    ...env,
    ZCODE_ENV,
  };

  return {
    ...env,
    ZCODE_BASE_URL: env.ZCODE_BASE_URL ?? resolveRuntimeZCodeEndpointOrigin(endpointEnv),
    ZAI_OAUTH_ORIGIN: env.ZAI_OAUTH_ORIGIN ?? resolveZaiOAuthOrigin(endpointEnv),
    ZAI_BUSINESS_BASE_URL: env.ZAI_BUSINESS_BASE_URL ?? resolveZaiBusinessBaseUrl(endpointEnv),
    ZAI_OAUTH_CLIENT_ID: env.ZAI_OAUTH_CLIENT_ID ?? resolveZaiOAuthClientId(endpointEnv),
  };
}

function resolveHostProcessNodeEnv(): ZCodeRuntimeEnv {
  return desktopRuntimeEnv;
}

function resolveRemoteAssetCacheDir(localEnv: LocalRuntimeEnv = {}): string {
  const overrideCacheDir = resolveEnvValue("ZCODE_REMOTE_ASSET_CACHE_DIR", localEnv);
  if (overrideCacheDir) {
    // Development needs to reuse the production remote cache to verify download decisions without
    // switching all of Electron userData. Override only the remote-assets cache directory to avoid
    // contaminating other development data such as login and window state.
    return resolve(overrideCacheDir);
  }

  return join(getElectronAppPath("userData"), "remote-assets-cache");
}

export function resolveRemoteAssetDirs(
  options: ResolveRemoteCdnOptions = {},
  localEnv: LocalRuntimeEnv = {},
): RemoteAssetDirs {
  const remoteCdnBaseUrls = resolveRemoteCdnBaseUrls(options, localEnv);
  const remoteCdnBaseUrl = remoteCdnBaseUrls[0];

  // Remote assets previously shared an in-package path with local desktop-provider assets, causing
  // the full Linux remote runtime to be bundled into the .app. This conflicted with the boundary
  // that remote assets come from CDN/mock-cdn. Split the paths explicitly: development reads only
  // the repository mock-cdn; production uses CDN plus a local cache, with no in-package remote-assets
  // path exposed so remote resources are not bundled again.
  // In development, keep using mock-cdn by default and switch to the public CDN only when explicitly
  // enabled. This supports offline development while allowing the real CDN download path to be tested.
  if (isElectronAppPackaged() || shouldUseRemoteCdnInDevelopment(localEnv)) {
    return {
      remoteCdnBaseUrl,
      remoteCdnBaseUrls,
      remoteCacheDir: resolveRemoteAssetCacheDir(localEnv),
    };
  }

  const developmentMockCdnDir = resolveAvailableDevelopmentMockCdnDir();
  return {
    ...(developmentMockCdnDir ? { mockCdnDir: developmentMockCdnDir } : {}),
    remoteCdnBaseUrl,
    remoteCdnBaseUrls,
    remoteCacheDir: resolveRemoteAssetCacheDir(localEnv),
  };
}

function resolveBundledZCodeAgentBinaryPath(): string | undefined {
  const runtime = ZCODE_AGENT_RUNTIME;
  const entrySegments = runtime.resolveEntrySegments(process.platform);
  const platformKey = resolvePlatformKeyForPackagedApp();
  const candidates = [
    isElectronAppPackaged()
      ? join(process.resourcesPath, runtime.bundledResourceDir, ...entrySegments)
      : null,
    // Desktop development may start with cwd at packages/desktop or at the repository root.
    // Previously bundled-agents was derived only from import.meta.dirname; add the same set of
    // candidate roots used by services to prevent resource-resolution drift across development,
    // build, and restart entry points.
    join(
      process.cwd(),
      "bundled-agents",
      platformKey,
      runtime.bundledResourceDir,
      ...entrySegments,
    ),
    join(
      process.cwd(),
      "packages",
      "desktop",
      "bundled-agents",
      platformKey,
      runtime.bundledResourceDir,
      ...entrySegments,
    ),
    join(
      import.meta.dirname,
      "../../bundled-agents",
      platformKey,
      runtime.bundledResourceDir,
      ...entrySegments,
    ),
  ].filter((candidate): candidate is string => Boolean(candidate));

  return candidates.find((candidate) => existsSync(candidate));
}

function resolveBundledRuntimeToolBinaryPath(
  toolDir: string,
  binaryName: string,
): string | undefined {
  const candidateBinaryName = process.platform === "win32" ? `${binaryName}.exe` : binaryName;
  const candidates = [
    isElectronAppPackaged()
      ? join(process.resourcesPath, "tools", toolDir, candidateBinaryName)
      : null,
    join(
      import.meta.dirname,
      "../../bundled-tools",
      resolvePlatformKeyForPackagedApp(),
      toolDir,
      candidateBinaryName,
    ),
  ].filter((candidate): candidate is string => Boolean(candidate));

  return candidates.find((candidate) => existsSync(candidate));
}

function resolveBundledLarkCliBinaryPath(): string | undefined {
  return resolveBundledRuntimeToolBinaryPath("lark-cli", "lark-cli");
}

export function resolveBundledGlmBinaryPath(): string | undefined {
  return resolveBundledZCodeAgentBinaryPath();
}

// 语音转写平台包命名必须与 transcribe-cpp dist/loader.js 的 platformTuple() 一致
// （darwin 用 metal，linux/win32 用 cpu-vulkan；上游未提供 win32-arm64 预编译包）。
const TRANSCRIBE_PLATFORM_TUPLES: Record<string, Record<string, string>> = {
  darwin: { arm64: "darwin-arm64-metal", x64: "darwin-x64-cpu" },
  linux: { arm64: "linux-arm64-cpu-vulkan", x64: "linux-x64-cpu-vulkan" },
  win32: { x64: "win32-x64-cpu-vulkan" },
};

// 根因：transcribe-cpp 通过 koffi 以 dlopen 加载平台包内的 libtranscribe 动态库，dlopen 读不了
// app.asar 虚拟路径（实测 koffi.load 对 asar 内路径报 errno=20），即使 asarUnpack 也不会被 Electron
// 自动重定向。打包时原生文件解包在 app.asar.unpacked 下，这里解析真实路径，由 main 经
// TRANSCRIBE_LIBRARY（transcribe-cpp loader 的最高优先级覆盖项）注入 Host。
export function resolveBundledTranscribeLibraryPath(
  options: {
    platform?: NodeJS.Platform | string;
    arch?: string;
    isPackaged?: boolean;
    resourcesPath?: string;
  } = {},
): string | undefined {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const isPackaged = options.isPackaged ?? isElectronAppPackaged();
  const resourcesPath = options.resourcesPath ?? process.resourcesPath;
  if (!isPackaged || !resourcesPath?.trim()) {
    return undefined;
  }

  const platformTuple = TRANSCRIBE_PLATFORM_TUPLES[platform]?.[arch];
  if (!platformTuple) {
    return undefined;
  }

  const libraryFileName =
    platform === "darwin"
      ? "libtranscribe.dylib"
      : platform === "win32"
        ? "transcribe.dll"
        : "libtranscribe.so";
  const candidate = join(
    resourcesPath,
    "app.asar.unpacked",
    "node_modules",
    "@transcribe-cpp",
    platformTuple,
    libraryFileName,
  );
  return existsSync(candidate) ? candidate : undefined;
}

function resolveHostProcessBinaryEnv(
  envVar: string,
  hostProcessLocalEnv: Record<string, string>,
  bundledPath: string | undefined,
): string | undefined {
  // The ZCode Agent and app protocol adapter are tightly version-coupled, so production packages
  // must prefer the fixed runtime bundled with the app. A leftover GLM_BINARY_PATH on the user's
  // machine or in a local .env may point to an incompatible version. Use an explicit path only when
  // the bundled runtime is missing, so a local CLI cannot override the embedded version.
  if (bundledPath) {
    return bundledPath;
  }
  const explicitPath = process.env[envVar]?.trim() || hostProcessLocalEnv[envVar]?.trim();
  if (explicitPath && existsSync(explicitPath)) {
    return explicitPath;
  }
  return undefined;
}

export function resolveWindowsAppInstallDirForDataBaseDirGuard(
  options: {
    platform?: NodeJS.Platform | string;
    isPackaged?: boolean;
    resourcesPath?: string;
  } = {},
): string | undefined {
  const platform = options.platform ?? process.platform;
  const packaged = options.isPackaged ?? isElectronAppPackaged();
  const resourcesPath = options.resourcesPath ?? process.resourcesPath;
  if (platform !== "win32" || !packaged) {
    return undefined;
  }

  const trimmedResourcesPath = resourcesPath?.trim();
  if (!trimmedResourcesPath) {
    return undefined;
  }

  return win32.dirname(trimmedResourcesPath);
}

/**
 * Local Dynamic Workflow rollout overrides follow three build tiers:
 *
 *   - Unpackaged dev: pass through valid shell values to allow manual switching; discard invalid
 *     values instead of forwarding them to Host, so Host does not need to check their source again.
 *   - Packaged Preview: always write `alwaysOn`, ignoring the shell so Preview users always have the feature.
 *   - Packaged production: do not write the value, and delete any inherited value so a local
 *     environment variable cannot enable the rollout.
 * Main is the sole decision-maker: for this key it either writes or deletes, never passes through
 * the original value. Host can then trust values read by resolveDynamicWorkflowClientConfig.
 */
export function resolveDynamicWorkflowModeHostEnv(options: {
  inheritedValue: string | undefined;
  isPackaged: boolean;
  isPreview: boolean;
}): Record<string, string> {
  if (!options.isPackaged) {
    const mode = normalizeDynamicWorkflowMode(options.inheritedValue);
    return mode ? { [ZCODE_DYNAMIC_WORKFLOW_MODE_ENV]: mode } : {};
  }
  if (options.isPreview) {
    return { [ZCODE_DYNAMIC_WORKFLOW_MODE_ENV]: "alwaysOn" };
  }
  return {};
}

export function buildHostProcessEnv(hostProcessLocalEnv: Record<string, string>) {
  const glmBinaryPath = resolveBundledGlmBinaryPath();
  const larkCliBinaryPath = resolveBundledLarkCliBinaryPath();
  const resolvedGlmBinaryPath = resolveHostProcessBinaryEnv(
    "GLM_BINARY_PATH",
    hostProcessLocalEnv,
    glmBinaryPath,
  );
  const resolvedLarkCliBinaryPath = resolveHostProcessBinaryEnv(
    "ZCODE_LARK_CLI_BINARY",
    hostProcessLocalEnv,
    larkCliBinaryPath,
  );
  // Bugfix: 打包产物内 transcribe-cpp 的原生库在 app.asar.unpacked 下，koffi dlopen 读不了 asar
  // 虚拟路径，必须显式指定；未打包（本地开发）时保持 loader 默认解析，.env 的显式覆盖仍然生效。
  const resolvedTranscribeLibraryPath = resolveHostProcessBinaryEnv(
    "TRANSCRIBE_LIBRARY",
    hostProcessLocalEnv,
    resolveBundledTranscribeLibraryPath(),
  );
  const dataBaseDir = getDataBaseDir();
  const rawInheritedEnv = {
    ...hostProcessLocalEnv,
    ...readDefinedProcessEnv(),
  };
  const packagedDesktop = isElectronAppPackaged();
  const bundledCuaHelperAppPath =
    process.platform !== "darwin"
      ? undefined
      : packagedDesktop
        ? join(process.resourcesPath, "cua-helper", HELPER_APP_NAME)
        : // Truthy grammar must match the producer's isUnsignedHelperLocalDevRequested
          // (1|true|on, case-insensitive). Accepting only the literal "1" silently
          // ignored `true`/`on` set by scripts following the documented dev flow.
          ["1", "true", "on"].includes(
              rawInheritedEnv.ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL?.trim().toLowerCase() ?? "",
            )
          ? rawInheritedEnv.ZCODE_CUA_BUNDLED_HELPER_APP_PATH?.trim() ||
            join(
              rawInheritedEnv.ZCODE_HOME?.trim() || join(homedir(), ".zcode"),
              "computer-use",
              "dev",
              DEV_HELPER_APP_NAME,
            )
          : undefined;
  const windowsAppInstallDir = resolveWindowsAppInstallDirForDataBaseDirGuard();
  const agentTelemetryEnv = readZCodeAgentTelemetryEnv(rawInheritedEnv);
  // Host reads Desktop identity from the credential store and local state, then injects it as trusted
  // data. External environment variables may configure OTLP connectivity but cannot spoof
  // uid/device/runtime surface or bypass local identity-state isolation.
  for (const key of [
    "ZCODE_TELEMETRY_USER_ID",
    "ZCODE_TELEMETRY_USER_ID_HASH",
    "ZCODE_TELEMETRY_USER_SUBJECT_ID",
    "ZCODE_TELEMETRY_IDENTITY_STATE",
    "ZCODE_TELEMETRY_DEVICE_MID",
    "ZCODE_TELEMETRY_RUNTIME_SURFACE",
  ]) {
    delete agentTelemetryEnv[key];
  }
  const inheritedEnv = applySelectedZCodeEnvLinks({
    ...sanitizeZCodeRuntimeEnv(rawInheritedEnv),
    ...buildZCodeToolEnvPassthroughEnv(rawInheritedEnv),
  });
  // A release app must never inherit the local unsigned-Helper escape hatch.
  // Otherwise a developer shell/launchctl variable can make the signed app
  // reject its verified bundled Helper and route onboarding to a stale dev app.
  if (packagedDesktop) {
    delete inheritedEnv.ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL;
  }
  const dynamicWorkflowModeHostEnv = resolveDynamicWorkflowModeHostEnv({
    inheritedValue: rawInheritedEnv[ZCODE_DYNAMIC_WORKFLOW_MODE_ENV],
    isPackaged: packagedDesktop,
    isPreview: isPreviewPackagedRuntime,
  });
  // Two of the three tiers do not write this key, and an empty object cannot override inheritedEnv.
  // Delete the inherited value unconditionally, then spread back the selected value. Without this,
  // packaged production and invalid dev values would pass through to Host unchanged.
  delete inheritedEnv[ZCODE_DYNAMIC_WORKFLOW_MODE_ENV];

  return {
    ...inheritedEnv,
    // Pass OTLP credentials only to Host; Host captures them during services initialization and
    // removes them from process.env, then injects them briefly only when starting the Agent. They do
    // not enter Bash/MCP/tool environments.
    ...agentTelemetryEnv,
    // The ZCode runtime no longer uses NODE_ENV, which is reused by user shells, package managers,
    // and test frameworks. Pass ZCODE_RUNTIME_ENV explicitly and remove inherited NODE_ENV to avoid
    // contaminating Host/Agent/Bash.
    [ZCODE_RUNTIME_ENV_KEY]: resolveHostProcessNodeEnv(),
    // Inject compile-time product identity so main and Host use the same identity semantics; resolve
    // the URLs separately. inheritedEnv fills in ZCode/ZAI links from general .env values and uses
    // production defaults when they are not set.
    ZCODE_ENV,
    // Preview and production share tasks, configuration, and credentials, but Helpers from different
    // versions must not overwrite one another or trigger downgrade protection. Isolate only the
    // computer-use runtime components; do not rewrite business data roots ZCODE_HOME / ZCODE_DATA_BASE_DIR.
    ...(isPreviewPackagedRuntime ? { ZCODE_CUA_HELPER_INSTALL_VARIANT: "preview" } : {}),
    // Local Dynamic Workflow rollout override: written after Main decides; packaged production gets
    // an empty object (the inherited value was removed above).
    ...dynamicWorkflowModeHostEnv,
    // The Agent process builds default model-request headers. Previously, inheriting only the shell
    // environment meant desktop launches lacked the app version. Pass it explicitly from main so
    // the Agent can reliably include it in request headers after inheriting the Host environment.
    [ZCODE_APP_VERSION_ENV]: ZCODE_VERSION,
    // Telemetry build identity must come from Desktop compile-time metadata; the Agent must not read
    // the worktree or guess from the install path at runtime. Otherwise different hotfix builds of the
    // same product version cannot be distinguished in ARMS.
    [ZCODE_BUILD_COMMIT_ID_ENV]: ZCODE_COMMIT,
    ...(dataBaseDir !== homedir() ? { ZCODE_DATA_BASE_DIR: dataBaseDir } : {}),
    ...(windowsAppInstallDir ? { [ZCODE_WINDOWS_APP_INSTALL_DIR_ENV]: windowsAppInstallDir } : {}),
    ...(bundledCuaHelperAppPath
      ? { [ZCODE_CUA_BUNDLED_HELPER_APP_PATH_ENV]: bundledCuaHelperAppPath }
      : {}),
    ...(resolvedGlmBinaryPath ? { GLM_BINARY_PATH: resolvedGlmBinaryPath } : {}),
    ...(resolvedLarkCliBinaryPath ? { ZCODE_LARK_CLI_BINARY: resolvedLarkCliBinaryPath } : {}),
    ...(resolvedTranscribeLibraryPath ? { TRANSCRIBE_LIBRARY: resolvedTranscribeLibraryPath } : {}),
  };
}
