import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  type BigIntStats,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { writeBundledOfficialMarketplacePartitionSync } from "@zcode/adapters";
import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE, type Logger } from "@zcode/contracts";
import { isZCodeCuaInternalFeatureEnabled, ZCODE_CUA_OFFICIAL_PLUGIN_ID } from "@zcode/shared";
import {
  createOfficialPluginCacheRetryBudget,
  getOfficialPluginCacheRetryAttempts,
  isTransientOfficialPluginCacheFsError,
  type OfficialPluginCacheRetryBudget,
  removeOfficialPluginCacheDirectory,
  renameOfficialPluginCachePath,
} from "./official-plugin-cache-fs.js";
import {
  OFFICIAL_PLUGIN_DEFINITIONS,
  type OfficialPluginDefinition,
} from "./official-plugin-definitions.js";
import { writeOfficialPluginRuntimeManifest } from "./official-plugin-runtime.js";
import {
  isOfficialPluginSeedLockTimeoutError,
  withOfficialPluginSeedLock,
} from "./official-plugin-seed-lock.js";

const OFFICIAL_PLUGIN_MARKETPLACE = ZCODE_OFFICIAL_PLUGIN_MARKETPLACE;
const SEA_PLUGIN_ASSET_PREFIX = "zcode-official-plugins/";
const SEA_PLUGIN_MANIFEST_ASSET_KEY = `${SEA_PLUGIN_ASSET_PREFIX}manifest.json`;
const SEED_MARKER_FILE = ".zcode-plugin-seed.json";
const SEED_LOCK_TOTAL_BUDGET_MS = 15_000;

const includedTopLevelPaths = new Set([
  ".mcp.json",
  ".zcode-plugin",
  "README.md",
  // After official content plugins added agents, the filesystem seed's top-level allowlist was not synced and the directory got silently pruned.
  "agents",
  "commands",
  "dist",
  "docs",
  "hooks",
  "output-styles",
  "package.json",
  // The Browser skill dynamically imports scripts/browser-client.mjs from the official plugin root.
  // If the filesystem seed omits scripts, Dev connects to node_repl successfully but fails the import at first Browser Use.
  "scripts",
  "skills",
  "templates",
]);

interface OfficialPluginSeedFile {
  mode?: number;
  path: string;
  sha256: string;
  sourcePath?: string;
}

interface OfficialPluginSeedPluginSource {
  definition: OfficialPluginDefinition;
  files: OfficialPluginSeedFile[];
  hash: string;
  missingSeedPaths: string[];
  rootPath?: string;
}

interface OfficialPluginSeedSource {
  kind: "filesystem" | "sea";
  plugins: OfficialPluginSeedPluginSource[];
}

interface SeaOfficialPluginManifest {
  hash: string;
  plugins: Array<{
    files: OfficialPluginSeedFile[];
    marketplace: string;
    name: string;
    version: string;
  }>;
  version: 1;
}

type SeaModule = typeof import("node:sea");

