import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SERVER_RUNTIME_NODE_VERSION } from "../contracts.js";
import {
  currentServerTarget,
  supportedServerTargets,
  type ServerTarget,
} from "../runtime/manifest.js";
import { stageRelease } from "./stage.js";
import { resolveNodeDistBase } from "./nodeDistMirror.js";

const log = (...args: unknown[]): void => console.log("[stage]", ...args);

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function findRepoRoot(startDir: string): Promise<string> {
  let current = resolve(startDir);
  while (true) {
    if (await pathExists(join(current, "pnpm-workspace.yaml"))) return current;
    const parent = dirname(current);
    if (parent === current)
      throw new Error("Unable to locate workspace root (pnpm-workspace.yaml)");
    current = parent;
  }
}

async function runCommand(command: string, args: readonly string[], cwd: string): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(command, [...args], { cwd, stdio: ["ignore", "inherit", "inherit"] });
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else
        rejectPromise(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "null"}`));
    });
  });
}

async function downloadFile(url: string, destinationPath: string): Promise<void> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: HTTP ${response.status} (${url})`);
  }
  // DOM fetch's ReadableStream and the identically named type from node:stream/web are incompatible under @types/node,
  // so bridge them explicitly here; at runtime the object is already a Node web stream.
  const body = response.body as unknown as NodeWebReadableStream<Uint8Array>;
  await pipeline(Readable.fromWeb(body), createWriteStream(destinationPath, { flags: "w" }));
}

/**
 * Prepare the Node binary for the target platform (pinned to v22.16.0). Lookup order:
 * 1. mock-cdn cache from the existing remote-asset pipeline (avoid duplicate downloads);
 * 2. this package's own cache;
 * 3. download tar.xz from the Node dist mirror (see resolveNodeDistBase), extract bin/node, and write it to this package's cache.
 */
async function ensureNodeBinary(repoRoot: string, target: ServerTarget): Promise<string> {
  const mockCdnReleasesDir = join(repoRoot, "packages/desktop/mock-cdn/releases");
  if (await pathExists(mockCdnReleasesDir)) {
    for (const entry of (await readdir(mockCdnReleasesDir)).sort().reverse()) {
      for (const binaryName of target.startsWith("win32-") ? ["node.exe", "node"] : ["node"]) {
        const candidate = join(mockCdnReleasesDir, entry, "node", target, binaryName);
        if (await pathExists(candidate)) {
          log(`reuse mock-cdn node runtime: ${candidate}`);
          return candidate;
        }
      }
    }
  }

  const nodeVersion = `v${SERVER_RUNTIME_NODE_VERSION}`;
  const isWindows = target.startsWith("win32-");
  const nodeTarget = isWindows ? target.replace(/^win32-/u, "win-") : target;
  const cacheDir = join(
    repoRoot,
    "node_modules/.cache/zcode-server-cli",
    `node-${nodeVersion}-${target}`,
  );
  const cachedBinaryPath = join(cacheDir, isWindows ? "node.exe" : "node");
  if (await pathExists(cachedBinaryPath)) {
    log(`reuse cached node runtime: ${cachedBinaryPath}`);
    return cachedBinaryPath;
  }

  const archiveName = `node-${nodeVersion}-${nodeTarget}.${isWindows ? "zip" : "tar.xz"}`;
  const url = `${resolveNodeDistBase()}/${nodeVersion}/${archiveName}`;
  log(`download node runtime: ${url}`);
  const tempDir = await mkdtemp(join(tmpdir(), "zcode-server-node-"));
  try {
    const archivePath = join(tempDir, archiveName);
    await downloadFile(url, archivePath);
    await mkdir(cacheDir, { recursive: true });
    if (isWindows) {
      await runCommand(
        "tar",
        [
          "-xf",
          archivePath,
          "--strip-components=1",
          "-C",
          cacheDir,
          `node-${nodeVersion}-${nodeTarget}/node.exe`,
        ],
        repoRoot,
      );
    } else {
      await runCommand(
        "tar",
        [
          "-xJf",
          archivePath,
          "--strip-components=2",
          "-C",
          cacheDir,
          `node-${nodeVersion}-${nodeTarget}/bin/node`,
        ],
        repoRoot,
      );
    }
    await chmod(cachedBinaryPath, 0o755);
    return cachedBinaryPath;
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
}

async function ensureAgentBundle(repoRoot: string, skipBuild: boolean): Promise<string> {
  const bundlePath = join(repoRoot, "apps/zcode-cli/packages/cli/dist/zcode.cjs");
  if (skipBuild) {
    if (await pathExists(bundlePath)) return bundlePath;
    throw new Error(`Agent bundle missing: ${bundlePath} (remove --skip-agent-build to build it)`);
  }
  // Bug cause: the first target only rebuilt when the bundle was missing, so bootstrap copied the previous dist into
  // every platform archive. Later targets may reuse the bundle only after this run's first target has really built it.
  log("building current agent bundle via scripts/build-desktop-agent-cli.mjs");
  await runCommand(
    process.execPath,
    [join(repoRoot, "scripts/build-desktop-agent-cli.mjs")],
    repoRoot,
  );
  if (!(await pathExists(bundlePath))) {
    throw new Error(`Agent bundle still missing after build: ${bundlePath}`);
  }
  return bundlePath;
}

async function resolveNativeToolsDir(repoRoot: string, target: ServerTarget): Promise<string> {
  // Fix: previously mock-cdn/releases/*/tools and bundled-tools were reused on "file exists". Remote
  // macOS assets are pinned to rg13 but would be reused as rg14 for a standalone Server release
  // package; those directories could also miss tool license notices. Preparation is now delegated to
  // prepare-native-search-tools.mjs, which stages assets into server-cli's own cache per the target
  // release plan: download when the intranet dependency source is configured, otherwise unpack the
  // repository archive; cache hits must still pass version, digest, and architecture checks, and
  // refresh the notices in the same directory.
  const [platform, arch] = target.split("-");
  const cacheDir = join(repoRoot, "node_modules/.cache/zcode-server-cli", "tools", target);
  log(`prepare native search target assets: ${target}`);
  await runCommand(
    process.execPath,
    [
      join(repoRoot, "scripts/prepare-native-search-tools.mjs"),
      `--platform=${platform}`,
      `--arch=${arch}`,
      `--output-dir=${cacheDir}`,
    ],
    repoRoot,
  );
  if (!(await pathExists(cacheDir)))
    throw new Error(`Native search tools preparation produced no directory for ${target}`);
  return cacheDir;
}

async function resolveWorkspacePackageDirs(repoRoot: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const root of [join(repoRoot, "apps/zcode-cli/packages"), join(repoRoot, "packages")]) {
    if (!(await pathExists(root))) continue;
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const packageJsonPath = join(root, entry.name, "package.json");
      if (!(await pathExists(packageJsonPath))) continue;
      try {
        const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
          name?: string;
        };
        if (packageJson.name) map.set(packageJson.name, join(root, entry.name));
      } catch {
        // A non-package directory does not affect staging for other workspace packages.
      }
    }
  }
  return map;
}

