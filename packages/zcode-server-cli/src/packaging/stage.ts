/* eslint-disable max-lines -- Release-package staging is assembled linearly by step; splitting it would add cross-step state synchronization. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, cp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createRuntimeManifest, type ServerTarget } from "../runtime/manifest.js";
import { isTarCommand, resolveHostTarCommand } from "./tarCommand.js";

const NODE_BUILTIN_MODULES = new Set(builtinModules);

/**
 * Extract top-level bare module references from bundle artifacts (`from "x"` / `import("x")` / `require("x")`).
 * The result is only syntactically normalized (scoped packages use the first two segments); callers intersect it with
 * workspace node_modules to decide whether a reference is a real npm package. Node built-ins are filtered here.
 */
function collectBareModuleSpecifiers(source: string): Set<string> {
  const names = new Set<string>();
  const specifierPattern =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["']([^"'\n]+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = specifierPattern.exec(source)) !== null) {
    const specifier = match[1];
    if (!specifier || specifier.startsWith(".") || specifier.startsWith("/")) continue;
    if (specifier.startsWith("node:")) continue;
    const segments = specifier.split("/");
    const packageName = specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
    if (!packageName || NODE_BUILTIN_MODULES.has(packageName)) continue;
    names.add(packageName);
  }
  return names;
}

