import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { writePluginTextIfChanged } from "./helpers.js";
import { withFileLock } from "@zcode/shared/node";
import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE } from "@zcode/contracts";

const BUNDLED_PARTITION_FILE = "bundled-marketplace.json";
const CDN_PARTITION_FILE = "cdn-marketplace.json";
const MERGED_MARKETPLACE_FILE = "marketplace.json";

interface BundledMarketplacePartition {
  manifest: Record<string, unknown>;
  version: 1;
}

export async function writeBundledOfficialMarketplacePartition(input: {
  manifest: Record<string, unknown>;
  storageRoot: string;
}): Promise<Record<string, unknown>> {
  assertOfficialManifest(input.manifest);
  return publishPartition(input.storageRoot, async () => {
    await writeJsonFile(partitionPath(input.storageRoot, BUNDLED_PARTITION_FILE), {
      manifest: input.manifest,
      version: 1,
    } satisfies BundledMarketplacePartition);
  });
}

export async function writeCdnOfficialMarketplacePartition(input: {
  manifest: Record<string, unknown>;
  storageRoot: string;
}): Promise<Record<string, unknown>> {
  assertOfficialManifest(input.manifest);
  return publishPartition(input.storageRoot, async () => {
    await writeJsonFile(partitionPath(input.storageRoot, CDN_PARTITION_FILE), input.manifest);
  });
}

async function publishPartition(
  storageRoot: string,
  write: () => Promise<void>,
): Promise<Record<string, unknown>> {
  // 启动 seed 和商店刷新可来自不同进程。分片写入和合并发布同属一次事务，
  // 使用目录文件本身的锁，不递归获取外层安装锁，也不会锁住普通查询。
  return withFileLock(partitionPath(storageRoot, MERGED_MARKETPLACE_FILE), async () => {
    await write();
    return rebuildOfficialMarketplace(storageRoot);
  });
}

export async function loadBundledOfficialPluginRoots(
  storageRoot: string,
): Promise<string[] | undefined> {
  const bundledPartition = await readBundledPartition(storageRoot);
  if (!bundledPartition) return undefined;

  const officialCacheRoot = resolve(storageRoot, "cache", ZCODE_OFFICIAL_PLUGIN_MARKETPLACE);
  return readPluginEntries(bundledPartition.manifest).flatMap((plugin) => {
    const name = readPluginName(plugin);
    const cachePath = typeof plugin.cachePath === "string" ? plugin.cachePath : undefined;
    if (!name || !cachePath) return [];

    const pluginCacheRoot = resolve(officialCacheRoot, name);
    const resolvedCachePath = resolve(cachePath);
    if (
      !isStrictDescendant(officialCacheRoot, pluginCacheRoot) ||
      !isStrictDescendant(pluginCacheRoot, resolvedCachePath)
    ) {
      return [];
    }
    return [resolvedCachePath];
  });
}

async function rebuildOfficialMarketplace(storageRoot: string): Promise<Record<string, unknown>> {
  const bundledPartition = await readBundledPartition(storageRoot);
  const cdnManifest = await readJsonRecord(partitionPath(storageRoot, CDN_PARTITION_FILE));
  const bundledManifest = bundledPartition?.manifest;
  const cdnPlugins = readPluginEntries(cdnManifest);
  const cdnPluginNames = new Set(cdnPlugins.map(readPluginName).filter(isDefined));
  const bundledPlugins = readPluginEntries(bundledManifest).filter((plugin) => {
    const name = readPluginName(plugin);
    return name !== undefined && !cdnPluginNames.has(name);
  });

  // Built-in and CDN plugins previously used two marketplace IDs, so the UI treated the built-in marketplace as a
  // separate source-less marketplace and reported not found on refresh. Persist the two slices separately before
  // merging them; otherwise startup seeding can overwrite the CDN catalog or a CDN refresh can overwrite built-ins.
  // When names collide, prefer the refreshable CDN entry, but filter only the merged catalog and do not delete the app's built-in cache.
  const merged = {
    ...(bundledManifest ?? {}),
    ...(cdnManifest ?? {}),
    name: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
    plugins: [...cdnPlugins, ...bundledPlugins],
  };
  await writeJsonFile(partitionPath(storageRoot, MERGED_MARKETPLACE_FILE), merged);
  return merged;
}

async function readBundledPartition(
  storageRoot: string,
): Promise<BundledMarketplacePartition | undefined> {
  const value = await readJsonRecord(partitionPath(storageRoot, BUNDLED_PARTITION_FILE));
  if (!value || value.version !== 1 || !isRecord(value.manifest)) return undefined;
  return {
    manifest: value.manifest,
    version: 1,
  };
}

function readPluginEntries(
  manifest: Record<string, unknown> | undefined,
): Record<string, unknown>[] {
  return Array.isArray(manifest?.plugins) ? manifest.plugins.filter(isRecord) : [];
}

function readPluginName(plugin: Record<string, unknown>): string | undefined {
  return typeof plugin.name === "string" && plugin.name.length > 0 ? plugin.name : undefined;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function isStrictDescendant(parentPath: string, childPath: string): boolean {
  const relativePath = relative(parentPath, childPath);
  return (
    relativePath.length > 0 &&
    !isAbsolute(relativePath) &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`)
  );
}

function assertOfficialManifest(manifest: Record<string, unknown>): void {
  if (manifest.name !== ZCODE_OFFICIAL_PLUGIN_MARKETPLACE) {
    throw new Error(
      `Official marketplace manifest must be named ${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`,
    );
  }
}

function partitionPath(storageRoot: string, fileName: string): string {
  return join(storageRoot, "marketplaces", ZCODE_OFFICIAL_PLUGIN_MARKETPLACE, fileName);
}

async function readJsonRecord(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writePluginTextIfChanged(path, `${JSON.stringify(value, null, 2)}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
