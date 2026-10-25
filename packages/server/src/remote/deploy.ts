/* eslint-disable max-lines -- The remote deployment entry point coordinates server/node/agent/tool resources; splitting it requires a separate boundary review. */
import { join } from "node:path";
import {
  ZCODE_VERSION,
  formatLogPrefix,
  normalizeRemoteResourcePackageSelection,
  type RemoteAssetInstallMode,
  type RemoteResourcePackageId,
  type RemoteResourcePackageSelection,
} from "@zcode/shared";
import type { IRemoteBackend, RemoteEnvironment } from "./backend.js";
import { deployZCodeAgentRuntime } from "./zcodeAgentDeploy.js";
import {
  deployNodePtyPrebuilds,
  deployNodeRuntime,
  createRemoteComponentVersionResolver,
  logDeployRequired,
} from "@zcode/server/remote/remoteAssetDeployDecision.js";
import {
  REMOTE_BASE,
  fileExists,
  formatOptionalValue,
  formatOptionalValues,
  type DeployLoggers,
  type RemoteAssetDeployOptions,
} from "@zcode/server/remote/deployShared.js";
import { quotePosixPathArg } from "@zcode/server/remote/posixShell.js";
import { checkServerBundleRequiredMarkers } from "@zcode/server/remote/serverBundleDeployCheck.js";
import { deployRuntimeTools } from "@zcode/server/remote/runtimeToolDeploy.js";
import { REMOTE_AGENT_OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS } from "@zcode/server/remote/zcodeAgentOfficialPluginAssets.js";
import {
  ensureRemoteReleaseDirFromCdn,
  selectRemoteAssetManifestComponents,
  type RemoteAssetManifestRef,
} from "@zcode/server/remote/remoteAssetCache.js";
import {
  fetchRemoteDownloadManifest,
  LocalUploadAssetInstaller,
  RemoteDownloadAssetInstaller,
  type RemoteAssetInstaller,
  type RemoteManifestRef,
} from "@zcode/server/remote/remoteAssetInstaller.js";
import {
  checkRemoteAssetComponentIdentity,
  createFreshRemoteAssetManifestRefResolver,
  hasRemoteAssetComponentRefreshPending,
  markRemoteAssetComponentRefreshPending,
  writeRemoteAssetComponentMeta,
} from "@zcode/server/remote/remoteAssetLiveIdentity.js";
import { detectRemoteAssetTools } from "@zcode/server/remote/remoteAssetPreflight.js";
import { assertSupportedRemoteEnvironment } from "@zcode/server/remote/remotePlatformSupport.js";
import { acquireRemoteDeployLock } from "@zcode/server/remote/remoteDeployLock.js";
import type { RemoteAssetNetworkPort } from "@zcode/server/remote/remoteAssetNetwork.js";

const log = (...args: unknown[]) => console.log(formatLogPrefix("deploy", process.pid), ...args);
const logWarn = (...args: unknown[]) =>
  console.warn(formatLogPrefix("deploy", process.pid), ...args);
const SERVER_BUNDLE_COMPONENT_ID = "server-bundle";

export type DeployLockMode = "remote" | "caller-serialized";

export interface DeployOptions {
  /** Cancel initialization of the current remote connection and uploads it owns. */
  signal?: AbortSignal;
  /** Local mock-CDN directory used to read remote assets during development. */
  mockCdnDir?: string;
  /** Production CDN base URL for remote assets. */
  remoteCdnBaseUrl?: string;
  /** Production CDN base URL candidates for remote assets, tried in order. */
  remoteCdnBaseUrls?: string[];
  /** Cache directory for production remote assets. */
  remoteCacheDir?: string;
  /** Timeout for one manifest CDN candidate request; defaults to 10 seconds. */
  manifestRequestTimeoutMs?: number;
  /** HTTP(S) egress for remote assets, injected by Desktop Host; standalone remains direct when omitted. */
  remoteAssetNetwork?: RemoteAssetNetworkPort;
  /** Force deploy even if versions match */
  force?: boolean;
  /** Total deadline for waiting on the remote install-root deployment lock; defaults to 120 seconds. */
  deployLockAcquireTimeoutMs?: number;
  /** Deployment serialization boundary; defaults to the remote install-root lock. */
  deployLockMode?: DeployLockMode;
  /** SSH-only remote asset install strategy. */
  assetInstallMode?: RemoteAssetInstallMode;
  /** Check, download, and upload remote assets only for the selected resource packages. */
  resourcePackages?: RemoteResourcePackageSelection;
}

