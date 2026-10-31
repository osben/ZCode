import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { resolveSpawnRuntimeOptions } from "./spawn-command.mjs";

const exec = promisify(execFile);
export const hashBytes = (bytes) => createHash("sha256").update(bytes).digest("hex");
const noticeName =
  /(?:^|[._-])(?:licen[sc]es?|copying|notice|copyright|unlicense|third.party|ofl)(?:[._-]|$)/iu;

export async function readPackageNotices(directory) {
  const files = [];
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (["node_modules", ".git", "test", "tests", "fixtures"].includes(entry.name)) continue;
      // The packaging process distributes Chromium's aggregate license separately through resources/licenses/electron; it is not included in npm notices.
      if (entry.isFile() && entry.name === "LICENSES.chromium.html") continue;
      const full = join(path, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile() && noticeName.test(entry.name)) {
        const bytes = await readFile(full);
        if (bytes.includes(0) || bytes.length === 0) continue;
        files.push({ member: relative(directory, full).replaceAll("\\", "/"), bytes });
      } else if (entry.isFile() && /^readme(?:\.[^/]*)?$/iu.test(entry.name)) {
        const text = await readFile(full, "utf8");
        const match = /^(?:#{1,6}\s+licen[sc]e[^\n]*\n|licen[sc]e\s*\n[=-]+\n)/imu.exec(text);
        if (match) {
          const section = text.slice(match.index).split(/\n(?=#{1,6}\s)/u)[0];
          files.push({
            member: `${relative(directory, full).replaceAll("\\", "/")} (license section)`,
            bytes: Buffer.from(section),
          });
        }
      }
    }
  }
  await visit(directory);
  return files.sort((a, b) => a.member.localeCompare(b.member, "en"));
}

// Parse platform constraints in the lockfile v9 `packages` section: `os/cpu/libc: [...]` lines under a `name@version` entry.
export function readLockfilePlatformConstraints(lockfileText) {
  const constraints = new Map();
  let inPackages = false;
  let key = null;
  for (const line of lockfileText.split(/\r?\n/u)) {
    if (/^\S/u.test(line)) {
      inPackages = line === "packages:";
      key = null;
      continue;
    }
    if (!inPackages) continue;
    const header = /^ {2}(?:'([^']+)'|([^\s'][^:]*)):$/u.exec(line);
    if (header) {
      key = header[1] ?? header[2];
      continue;
    }
    const field = key && /^ {4}(os|cpu|libc): \[(.*)\]$/u.exec(line);
    if (field) {
      const values = field[2]
        .split(",")
        .map((value) => value.trim().replace(/^'(.*)'$/u, "$1"))
        .filter(Boolean);
      constraints.set(key, { ...constraints.get(key), [field[1]]: values });
    }
  }
  return constraints;
}

// Mirror pnpm package-is-installable’s checkList so the result matches actual installation, including negated constraints.
function pnpmCheckList(values, list) {
  if (list.length === 1 && list[0] === "any") return true;
  let match = false;
  let blc = 0;
  for (const value of values) {
    for (const item of list) {
      if (item[0] === "!") {
        if (item.slice(1) === value) return false;
        ++blc;
      } else {
        match = match || item === value;
      }
    }
  }
  return match || blc === list.length;
}

// A null `targets.libc` means the host libc is unknown (non-Linux); pnpm does not check libc in that case.
export function createInstallablePackageFilter(constraints, targets) {
  return (name, version) => {
    const wanted = constraints.get(`${name}@${version.split("(")[0]}`);
    if (!wanted) return true;
    if (wanted.os && !pnpmCheckList(targets.os, wanted.os)) return false;
    if (wanted.cpu && !pnpmCheckList(targets.cpu, wanted.cpu)) return false;
    if (wanted.libc && targets.libc && !pnpmCheckList(targets.libc, wanted.libc)) return false;
    return true;
  };
}

function hostLibc() {
  if (process.platform !== "linux") return null;
  return process.report?.getReport?.()?.header?.glibcVersionRuntime ? "glibc" : "musl";
}

// Match pnpm checkPlatform: when supportedArchitectures is unset, use only the host; replace `current` with the host value.
export async function readInstallTargets(root) {
  const { parse } = await import("yaml");
  const workspace = parse(await readFile(join(root, "pnpm-workspace.yaml"), "utf8")) ?? {};
  const supported = workspace.supportedArchitectures ?? {};
  const resolveCurrent = (list, current) =>
    (list ?? ["current"]).map((value) => (value === "current" ? current : value));
  const libc = hostLibc();
  return {
    os: resolveCurrent(supported.os, process.platform),
    cpu: resolveCurrent(supported.cpu, process.arch),
    libc: libc ? resolveCurrent(supported.libc, libc) : null,
  };
}

