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
  function dependencies(deps) {
    for (const [alias, info] of Object.entries(deps ?? {})) {
      const name = info.name ?? alias;
      if (!isInstallable(name, info.version)) continue;
      if (!own.has(name) && !name.startsWith("@zcode/") && !info.version.startsWith("link:")) {
        required.set(`${name}@${info.version}`, { name, version: info.version });
      }
      dependencies(info.dependencies);
      dependencies(info.optionalDependencies);
    }
  }
  for (const project of projects) {
    dependencies(project.dependencies);
    dependencies(project.optionalDependencies);
  }
  return required;
}

export function assertProductionGraphs(lockedProjects, installedProjects, isInstallable) {
  const locked = productionPackages(lockedProjects, isInstallable);
  const installed = productionPackages(installedProjects, isInstallable);
  const missing = [...locked].filter(([key]) => !installed.has(key));
  const stale = [...installed.keys()].filter((key) => !locked.has(key));
  if (missing.length || stale.length) {
    throw new Error(
      `Installed production graph differs from pnpm-lock.yaml. Run pnpm install --frozen-lockfile.\nMissing: ${missing.map(([key]) => key).join(", ")}\nStale: ${stale.join(", ")}`,
    );
  }
  return locked;
}

export async function readWorkspaceProductionGraph(root) {
  root = await realpath(root);
  // Fix: pnpm ls reads the installed snapshot by default; do not combine an old graph with the current lockfile hash to produce a seemingly valid declaration.
  const [locked, actual] = await Promise.all(
    [true, false].map(async (lockfileOnly) => {
      const { stdout } = await exec(
        "pnpm",
        [
          "-r",
          "ls",
          "--prod",
          "--json",
          "--depth",
          "Infinity",
          ...(lockfileOnly ? ["--lockfile-only"] : []),
        ],
        {
          cwd: root,
          maxBuffer: 256 * 1024 * 1024,
          ...resolveSpawnRuntimeOptions("pnpm"),
        },
      );
      return JSON.parse(stdout);
    }),
  );
  const isInstallable = createInstallablePackageFilter(
    readLockfilePlatformConstraints(await readFile(join(root, "pnpm-lock.yaml"), "utf8")),
    await readInstallTargets(root),
  );
  const required = assertProductionGraphs(locked, actual, isInstallable);
  return { required, projects: actual };
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