/**
 * Deploy the zcode server to the remote machine.
 * Uploads Node.js binary, server bundle, and node-pty prebuild.
 *
 * Returns true if a deploy was performed, false if skipped (version matches).
 */
export async function deployServer(
  backend: IRemoteBackend,
  env: RemoteEnvironment,
  options?: DeployOptions,
): Promise<boolean> {
  const platformArch = `${env.platform}-${env.arch}`;
  assertSupportedRemoteEnvironment(env);
  const selectedResourcePackageIds = normalizeRemoteResourcePackageSelection();
  const shouldDeployResourcePackage = (packageId: RemoteResourcePackageId): boolean =>
    selectedResourcePackageIds.includes(packageId);
  const componentResolverOptions = {
    mockCdnDir: options?.mockCdnDir,
    remoteCdnBaseUrl: options?.remoteCdnBaseUrl,
    remoteCdnBaseUrls: options?.remoteCdnBaseUrls,
    remoteCacheDir: options?.remoteCacheDir,
    manifestRequestTimeoutMs: options?.manifestRequestTimeoutMs,
    remoteAssetNetwork: options?.remoteAssetNetwork,
  };
  const resolveFreshAssetManifestRef = createFreshRemoteAssetManifestRefResolver(
    componentResolverOptions,
    env,
    {
      log,
      logWarn,
    },
  );
  const resolveFreshCdnManifestRef = createFreshRemoteAssetManifestRefResolver(
    { ...componentResolverOptions, mockCdnDir: undefined },
    env,
    { log, logWarn },
  );
  let remoteManifestPromise: Promise<RemoteManifestRef> | null = null;
  const getRemoteManifestRef = (): Promise<RemoteManifestRef> => {
    remoteManifestPromise ??= fetchRemoteDownloadManifest(
      {
        version: ZCODE_VERSION,
        platformArch,
        remoteCdnBaseUrl: options?.remoteCdnBaseUrl,
        remoteCdnBaseUrls: options?.remoteCdnBaseUrls,
        manifestRequestTimeoutMs: options?.manifestRequestTimeoutMs,
        remoteAssetNetwork: options?.remoteAssetNetwork,
      },
      { log, logWarn },
    );
    return remoteManifestPromise;
  };
  let localManifestRefPromise: Promise<RemoteAssetManifestRef | null> | null = null;
  const getLocalManifestRef = (): Promise<RemoteAssetManifestRef | null> => {
    // The deployment lock may take a while to acquire. Starting a fresh manifest request before the
    // lock is acquired could let a waiter overwrite the new owner's deployment with an old SHA. Resolve
    // and pin it only when first needed inside the lock; later GLM identity checks and release
    // materialization still reuse the same snapshot.
    localManifestRefPromise ??= resolveFreshAssetManifestRef();
    return localManifestRefPromise;
  };
  const getManifestRefForComponents = async (
    componentIds?: string[],
  ): Promise<RemoteAssetManifestRef | null> => {
    if (options?.assetInstallMode === "remote-download") {
      return getRemoteManifestRef();
    }
    const mockReleaseDir = resolveMockCdnReleaseDir(options?.mockCdnDir);
    if (!mockReleaseDir) {
      return getLocalManifestRef();
    }
    const missingMockPaths = await findMissingMockReleasePaths(
      mockReleaseDir,
      platformArch,
      componentIds,
    );
    if (missingMockPaths.length > 0 && hasRemoteAssetCdnFallback(options)) {
      // A mock manifest existing does not mean every file for this component is complete. When falling
      // back to the CDN, the SHA skip decision and release materialization must share one CDN snapshot.
      return resolveFreshCdnManifestRef();
    }
    return getLocalManifestRef();
  };
  const resolvedReleaseDirs = new Map<string, string | null>();
  const getReleaseDir = async (
    componentIds?: string[],
    resolutionOptions?: { forceRefresh?: boolean },
  ): Promise<string | null> => {
    const forceRefresh = Boolean(resolutionOptions?.forceRefresh);
    const cacheKey = buildReleaseDirCacheKey(componentIds, forceRefresh);
    if (resolvedReleaseDirs.has(cacheKey)) {
      return resolvedReleaseDirs.get(cacheKey) ?? null;
    }
    const releaseDir = await resolveReleaseDir(
      options,
      env,
      { log, logWarn },
      componentIds,
      await getManifestRefForComponents(componentIds),
      forceRefresh,
    );
    resolvedReleaseDirs.set(cacheKey, releaseDir);
    log(
      "releaseDir:",
      releaseDir ?? "<missing>",
      "components:",
      componentIds?.join(",") ?? "<all>",
    );
    return releaseDir;
  };
  const getComponentSha256 = async (componentId: string): Promise<string | null> => {
    const manifestRef = await getManifestRefForComponents([componentId]);
    return manifestRef
      ? (selectRemoteAssetManifestComponents(manifestRef.manifest, [componentId])[0]?.sha256 ??
          null)
      : null;
  };
  const assetDeployOptions = {
    signal: options?.signal,
    resolveReleaseDir: getReleaseDir,
    resolveComponentSha256: getComponentSha256,
    remoteCdnBaseUrl: options?.remoteCdnBaseUrl,
    remoteCdnBaseUrls: options?.remoteCdnBaseUrls,
    remoteCacheDir: options?.remoteCacheDir,
    manifestRequestTimeoutMs: options?.manifestRequestTimeoutMs,
    remoteAssetNetwork: options?.remoteAssetNetwork,
  };
  const getComponentVersion = createRemoteComponentVersionResolver(componentResolverOptions, env, {
    log,
    logWarn,
  });
  const installer = createRemoteAssetInstaller(
    backend,
    {
      ...assetDeployOptions,
      platformArch,
      version: ZCODE_VERSION,
      assetInstallMode: options?.assetInstallMode,
    },
    { log, logWarn },
    options?.assetInstallMode === "remote-download" ? getRemoteManifestRef : null,
  );
  const getExpectedComponentVersion = async (componentId: string): Promise<string | null> => {
    if (installer.resolveComponentVersion) {
      const installerVersion = await installer.resolveComponentVersion(componentId);
      if (installerVersion) {
        return installerVersion;
      }
    }

    // LocalUploadAssetInstaller reads the mock-CDN manifest in development. Deployment decisions
    // previously used only the CDN resolver, so the mock-CDN branch had no expectedVersion and
    // repeatedly uploaded the full node-runtime even when the main server needed no refresh.
    return getComponentVersion(componentId);
  };

  log("mockCdnDir:", options?.mockCdnDir ?? "<missing>");
  log("remoteCdnBaseUrl:", formatOptionalValue(options?.remoteCdnBaseUrl));
  log("remoteCdnBaseUrls:", formatOptionalValues(options?.remoteCdnBaseUrls));
  log("remoteCacheDir:", formatOptionalValue(options?.remoteCacheDir));
  log("remote env:", platformArch);
  log("selected remote resource packages:", selectedResourcePackageIds.join(","));

  const deployWithDecision = async (
    serverDeployDecision: ServerDeployDecision,
    expectedServerBundleSha256: string | null,
  ): Promise<boolean> => {
    const hasPendingAppVersionRefresh = await hasRemoteAssetComponentRefreshPending(backend, {
      componentId: "glm",
      platformArch,
    });
    const shouldForceRefreshContentAddressedAssets =
      Boolean(options?.force) ||
      hasPendingAppVersionRefresh ||
      (serverDeployDecision.shouldDeploy && serverDeployDecision.appVersionChanged === true);

    if (shouldForceRefreshContentAddressedAssets) {
      // The server updates before GLM. If a later step fails, the server version will already match on
      // the next connection. Persist the forced-refresh state so retries continue bypassing the same-SHA
      // cache until GLM succeeds and updates the marker.
      await markRemoteAssetComponentRefreshPending(backend, {
        componentId: "glm",
        platformArch,
        appVersion: ZCODE_VERSION,
      });
    }

    // Check if deploy is needed
    if (!serverDeployDecision.shouldDeploy) {
      log("skipped — remote version matches");
      // A matching main-server version proves only that node/zcode-server.cjs can start; it does not
      // prove bundled tools still exist. GLM content follows the app/server version, but check and repair
      // the wrapper/bundle itself if it was removed or changed in development.
      if (shouldDeployResourcePackage("node-pty")) {
        await deployNodePtyPrebuilds(
          backend,
          env,
          {
            ...assetDeployOptions,
            platformArch,
            onlyIfMissing: true,
            installer,
          },
          { log, logWarn },
        );
      }
      await deployZCodeAgentRuntime(
        backend,
        env,
        {
          ...assetDeployOptions,
          platformArch,
          installer,
          force: shouldForceRefreshContentAddressedAssets,
          selectedResourcePackageIds,
        },
        { log, logWarn },
      );
      await deployRuntimeTools(
        backend,
        env,
        {
          ...assetDeployOptions,
          platformArch,
          installer,
          selectedResourcePackageIds,
        },
        { log, logWarn },
      );
      return false;
    }

    await deployNodeRuntime(
      backend,
      {
        ...assetDeployOptions,
        platformArch,
        force: Boolean(options?.force),
        installer,
        expectedVersion: await getExpectedComponentVersion("node-runtime"),
      },
      { log, logWarn },
    );

    logDeployRequired({
      loggers: { logWarn },
      installer,
      componentId: SERVER_BUNDLE_COMPONENT_ID,
      reason: serverDeployDecision.reason,
    });
    await installer.installFile({
      componentId: SERVER_BUNDLE_COMPONENT_ID,
      sourceRelativePath: "server/zcode-server.cjs",
      remotePath: `${REMOTE_BASE}/zcode-server.cjs`,
      // An app-version change is a new release boundary. Do not use a historical `.ready` marker alone
      // to decide server-bundle is reusable; as with GLM, redownload and validate the current manifest
      // artifact.
      forceRefresh: shouldForceRefreshContentAddressedAssets,
    });
    if (expectedServerBundleSha256) {
      // A matching app/version does not prove the server-bundle artifact is unchanged. Write the
      // manifest SHA marker only after installation succeeds, so a failed retry cannot mistake an old
      // server for the current artifact.
      await writeRemoteAssetComponentMeta(backend, {
        id: SERVER_BUNDLE_COMPONENT_ID,
        sha256: expectedServerBundleSha256,
        platformArch,
      });
    }
    log("server install done");

    if (shouldDeployResourcePackage("node-pty")) {
      await deployNodePtyPrebuilds(
        backend,
        env,
        {
          ...assetDeployOptions,
          platformArch,
          force: Boolean(options?.force),
          onlyIfMissing: false,
          installer,
          expectedVersion: await getExpectedComponentVersion("node-pty"),
        },
        { log, logWarn },
      );
    }

    log("all uploads complete");

    // Deploy the ZCode Agent runtime remotely; legacy resource-package selections were already ignored
    // at the entry point.
    await deployZCodeAgentRuntime(
      backend,
      env,
      {
        ...assetDeployOptions,
        platformArch,
        installer,
        // Older app versions overwrite agents/glm without updating the GLM SHA marker introduced later.
        // After an app-version change, the marker may not match the actual bundle. Bypass the marker and
        // remote cache, then download and deploy from the current app's manifest. Within the same app
        // version, continue checking the SHA exactly.
        force: shouldForceRefreshContentAddressedAssets,
        selectedResourcePackageIds,
      },
      { log, logWarn },
    );
    await deployRuntimeTools(
      backend,
      env,
      {
        ...assetDeployOptions,
        platformArch,
        installer,
        selectedResourcePackageIds,
      },
      { log, logWarn },
    );

    return true;
  };

  const deployUsingCurrentRemoteState = async (): Promise<boolean> => {
    const expectedServerBundleSha256 = await getComponentSha256(SERVER_BUNDLE_COMPONENT_ID);
    const decision = options?.force
      ? {
          shouldDeploy: true,
          reason: "force deploy requested",
        }
      : await checkServerDeployDecision(backend, {
          platformArch,
          expectedSha256: expectedServerBundleSha256,
        });
    return deployWithDecision(decision, expectedServerBundleSha256);
  };

  if (options?.deployLockMode === "caller-serialized") {
    // Desktop SSH uses window-level shared Host readiness to ensure only one deployment transaction
    // per target. Creating a remote lock-holder here would hold an SSH channel without adding mutual
    // exclusion. Callers may explicitly use this mode only when they already provide single-flight;
    // WSL/Docker and other callers continue using the remote lock by default.
    return deployUsingCurrentRemoteState();
  }

  const preLockDecision = options?.force
    ? { shouldDeploy: true as const, reason: "force deploy requested" }
    : await checkServerDeployDecision(backend, {
        platformArch,
        expectedSha256: null,
      });
  if (preLockDecision.shouldDeploy) {
    log(`waiting for install-root lock: ${preLockDecision.reason}`);
  }
  const deployLock = await acquireRemoteDeployLock(backend, {
    acquireTimeoutMs: options?.deployLockAcquireTimeoutMs,
  });
  let deployOutcome: { ok: true; value: boolean } | { ok: false; error: unknown };
  try {
    // In-process WSL single-flight cannot cover different Desktop builds or backends. Recheck after
    // acquiring the remote install-root lock so a waiter cannot overwrite the deployment based on a
    // stale decision.
    deployOutcome = {
      ok: true,
      value: await deployUsingCurrentRemoteState(),
    };
  } catch (error) {
    deployOutcome = { ok: false, error };
  }

  let releaseOutcome: { ok: true } | { ok: false; error: unknown };
  try {
    await deployLock.release();
    releaseOutcome = { ok: true };
  } catch (error) {
    releaseOutcome = { ok: false, error };
  }
  if (!deployOutcome.ok && !releaseOutcome.ok) {
    // Throwing a release error directly from finally would mask the deployment failure and leave only a
    // secondary symptom for diagnosis. AggregateError preserves both the deployment and release causes,
    // while the release deadline ensures this returns within a bounded time.
    throw new AggregateError(
      [deployOutcome.error, releaseOutcome.error],
      "remote deployment and deploy-lock release both failed",
    );
  }
  if (!deployOutcome.ok) {
    throw deployOutcome.error;
  }
  if (!releaseOutcome.ok) {
    throw releaseOutcome.error;
  }
  return deployOutcome.value;
}

