/* eslint-disable max-lines -- Skill discovery, validation, state, and generic directory management are grouped in one service; splitting the layers would make navigation harder. */
import {
  access,
  appendFile,
  cp,
  mkdir,
  realpath,
  rm,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { existsSync, type Dirent } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  ZCodeProvider,
  SkillDiagnostic,
  SkillMetadata,
  SkillScope,
  SkillSummary,
  SkillsPromptContext,
  SkillsListResult,
  SkillsCapability,
} from "@zcode/shared";
import { DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS } from "@zcode/shared";
import type { ISkillsService } from "./skills.js";
import { SKILL_FILE_NAME, walkSkillMarkdownPaths } from "./skillDiscoveryWalk.js";
import { readInstalledPluginRoots } from "#src/plugins/installedPluginRoots.js";

interface DiscoverResult {
  skills: SkillSummary[];
  diagnostics: SkillDiagnostic[];
}

interface ParsedFrontmatter {
  hasFrontmatter: boolean;
  name: string;
  description: string;
  body: string;
  /** Top-level keys found in frontmatter, retained for capability checks and no longer exposed as warnings. */
  keys: string[];
  /** Whether strict YAML parsing succeeded; looseFields may still be available on failure. */
  parseOk: boolean;
}

const SKILL_META_FILE_NAME = "_meta.json";
const SKILL_SETTINGS_DIR = join(resolveUserHomeDir(), ".zcode", "v2");
const SKILL_CLI_SETTINGS_DIR = join(resolveUserHomeDir(), ".zcode", "cli");
const SKILL_CLI_CONFIG_FILE = join(SKILL_CLI_SETTINGS_DIR, "config.json");
const GIT_MARKER = ".git";
const HOME_PREFIX = "~/";
const ZCODE_OFFICIAL_PLUGIN_MARKETPLACE = "zcode-plugins-official";
const ZCODE_INLINE_PLUGIN_MARKETPLACE = "inline";
const ZCODE_PLUGIN_MANIFEST_PATH = join(".zcode-plugin", "plugin.json");
const CLAUDE_PLUGIN_MANIFEST_PATH = join(".claude-plugin", "plugin.json");
const CODEX_PLUGIN_MANIFEST_PATH = join(".codex-plugin", "plugin.json");

/** Keep in sync with apps/zcode-cli/packages/adapters/src/skills/index.ts:19. */
const MAX_DESCRIPTION_LENGTH = 1024;
function resolveUserHomeDir() {
  const envHome = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
  return envHome && envHome.length > 0 ? envHome : homedir();
}

interface SkillsServiceOptions {
  isDesktopRuntime?: boolean;
}

/** ZCode Agent workspace-level skill directory. */
function getWorkspaceZcodeSkillRoot(workspacePath: string): string {
  return join(workspacePath, ".zcode", "skills");
}

/** Compatibility directory: workspace-level `.agents/skills`; fallback only when no skills are found in the same-level `.zcode/skills`. */
function getWorkspaceAgentsSkillRoot(workspacePath: string): string {
  return join(workspacePath, ".agents", "skills");
}

/** ZCode Agent user-level skill directory. */
function getUserZcodeSkillRoot(): string {
  return join(resolveUserHomeDir(), ".zcode", "skills");
}

/** Compatibility directory: user-level `~/.agents/skills`. */
function getUserAgentsSkillRoot(): string {
  return join(resolveUserHomeDir(), ".agents", "skills");
}

function normalizeSkillNameKey(name: string): string {
  return name.trim().toLowerCase();
}

async function readSkillNameKey(skillPath: string): Promise<string> {
  const fallbackName = basename(dirname(skillPath));
  try {
    const parsed = readFrontmatter(await readFile(skillPath, "utf-8"));
    const rawName = parsed.hasFrontmatter ? parsed.name.trim() : fallbackName;
    return normalizeSkillNameKey(rawName || fallbackName);
  } catch {
    return normalizeSkillNameKey(fallbackName);
  }
}

async function collectSkillNameKeysInRoot(rootPath: string): Promise<Set<string>> {
  const nameKeys = new Set<string>();
  if (!(await exists(rootPath))) {
    return nameKeys;
  }
  const diagnostics: SkillDiagnostic[] = [];
  for (const skillPath of await collectSkillMarkdownPaths(rootPath, diagnostics)) {
    nameKeys.add(await readSkillNameKey(skillPath));
  }
  return nameKeys;
}

async function isUserAgentsSkillCoveredByZcode(params: {
  skillPath: string;
  rootPath: string;
  userZcodeSkillNameKeys: Set<string>;
}): Promise<boolean> {
  const { skillPath, rootPath, userZcodeSkillNameKeys } = params;
  if (rootPath !== getUserAgentsSkillRoot()) {
    return false;
  }
  if (await exists(join(getUserZcodeSkillRoot(), basename(dirname(skillPath)), SKILL_FILE_NAME))) {
    return true;
  }
  return userZcodeSkillNameKeys.has(await readSkillNameKey(skillPath));
}

