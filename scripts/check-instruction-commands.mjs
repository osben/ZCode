import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// pnpm built-ins and informational flags are not verified: they do not depend on
// repository scripts, dependencies or files, so a citation cannot rot.
const SKIPPED_PNPM_COMMANDS = new Set([
  "install",
  "i",
  "add",
  "remove",
  "update",
  "why",
  "list",
  "ls",
  "dlx",
  "create",
  "store",
  "outdated",
  "audit",
  "rebuild",
  "link",
  "publish",
  "pack",
  "pkg",
  "config",
  "env",
  "root",
  "bin",
  "patch",
  "dedupe",
  "deploy",
  "approve-builds",
  "exec",
]);

const GLOBAL_PNPM_FLAGS = new Set(["-r", "-w", "-s"]);
// node flags whose separate argument is a module specifier, not the entry file
const NODE_FLAGS_WITH_VALUE = new Set([
  "--import",
  "--require",
  "-r",
  "--loader",
  "--experimental-loader",
]);
const PLACEHOLDER_PATTERN = /[<{*[]|\$|\|/u;

function unquote(token) {
  if (
    (token.startsWith('"') && token.endsWith('"') && token.length >= 2) ||
    (token.startsWith("'") && token.endsWith("'") && token.length >= 2)
  ) {
    return token.slice(1, -1);
  }
  return token;
}

/**
 * Split a candidate line (fence line or inline code span) into runnable command
 * segments. Prompt prefixes, env assignments and shell separators are stripped;
 * template segments containing placeholders are dropped entirely.
 */
export function extractCommands(markdown) {
  const commands = [];
  const lines = markdown.split("\n");
  let fenced = false;
  let fenceMarker = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!fenced) {
        fenced = true;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        fenced = false;
        fenceMarker = null;
      }
      continue;
    }
    if (fenced) {
      commands.push(...segmentLine(line, index + 1));
      continue;
    }
    for (const span of line.matchAll(/`([^`\n]+)`/gu)) {
      commands.push(...segmentLine(span[1], index + 1));
    }
  }
  return commands;
}

function segmentLine(line, lineNumber) {
  const stripped = line.replace(/^\$\s+/u, "");
  const commands = [];
  let cwd = "";
  for (const rawSegment of stripped.split(/\s*(?:&&|\|\||;)\s*/u)) {
    let segment = rawSegment.trim();
    segment = segment.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)+/u, "");
    segment = unquote(segment);
    const cdMatch = segment.match(/^cd\s+(\S+)$/u);
    if (cdMatch) {
      cwd = unquote(cdMatch[1]).replace(/\/+$/u, "");
      continue;
    }
    if (!segment) continue;
    if (PLACEHOLDER_PATTERN.test(segment)) continue;
    if (!/^(?:pnpm|node)(?:\s|$)/u.test(segment)) continue;
    commands.push({ command: segment, line: lineNumber, cwd });
  }
  return commands;
}

/**
 * Collect tracked markdown files whose command citations are verified.
 * Vendored skill trees and plugin skill trees are not authored here; docs/ is
 * phase 2 (see specs/instruction-command-contract.md).
 */
export function collectScope(root) {
  const tracked = execFileSync("git", ["ls-files"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  })
    .split("\n")
    .filter(Boolean);
  return tracked.filter((path) => {
    if (path.endsWith("/")) return false;
    if (
      path.startsWith(".agents/skills/react-best-practices/") ||
      path.startsWith("apps/zcode-cli/.agents/skills/vercel-react-") ||
      /^apps\/zcode-cli\/packages\/[^/]+\/skills\//u.test(path) ||
      // This contract's own spec quotes failing commands as examples.
      path === "specs/instruction-command-contract.md"
    ) {
      return false;
    }
    const base = path.split("/").pop();
    if (base === "AGENTS.md" || base === "CLAUDE.md") return true;
    if (path === "CONTEXT.md" || path === "DESIGN.md") return true;
    if (/^\.agents\/skills\/[^/]+\/SKILL\.md$/u.test(path)) return true;
    if (/^apps\/zcode-cli\/\.agents\/skills\/[^/]+\/SKILL\.md$/u.test(path)) return true;
    if (/^specs\/[^/].*\.md$/u.test(path)) return true;
    if (/^apps\/zcode-cli\/docs\/design\/v2\/[^/].*\.md$/u.test(path)) return true;
    return false;
  });
}

function toPackageInfo(manifestPath, content) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  const dir = dirname(manifestPath) === "." ? "" : dirname(manifestPath);
  const dependencies = { ...parsed.dependencies, ...parsed.devDependencies };
  return {
    dir,
    name: typeof parsed.name === "string" ? parsed.name : null,
    scripts: new Set(Object.keys(parsed.scripts ?? {})),
    binaries: new Set(Object.keys(dependencies)),
    nestedWorkspace: false,
  };
}

/**
 * Build the static resolution context from tracked manifests. Never reads
 * node_modules: a bare command passes only via a declared script or dependency
 * name. `packagePaths`/`workspacePaths`/`fileExists` exist so tests can run on
 * fixture trees without git.
 */
export function buildContext(
  root,
  { packagePaths = null, workspacePaths = null, fileExists = null } = {},
) {
  const manifestPaths =
    packagePaths ??
    execFileSync("git", ["ls-files", "--", "**/package.json", "*package.json"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    })
      .split("\n")
      .filter(Boolean);
  const packagesByDir = new Map();
  for (const manifestPath of manifestPaths) {
    let content;
    try {
      content = readFileSync(join(root, manifestPath), "utf8");
    } catch {
      continue;
    }
    const info = toPackageInfo(manifestPath, content);
    if (info) packagesByDir.set(info.dir, info);
  }
  const workspaceDirs = new Set();
  for (const workspacePath of workspacePaths ?? []) {
    workspaceDirs.add(dirname(workspacePath) === "." ? "" : dirname(workspacePath));
  }
  if (workspacePaths === null) {
    const workspaceFiles = execFileSync(
      "git",
      ["ls-files", "--", "**/pnpm-workspace.yaml", "*pnpm-workspace.yaml"],
      {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      },
    )
      .split("\n")
      .filter(Boolean);
    for (const workspacePath of workspaceFiles) {
      workspaceDirs.add(dirname(workspacePath) === "." ? "" : dirname(workspacePath));
    }
  }
  const rootPackage = packagesByDir.get("") ?? null;
  for (const dir of workspaceDirs) {
    const info = packagesByDir.get(dir);
    if (info) info.nestedWorkspace = dir !== "" ? true : info.nestedWorkspace;
  }
  const packagesByName = new Map();
  for (const info of packagesByDir.values()) {
    if (info.name && !packagesByName.has(info.name)) packagesByName.set(info.name, info);
  }
  return {
    root,
    rootPackage,
    packagesByDir,
    packagesByName,
    workspaceDirs,
    fileExists: fileExists ?? ((absolutePath) => existsSync(absolutePath)),
  };
}

/**
 * The owning package of a doc: the nearest tracked package.json at or above the
 * doc's directory. Docs under apps/zcode-cli resolve to apps/zcode-cli; root
 * docs resolve to the root manifest.
 */
export function owningPackageDir(ctx, docPath) {
  let dir = dirname(docPath) === "." ? "" : dirname(docPath);
  while (true) {
    if (ctx.packagesByDir.has(dir)) return dir;
    if (dir === "") return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent === "." ? "" : parent;
  }
}

function normalizeFilterSelector(selector) {
  const cleaned = selector
    .replace(/^\^/u, "")
    .replace(/^\.\.\./u, "")
    .replace(/\^\.\.\.$/u, "")
    .replace(/\.\.\.$/u, "")
    .replace(/\^$/u, "");
  if (cleaned.startsWith("./") || cleaned.startsWith("../")) {
    const dir = normalize(cleaned.replace(/\/+$/u, "")).replaceAll("\\", "/");
    return { kind: "dir", dir };
  }
  if (/[*?{[]/u.test(cleaned)) return { kind: "glob" };
  return { kind: "name", name: cleaned };
}

function nearestNestedWorkspace(dir, workspaceDirs) {
  for (
    let current = dir;
    current !== "";
    current = dirname(current) === "." ? "" : dirname(current)
  ) {
    if (workspaceDirs.has(current)) return current;
  }
  return null;
}

function resolvePnpm(tokens, ctx, ownerDir) {
  const filters = [];
  let dir = null;
  let index = 1;
  for (; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--filter" || token === "-F") {
      if (index + 1 >= tokens.length) return { ok: true };
      index += 1;
      filters.push(unquote(tokens[index]));
      continue;
    }
    if (token.startsWith("--filter=")) {
      filters.push(unquote(token.slice("--filter=".length)));
      continue;
    }
    if (token === "--dir" || token === "-C") {
      if (index + 1 >= tokens.length) return { ok: true };
      index += 1;
      dir = unquote(tokens[index]);
      continue;
    }
    if (token.startsWith("--dir=")) {
      dir = unquote(token.slice("--dir=".length));
      continue;
    }
    if (token.startsWith("-C")) {
      dir = unquote(token.slice(2));
      continue;
    }
    if (GLOBAL_PNPM_FLAGS.has(token)) continue;
    if (token === "-v" || token === "--version" || token === "--help") return { ok: true };
    if (token.startsWith("-")) continue;
    break;
  }

  if (dir !== null) {
    const normalizedDir = normalize(dir).replaceAll("\\", "/");
    if (isAbsolute(normalizedDir) || normalizedDir.startsWith("..")) return { ok: true };
    // pnpm walks up from --dir to the nearest pnpm-workspace.yaml, so any directory inside a
    // nested workspace (not only its root) runs with that workspace's binaries and lockfile.
    const nestedRoot = nearestNestedWorkspace(normalizedDir, ctx.workspaceDirs);
    if (nestedRoot !== null) {
      const target = ctx.packagesByDir.get(normalizedDir);
      return {
        ok: false,
        reason: `--dir targets ${normalizedDir}, inside the nested pnpm workspace ${nestedRoot}`,
        suggestion: target?.name
          ? `use --filter ${target.name} from the repository root instead`
          : "use a --filter selector from the repository root instead",
      };
    }
    if (!ctx.packagesByDir.has(normalizedDir)) {
      return { ok: false, reason: `--dir target has no package.json: ${dir}` };
    }
  }

  for (const filter of filters) {
    const selector = normalizeFilterSelector(filter);
    if (selector.kind === "glob") continue;
    if (selector.kind === "dir") {
      if (isAbsolute(selector.dir) || selector.dir.startsWith("..")) continue;
      if (!ctx.packagesByDir.has(selector.dir)) {
        return { ok: false, reason: `--filter path selector has no package.json: ${filter}` };
      }
      continue;
    }
    if (!ctx.packagesByName.has(selector.name)) {
      return { ok: false, reason: `unknown --filter target: ${filter}` };
    }
  }

  const first = tokens[index];
  if (first === undefined) return { ok: true };
  let script = first;
  if (first === "run") {
    script = tokens[index + 1];
    if (script === undefined) return { ok: true };
  } else if (SKIPPED_PNPM_COMMANDS.has(first)) {
    return { ok: true };
  }

  const candidates = [];
  if (dir !== null) {
    candidates.push(ctx.packagesByDir.get(normalize(dir).replaceAll("\\", "/")));
  } else if (filters.length > 0) {
    for (const filter of filters) {
      const selector = normalizeFilterSelector(filter);
      if (selector.kind === "name" && ctx.packagesByName.has(selector.name)) {
        candidates.push(ctx.packagesByName.get(selector.name));
      } else if (selector.kind === "dir" && ctx.packagesByDir.has(selector.dir)) {
        candidates.push(ctx.packagesByDir.get(selector.dir));
      }
    }
  } else {
    const owner = ownerDir === null ? null : ctx.packagesByDir.get(ownerDir);
    if (owner && owner.dir !== "") candidates.push(owner);
  }
  candidates.push(ctx.rootPackage);
  if (candidates.some((pkg) => pkg && pkg.scripts.has(script))) return { ok: true };
  if (candidates.some((pkg) => pkg && pkg.binaries.has(script))) return { ok: true };
  const scope = candidates
    .filter(Boolean)
    .map((pkg) => pkg.dir || "<root>")
    .join(", ");
  return { ok: false, reason: `no script or dependency named "${script}" in ${scope}` };
}

function resolveNode(tokens, ctx, ownerDir) {
  for (let index = 1; index < tokens.length; index += 1) {
    const token = unquote(tokens[index]);
    if (token === "-e" || token === "--eval" || token === "-p" || token === "--print") {
      return { ok: true };
    }
    if (NODE_FLAGS_WITH_VALUE.has(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) continue;
    if (token.startsWith("http://") || token.startsWith("https://")) return { ok: true };
    if (token.startsWith("~")) return { ok: true };
    const owner = ownerDir === null ? "" : ownerDir;
    const asRootPath = isAbsolute(token) ? token : join(ctx.root, token);
    const asOwnerPath = isAbsolute(token) ? token : join(ctx.root, owner, token);
    if (ctx.fileExists(asRootPath) || ctx.fileExists(asOwnerPath)) return { ok: true };
    return {
      ok: false,
      reason: `file not found (repo-root or ${owner || "repo-root"} relative): ${token}`,
    };
  }
  return { ok: true };
}

/**
 * Resolve one extracted command against the static context. `cwd` is the
 * directory a `cd <dir> &&` prefix put the command in; it takes precedence over
 * the doc's owning package for resolution. Returns { ok: true } or
 * { ok: false, reason, suggestion? }.
 */
export function resolveCommand(command, ctx, ownerDir = "", cwd = "") {
  const effectiveOwner = cwd
    ? (owningPackageDir(ctx, cwd === "." ? "x" : `${cwd}/x`) ?? ownerDir)
    : ownerDir;
  const tokens = command.split(/\s+/u);
  if (tokens[0] === "pnpm") return resolvePnpm(tokens, ctx, effectiveOwner);
  return resolveNode(tokens, ctx, effectiveOwner);
}

// Allowlist entries are keyed "<file>::<command>" and must carry a reason.
// An entry that stops matching (the citation was fixed or reworded) fails the
// check, so the list cannot accumulate history.
export const allowlist = new Set([
  // Fixture prose: the compact e2e case matrix describes emitter scripts that
  // the runner creates inside a throwaway workspace; they are not repo files.
  "apps/zcode-cli/docs/design/v2/compact/e2e.md::node scripts/emit-alpha.mjs",
  "apps/zcode-cli/docs/design/v2/compact/e2e.md::node scripts/emit-beta.mjs",
]);

export function checkFiles(ctx, files, entries = allowlist) {
  const violations = [];
  const usedAllowlist = new Set();
  for (const path of files) {
    const source = readFileSync(join(ctx.root, path), "utf8");
    const ownerDir = owningPackageDir(ctx, path);
    for (const { command, line, cwd } of extractCommands(source)) {
      const result = resolveCommand(command, ctx, ownerDir, cwd);
      if (result.ok) continue;
      const key = `${path}::${command}`;
      if (entries.has(key)) {
        usedAllowlist.add(key);
        continue;
      }
      violations.push({
        path,
        line,
        command,
        reason: result.reason,
        suggestion: result.suggestion,
      });
    }
  }
  const stale = [...entries].filter((key) => !usedAllowlist.has(key));
  return { violations, stale };
}

function main() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const ctx = buildContext(root);
  const files = collectScope(root);
  const { violations, stale } = checkFiles(ctx, files);
  if (violations.length === 0 && stale.length === 0) {
    process.stdout.write(`Instruction command check passed (${files.length} files).\n`);
    return;
  }
  process.stderr.write(
    `Instruction command violations (${violations.length} commands, ${stale.length} stale allowlist entries):\n`,
  );
  for (const violation of violations) {
    process.stderr.write(`- ${violation.path}:${violation.line}: ${violation.command}\n`);
    process.stderr.write(`  reason: ${violation.reason}\n`);
    if (violation.suggestion) process.stderr.write(`  fix: ${violation.suggestion}\n`);
  }
  for (const key of stale) {
    process.stderr.write(`- stale allowlist entry: ${key}\n`);
  }
  process.exitCode = 1;
}

const isCli = (() => {
  try {
    return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isCli) {
  main();
}