type ServerDeployDecision =
  | { shouldDeploy: false }
  | {
      shouldDeploy: true;
      reason: string;
      appVersionChanged?: boolean;
    };

async function checkServerDeployDecision(
  backend: IRemoteBackend,
  options: {
    platformArch: string;
    expectedSha256: string | null;
  },
): Promise<ServerDeployDecision> {
  try {
    log("checking if deploy needed...");
    const nodePath = `${REMOTE_BASE}/node`;
    const exists = await backend.exists(nodePath);
    log("remote node exists:", exists);
    if (!exists) {
      return {
        shouldDeploy: true,
        reason: `remote file missing path=${nodePath}`,
      };
    }

    const serverPath = `${REMOTE_BASE}/zcode-server.cjs`;
    const serverExists = await backend.exists(serverPath);
    log("remote server exists:", serverExists);
    if (!serverExists) {
      return {
        shouldDeploy: true,
        reason: `remote file missing path=${serverPath}`,
      };
    }

    // Check version
    log("checking remote version...");
    const stream = await backend.exec(
      `${quotePosixPathArg(nodePath)} ${quotePosixPathArg(serverPath)} --version`,
    );
    const version = (await collectStdout(stream)).trim();
    log("remote version:", JSON.stringify(version), "local:", ZCODE_VERSION);
    if (version !== ZCODE_VERSION) {
      return {
        shouldDeploy: true,
        reason: `remote server version mismatch remote=${version} expected=${ZCODE_VERSION}`,
        appVersionChanged: true,
      };
    }
    const requiredFeatureDecision = await checkServerBundleRequiredMarkers(
      backend,
      nodePath,
      serverPath,
    );
    if (requiredFeatureDecision.shouldDeploy) {
      return requiredFeatureDecision;
    }
    if (options.expectedSha256) {
      const identityDecision = await checkRemoteAssetComponentIdentity(backend, {
        componentId: SERVER_BUNDLE_COMPONENT_ID,
        platformArch: options.platformArch,
        expectedIdentity: { sha256: options.expectedSha256 },
      });
      if (identityDecision.shouldDeploy) {
        return identityDecision;
      }
    }
    return { shouldDeploy: false };
  } catch (err) {
    log("checkServerDeployDecision error (will deploy):", err);
    return {
      shouldDeploy: true,
      reason: `remote deploy check failed: ${String(err)}`,
    };
  }
}