/**
 * Walk upward from workspacePath to the worktree root (including the level marked by .git) and collect
 * `.zcode/skills` and `.agents/skills` at every level.
 * Keep in sync with apps/zcode-cli/packages/adapters/src/skills/roots.ts:60-72.
 * If .git is not found, use workspacePath itself.
 */
async function resolveAncestorWorkspaceRoots(workspacePath: string): Promise<string[]> {
  const worktreeRoot = await findWorktreeRoot(workspacePath);
  const baseDirectories: string[] = [];
  if (!worktreeRoot) {
    baseDirectories.push(workspacePath);
  } else {
    let current = workspacePath;
    while (true) {
      baseDirectories.push(current);
      if (current === worktreeRoot || current === dirname(current)) {
        break;
      }
      current = dirname(current);
    }
  }
  const roots: string[] = [];
  for (const dir of baseDirectories) {
    // Agent runtime scans both workspace skill roots together. The UI previously treated `.agents`
    // as a fallback for `.zcode`, so a single skill in same-level `.zcode` caused `/`, `$`, and settings to
    // miss the entire `.agents` root, splitting discovery semantics so the model could execute a skill the UI could not reference.
    roots.push(getWorkspaceZcodeSkillRoot(dir));
    roots.push(getWorkspaceAgentsSkillRoot(dir));
  }
  return roots;
}

async function findWorktreeRoot(workingDirectory: string): Promise<string | null> {
  let current = workingDirectory;
  while (true) {
    if (await exists(join(current, GIT_MARKER))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function dedupeRoots(paths: string[]): string[] {
  const roots = new Set<string>();
  for (const path of paths) {
    roots.add(path);
  }
  return [...roots];
}

function normalizeScanRootPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/+$/, "");
}

/**
 * Remove ancestor directories completely covered by deeper scan roots that exist.
 * The same SKILL.md may otherwise appear more than once when the same directory is scanned through different path strings.
 * Keep the parent directory if the child does not yet exist, for compatibility with nonstandard layouts.
 */
async function filterNestedScanRoots(paths: string[]): Promise<string[]> {
  const existing = new Set<string>();
  for (const path of paths) {
    if (await exists(path)) {
      existing.add(normalizeScanRootPath(path));
    }
  }
  const normalized = paths.map((path) => normalizeScanRootPath(path));
  return paths.filter((path, index) => {
    const current = normalized[index] ?? normalizeScanRootPath(path);
    if (!existing.has(current)) {
      return true;
    }
    return !normalized.some((other, otherIndex) => {
      if (otherIndex === index || !existing.has(other)) {
        return false;
      }
      return other.startsWith(`${current}/`);
    });
  });
}

async function dedupeScanRootsByRealpath(paths: string[]): Promise<string[]> {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of await filterNestedScanRoots(paths)) {
    let canonical = normalizeScanRootPath(path);
    if (await exists(path)) {
      canonical = normalizeScanRootPath(await realpath(path).catch(() => path));
    }
    if (seen.has(canonical)) {
      continue;
    }
    seen.add(canonical);
    result.push(path);
  }
  return result;
}