function parseTarget(argv: readonly string[]): ServerTarget {
  const index = argv.indexOf("--target");
  if (index < 0) return currentServerTarget();
  const value = argv[index + 1];
  if (!value || !supportedServerTargets.includes(value as ServerTarget)) {
    throw new Error(
      `Invalid --target: ${value ?? "<missing>"} (supported: ${supportedServerTargets.join(", ")})`,
    );
  }
  return value as ServerTarget;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const repoRoot = await findRepoRoot(packageRoot);
  const target = parseTarget(argv);
  // The build only reads and includes existing notices; the explicit licenses command performs
  // validation, and the runtime server does not depend on repository scripts.
  const { readThirdPartyNotices, readNodeNotices } = (await import(
    pathToFileURL(join(repoRoot, "scripts/third-party-notices.mjs")).href
  )) as {
    readThirdPartyNotices: (root: string) => Promise<Buffer>;
    readNodeNotices: (version: string, root: string) => Promise<{ source: unknown; bytes: Buffer }>;
  };
  const [thirdParty, nodeNotice] = await Promise.all([
    readThirdPartyNotices(repoRoot),
    readNodeNotices(SERVER_RUNTIME_NODE_VERSION, repoRoot),
  ]);

  const distDir = join(packageRoot, "dist");
  if (!(await pathExists(join(distDir, "server-cli.js")))) {
    throw new Error(
      `Missing tsup output in ${distDir}; run pnpm --filter @zcode/server-cli build first`,
    );
  }

  const appVersion = (
    JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as { version: string }
  ).version;
  const [agentBundlePath, nodeBinaryPath] = await Promise.all([
    ensureAgentBundle(repoRoot, argv.includes("--skip-agent-build")),
    ensureNodeBinary(repoRoot, target),
  ]);
  const [nativeToolsDir, officialPluginsDir, workspacePackageDirs] = await Promise.all([
    resolveNativeToolsDir(repoRoot, target),
    Promise.resolve(join(repoRoot, "apps/zcode-cli/packages")),
    resolveWorkspacePackageDirs(repoRoot),
  ]);

  const staged = await stageRelease({
    target,
    appVersion,
    distDir,
    agentBundlePath,
    nodeBinaryPath,
    notices: {
      thirdParty: thirdParty.toString("utf8"),
      node: nodeNotice.bytes.toString("utf8"),
      nodeSource: JSON.stringify(nodeNotice.source, null, 2) + "\n",
    },
    workspaceNodeModulesDir: join(repoRoot, "node_modules"),
    workspacePackageDirs,
    nativeToolsDir,
    officialPluginsDir,
    outputDir: join(packageRoot, "dist-release"),
    archive: !argv.includes("--no-archive"),
    componentArchives: !argv.includes("--skip-component-archives"),
  });

  log(`release dir: ${staged.releaseDir}`);
  if (staged.archivePath) log(`archive: ${staged.archivePath}`);
  log(`packaged dependencies: ${staged.packagedDependencies.join(", ")}`);
}

await main();