// Fix: platform packages skipped by pnpm according to supportedArchitectures (such as Sharp’s s390x/wasm32 builds) are never installed or distributed,
// Previously, a package-name exception list allowed them, so adding a dependency caused false missing-package reports; now the entire subtree is skipped according to lockfile platform constraints.
export function productionPackages(projects, isInstallable = () => true) {
  const own = new Set(projects.map((project) => project.name));
  const required = new Map();
  const graph = new Map();
  const identity = (alias, info) => `${info.name ?? alias}@${info.version}`;
  function index(deps) {
    for (const [alias, info] of Object.entries(deps ?? {})) {
      const key = identity(alias, info);
      const edges = graph.get(key) ?? {};
      Object.assign(edges, info.dependencies, info.optionalDependencies);
      graph.set(key, edges);
      index(info.dependencies);
      index(info.optionalDependencies);
    }
  }
  // pnpm 12 prunes repeated subtrees; their expansion may live under a dev root.
  // Index all edges before selecting production roots so runtime peers keep their closure.
  for (const project of projects) {
    index(project.dependencies);
    index(project.optionalDependencies);
    index(project.devDependencies);
  }
  const visited = new Set();
  function dependencies(deps) {
    for (const [alias, info] of Object.entries(deps ?? {})) {
      const name = info.name ?? alias;
      // Workspace projects are traversed through their own production roots, not expanded links.
      if (own.has(name) || info.version.startsWith("link:")) continue;
      if (!isInstallable(name, info.version)) continue;
      const key = identity(alias, info);
      if (visited.has(key)) continue;
      visited.add(key);
      if (!name.startsWith("@zcode/")) {
        required.set(`${name}@${info.version}`, { name, version: info.version });
      }
      dependencies(graph.get(key));
    }
  }
  for (const project of projects) {
    dependencies(project.dependencies);
    dependencies(project.optionalDependencies);
  }
  return required;
}

// Fork: pnpm 12 (packageManager pin) writes a leading env-lockfile YAML document (`---` +
// packageManagerDependencies + `---`) into pnpm-lock.yaml, but never into node_modules/.pnpm/lock.yaml.
// Drop it so the snapshot comparison sees only the dependency document.
export function stripPnpmEnvLockfileDocument(lockfile) {
  if (!lockfile.startsWith("---\n")) return lockfile;
  const end = lockfile.indexOf("\n---\n", 4);
  return end === -1 ? lockfile : lockfile.slice(end + 5);
}

export function assertInstalledLockfileSnapshot(rootLockfile, installedLockfile) {
  // A Windows autocrlf working tree may hold a CRLF root lockfile while pnpm always writes LF snapshots.
  // Line endings do not change the dependency graph, so compare normalized text (review CR-03: a raw string
  // comparison reported a CRLF workspace with an identical graph as a stale snapshot, and reinstalling could not clear it).
  const normalize = (value) => stripPnpmEnvLockfileDocument(value.replaceAll("\r\n", "\n"));
  if (normalize(rootLockfile) !== normalize(installedLockfile)) {
    throw new Error(
      "Installed dependency snapshot differs from pnpm-lock.yaml. Run pnpm install --frozen-lockfile.",
    );
  }
}

async function readWorkspaceProjects(root) {
  const { stdout } = await exec("pnpm", ["-r", "list", "--depth", "-1", "--json"], {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
    ...resolveSpawnRuntimeOptions("pnpm"),
  });
  return JSON.parse(stdout);
}

export function createPnpmLockfileOnlyEnv(env = process.env) {
  return { ...env, NPM_CONFIG_LOCKFILE_ONLY: "true" };
}

async function readLockedWorkspaceProductionGraph(root, workspaceProjects) {
  const projects = [];
  // A recursive pnpm list opens the whole workspace at once on Windows and exceeds the handle limit.
  // After pinning the root lockfile, list each unique workspace name separately to keep the full deduped subtree and cap peak handles.
  // Do not pass --prod: pnpm 12 prunes repeated subtrees, so a production-only listing can drop edges that a dev root expanded.
  // productionPackages indexes every edge and selects only production roots, so the extra dev rows are never installed or distributed.
  for (const project of workspaceProjects) {
    const { stdout } = await exec(
      "pnpm",
      ["--filter", project.name, "list", "--json", "--depth", "Infinity"],
      {
        cwd: root,
        env: createPnpmLockfileOnlyEnv(),
        maxBuffer: 64 * 1024 * 1024,
        ...resolveSpawnRuntimeOptions("pnpm"),
      },
    );
    const rows = JSON.parse(stdout);
    if (rows.length !== 1) {
      throw new Error(`Unexpected pnpm production graph rows for ${project.name}: ${rows.length}`);
    }
    projects.push(rows[0]);
  }
  return projects;
}