function createRemoteAssetInstaller(
  backend: IRemoteBackend,
  options: RemoteAssetDeployOptions & {
    version: string;
    platformArch: string;
    assetInstallMode?: RemoteAssetInstallMode;
  },
  loggers: DeployLoggers,
  getPinnedRemoteManifest: (() => Promise<RemoteManifestRef>) | null = null,
): RemoteAssetInstaller {
  if (options.assetInstallMode !== "remote-download") {
    return new LocalUploadAssetInstaller(backend, options, loggers);
  }

  let remoteInstallerPromise: Promise<RemoteAssetInstaller> | null = null;
  let remoteManifestPromise: ReturnType<typeof fetchRemoteDownloadManifest> | null = null;
  const getRemoteManifest = (): ReturnType<typeof fetchRemoteDownloadManifest> => {
    if (getPinnedRemoteManifest) {
      return getPinnedRemoteManifest();
    }
    if (!remoteManifestPromise) {
      remoteManifestPromise = fetchRemoteDownloadManifest(options, loggers);
    }
    return remoteManifestPromise;
  };
  const getRemoteInstaller = async (): Promise<RemoteAssetInstaller> => {
    if (!remoteInstallerPromise) {
      remoteInstallerPromise = detectRemoteAssetTools(backend, loggers).then(
        (tools) =>
          new RemoteDownloadAssetInstaller(backend, options, tools, loggers, getRemoteManifest()),
      );
    }
    return remoteInstallerPromise;
  };

  return {
    mode: "remote-download",
    async resolveComponentVersion(componentId) {
      const manifestRef = await getRemoteManifest();
      return (
        selectRemoteAssetManifestComponents(manifestRef.manifest, [componentId])[0]?.version ?? null
      );
    },
    async resolveComponentSha256(componentId) {
      const manifestRef = await getRemoteManifest();
      return (
        selectRemoteAssetManifestComponents(manifestRef.manifest, [componentId])[0]?.sha256 ?? null
      );
    },
    async installFile(params) {
      const remoteInstaller = await getRemoteInstaller();
      await remoteInstaller.installFile(params);
    },
    async installDirectory(params) {
      const remoteInstaller = await getRemoteInstaller();
      await remoteInstaller.installDirectory(params);
    },
  };
}