function seedBundledOfficialPlugins(input: {
  logger?: Logger;
  storageRoot: string;
}): OfficialPluginDefinition[] {
  const source = resolveSeedSource();
  if (!source) return [];

  // Catalog/cache is an immutable product asset of the bundled plugins; whether the Runtime loads
  // them is decided by discovery's suppression state. Never delete or filter at seed time, or the
  // detail page cannot read components after an uninstall, and there is no way back.
  writeOfficialMarketplace(input.storageRoot, source);
  const retryBudget = createOfficialPluginCacheRetryBudget();
  // After a lock-wait timeout degrades, the loop continues; if each plugin reset its own 15s wait
  // budget, a group of leftover locks would freeze startup for N×15s. All plugins share one
  // deadline: uncontended locks are still acquired instantly (mkdir success does not check the
  // budget), contended ones degrade immediately once the budget is spent, capping total seeding
  // wait at 15s.
  const seedLockDeadlineAt = Date.now() + SEED_LOCK_TOTAL_BUDGET_MS;
  const failedSeeds: OfficialPluginDefinition[] = [];
  for (const plugin of source.plugins) {
    const pluginId = `${plugin.definition.name}@${OFFICIAL_PLUGIN_MARKETPLACE}`;
    const targetRoot = officialPluginCacheRoot(input.storageRoot, plugin.definition);
    // The plugin copy next to the entry can mismatch the new definition (mid-upgrade desktop
    // package, old checkout without built dist). Seed source resolution used to throw directly on
    // missing requiredSeedPaths, and one broken plugin blew up all plugins and session resume into
    // resumeFailed. A broken plugin affects only itself: refuse to write the cache, warn per the
    // existing degradation protocol, and fall back to the last usable cache.
    if (plugin.missingSeedPaths.length > 0) {
      warnCacheDegraded(input.logger, {
        error: Object.assign(
          new Error(
            `Bundled official plugin ${plugin.definition.name} is missing required seed assets: ${plugin.missingSeedPaths.join(", ")}`,
          ),
          { code: "ZCODE_PLUGIN_SEED_INCOMPLETE" },
        ),
        missingSeedPaths: plugin.missingSeedPaths,
        operation: "seed_plugin",
        pluginId,
        targetRoot,
      });
      failedSeeds.push(plugin.definition);
      continue;
    }
    try {
      withOfficialPluginSeedLock(
        targetRoot,
        () => {
          const manifestFile = plugin.files.find(
            (file) => file.path === ".zcode-plugin/plugin.json",
          );
          if (!manifestFile)
            throw new Error(`Bundled plugin manifest is missing: ${plugin.definition.name}`);
          const sourceManifestContents = readSeedFileBytes(source, plugin, manifestFile).toString(
            "utf8",
          );
          // Desktop preheats several workspace Agents concurrently; while copying plugin assets,
          // processes can delete each other's targets and hit EPERM on Windows rename. After
          // taking the lock, re-check so waiters directly reuse the complete cache the first
          // process already committed.
          if (isSeedCurrent(targetRoot, plugin)) {
            cleanupLegacySeedBackup(targetRoot, retryBudget);
            const manifestWritten = tryWriteOfficialPluginRuntimeManifest({
              sourceManifestContents,
              pluginName: plugin.definition.name,
              retryBudget,
              rootPath: targetRoot,
            });
            if (manifestWritten) return;
          }

          const temporaryRoot = `${targetRoot}.tmp-${process.pid}-${Date.now()}`;
          removeOfficialPluginCacheDirectory(temporaryRoot, retryBudget);
          mkdirSync(temporaryRoot, { recursive: true });

          try {
            for (const file of plugin.files) {
              const bytes = readSeedFileBytes(source, plugin, file);
              if (hashBytes(bytes) !== file.sha256) {
                // Copy-path self-heal only: if a memoized hash went stale without a stat change,
                // forget this plugin's hashes so the next call re-hashes instead of failing again.
                forgetFilesystemSeedHashes(plugin.files);
                throw new Error(
                  `Bundled plugin asset hash mismatch: ${plugin.definition.name}/${file.path}`,
                );
              }
              const outputPath = join(temporaryRoot, ...file.path.split("/"));
              mkdirSync(dirname(outputPath), { recursive: true });
              writeFileSync(outputPath, bytes);
              chmodSync(outputPath, modeForSeedFile(file.path, file.mode));
            }

            writeFileSync(
              join(temporaryRoot, SEED_MARKER_FILE),
              JSON.stringify(seedMarker(source, plugin), null, 2),
            );
            replaceSeedRoot(temporaryRoot, targetRoot, plugin, retryBudget);
            writeOfficialPluginRuntimeManifest({
              sourceManifestContents,
              pluginName: plugin.definition.name,
              retryBudget,
              rootPath: targetRoot,
            });
          } catch (error) {
            try {
              removeOfficialPluginCacheDirectory(temporaryRoot, retryBudget);
            } catch {
              // A temp-directory cleanup failure must not mask the real seed error; the directory name is unique and cannot pollute later loads.
            }
            throw error;
          }
        },
        { timeoutMs: Math.max(0, seedLockDeadlineAt - Date.now()) },
      );
    } catch (error) {
      if (
        isTransientOfficialPluginCacheFsError(error) ||
        // A seed-lock wait timeout only means the same-version cache lock is held or left over by
        // another process (on Windows, an undeletable leftover lock + PID reuse can keep takeover
        // from ever firing). Seeding merely refreshes the cache; a timeout must follow the existing
        // degradation protocol — fall back to the usable cache with a warning — instead of blowing
        // session resume into resumeFailed.
        isOfficialPluginSeedLockTimeoutError(error) ||
        // EXDEV on an overlay lower-layer directory does not disappear on retry (not in the retry
        // set). If replace still fails after deletion, this run merely failed to refresh the cache;
        // degrade to the usable old cache instead of failing the whole session resume.
        isCrossDeviceFsError(error) ||
        // Multiple workspace apps can seed the same official plugin cache concurrently. While this
        // process writes the runtime manifest, the concurrent winner may have atomically replaced
        // the whole targetRoot, taking this process's temp files with it, so rename returns ENOENT.
        // Degrade only when the new target is proven complete by its marker; if the target is
        // missing or stale, keep throwing — real cache corruption must not be masked.
        (isNotFoundFsError(error) && isSeedCurrent(targetRoot, plugin))
      ) {
        warnCacheDegraded(input.logger, {
          error,
          operation: "seed_plugin",
          pluginId,
          targetRoot,
        });
        failedSeeds.push(plugin.definition);
        continue;
      }
      throw error;
    }
  }
  return failedSeeds;
}