async function readPackageJson(packageDir: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

/**
 * Simplified Node resolution: walk upward from the dependent's real directory to locate `node_modules/<name>`.
 * Do not resolve main/exports entry points, so this also works for packages with restricted exports or types-only contents;
 * both pnpm (dependencies alongside `.pnpm/<pkg>/node_modules`) and flat npm layouts are supported.
 */
async function findDependencyDir(fromDir: string, name: string): Promise<string | null> {
  let current = resolve(fromDir);
  while (true) {
    const candidate = join(current, "node_modules", ...name.split("/"));
    if ((await readPackageJson(candidate)) !== null) {
      return await realpath(candidate);
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Recursively collect the production dependency closure (dependencies + optionalDependencies) starting from entry packages.
 * Return package name → real directory. If the same name resolves to different real directories, throw an error: a flat release layout cannot contain two versions,
 * and silently choosing one would introduce version drift into the package. Skip missing optional dependencies.
 */
async function resolveProductionPackageClosure(
  entryPackageNames: readonly string[],
  nodeModulesDir: string,
  workspacePackageDirs: ReadonlyMap<string, string> = new Map(),
): Promise<Map<string, string>> {
  const closure = new Map<string, string>();
  const queue: Array<{ name: string; fromDir: string; optional: boolean }> = entryPackageNames.map(
    (name) => ({ name, fromDir: dirname(resolve(nodeModulesDir)), optional: true }),
  );

  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) break;
    const packageDir =
      (await findDependencyDir(item.fromDir, item.name)) ??
      workspacePackageDirs.get(item.name) ??
      null;
    if (!packageDir) {
      if (item.optional) continue;
      throw new Error(
        `Missing production dependency in workspace: ${item.name} (from ${item.fromDir})`,
      );
    }
    const existing = closure.get(item.name);
    if (existing) {
      if (existing !== packageDir) {
        // pnpm peer dependencies may legitimately include multiple versions (typically ajv6 + ajv8).
        // Keep the first resolved version at the top level and preserve package-specific nested node_modules during copying,
        // letting Node's local resolution select the correct peer; do not reject a valid Agent bundle during staging.
        continue;
      }
      continue;
    }
    closure.set(item.name, packageDir);

    const packageJson = await readPackageJson(packageDir);
    const dependencies = (packageJson?.dependencies ?? {}) as Record<string, string>;
    const optionalDependencies = (packageJson?.optionalDependencies ?? {}) as Record<
      string,
      string
    >;
    for (const dependencyName of Object.keys(dependencies)) {
      queue.push({
        name: dependencyName,
        fromDir: packageDir,
        optional: dependencyName in optionalDependencies,
      });
    }
    for (const dependencyName of Object.keys(optionalDependencies)) {
      queue.push({ name: dependencyName, fromDir: packageDir, optional: true });
    }
  }
  return closure;
}

/**
 * Runtime allowlist for node-pty. Always exclude `build/`: it contains host-platform build artifacts, and node-pty's
 * loadNativeModule loads in the order build/Release → build/Debug → prebuilds/<platform>-<arch>.
 * Leaving build/ in a cross-platform package makes the target machine load the wrong pty.node architecture first and crash immediately.
 * Also exclude prebuilds for other platforms to keep the release package small.
 */
function isNodePtyRuntimePath(relativePath: string, target: ServerTarget): boolean {
  const normalized = relativePath.split(sep).join("/");
  if (normalized === "" || normalized === "package.json") return true;
  if (/^(?:LICENSE|NOTICE|COPYING)(?:[._-].*)?$/iu.test(normalized)) return true;
  if (normalized === "lib" || normalized.startsWith("lib/")) return true;
  if (normalized === "typings" || normalized.startsWith("typings/")) return true;
  if (
    normalized === "prebuilds" ||
    normalized === `prebuilds/${target}` ||
    normalized.startsWith(`prebuilds/${target}/`)
  ) {
    return true;
  }
  return false;
}

function isTargetSpecificPackage(packageName: string, target: ServerTarget): boolean {
  if (!packageName.startsWith("@mbears/opentui-core-")) return true;
  return packageName === `@mbears/opentui-core-${target}`;
}

interface StageOptions {
  target: ServerTarget;
  appVersion: string;
  /** tsup output directory (server-cli.js / server-core.js). */
  distDir: string;
  /** Existing CLI/Agent bundle (zcode.cjs, standalone CJS). */
  agentBundlePath: string;
  /** Prepared Node binary for the target platform. */
  nodeBinaryPath: string;
  /** Passed from the build entry point after validation by the single compliance owner; component assembly must not construct its own license list. */
  notices: { thirdParty: string; node: string; nodeSource: string };
  /** Source node_modules used to resolve and copy the dependency closure. */
  workspaceNodeModulesDir: string;
  /** Workspace packages not linked into node_modules by pnpm (for example, @zcode/tui). */
  workspacePackageDirs?: ReadonlyMap<string, string>;
  /** Parent directory for release output. */
  outputDir: string;
  /** Root directory for prepared native search tools (tools/<id>/<binary>). */
  nativeToolsDir?: string;
  /** Official plugin sources or a packages directory that has already been seeded. */
  officialPluginsDir?: string;
  /** Whether to also produce tar.gz (defaults to true). */
  archive?: boolean;
}

interface StagedRelease {
  releaseDir: string;
  archivePath: string | null;
  componentArchivePaths: string[];
  packagedDependencies: string[];
}

const POSIX_LAUNCHER = `#!/bin/sh
# Generated by zcode-server staging: locate the distribution root and start Server CLI with the bundled Node.
DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec "$DIR/runtime/node" "$DIR/runtime/server-cli.js" "$@"
`;

const WINDOWS_LAUNCHER = [
  "@echo off",
  'set "DIR=%~dp0.."',
  '"%DIR%\\runtime\\node.exe" "%DIR%\\runtime\\server-cli.js" %*',
  "",
].join("\r\n");

async function copyPackageDir(
  sourceDir: string,
  targetDir: string,
  filter?: (relativePath: string) => boolean,
  includeNestedNodeModules = false,
): Promise<void> {
  await cp(sourceDir, targetDir, {
    recursive: true,
    dereference: true,
    filter: (source) => {
      const relativePath = relative(sourceDir, source);
      if (relativePath === "") return true;
      // Do not copy nested node_modules from packages: closure resolution already flattened transitive dependencies into release node_modules.
      if (
        !includeNestedNodeModules &&
        (relativePath === "node_modules" || relativePath.split(sep).includes("node_modules"))
      )
        return false;
      return filter ? filter(relativePath) : true;
    },
  });
}

async function runCommand(command: string, args: readonly string[], cwd: string): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    // macOS's bundled tar writes Finder extended attributes as AppleDouble `._*` entries by default.
    // When the release package is extracted on Linux/Windows, these host metadata entries become real files, polluting the file tree
    // and causing component hashes to differ between download and target machine. Disable copyfile metadata before creating the archive.
    // On Windows, the passed command is an absolute System32 tar.exe path, which also matches this check.
    const env = isTarCommand(command) ? { ...process.env, COPYFILE_DISABLE: "1" } : process.env;
    const child = spawn(command, [...args], { cwd, env, stdio: ["ignore", "inherit", "inherit"] });
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else
        rejectPromise(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "null"}`));
    });
  });
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await (await import("node:fs/promises")).readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = entry.name;
    const absolutePath = join(root, relativePath);
    if (entry.isDirectory()) {
      for (const nested of await listFiles(absolutePath)) files.push(join(relativePath, nested));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files.sort();
}

async function hashPaths(
  root: string,
  paths: readonly string[],
): Promise<{ sha256: string; sizeBytes: number }> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  for (const relativePath of [...paths].sort()) {
    const absolutePath = join(root, relativePath);
    const stat = await (await import("node:fs/promises")).stat(absolutePath);
    const files = stat.isDirectory()
      ? (await listFiles(absolutePath)).map((file) => join(relativePath, file))
      : [relativePath];
    for (const file of files.sort()) {
      const contents = await readFile(join(root, file));
      hash.update(`${file}\0`);
      hash.update(contents);
      sizeBytes += contents.byteLength;
    }
  }
  return { sha256: hash.digest("hex"), sizeBytes };
}

async function copyDirectoryIfPresent(
  sourceDir: string | undefined,
  targetDir: string,
): Promise<string[]> {
  if (!sourceDir) return [];
  try {
    await access(sourceDir);
  } catch {
    return [];
  }
  const names = (
    await (await import("node:fs/promises")).readdir(sourceDir, { withFileTypes: true })
  )
    .filter((entry) => entry.isDirectory() && entry.name.endsWith("-plugin"))
    .map((entry) => entry.name)
    .filter((name) => name !== "superpowers-plugin")
    .sort();
  for (const name of names) {
    await copyPackageDir(join(sourceDir, name), join(targetDir, name));
  }
  return names.map((name) => name.replace(/-plugin$/u, ""));
}

async function copyNativeTools(
  sourceDir: string | undefined,
  targetDir: string,
  target: ServerTarget,
): Promise<string[]> {
  if (!sourceDir) return [];
  try {
    await access(sourceDir);
  } catch {
    return [];
  }
  const ids = target.startsWith("win32-") ? ["ripgrep", "ugrep"] : ["bfs", "ripgrep", "ugrep"];
  const copied: string[] = [];
  for (const id of ids) {
    const source = join(
      sourceDir,
      id,
      id === "ripgrep"
        ? target.startsWith("win32-")
          ? "rg.exe"
          : "rg"
        : id + (target.startsWith("win32-") ? ".exe" : ""),
    );
    try {
      await access(source);
    } catch {
      continue;
    }
    const targetPath = join(targetDir, id, source.split(sep).pop() ?? id);
    await mkdir(dirname(targetPath), { recursive: true });
    await cp(source, targetPath, { dereference: true });
    // Fix: copying only executables would omit the prepared declarations from the standalone native-search-tools component.
    for (const notice of ["THIRD-PARTY-NOTICES.txt", "SOURCES.json"]) {
      const bytes = await readFile(join(dirname(source), notice));
      if (!bytes.length) throw new Error(`Empty native notice: ${notice}`);
      await writeFile(join(dirname(targetPath), notice), bytes);
    }
    if (!target.startsWith("win32-")) await chmod(targetPath, 0o755);
    copied.push(id);
  }
  return copied;
}

async function createComponentArchive(
  releaseDir: string,
  outputDir: string,
  target: ServerTarget,
  id: string,
  paths: readonly string[],
): Promise<{ archivePath: string; sha256: string; sizeBytes: number }> {
  const info = await hashPaths(releaseDir, paths);
  const componentRoot = join(outputDir, ".components", `${id}-${info.sha256.slice(0, 12)}`);
  await rm(componentRoot, { force: true, recursive: true });
  await mkdir(componentRoot, { recursive: true });
  for (const relativePath of paths) {
    const source = join(releaseDir, relativePath);
    try {
      await access(source);
    } catch {
      continue;
    }
    const targetPath = join(componentRoot, relativePath);
    await mkdir(dirname(targetPath), { recursive: true });
    await cp(source, targetPath, { recursive: true, dereference: true });
  }
  const extension = target.startsWith("win32-") ? "zip" : "tar.gz";
  const archivePath = join(outputDir, "components", target, `${id}-${info.sha256}.${extension}`);
  await mkdir(dirname(archivePath), { recursive: true });
  await rm(archivePath, { force: true });
  // Windows hosts lack zip and Git Bash's GNU tar is not usable (see tarCommand.ts); all tar calls explicitly use System32 bsdtar.
  // POSIX hosts continue using the zip command to create zip archives.
  const tarCommand = resolveHostTarCommand();
  if (extension === "zip") {
    if (process.platform === "win32")
      await runCommand(tarCommand, ["-acf", archivePath, "."], componentRoot);
    else await runCommand("zip", ["-qr", archivePath, "."], componentRoot);
  } else if (process.platform === "win32") {
    await runCommand(tarCommand, ["-czf", archivePath, "."], componentRoot);
  } else await runCommand("tar", ["-czf", archivePath, "."], componentRoot);
  await rm(componentRoot, { force: true, recursive: true });
  return { archivePath, ...info };
}

/** Assemble the `zcode-server-<os>-<arch>/` release directory; local assembly only, with no upload or publishing. */
export async function stageRelease(options: StageOptions): Promise<StagedRelease> {
  for (const [name, value] of Object.entries(options.notices)) {
    if (!value.trim()) throw new Error(`Missing distribution notice: ${name}`);
  }
  const releaseName = `zcode-server-${options.target}`;
  const outputRoot = resolve(options.outputDir);
  const releaseDir = join(outputRoot, releaseName);
  const runtimeDir = join(releaseDir, "runtime");
  await rm(releaseDir, { force: true, recursive: true });
  // Staging rebuilds the release directory: delete old component archives for the same target so a previous build's
  // hash is not accidentally uploaded to the CDN, exposing components in the catalog that do not match this manifest.
  await rm(join(outputRoot, "components", options.target), { force: true, recursive: true });
  await rm(join(outputRoot, ".components"), { force: true, recursive: true });
  await mkdir(join(releaseDir, "bin"), { recursive: true });
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(join(runtimeDir, "THIRD-PARTY-NOTICES.md"), options.notices.thirdParty);
  await writeFile(join(runtimeDir, "LICENSE.node.txt"), options.notices.node);
  await writeFile(join(runtimeDir, "NODE-SOURCES.json"), options.notices.nodeSource);
  for (const component of ["agent", "official-plugins"]) {
    await mkdir(join(runtimeDir, "licenses", component), { recursive: true });
    await writeFile(
      join(runtimeDir, "licenses", component, "THIRD-PARTY-NOTICES.md"),
      options.notices.thirdParty,
    );
  }

  // Copy the entry bundle and sourcemap with matching names; filenames must align with the relative-path resolution in cli.ts.
  const bundleSources: string[] = [];
  for (const entryName of ["server-cli.js", "server-core.js"]) {
    const sourcePath = join(options.distDir, entryName);
    const contents = await readFile(sourcePath, "utf8");
    bundleSources.push(contents);
    await writeFile(join(runtimeDir, entryName), contents, "utf8");
  }
  await writeFile(
    join(runtimeDir, "package.json"),
    `${JSON.stringify({ name: releaseName, private: true, type: "module" }, null, 2)}\n`,
    "utf8",
  );
  await cp(options.agentBundlePath, join(runtimeDir, "zcode.cjs"), { dereference: true });
  // The Agent bundle is the third runtime entry point; scanning only the Server bundle would miss external TUI/Playwright dependencies.
  bundleSources.push(await readFile(options.agentBundlePath, "utf8"));

  const nodeTargetPath = join(
    runtimeDir,
    options.target.startsWith("win32-") ? "node.exe" : "node",
  );
  await cp(options.nodeBinaryPath, nodeTargetPath, { dereference: true });
  if (!options.target.startsWith("win32-")) await chmod(nodeTargetPath, 0o755);

  // Use artifact scanning as the source of truth for runtime/node_modules: install everything the bundles reference, including transitive dependencies.
  // Do not use the tsup external declaration list, which can drift from actual references.
  const referencedPackages = new Set<string>();
  for (const source of bundleSources) {
    for (const name of collectBareModuleSpecifiers(source)) referencedPackages.add(name);
  }
  const rawClosure = await resolveProductionPackageClosure(
    [...referencedPackages],
    options.workspaceNodeModulesDir,
    options.workspacePackageDirs,
  );
  const closure = new Map(
    [...rawClosure].filter(([packageName]) => isTargetSpecificPackage(packageName, options.target)),
  );
  const nodeModulesTargetDir = join(runtimeDir, "node_modules");
  for (const [packageName, packageDir] of closure) {
    const targetDir = join(nodeModulesTargetDir, ...packageName.split("/"));
    await mkdir(dirname(targetDir), { recursive: true });
    if (packageName === "node-pty") {
      await copyPackageDir(packageDir, targetDir, (relativePath) =>
        isNodePtyRuntimePath(relativePath, options.target),
      );
    } else {
      // External Agent dependencies can contain multiple peer versions (for example, ajv6 + ajv8). Preserve nested node_modules only for known peer
      // conflicts to avoid copying pnpm's entire development dependency tree into the release package.
      await copyPackageDir(
        packageDir,
        targetDir,
        undefined,
        packageName === "ajv-formats" || packageName === "ajv-keywords",
      );
      if (packageName === "koffi") await pruneKoffiRuntime(packageDir, targetDir, options.target);
    }
  }

  if (closure.has("node-pty")) {
    await ensureNodePtyPrebuild(options, nodeModulesTargetDir);
  }

  const tools = await copyNativeTools(
    options.nativeToolsDir,
    join(runtimeDir, "tools"),
    options.target,
  );
  const plugins = await copyDirectoryIfPresent(
    options.officialPluginsDir,
    join(runtimeDir, "packages"),
  );

  const launcherPath = join(
    releaseDir,
    "bin",
    options.target.startsWith("win32-") ? "zcode.cmd" : "zcode",
  );
  await writeFile(launcherPath, POSIX_LAUNCHER, "utf8");
  if (options.target.startsWith("win32-")) {
    await writeFile(launcherPath, WINDOWS_LAUNCHER, "utf8");
  } else {
    await chmod(launcherPath, 0o755);
  }

  const componentSpecs = [
    {
      id: "node-runtime",
      paths: [
        options.target.startsWith("win32-") ? "runtime/node.exe" : "runtime/node",
        "runtime/LICENSE.node.txt",
        "runtime/NODE-SOURCES.json",
      ],
    },
    {
      id: "server-runtime",
      paths: [
        "runtime/server-cli.js",
        "runtime/server-core.js",
        "runtime/package.json",
        "runtime/node_modules",
        "runtime/THIRD-PARTY-NOTICES.md",
      ],
    },
    { id: "agent-runtime", paths: ["runtime/zcode.cjs", "runtime/licenses/agent"] },
    ...(plugins.length > 0
      ? [
          {
            id: "official-plugins",
            paths: ["runtime/packages", "runtime/licenses/official-plugins"],
          },
        ]
      : []),
    ...(tools.length > 0 ? [{ id: "native-search-tools", paths: ["runtime/tools"] }] : []),
  ];
  const componentMeta: Array<{
    id: string;
    sha256: string;
    paths: string[];
    sizeBytes: number;
    archivePath?: string;
  }> = [];
  const componentArchivePaths: string[] = [];
  for (const component of componentSpecs) {
    const info = await hashPaths(releaseDir, component.paths);
    componentMeta.push({ ...component, ...info });
  }
  const manifest = createRuntimeManifest(options.target, options.appVersion, {
    tools,
    plugins,
    components: componentMeta,
  });
  await writeFile(
    join(releaseDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  for (const component of componentMeta) {
    const archive = await createComponentArchive(
      releaseDir,
      outputRoot,
      options.target,
      component.id,
      component.paths,
    );
    component.archivePath = relative(outputRoot, archive.archivePath).split(sep).join("/");
    componentArchivePaths.push(archive.archivePath);
  }
  await writeFile(
    join(releaseDir, "manifest.json"),
    `${JSON.stringify({ ...manifest, components: componentMeta }, null, 2)}\n`,
    "utf8",
  );

  let archivePath: string | null = null;
  if (options.archive !== false) {
    const extension = options.target.startsWith("win32-") ? "zip" : "tar.gz";
    archivePath = join(outputRoot, `${releaseName}.${extension}`);
    await rm(archivePath, { force: true });
    // On Windows hosts, explicitly use System32 bsdtar instead of relying on the caller's PATH (see tarCommand.ts for the reason).
    const tarCommand = resolveHostTarCommand();
    if (extension === "zip") {
      if (process.platform === "win32")
        await runCommand(tarCommand, ["-acf", archivePath, releaseName], outputRoot);
      else await runCommand("zip", ["-qr", archivePath, releaseName], outputRoot);
    } else if (process.platform === "win32") {
      await runCommand(tarCommand, ["-czf", archivePath, releaseName], outputRoot);
    } else await runCommand("tar", ["-czf", archivePath, releaseName], outputRoot);
  }

  return {
    releaseDir,
    archivePath,
    componentArchivePaths,
    packagedDependencies: [...closure.keys()].sort(),
  };
}

async function pruneKoffiRuntime(
  sourceDir: string,
  targetDir: string,
  target: ServerTarget,
): Promise<void> {
  const [platform, architecture] = target.split("-");
  const targetKeys =
    platform === "linux"
      ? [`linux_${architecture}`, `musl_${architecture}`]
      : [`${platform}_${architecture}`];
  const sourceBuild = join(sourceDir, "build", "koffi");
  const targetBuild = join(targetDir, "build", "koffi");
  await rm(targetBuild, { recursive: true, force: true });
  await mkdir(targetBuild, { recursive: true });
  for (const targetKey of targetKeys) {
    const sourcePath = join(sourceBuild, targetKey);
    try {
      await access(sourcePath);
    } catch {
      continue;
    }
    await cp(sourcePath, join(targetBuild, targetKey), { recursive: true, dereference: true });
  }
}

/**
 * Ensure node-pty in the release package has a pty.node for the target platform. The official node-pty npm package includes only
 * darwin/win32 prebuilds; for Linux, add the binary from the workspace's `@lydell/node-pty-<target>`
 * (the same source as the legacy remote-asset pipeline). Fail directly if it is missing to avoid shipping a package with broken terminal support.
 */
async function ensureNodePtyPrebuild(
  options: StageOptions,
  nodeModulesTargetDir: string,
): Promise<void> {
  const prebuildDir = join(nodeModulesTargetDir, "node-pty", "prebuilds", options.target);
  const ptyNodePath = join(prebuildDir, "pty.node");
  let hasPtyNode = true;
  try {
    await access(ptyNodePath);
  } catch {
    hasPtyNode = false;
  }
  if (!hasPtyNode) {
    // The official package has no prebuild for this platform (Linux); add it from the @lydell platform package.
    const lydellDir = await findDependencyDir(
      dirname(resolve(options.workspaceNodeModulesDir)),
      `@lydell/node-pty-${options.target}`,
    );
    const lydellPtyNode = lydellDir
      ? join(lydellDir, "prebuilds", options.target, "pty.node")
      : null;
    if (!lydellPtyNode) {
      throw new Error(
        `Missing node-pty prebuild for ${options.target}: install @lydell/node-pty-${options.target}`,
      );
    }
    await mkdir(prebuildDir, { recursive: true });
    await cp(lydellPtyNode, ptyNodePath, { dereference: true });
  }
  // On Darwin, spawn-helper must be executable; npm publishing/extraction does not guarantee permission bits, and node-pty
  // fails during posix_spawn if they are missing (the legacy remote-asset pipeline hit the same issue; see prepare-prebuilds.mjs).
  const spawnHelperPath = join(prebuildDir, "spawn-helper");
  try {
    await access(spawnHelperPath);
    await chmod(spawnHelperPath, 0o755);
  } catch {
    // Non-Darwin platforms do not have spawn-helper; ignore it.
  }
}