function hashStableIdPart(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function buildSkillId(params: {
  provider: ZCodeProvider;
  scope: SkillScope;
  name: string;
  path: string;
}): string {
  return `${params.provider}:${params.scope}:${params.name}:${hashStableIdPart(params.path)}`;
}

function collectMentionedSkillNames(prompt: string): Set<string> {
  const names = new Set<string>();
  for (const match of prompt.matchAll(/\$([a-z0-9]+(?:-[a-z0-9]+)*)/g)) {
    const name = match[1];
    if (name) {
      names.add(name);
    }
  }
  return names;
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function buildActivatedSkillsPromptBlock(skills: SkillSummary[]): string {
  return [
    "<available_skills>",
    ...skills.map((skill) =>
      [
        `<activated_skill name="${escapeXmlAttribute(skill.name)}" path="${escapeXmlAttribute(skill.path)}">`,
        skill.body,
        "</activated_skill>",
      ].join("\n"),
    ),
    "</available_skills>",
  ].join("\n");
}

async function appendSkillsAuditLog(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  activatedSkillNames: string[];
}): Promise<void> {
  await mkdir(SKILL_SETTINGS_DIR, { recursive: true });
  await appendFile(
    join(SKILL_SETTINGS_DIR, "skills-audit.log"),
    `${JSON.stringify({
      createdAt: Date.now(),
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity ?? null,
      activatedSkillNames: params.activatedSkillNames,
    })}\n`,
    "utf-8",
  );
}

function readFrontmatter(content: string): ParsedFrontmatter {
  // SKILL.md may come from Windows or another toolchain, so its line endings may not be \n.
  // Normalize line endings first, then pass frontmatter fields to YAML parsing to support multiline descriptions.
  const normalized = content.replace(/\r\n|\r/g, "\n");
  const frontmatterMatch = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  if (!frontmatterMatch) {
    return {
      hasFrontmatter: false,
      name: "",
      description: "",
      body: normalized.trim(),
      keys: [],
      parseOk: false,
    };
  }

  const frontmatterText = frontmatterMatch[1] ?? "";
  const frontmatterParts = splitFrontmatterAndLeakedBody(frontmatterText);
  const bodyAfterFrontmatter = normalized.slice(frontmatterMatch[0].length).trim();
  const body = [frontmatterParts.leakedBody, bodyAfterFrontmatter]
    .filter((part) => part.trim().length > 0)
    .join("\n\n")
    .trim();
  const looseFields = readLooseFrontmatterFields(frontmatterParts.metadataText);
  const looseKeys = extractLooseFrontmatterKeys(frontmatterParts.metadataText);
  if (hasYamlUnsafeLooseInlineField(frontmatterParts.metadataText)) {
    // Historical Chinese descriptions often used an unquoted form such as `Trigger scenario: ...`.
    // YAML treats `: ` in a plain scalar as a mapping separator, so strict parsing fails. Use the loose-read result directly to avoid repeatedly taking the failed-parse path during concurrent scans.
    return {
      hasFrontmatter: true,
      ...looseFields,
      body,
      keys: looseKeys,
      parseOk: false,
    };
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(frontmatterParts.metadataText);
  } catch {
    // Some historical skills contain body text before the closing --- and are not strict YAML.
    // Fall back to loose field reading after YAML parse failure so existing metadata such as Chinese descriptions is not lost.
    return {
      hasFrontmatter: true,
      ...looseFields,
      body,
      keys: looseKeys,
      parseOk: false,
    };
  }
  if (!isObjectRecord(parsed)) {
    return {
      hasFrontmatter: true,
      ...looseFields,
      body,
      keys: looseKeys,
      parseOk: false,
    };
  }

  return {
    hasFrontmatter: true,
    name: readFrontmatterString(parsed.name) || looseFields.name,
    description: readFrontmatterString(parsed.description) || looseFields.description,
    body,
    keys: Object.keys(parsed),
    parseOk: true,
  };
}

function splitFrontmatterAndLeakedBody(frontmatterText: string): {
  metadataText: string;
  leakedBody: string;
} {
  const lines = frontmatterText.split("\n");
  const leakedBodyStartIndex = lines.findIndex(
    (line, index) =>
      index > 0 &&
      // Some historical skills place body headings before the closing ---.
      // When a Markdown heading appears, move this section from frontmatter into the body so the parser does not swallow its content.
      /^#{1,6}\s+\S/.test(line),
  );
  if (leakedBodyStartIndex < 0) {
    return { metadataText: frontmatterText, leakedBody: "" };
  }
  return {
    metadataText: lines.slice(0, leakedBodyStartIndex).join("\n").trimEnd(),
    leakedBody: lines.slice(leakedBodyStartIndex).join("\n").trim(),
  };
}

function readLooseFrontmatterFields(frontmatterText: string): {
  name: string;
  description: string;
} {
  let name = "";
  let description = "";
  const lines = frontmatterText.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const colonIndex = line.indexOf(":");
    if (colonIndex < 0) {
      continue;
    }
    const key = line.slice(0, colonIndex).trim();
    const rawValue = line.slice(colonIndex + 1).trim();
    if (key === "name") {
      name = readLooseFrontmatterInlineString(rawValue);
    } else if (key === "description") {
      const blockStyle = rawValue[0];
      if (blockStyle === "|" || blockStyle === ">") {
        const blockLines: string[] = [];
        for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
          const nextLine = lines[nextIndex] ?? "";
          if (!nextLine.startsWith(" ") && !nextLine.startsWith("\t")) {
            break;
          }
          blockLines.push(nextLine.replace(/^\s{1,2}/, ""));
          index = nextIndex;
        }
        description = blockStyle === ">" ? blockLines.join(" ") : blockLines.join("\n");
      } else {
        description = readLooseFrontmatterInlineString(rawValue);
      }
    }
  }
  return { name, description };
}

/**
 * Collect only top-level frontmatter keys (skip indented nested fields).
 * Used to provide the key list for unknown-key diagnostics and fallback when YAML parsing fails.
 */
function extractLooseFrontmatterKeys(frontmatterText: string): string[] {
  const keys: string[] = [];
  for (const line of frontmatterText.split("\n")) {
    if (line.length === 0) continue;
    if (/^\s/.test(line)) continue;
    if (line.trim().startsWith("#")) continue;
    const colonIndex = line.indexOf(":");
    if (colonIndex <= 0) continue;
    const key = line.slice(0, colonIndex).trim();
    if (key.length === 0) continue;
    if (!keys.includes(key)) {
      keys.push(key);
    }
  }
  return keys;
}

function hasYamlUnsafeLooseInlineField(frontmatterText: string): boolean {
  const lines = frontmatterText.split("\n");
  for (const line of lines) {
    const colonIndex = line.indexOf(":");
    if (colonIndex < 0) {
      continue;
    }
    const key = line.slice(0, colonIndex).trim();
    if (key !== "name" && key !== "description") {
      continue;
    }
    const rawValue = line.slice(colonIndex + 1).trim();
    if (
      rawValue.length === 0 ||
      rawValue.startsWith('"') ||
      rawValue.startsWith("'") ||
      rawValue.startsWith("|") ||
      rawValue.startsWith(">")
    ) {
      continue;
    }
    if (rawValue.includes(": ")) {
      return true;
    }
  }
  return false;
}