function tryWriteOfficialPluginRuntimeManifest(input: {
  sourceManifestContents: string;
  pluginName: string;
  retryBudget: OfficialPluginCacheRetryBudget;
  rootPath: string;
}): boolean {
  try {
    writeOfficialPluginRuntimeManifest(input);
    return true;
  } catch (error) {
    if (isTransientOfficialPluginCacheFsError(error)) throw error;
    return false;
  }
}

export function resolveOfficialPluginRoots(input: {
  env?: NodeJS.ProcessEnv;
  extraRoots?: string[];
  logger?: Logger;
  storageRoot: string;
  suppressedBuiltins?: ReadonlySet<string>;
}): string[] {
  const suppressedBuiltins = new Set(input.suppressedBuiltins ?? []);
  // The zcode-cua built-in plugin is off by default and gated by a feature flag. Gate at the
  // seed/discovery layer (not just hiding one UI surface) so that with the flag off, users cannot
  // see it via the plugin list/marketplace/MCP settings/CLI commands.
  if (!isZCodeCuaInternalFeatureEnabled(input.env ?? process.env)) {
    suppressedBuiltins.add(ZCODE_CUA_OFFICIAL_PLUGIN_ID);
  }
  const failedSeeds = seedBundledOfficialPlugins({
    logger: input.logger,
    storageRoot: input.storageRoot,
  });

  const fallbackRoots = failedSeeds.flatMap((definition) => {
    // CUA's frame contract upgrades atomically with the wrapper and producer. Loading an old
    // cache version would wire an old block layout into a new consumer; when the current cache is
    // unavailable, prefer not registering CUA at all.
    if (`${definition.name}@${OFFICIAL_PLUGIN_MARKETPLACE}` === ZCODE_CUA_OFFICIAL_PLUGIN_ID) {
      return [];
    }
    const fallbackRoot = findUsableOfficialPluginFallback(input.storageRoot, definition);
    return fallbackRoot ? [fallbackRoot] : [];
  });
  return uniquePaths([...(input.extraRoots ?? []), ...fallbackRoots]);
}

function resolveSeedSource(): OfficialPluginSeedSource | undefined {
  const seaSource = resolveSeaSeedSource();
  if (seaSource) return seaSource;
  return resolveFilesystemSeedSource();
}