function buildReleaseDirCacheKey(componentIds: string[] | undefined, forceRefresh = false): string {
  const componentKey =
    componentIds && componentIds.length > 0 ? componentIds.slice().sort().join(",") : "<all>";
  return `${componentKey}:${forceRefresh ? "force" : "reuse"}`;
}

function resolveMockCdnReleaseDir(mockCdnDir?: string): string | null {
  if (!mockCdnDir) {
    return null;
  }

  return join(mockCdnDir, "releases", ZCODE_VERSION);
}

async function resolveReleaseDir(
  options: DeployOptions | undefined,
  env: RemoteEnvironment,
  loggers: {
    log: (...args: unknown[]) => void;
    logWarn: (...args: unknown[]) => void;
  },
  componentIds?: string[],
  manifestRef?: RemoteAssetManifestRef | null,
  forceRefresh = false,
): Promise<string | null> {
  const mockReleaseDir = resolveMockCdnReleaseDir(options?.mockCdnDir);
  const platformArch = `${env.platform}-${env.arch}`;
  if (mockReleaseDir) {
    const missingMockPaths = await findMissingMockReleasePaths(
      mockReleaseDir,
      platformArch,
      componentIds,
    );
    if (missingMockPaths.length === 0) {
      return mockReleaseDir;
    }

    // A WSL/SSH development setup may have the version directory but lack the component for the current
    // remote platform (for example, Windows mock-cdn has linux-arm64 while the target is linux-x64 WSL).
    // Returning the mock directory directly would fail during upload with local remote asset not found.
    // When CDN/cache fallback is available, use the complete cached component; without a fallback,
    // preserve the original error that identifies the missing file.
    loggers.logWarn(
      `[remote-assets] mock-cdn incomplete for ${platformArch}; missing=${missingMockPaths.join(", ")}`,
    );
    if (!hasRemoteAssetCdnFallback(options)) {
      return mockReleaseDir;
    }

    loggers.logWarn(
      `[remote-assets] fallback to CDN/cache for ${platformArch}; components=${componentIds?.join(",") ?? "<all>"}`,
    );
  }

  // Production no longer bundles remote assets, so first download them from the CDN to the local cache.
  // Centralize releaseDir acquisition here instead of scattering placeholder checks across resource branches.
  return ensureRemoteReleaseDirFromCdn(
    {
      remoteCdnBaseUrl: options?.remoteCdnBaseUrl,
      remoteCdnBaseUrls: options?.remoteCdnBaseUrls,
      remoteCacheDir: options?.remoteCacheDir,
      version: ZCODE_VERSION,
      platformArch,
      componentIds,
      manifestRef,
      forceRefresh,
      manifestRequestTimeoutMs: options?.manifestRequestTimeoutMs,
      remoteAssetNetwork: options?.remoteAssetNetwork,
    },
    loggers,
  );
}