function readLooseFrontmatterInlineString(value: string): string {
  return value.trim().replace(/^["']|["']$/g, "");
}

function readFrontmatterString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return "";
  }
  return String(value);
}

async function readSkillMetadata(skillPath: string): Promise<SkillMetadata | undefined> {
  const metaPath = join(dirname(skillPath), SKILL_META_FILE_NAME);
  const raw = await readFile(metaPath, "utf-8").catch(() => null);
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isObjectRecord(parsed)) {
      return undefined;
    }
    const metadata: SkillMetadata = {};
    if (typeof parsed.slug === "string" && parsed.slug.trim().length > 0) {
      metadata.slug = parsed.slug.trim();
    }
    if (typeof parsed.version === "string" && parsed.version.trim().length > 0) {
      metadata.version = parsed.version.trim();
    }
    if (typeof parsed.ownerId === "string" && parsed.ownerId.trim().length > 0) {
      metadata.ownerId = parsed.ownerId.trim();
    }
    if (typeof parsed.publishedAt === "number" && Number.isFinite(parsed.publishedAt)) {
      metadata.publishedAt = parsed.publishedAt;
    }
    return Object.keys(metadata).length > 0 ? metadata : undefined;
  } catch {
    // _meta.json contains extra information from the skill installer; corruption must not affect display of SKILL.md itself.
    return undefined;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function normalizeSkillConfigPath(path: string): string {
  return path.replaceAll("\\", "/");
}

async function readCliConfigFile(): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(SKILL_CLI_CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return isObjectRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSkillEnabledMapFromConfig(config: Record<string, unknown>): Record<string, boolean> {
  const skillsConfig = isObjectRecord(config.skills) ? config.skills : {};
  const result: Record<string, boolean> = {};
  for (const [path, value] of Object.entries(skillsConfig)) {
    if (isObjectRecord(value) && typeof value.enable === "boolean") {
      result[normalizeSkillConfigPath(path)] = value.enable;
    }
  }
  return result;
}

async function readSkillEnabledMap(): Promise<Record<string, boolean>> {
  return readSkillEnabledMapFromConfig(await readCliConfigFile());
}

async function writeSkillEnabledMap(next: Record<string, boolean>): Promise<void> {
  const config = await readCliConfigFile();
  const skillsConfig = isObjectRecord(config.skills) ? config.skills : {};
  for (const [path, enable] of Object.entries(next).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    // Skill toggles were previously spread across workspace/provider/context state files, causing inconsistent behavior across entry points.
    // Now write only the skills field in CLI config by SKILL.md path, avoiding extra migrations or side effects from old files.
    const normalizedPath = normalizeSkillConfigPath(path);
    if (enable) {
      // Enabled is the default and should not be persisted as `{ enable: true }`; delete the override so plugin/default configuration changes take effect.
      delete skillsConfig[normalizedPath];
    } else {
      skillsConfig[normalizedPath] = { enable };
    }
  }
  if (Object.keys(skillsConfig).length > 0) {
    config.skills = skillsConfig;
  } else {
    delete config.skills;
  }
  await mkdir(SKILL_CLI_SETTINGS_DIR, { recursive: true });
  await writeFile(SKILL_CLI_CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

interface SkillRootDescriptor {
  scope: SkillScope;
  rootPath: string;
  pluginName?: string;
  pluginId?: string;
}

interface PluginConfigSummary {
  dirs: string[];
  enabled: boolean;
  enabledPlugins: Record<string, boolean>;
  storageDir: string;
  suppressedBuiltins: string[];
}

interface PluginRootCandidate {
  defaultEnabled: boolean;
  marketplace: string;
  rootPath: string;
}

interface PluginManifestSummary {
  name: string;
  skills?: unknown;
}

function readPluginConfigFromConfig(config: Record<string, unknown>): PluginConfigSummary {
  const plugins = isObjectRecord(config.plugins) ? config.plugins : {};
  return {
    dirs: readStringArray(plugins.dirs),
    enabled: typeof plugins.enabled === "boolean" ? plugins.enabled : true,
    enabledPlugins: readBooleanRecord(plugins.enabledPlugins),
    storageDir: readStorageDirFromConfig(config),
    suppressedBuiltins: readStringArray(plugins.suppressedBuiltins),
  };
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function readBooleanRecord(value: unknown): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  if (!isObjectRecord(value)) {
    return result;
  }
  for (const [key, enabled] of Object.entries(value)) {
    if (typeof enabled === "boolean") {
      result[key] = enabled;
    }
  }
  return result;
}

function readStorageDirFromConfig(config: Record<string, unknown>): string {
  const storage = isObjectRecord(config.storage) ? config.storage : {};
  return typeof storage.dir === "string" && storage.dir.trim().length > 0
    ? storage.dir
    : "~/.zcode";
}

function resolveConfigPath(path: string): string {
  const expanded = path.startsWith(HOME_PREFIX)
    ? join(resolveUserHomeDir(), path.slice(HOME_PREFIX.length))
    : path;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

function resolveCliStorageRoot(storageDir: string): string {
  const storageRoot = resolveConfigPath(storageDir);
  return basename(storageRoot) === "cli" ? storageRoot : join(storageRoot, "cli");
}

function resolvePluginStorageRoot(storageDir: string): string {
  return join(resolveCliStorageRoot(storageDir), "plugins");
}

function parsePathList(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  return readStringArray(value);
}

function resolveInside(rootPath: string, rawPath: string): string | null {
  if (isAbsolute(rawPath)) {
    return null;
  }
  const resolved = resolve(rootPath, rawPath);
  const relativePath = relative(rootPath, resolved);
  if (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !relativePath.includes(`..${sep}`))
  ) {
    return resolved;
  }
  return null;
}

async function scanOfficialPluginCacheRoots(pluginStorageRoot: string): Promise<string[]> {
  const cacheRoot = join(pluginStorageRoot, "cache", ZCODE_OFFICIAL_PLUGIN_MARKETPLACE);
  let pluginEntries: Dirent[] = [];
  try {
    pluginEntries = await readdir(cacheRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const roots: string[] = [];
  for (const pluginEntry of pluginEntries) {
    if (!pluginEntry.isDirectory()) {
      continue;
    }
    const pluginDir = join(cacheRoot, pluginEntry.name);
    let versionEntries: Dirent[] = [];
    try {
      versionEntries = await readdir(pluginDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const versionEntry of versionEntries) {
      if (versionEntry.isDirectory()) {
        roots.push(join(pluginDir, versionEntry.name));
      }
    }
  }
  return roots.sort((left, right) => left.localeCompare(right));
}

async function readPluginManifest(rootPath: string): Promise<PluginManifestSummary | null> {
  const manifestPath = await findPluginManifestPath(rootPath);
  if (!manifestPath) {
    return null;
  }
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf-8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isObjectRecord(parsed)) {
      return null;
    }
    const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(name)) {
      return null;
    }
    return { name, skills: parsed.skills };
  } catch {
    return null;
  }
}

async function findPluginManifestPath(rootPath: string): Promise<string | null> {
  for (const manifestPath of [
    join(rootPath, ZCODE_PLUGIN_MANIFEST_PATH),
    join(rootPath, CLAUDE_PLUGIN_MANIFEST_PATH),
    join(rootPath, CODEX_PLUGIN_MANIFEST_PATH),
  ]) {
    if (await exists(manifestPath)) {
      return manifestPath;
    }
  }
  return null;
}

function resolvePluginSkillRoots(params: {
  manifest: PluginManifestSummary;
  rootPath: string;
}): string[] {
  const roots: string[] = [];
  for (const rawPath of parsePathList(params.manifest.skills)) {
    const rootPath = resolveInside(params.rootPath, rawPath);
    if (rootPath) {
      roots.push(rootPath);
    }
  }
  if (roots.length === 0 && params.manifest.skills === undefined) {
    const defaultRoot = join(params.rootPath, "skills");
    if (existsSync(defaultRoot)) {
      roots.push(defaultRoot);
    }
  }
  return roots;
}

async function resolvePluginSkillRootDescriptors(): Promise<SkillRootDescriptor[]> {
  const config = readPluginConfigFromConfig(await readCliConfigFile());
  if (!config.enabled) {
    return [];
  }

  const pluginStorageRoot = resolvePluginStorageRoot(config.storageDir);
  const officialCacheRoots = await scanOfficialPluginCacheRoots(pluginStorageRoot);
  const installedRoots = await readInstalledPluginRoots(pluginStorageRoot);
  const candidates: PluginRootCandidate[] = [
    ...config.dirs.map((dir) => ({
      defaultEnabled: true,
      marketplace: ZCODE_INLINE_PLUGIN_MARKETPLACE,
      rootPath: resolveConfigPath(dir),
    })),
    ...officialCacheRoots.map((rootPath) => ({
      defaultEnabled: false,
      marketplace: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
      rootPath,
    })),
    ...installedRoots,
  ];
  const descriptors: SkillRootDescriptor[] = [];
  const seenPluginIds = new Set<string>();

  for (const candidate of candidates) {
    const manifest = await readPluginManifest(candidate.rootPath);
    if (!manifest) {
      continue;
    }
    const pluginId = `${manifest.name}@${candidate.marketplace}`;
    // “Uninstalling” a built-in official plugin writes only suppressedBuiltins to CLI config. Desktop scans the official cache directly
    // without the CLI resolve filter, so it must skip these entries too or an uninstalled built-in plugin still contributes skills from cache.
    if (
      candidate.marketplace === ZCODE_OFFICIAL_PLUGIN_MARKETPLACE &&
      config.suppressedBuiltins.includes(pluginId)
    ) {
      continue;
    }
    if (seenPluginIds.has(pluginId)) {
      continue;
    }
    seenPluginIds.add(pluginId);
    const defaultEnabled =
      candidate.defaultEnabled || DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS.has(pluginId);
    const enabled = config.enabledPlugins[pluginId] ?? defaultEnabled;
    if (!enabled) {
      continue;
    }
    // The Agent runtime already adds skillRoots from plugin manifests, but the UI skillsService
    // previously scanned only the built-in official cache/manual directories and missed official Claude and custom marketplace plugins in installed_plugins.json,
    // leaving plugin details with a skill count but no skill names.
    for (const rootPath of resolvePluginSkillRoots({ manifest, rootPath: candidate.rootPath })) {
      descriptors.push({
        scope: "plugin",
        rootPath,
        pluginName: manifest.name,
        pluginId,
      });
    }
  }

  return descriptors;
}

async function discoverSkills(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  includeUserSkills: boolean;
  provider: ZCodeProvider;
}): Promise<DiscoverResult> {
  const workspaceRoots = dedupeRoots(await resolveAncestorWorkspaceRoots(params.workspacePath));
  const roots: SkillRootDescriptor[] = workspaceRoots.map((rootPath) => ({
    scope: "workspace" as const,
    rootPath,
  }));
  if (params.includeUserSkills) {
    // User-level skills are global resources. Stopping at `.zcode/skills` as soon as it contains one skill
    // makes global skills from external Agents disappear from settings after import.
    roots.push({
      scope: "user" as const,
      rootPath: getUserZcodeSkillRoot(),
    });
    roots.push({
      scope: "user" as const,
      rootPath: getUserAgentsSkillRoot(),
    });
  }
  roots.push(...(await resolvePluginSkillRootDescriptors()));

  const diagnostics: SkillDiagnostic[] = [];
  const skills: SkillSummary[] = [];
  const seenSkillPaths = new Set<string>();
  const userZcodeSkillNameKeys = params.includeUserSkills
    ? await collectSkillNameKeysInRoot(getUserZcodeSkillRoot())
    : new Set<string>();
  const scanRootPaths = await dedupeScanRootsByRealpath(roots.map((root) => root.rootPath));
  const rootByPath = new Map(roots.map((root) => [root.rootPath, root]));

  for (const rootPath of scanRootPaths) {
    const root = rootByPath.get(rootPath);
    if (!root) {
      continue;
    }
    if (!(await exists(root.rootPath))) {
      continue;
    }

    const skillPaths = await collectSkillMarkdownPaths(root.rootPath, diagnostics);
    for (const skillPath of skillPaths) {
      if (
        await isUserAgentsSkillCoveredByZcode({
          skillPath,
          rootPath: root.rootPath,
          userZcodeSkillNameKeys,
        })
      ) {
        continue;
      }
      const canonicalSkillPath = await realpath(skillPath).catch(() => skillPath);
      if (seenSkillPaths.has(canonicalSkillPath)) {
        continue;
      }
      seenSkillPaths.add(canonicalSkillPath);
      if (!(await exists(skillPath))) {
        continue;
      }
      let markdown: string;
      try {
        markdown = await readFile(skillPath, "utf-8");
      } catch (error) {
        diagnostics.push({
          code: "skill_read_failed",
          severity: "warning",
          message: error instanceof Error ? error.message : `Failed to read skill: ${skillPath}`,
          path: skillPath,
        });
        continue;
      }
      const parsed = readFrontmatter(markdown);
      const skillFolderName = basename(dirname(skillPath));

      // Name validation requires only a non-empty value; case, underscores, and similar forms are valid display names in other skill ecosystems and should not produce noisy diagnostics.
      // Do not show an unactionable diagnostic for a hand-written skill without frontmatter; use the directory name and leave metadata fields empty.
      const rawName = parsed.hasFrontmatter ? parsed.name.trim() : skillFolderName;
      const resolvedName = rawName || skillFolderName;
      if (!resolvedName) {
        diagnostics.push({
          code: "skill_missing_name",
          severity: "error",
          message: `Skill frontmatter must include a name: ${skillPath}`,
          path: skillPath,
        });
        continue;
      }

      const description = parsed.hasFrontmatter ? parsed.description.trim() : "";
      if (description.length > MAX_DESCRIPTION_LENGTH) {
        diagnostics.push({
          code: "skill_description_too_long",
          severity: "error",
          message: `Skill description is too long (>${MAX_DESCRIPTION_LENGTH}): ${resolvedName}`,
          path: skillPath,
          skillName: resolvedName,
        });
        continue;
      }

      // Frontmatter extension fields usually come from metadata in other skill ecosystems.
      // These fields do not affect ZCode's reading of name/description, so warning about them only creates noise with no actionable value.

      const body = parsed.body.trim();
      const metadata = await readSkillMetadata(skillPath);
      skills.push({
        id: buildSkillId({
          provider: params.provider,
          scope: root.scope,
          name: resolvedName,
          path: canonicalSkillPath,
        }),
        name: resolvedName,
        description,
        body,
        // SkillSummary.path previously stored the skill directory, so the frontend could not get a standard file path when generating a skill mention link,
        // resulting in an incomplete reference such as `[$skill](.../skill-dir)`. Return the `SKILL.md` file path directly
        // so the UI, logs, and later skill navigation share one canonical location.
        path: canonicalSkillPath,
        // Original scan path (before realpath). Use it to locate the link itself when deleting a symlinked skill, avoiding accidental deletion of the target directory.
        sourcePath: skillPath,
        scope: root.scope,
        enabled: true,
        ...(root.pluginName ? { pluginName: root.pluginName } : {}),
        ...(root.pluginId ? { pluginId: root.pluginId } : {}),
        ...(metadata ? { metadata } : {}),
      });
    }
  }

  skills.sort((left, right) => {
    const byName = left.name.localeCompare(right.name);
    if (byName !== 0) {
      return byName;
    }
    const byScope = left.scope.localeCompare(right.scope);
    return byScope !== 0 ? byScope : left.path.localeCompare(right.path);
  });

  return { skills, diagnostics };
}

async function collectSkillMarkdownPaths(
  rootPath: string,
  diagnostics: SkillDiagnostic[],
): Promise<string[]> {
  // Reuse the shared bounded traversal: support grouped directories, exclude content directories such as node_modules, limit depth, and deduplicate symlinks by realpath,
  // preventing Windows junctions or huge dependency directories from stretching one scan to tens of seconds.
  const discovered = new Set<string>();
  for await (const skillPath of walkSkillMarkdownPaths(rootPath, {
    onError: (path, error) => {
      diagnostics.push({
        code: "skill_scan_failed",
        severity: "warning",
        message: error instanceof Error ? error.message : `Failed to scan skill directory: ${path}`,
        path,
      });
    },
  })) {
    discovered.add(skillPath);
  }
  return [...discovered].sort((left, right) => left.localeCompare(right));
}

function resolveCapabilities(options?: SkillsServiceOptions): SkillsCapability {
  const isDesktopRuntime = options?.isDesktopRuntime ?? Boolean(process.env.ZCODE_PROCESS_LABEL);
  if (isDesktopRuntime) {
    return { userScopeAvailable: true };
  }
  return { userScopeAvailable: false, userScopeReason: "desktop_only" };
}

function attachEnabledState(
  skills: SkillSummary[],
  enabledByPath: Record<string, boolean>,
): SkillSummary[] {
  return skills.map((skill) => ({
    ...skill,
    enabled: enabledByPath[normalizeSkillConfigPath(skill.path)] ?? true,
  }));
}

export function createSkillsService(options?: SkillsServiceOptions): ISkillsService {
  let writeQueue = Promise.resolve();

  return {
    async list(params: {
      workspacePath: string;
      workspaceIdentity?: string;
      provider?: ZCodeProvider;
    }): Promise<SkillsListResult> {
      const capability = resolveCapabilities(options);
      const provider = "glm";
      const { skills: discovered, diagnostics } = await discoverSkills({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        includeUserSkills: capability.userScopeAvailable,
        provider,
      });
      const enabledByPath = await readSkillEnabledMap();
      return {
        skills: attachEnabledState(discovered, enabledByPath),
        capability,
        diagnostics,
      };
    },

    async setEnabled(params: {
      workspacePath: string;
      workspaceIdentity?: string;
      provider?: ZCodeProvider;
      scope?: SkillScope;
      skillId: string;
      enabled: boolean;
    }): Promise<void> {
      const runUpdate = async () => {
        const provider = "glm";
        const capability = resolveCapabilities(options);
        const { skills } = await discoverSkills({
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
          includeUserSkills: capability.userScopeAvailable,
          provider,
        });
        const skill = skills.find((item) => item.id === params.skillId);
        if (!skill) {
          throw new Error(`Skill not found: ${params.skillId}`);
        }
        const enabledByPath = await readSkillEnabledMap();
        enabledByPath[normalizeSkillConfigPath(skill.path)] = params.enabled;
        await writeSkillEnabledMap(enabledByPath);
      };

      const queued = writeQueue.then(runUpdate, runUpdate);
      writeQueue = queued.catch(() => {});
      await queued;
    },

    async buildPromptContext(params: {
      workspacePath: string;
      workspaceIdentity?: string;
      provider?: ZCodeProvider;
      prompt: string;
    }): Promise<SkillsPromptContext> {
      const mentionedSkillNames = collectMentionedSkillNames(params.prompt);
      if (mentionedSkillNames.size === 0) {
        return { prompt: params.prompt, activatedSkillNames: [] };
      }

      const { skills } = await this.list({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        provider: params.provider,
      });
      const activatedSkills = skills.filter(
        (skill) => skill.enabled && mentionedSkillNames.has(skill.name),
      );
      if (activatedSkills.length === 0) {
        return { prompt: params.prompt, activatedSkillNames: [] };
      }

      const activatedSkillNames = activatedSkills.map((skill) => skill.name);
      // Skill directories are visible resources but must not all be injected on every session send.
      // Only skills explicitly mentioned in the prompt and currently enabled enter context, preventing UI list state from leaking into the Agent's core session.
      await appendSkillsAuditLog({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        activatedSkillNames,
      });
      return {
        prompt: `${params.prompt}\n\n${buildActivatedSkillsPromptBlock(activatedSkills)}`,
        activatedSkillNames,
      };
    },

    async copyToCommon(params: {
      workspacePath: string;
      workspaceIdentity?: string;
      skillId: string;
    }): Promise<{ newPath: string }> {
      // Find the target skill across all provider scan results (list has already scanned every path).
      const { skills } = await this.list({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
      });
      const skill = skills.find((s) => s.id === params.skillId);
      if (!skill) {
        throw new Error(`Skill not found: ${params.skillId}`);
      }
      const sourceDir = dirname(skill.path);
      // Determine user vs workspace scope for a generic directory from the skill's original scope.
      const commonRoot =
        skill.scope === "workspace"
          ? getWorkspaceZcodeSkillRoot(params.workspacePath)
          : getUserZcodeSkillRoot();
      const targetDir = join(commonRoot, basename(sourceDir));
      // Do not overwrite an existing directory.
      if (await exists(targetDir)) {
        throw new Error(`通用目录已存在同名技能: ${basename(sourceDir)}`);
      }
      await mkdir(commonRoot, { recursive: true });
      await cp(sourceDir, targetDir, { recursive: true });
      return { newPath: join(targetDir, SKILL_FILE_NAME) };
    },

    async removeFromCommon(params: {
      workspacePath: string;
      workspaceIdentity?: string;
      skillId: string;
    }): Promise<void> {
      const { skills } = await this.list({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
      });
      const skill = skills.find((s) => s.id === params.skillId);
      if (!skill) {
        throw new Error(`Skill not found: ${params.skillId}`);
      }
      const normalizedPath = skill.path.replaceAll("\\", "/").toLowerCase();
      const userCommonRoot = getUserZcodeSkillRoot().replaceAll("\\", "/").toLowerCase();
      const workspaceCommonRoot = getWorkspaceZcodeSkillRoot(params.workspacePath)
        .replaceAll("\\", "/")
        .toLowerCase();
      const inUserCommon = normalizedPath.includes(`${userCommonRoot}/`);
      const inWorkspaceCommon = normalizedPath.includes(`${workspaceCommonRoot}/`);
      if (!inUserCommon && !inWorkspaceCommon) {
        throw new Error("该技能不在通用目录中");
      }
      await rm(dirname(skill.path), { recursive: true, force: true });
    },

    async deleteSkill(params: {
      workspacePath: string;
      workspaceIdentity?: string;
      skillId: string;
    }): Promise<void> {
      const { skills } = await this.list({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
      });
      const skill = skills.find((s) => s.id === params.skillId);
      if (!skill) {
        throw new Error(`Skill not found: ${params.skillId}`);
      }
      // Plugin-scoped skills are managed by their owning plugin and must be removed by uninstalling that plugin; reject individual deletion here.
      if (skill.scope === "plugin") {
        throw new Error("插件提供的技能不可单独删除，请卸载对应插件");
      }

      // Use the original path found during discovery (sourcePath, before realpath) to locate the skill directory entry.
      // For an imported symlinked skill, skill.path is the realpath target and dirname points to the target directory;
      // sourcePath points to the directory entry under `~/.zcode/skills/<name>` itself.
      const skillDir = dirname(skill.sourcePath ?? skill.path);
      const skillLeafName = basename(skillDir);
      // Resolve only the parent directory, not the leaf itself:
      // - If the leaf is a symlink (the normal import case), leave it unresolved so deletion removes only the link, not its target.
      // - realpath on the parent resolves any symlink/junction ancestors to their true locations,
      //   allowing the boundary check below to prevent data loss by deleting outside a controlled root through an ancestor link.
      const canonicalParent = await realpath(dirname(skillDir)).catch(() => null);
      if (!canonicalParent) {
        throw new Error(`该技能不可删除: ${skill.path}`);
      }

      // Safety guard: deletion recursively removes a directory, so allow it only under a controlled skill root.
      // Collect `.zcode/skills` and `.agents/skills` at every workspace level (walking upward through the worktree), plus both user-level roots.
      const allowedRootCandidates = await resolveAncestorWorkspaceRoots(params.workspacePath);
      allowedRootCandidates.push(getUserZcodeSkillRoot());
      allowedRootCandidates.push(getUserAgentsSkillRoot());

      // Compare the realpath parent against realpath roots: the parent must be inside or equal to a controlled root.
      // Resolve both sides so system symlinks such as `/tmp` → `/private/tmp` cancel out instead of causing false boundary violations.
      let contained = false;
      for (const root of allowedRootCandidates) {
        const canonicalRoot = await realpath(root).catch(() => root);
        const relativePath = relative(canonicalRoot, canonicalParent);
        // The parent may equal the root when the leaf is directly under it; this is common and valid, so allow "".
        if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) {
          contained = true;
          break;
        }
      }

      if (!contained) {
        throw new Error(`该技能不可删除: ${skill.path}`);
      }
      // Delete `<real parent>/<leaf name>`: the parent is already a real path, so traversal through ancestor symlinks is impossible.
      // The leaf remains the original directory entry; delete only the link if it is a symlink, or the whole directory if it is a normal directory.
      await rm(join(canonicalParent, skillLeafName), {
        recursive: true,
        force: true,
      });
    },
  };
}