function resolveSeaSeedSource(): OfficialPluginSeedSource | undefined {
  const sea = getSeaModule();
  if (!sea?.isSea()) return undefined;

  const manifest = readSeaManifest(sea);
  if (!manifest) return undefined;
  const plugins = OFFICIAL_PLUGIN_DEFINITIONS.flatMap((definition) => {
    const plugin = manifest.plugins.find(
      (item) =>
        item.marketplace === OFFICIAL_PLUGIN_MARKETPLACE &&
        item.name === definition.name &&
        item.version === definition.version,
    );
    if (!plugin) return [];
    return [
      {
        definition,
        files: plugin.files,
        hash: hashSeedFiles(plugin.files),
        missingSeedPaths: findMissingOfficialPluginSeedPaths(definition, plugin.files),
      },
    ];
  });
  if (plugins.length === 0) return undefined;

  return {
    kind: "sea",
    plugins,
  };
}

function resolveFilesystemSeedSource(): OfficialPluginSeedSource | undefined {
  const plugins = OFFICIAL_PLUGIN_DEFINITIONS.flatMap((definition) => {
    const rootPath = resolveFilesystemPluginRoot(definition);
    if (!rootPath) return [];
    const files = collectFilesystemPluginFiles(rootPath, definition);
    return [
      {
        definition,
        files,
        hash: hashSeedFiles(files),
        missingSeedPaths: findMissingOfficialPluginSeedPaths(definition, files),
        rootPath,
      },
    ];
  });
  if (plugins.length === 0) return undefined;
  return {
    kind: "filesystem",
    plugins,
  };
}

export function findMissingOfficialPluginSeedPaths(
  definition: Pick<OfficialPluginDefinition, "requiredSeedPaths">,
  files: ReadonlyArray<{ path: string }>,
): string[] {
  const availablePaths = new Set(files.map((file) => file.path));
  return (definition.requiredSeedPaths ?? []).filter(
    (requiredPath) => !availablePaths.has(requiredPath),
  );
}

function getSeaModule(): SeaModule | undefined {
  const getBuiltinModule = process.getBuiltinModule as ((id: "node:sea") => SeaModule) | undefined;
  try {
    return getBuiltinModule?.("node:sea");
  } catch {
    return undefined;
  }
}

function readSeaManifest(sea: SeaModule): SeaOfficialPluginManifest | undefined {
  try {
    const raw = sea.getAsset(SEA_PLUGIN_MANIFEST_ASSET_KEY, "utf8");
    const manifest = JSON.parse(raw) as SeaOfficialPluginManifest;
    return manifest.version === 1 && Array.isArray(manifest.plugins) ? manifest : undefined;
  } catch {
    return undefined;
  }
}

function resolveFilesystemPluginRoot(definition: OfficialPluginDefinition): string | undefined {
  for (const baseDir of candidateBaseDirs()) {
    for (const relativePath of definition.rootCandidates) {
      const rootPath = resolve(baseDir, relativePath);
      if (existsSync(join(rootPath, ".zcode-plugin", "plugin.json"))) return rootPath;
    }
  }
  return undefined;
}