function hasRemoteAssetCdnFallback(options: DeployOptions | undefined): boolean {
  const hasRemoteCacheDir = Boolean(options?.remoteCacheDir?.trim());
  const hasBaseUrl = Boolean(options?.remoteCdnBaseUrl?.trim());
  const hasBaseUrls = Boolean(
    options?.remoteCdnBaseUrls?.some((baseUrl) => baseUrl.trim().length > 0),
  );
  return hasRemoteCacheDir && (hasBaseUrl || hasBaseUrls);
}

async function findMissingMockReleasePaths(
  releaseDir: string,
  platformArch: string,
  componentIds: string[] | undefined,
): Promise<string[]> {
  const missingPaths: string[] = [];
  for (const relativePath of resolveRequiredMockReleasePaths(platformArch, componentIds)) {
    if (!(await fileExists(releaseDir, ...relativePath.split("/")))) {
      missingPaths.push(relativePath);
    }
  }
  return missingPaths;
}

function resolveRequiredMockReleasePaths(
  platformArch: string,
  componentIds: string[] | undefined,
): string[] {
  const ids =
    componentIds && componentIds.length > 0
      ? componentIds
      : [SERVER_BUNDLE_COMPONENT_ID, "node-runtime"];
  const requiredPaths = new Set<string>();

  for (const componentId of ids) {
    switch (componentId) {
      case SERVER_BUNDLE_COMPONENT_ID:
        requiredPaths.add("server/zcode-server.cjs");
        break;
      case "node-runtime":
        requiredPaths.add(`node/${platformArch}/node`);
        break;
      case "node-pty":
        requiredPaths.add(`node-pty/${platformArch}/pty.node`);
        if (platformArch.startsWith("darwin-")) {
          requiredPaths.add(`node-pty/${platformArch}/spawn-helper`);
        }
        break;
      case "glm":
        requiredPaths.add(`glm/${platformArch}/zcode.cjs`);
        for (const relativePath of REMOTE_AGENT_OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS) {
          requiredPaths.add(`glm/${platformArch}/packages/${relativePath}`);
        }
        break;
      case "bfs":
        requiredPaths.add(`tools/${platformArch}/bfs/bfs`);
        break;
      case "ripgrep":
        requiredPaths.add(`tools/${platformArch}/ripgrep/rg`);
        break;
      case "ugrep":
        requiredPaths.add(`tools/${platformArch}/ugrep/ugrep`);
        break;
    }
  }

  return [...requiredPaths];
}

function collectStdout(stream: import("./backend.js").StdioStream): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    stream.stdout.on("data", (chunk: Buffer) => {
      data += chunk.toString();
    });
    stream.onClose(() => resolve(data));
  });
}