export async function readWorkspaceProductionGraph(root) {
  root = await realpath(root);
  const rootLockfile = await readFile(join(root, "pnpm-lock.yaml"), "utf8");
  let installedLockfile;
  try {
    installedLockfile = await readFile(join(root, "node_modules/.pnpm/lock.yaml"), "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    throw new Error(
      "Installed dependency snapshot is missing. Run pnpm install --frozen-lockfile.",
      { cause: error },
    );
  }
  assertInstalledLockfileSnapshot(rootLockfile, installedLockfile);
  const workspaceProjects = await readWorkspaceProjects(root);
  const lockedProjects = await readLockedWorkspaceProductionGraph(root, workspaceProjects);
  const isInstallable = createInstallablePackageFilter(
    readLockfilePlatformConstraints(
      stripPnpmEnvLockfileDocument(rootLockfile.replaceAll("\r\n", "\n")),
    ),
    await readInstallTargets(root),
  );
  const required = productionPackages(lockedProjects, isInstallable);
  return { required, projects: workspaceProjects };
}

export async function scanInstalledPackages(root, projects) {
  // In pnpm's hoisted layout, ls.path may still point to a nonexistent .pnpm path; match by the real install directory and exact version.
  const installed = new Map();
  const visited = new Set();
  async function scanNodeModules(directory) {
    let actual;
    try {
      actual = await realpath(directory);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    if (visited.has(actual)) return;
    visited.add(actual);
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const path = join(directory, entry.name);
      if (entry.name.startsWith("@")) {
        for (const scoped of await readdir(path)) await scanPackage(join(path, scoped));
      } else await scanPackage(path);
    }
  }
  async function scanPackage(directory) {
    let pkg;
    try {
      pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes(error.code)) return;
      throw error;
    }
    if (pkg.name && pkg.version) installed.set(`${pkg.name}@${pkg.version}`, { pkg, directory });
    await scanNodeModules(join(directory, "node_modules"));
  }
  for (const project of projects) await scanNodeModules(join(project.path, "node_modules"));
  await scanNodeModules(join(root, "node_modules"));
  await scanNodeModules(join(root, "apps/zcode-cli/node_modules"));
  return installed;
}

export function missingProductionPackages(required, installed) {
  const missing = [...required].filter(([key]) => !installed.has(key)).map(([, item]) => item);
  for (const item of missing) {
    throw new Error(`Missing installed dependency: ${item.name}@${item.version}`);
  }
  return missing;
}

export async function collectNpmNotices(root, overrides) {
  root = await realpath(root);
  const { required, projects } = await readWorkspaceProductionGraph(root);
  // Fix: the license gate and notice generation must scan the same installed package set, so nested versions are not included only in the notices.
  const installed = await scanInstalledPackages(root, projects);
  const packages = [];
  const missing = [];
  const notInstalled = missingProductionPackages(required, installed);
  for (const [key, item] of [...required].sort(([a], [b]) => a.localeCompare(b, "en"))) {
    const installedPackage = installed.get(key);
    if (!installedPackage) {
      continue;
    }
    const { pkg, directory } = installedPackage;
    const notices = await readPackageNotices(directory);
    const override = overrides.find((record) => record.package === key);
    if (override?.file) {
      const bytes = await readFile(join(root, override.file));
      if (hashBytes(bytes) !== override.sha256) throw new Error(`Changed upstream notice: ${key}`);
      notices.push({ member: override.source, bytes });
    }
    // MIT and similar labels in a README are not a substitute for the full license file; this package still needs version-pinned supplemental material.
    if (
      !notices.some(({ member }) => !member.endsWith(" (license section)")) &&
      !override?.acceptedMissingNotice
    )
      missing.push(key);
    packages.push({
      ...item,
      license:
        pkg.license ??
        pkg.licenses?.map((item) => (typeof item === "string" ? item : item.type)).join(" OR ") ??
        override?.license ??
        "(not declared)",
      repository: typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url,
      ...(override?.acceptedMissingNotice
        ? { acceptedMissingNotice: override.acceptedMissingNotice }
        : {}),
      notices,
    });
  }
  if (missing.length) throw new Error(`Missing complete upstream notices:\n${missing.join("\n")}`);
  return {
    packages,
    notInstalled,
    workspaceManifests: projects.map((project) =>
      relative(root, join(project.path, "package.json")).replaceAll("\\", "/"),
    ),
  };
}