function collectFilesystemPluginFiles(
  rootPath: string,
  definition: OfficialPluginDefinition,
): OfficialPluginSeedFile[] {
  const files: OfficialPluginSeedFile[] = [];
  const allowedTopLevelPaths = new Set([
    ...includedTopLevelPaths,
    ...(definition.runtimeTopLevelPaths ?? []),
  ]);
  const visited = new Set<string>();
  for (const sourcePath of walkFiles(rootPath, allowedTopLevelPaths)) {
    const relativePath = toPosixPath(sourcePath.slice(rootPath.length + 1));
    if (!shouldIncludePluginFile(relativePath, allowedTopLevelPaths)) continue;
    visited.add(sourcePath);
    const stats = statSync(sourcePath, { bigint: true });
    files.push({
      mode: modeForSeedFile(relativePath, Number(stats.mode)),
      path: relativePath,
      sha256: hashFilesystemSeedFile(sourcePath, stats),
      sourcePath,
    });
  }
  pruneFilesystemSeedHashMemo(rootPath, visited);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

// Every discovery call (readPresentation, session runtime creation, skills) rebuilt the seed hash
// list by reading and hashing all bundled plugin bytes (~63 MB packaged), which dominated the
// synchronous plugin resolution on the CLI request queue. Hashes are reused only while the
// file's exact (nanosecond) stat signature is unchanged; ctime and inode catch edits that preserve
// size and mtime. Like git's racily-clean rule, a file whose mtime or ctime is within the window
// before the read is hashed but not memoized: a later same-size edit inside the same coarse
// timestamp tick (FAT 2 s, HFS+ 1 s, coarse ktime) would otherwise keep the signature and the old
// hash, and isSeedCurrent would then skip the copy-time check that could catch it.
const filesystemSeedHashMemo = new Map<string, { signature: string; sha256: string }>();
const RACY_SEED_HASH_WINDOW_NS = 2_000_000_000n;

function hashFilesystemSeedFile(sourcePath: string, stats: BigIntStats): string {
  const signature = `${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}:${stats.ino}`;
  const memo = filesystemSeedHashMemo.get(sourcePath);
  if (memo?.signature === signature) return memo.sha256;
  const memoizableBeforeNs = BigInt(Date.now()) * 1_000_000n - RACY_SEED_HASH_WINDOW_NS;
  const sha256 = hashBytes(readFileSync(sourcePath));
  if (stats.mtimeNs <= memoizableBeforeNs && stats.ctimeNs <= memoizableBeforeNs) {
    filesystemSeedHashMemo.set(sourcePath, { signature, sha256 });
  } else {
    filesystemSeedHashMemo.delete(sourcePath);
  }
  return sha256;
}

function forgetFilesystemSeedHashes(files: ReadonlyArray<{ sourcePath?: string }>): void {
  for (const file of files) {
    if (file.sourcePath) filesystemSeedHashMemo.delete(file.sourcePath);
  }
}

function pruneFilesystemSeedHashMemo(rootPath: string, visited: ReadonlySet<string>): void {
  const prefix = `${rootPath}${sep}`;
  for (const sourcePath of filesystemSeedHashMemo.keys()) {
    if (sourcePath.startsWith(prefix) && !visited.has(sourcePath)) {
      filesystemSeedHashMemo.delete(sourcePath);
    }
  }
}

function* walkFiles(
  directory: string,
  allowedTopLevelPaths: ReadonlySet<string>,
  depth = 0,
): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (shouldSkipDirectory(entry.name, depth, allowedTopLevelPaths)) continue;
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(fullPath, allowedTopLevelPaths, depth + 1);
      continue;
    }
    if (entry.isFile()) yield fullPath;
  }
}

function readSeedFileBytes(
  source: OfficialPluginSeedSource,
  plugin: OfficialPluginSeedPluginSource,
  file: OfficialPluginSeedFile,
): Buffer {
  if (source.kind === "filesystem" && file.sourcePath) return readFileSync(file.sourcePath);
  const sea = getSeaModule();
  if (!sea?.isSea()) throw new Error("SEA plugin asset is unavailable outside SEA runtime.");
  return Buffer.from(
    sea.getRawAsset(
      `${SEA_PLUGIN_ASSET_PREFIX}${OFFICIAL_PLUGIN_MARKETPLACE}/${plugin.definition.name}/${plugin.definition.version}/${file.path}`,
    ),
  );
}

function writeOfficialMarketplace(storageRoot: string, source: OfficialPluginSeedSource): void {
  writeBundledOfficialMarketplacePartitionSync({
    manifest: {
      name: OFFICIAL_PLUGIN_MARKETPLACE,
      plugins: source.plugins.map((plugin) => {
        // Store listing and description ship with the catalog entry: keys match the CDN catalog
        // schema and are parsed by the adapter's same parseEntryStoreListing, so the UI can render
        // display name/category/author/sample prompts for bundled plugins. The description comes
        // from the plugin package's own plugin.json (single source of truth).
        const description = readSeedPluginDescription(source, plugin);
        return {
          cachePath: officialPluginCacheRoot(storageRoot, plugin.definition),
          // When not installed/uninstalled, the store reads the catalog entry's componentTypes to decide "UI plugin"; missing it drops the plugin into the categorized grouping.
          ...(plugin.definition.componentTypes
            ? { componentTypes: [...plugin.definition.componentTypes] }
            : {}),
          ...(description ? { description } : {}),
          name: plugin.definition.name,
          source: source.kind,
          version: plugin.definition.version,
          ...(plugin.definition.listing ?? {}),
        };
      }),
      version: 1,
    },
    storageRoot,
  });
}

/** Read the plugin's plugin.json description from the seed file set; read/parse failures degrade to undefined. */
function readSeedPluginDescription(
  source: OfficialPluginSeedSource,
  plugin: OfficialPluginSeedPluginSource,
): string | undefined {
  const manifestFile = plugin.files.find((file) => file.path === ".zcode-plugin/plugin.json");
  if (!manifestFile) return undefined;
  try {
    const parsed = JSON.parse(readSeedFileBytes(source, plugin, manifestFile).toString("utf8")) as {
      description?: unknown;
    };
    return typeof parsed.description === "string" && parsed.description.trim().length > 0
      ? parsed.description
      : undefined;
  } catch {
    return undefined;
  }
}

function isSeedCurrent(targetRoot: string, plugin: OfficialPluginSeedPluginSource): boolean {
  const markerPath = join(targetRoot, SEED_MARKER_FILE);
  if (!existsSync(markerPath)) return false;
  try {
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as ReturnType<typeof seedMarker>;
    return marker.hash === plugin.hash && marker.pluginVersion === plugin.definition.version;
  } catch {
    return false;
  }
}

/**
 * An older cache can keep serving the current session as long as the plugin manifest and the
 * files needed to run are complete. A marker hash mismatch only means an upgrade is needed; a
 * usable old cache must not be treated as a startup failure.
 */
function isSeedUsable(targetRoot: string, definition: OfficialPluginDefinition): boolean {
  try {
    const manifest = JSON.parse(
      readFileSync(join(targetRoot, ".zcode-plugin", "plugin.json"), "utf8"),
    ) as { name?: unknown };
    if (manifest.name !== definition.name) return false;
  } catch {
    return false;
  }

  return (definition.requiredSeedPaths ?? []).every((requiredPath) =>
    existsSync(join(targetRoot, ...requiredPath.split("/"))),
  );
}

function findUsableOfficialPluginFallback(
  storageRoot: string,
  definition: OfficialPluginDefinition,
): string | undefined {
  const targetRoot = officialPluginCacheRoot(storageRoot, definition);
  if (isSeedUsable(targetRoot, definition)) return undefined;

  let entries;
  try {
    entries = readdirSync(dirname(targetRoot), { withFileTypes: true });
  } catch (error) {
    if (isNotFoundFsError(error)) return undefined;
    throw error;
  }

  return entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name !== definition.version &&
        !entry.name.includes(".backup") &&
        // Lock directories (including .seed-lock.stale-*) sit beside version directories; after a
        // timeout degradation the lock is guaranteed present, so do not rely on isSeedUsable's
        // content checks — exclude by name directly.
        !entry.name.includes(".seed-lock") &&
        !entry.name.includes(".tmp-"),
    )
    .sort((left, right) =>
      right.name.localeCompare(left.name, undefined, { numeric: true, sensitivity: "base" }),
    )
    .map((entry) => join(dirname(targetRoot), entry.name))
    .find((rootPath) => isSeedUsable(rootPath, definition));
}

function replaceSeedRoot(
  temporaryRoot: string,
  targetRoot: string,
  plugin: OfficialPluginSeedPluginSource,
  retryBudget: OfficialPluginCacheRetryBudget,
): void {
  const backupRoot = createSeedBackupRoot(targetRoot);
  let movedTargetToBackup = false;
  mkdirSync(dirname(targetRoot), { recursive: true });
  if (existsSync(targetRoot)) {
    try {
      renameOfficialPluginCachePath(targetRoot, backupRoot, retryBudget);
      movedTargetToBackup = true;
    } catch (error) {
      if (isCrossDeviceFsError(error)) {
        // Bug cause: when the container image already ships a plugin cache, the old target sits in
        // the overlayfs lower layer; without redirect_dir the kernel refuses to rename a lower
        // directory, returning EXDEV even within the same parent. The old logic rethrew it as
        // fatal, failing every startup/session resume. A lower-layer directory can be deleted but
        // not renamed, so inside the seed lock this becomes "delete target, then promote temp";
        // this path has no backup to roll back to — if promote fails, the degradation protocol
        // falls back to the usable old version. Delete the marker first: on a mid-delete exit, the
        // partial directory will not be mistaken for a complete cache with the current hash at next
        // startup.
        removeOfficialPluginCacheDirectory(join(targetRoot, SEED_MARKER_FILE), retryBudget);
        removeOfficialPluginCacheDirectory(targetRoot, retryBudget);
      } else if (!isNotFoundFsError(error)) {
        // The official plugin cache is shared by desktop windows, the protocol, and CLI entries.
        // After existsSync, another process may have moved the target away first; only this
        // TOCTOU's ENOENT is absorbed here — execution continues to promote, or isSeedCurrent
        // recognizes the concurrent winner. Other not-found errors keep their original fatal
        // semantics.
        throw error;
      }
    }
  }

  try {
    renameOfficialPluginCachePath(temporaryRoot, targetRoot, retryBudget);
  } catch (error) {
    if (isSeedCurrent(targetRoot, plugin)) {
      removeOfficialPluginCacheDirectory(temporaryRoot, retryBudget);
      if (movedTargetToBackup) {
        removeOfficialPluginCacheDirectory(backupRoot, retryBudget);
      }
      cleanupLegacySeedBackup(targetRoot, retryBudget);
      return;
    }
    if (movedTargetToBackup && !existsSync(targetRoot) && existsSync(backupRoot)) {
      renameOfficialPluginCachePath(backupRoot, targetRoot, retryBudget);
    }
    throw error;
  }

  if (movedTargetToBackup) {
    removeOfficialPluginCacheDirectory(backupRoot, retryBudget);
  }
  cleanupLegacySeedBackup(targetRoot, retryBudget);
}

function cleanupLegacySeedBackup(
  targetRoot: string,
  retryBudget: OfficialPluginCacheRetryBudget,
): void {
  const backupRoot = `${targetRoot}.backup`;
  if (!existsSync(backupRoot)) return;

  // The old fixed backup has no transaction owner; while the target is briefly missing it may
  // belong to another process still promoting, so it must not be restored. Clean this legacy
  // directory only after the current seed is confirmed usable.
  removeOfficialPluginCacheDirectory(backupRoot, retryBudget);
}

function createSeedBackupRoot(targetRoot: string): string {
  // A fixed backup would be treated as a shared rollback point by concurrent startup processes;
  // each replacement uses a unique directory, and the catch branch restores only the target this
  // process moved out — no process can steal another's transaction state.
  return `${targetRoot}.backup-${process.pid}-${Date.now()}`;
}

function isNotFoundFsError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    String((error as NodeJS.ErrnoException).code) === "ENOENT"
  );
}

function isCrossDeviceFsError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    String((error as NodeJS.ErrnoException).code) === "EXDEV"
  );
}

function warnCacheDegraded(
  logger: Logger | undefined,
  input: {
    error: NodeJS.ErrnoException;
    missingSeedPaths?: readonly string[];
    operation: "remove_suppressed_plugin" | "seed_plugin";
    pluginId: string;
    targetRoot: string;
  },
): void {
  logger?.warn("Official plugin cache operation degraded", {
    attempts: getOfficialPluginCacheRetryAttempts(input.error),
    degraded: true,
    errorCode: input.error.code,
    ...(input.missingSeedPaths ? { missingSeedPaths: input.missingSeedPaths } : {}),
    module: "bootstrap.official_plugin_cache",
    operation: input.operation,
    pluginId: input.pluginId,
    targetRoot: input.targetRoot,
  });
}

function seedMarker(source: OfficialPluginSeedSource, plugin: OfficialPluginSeedPluginSource) {
  return {
    hash: plugin.hash,
    marketplace: OFFICIAL_PLUGIN_MARKETPLACE,
    plugin: plugin.definition.name,
    pluginVersion: plugin.definition.version,
    source: source.kind,
    version: 1,
  };
}

function officialPluginCacheRoot(
  storageRoot: string,
  definition: OfficialPluginDefinition,
): string {
  return join(
    storageRoot,
    "cache",
    OFFICIAL_PLUGIN_MARKETPLACE,
    definition.name,
    definition.version,
  );
}

/** The bundled skill packs (bundled-skills.ts) resolve through the same candidate directories, keeping both bundled asset kinds present together in every run layout. */
export function candidateBaseDirs(): string[] {
  // Fix reason: the Electron app-server runs at resources/glm/zcode.cjs and official plugin assets
  // are staged with the desktop package into sibling packages/*-plugin. Candidate directories
  // must look at the entry file's directory first, avoiding a production fallback to the
  // monorepo-only __dirname lookup assumption.
  return [...bundleBaseDirs(), process.cwd()];
}

/** The entry file's directory and the bundle's own directory, excluding cwd: assets shipped with the package (e.g. npm) must not be shadowed by same-named workspace directories. */
export function bundleBaseDirs(): string[] {
  return [entrypointDir(), runtimeDir()].filter((dir): dir is string => typeof dir === "string");
}

function runtimeDir(): string | undefined {
  return typeof __dirname === "string" ? __dirname : undefined;
}

function entrypointDir(): string | undefined {
  return process.argv[1] ? dirname(process.argv[1]) : undefined;
}

function shouldSkipDirectory(
  name: string,
  depth: number,
  allowedTopLevelPaths: ReadonlySet<string>,
): boolean {
  if (name === ".turbo" || name === "coverage" || name === ".venv" || name === "__pycache__") {
    return true;
  }
  return name === "node_modules" && !(depth === 0 && allowedTopLevelPaths.has(name));
}

function shouldIncludePluginFile(
  relativePath: string,
  allowedTopLevelPaths: ReadonlySet<string>,
): boolean {
  const segments = relativePath.split("/");
  if (segments.includes(".DS_Store") || segments.some((segment) => segment.endsWith(".pyc"))) {
    return false;
  }
  const [topLevel] = relativePath.split("/");
  return topLevel !== undefined && allowedTopLevelPaths.has(topLevel);
}

function modeForSeedFile(filePath: string, sourceMode?: number): number {
  if (sourceMode !== undefined && (sourceMode & 0o111) !== 0) return 0o755;

  const normalizedPath = toPosixPath(filePath);
  // The official plugin seed rewrites cache file permissions. Some plugins execute hook scripts
  // directly through polyglot shell wrappers, which would hit permission denied if written 0644.
  // Preserve the source's executable bit here, and fall back for hook scripts lacking mode in
  // SEA/old manifests.
  if (/(?:^|\/)dist\/mcp\/server\.js$/i.test(normalizedPath)) return 0o755;
  if (/^hooks\//u.test(normalizedPath) && !/\.(json|md|txt)$/iu.test(normalizedPath)) {
    return 0o755;
  }

  return 0o644;
}

function hashSeedFiles(files: OfficialPluginSeedFile[]): string {
  return hashText(
    JSON.stringify(
      files.map((file) => [file.path, file.sha256, modeForSeedFile(file.path, file.mode)]),
    ),
  );
}

function toPosixPath(value: string): string {
  return value.split(sep).join("/");
}

function uniquePaths(paths: string[]): string[] {
  return paths.filter((path, index) => paths.indexOf(path) === index);
}

function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hashText(text: string): string {
  return hashBytes(Buffer.from(text));
}
