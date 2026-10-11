import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const moduleDir = import.meta.dirname;

function findPackageDir(packageName, startDirs) {
  for (const startDir of startDirs) {
    let currentDir = resolve(startDir);

    while (true) {
      const packageJsonPath = resolve(currentDir, "package.json");
      if (existsSync(packageJsonPath)) {
        try {
          const packageJson = readJson(packageJsonPath);
          if (packageJson.name === packageName) {
            return currentDir;
          }
        } catch {
          // ignore invalid package.json and continue walking up
        }
      }

      const parentDir = resolve(currentDir, "..");
      if (parentDir === currentDir) {
        break;
      }
      currentDir = parentDir;
    }
  }

  throw new Error(`Unable to find package directory for ${packageName}`);
}

const desktopDir = findPackageDir("@zcode/desktop", [
  moduleDir,
  resolve(moduleDir, ".."),
  process.cwd(),
]);
const workspaceDir = resolve(desktopDir, "../..");
const metadataDir = resolve(desktopDir, "out/metadata");
const metadataPath = resolve(metadataDir, "build-meta.json");

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf-8"));
}

function normalizeVersion(version) {
  if (typeof version !== "string" || version.length === 0) {
    return "unknown";
  }

  const normalized = version.replace(/^[^\d]*/, "");
  return normalized || version;
}

function resolveInstalledPackageVersion(packageName, fallbackVersion) {
  try {
    const packageJsonPath = require.resolve(`${packageName}/package.json`, { paths: [desktopDir] });
    return normalizeVersion(readJson(packageJsonPath).version);
  } catch {
    return normalizeVersion(fallbackVersion);
  }
}

function resolveCommitId() {
  try {
    return execSync("git rev-parse --short=8 HEAD", {
      cwd: workspaceDir,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return process.env.ZCODE_COMMIT ?? "unknown";
  }
}

export function collectBuildMetadata() {
  const rootPackageJson = readJson(resolve(workspaceDir, "package.json"));
  const desktopPackageJson = readJson(resolve(desktopDir, "package.json"));

  return {
    appVersion: normalizeVersion(rootPackageJson.version),
    buildCommitId: resolveCommitId(),
    buildTime: new Date().toISOString(),
    electronBuilderVersion: resolveInstalledPackageVersion(
      "electron-builder",
      desktopPackageJson.devDependencies?.["electron-builder"],
    ),
  };
}

export function readBuildMetadata() {
  if (!existsSync(metadataPath)) {
    return null;
  }

  try {
    return readJson(metadataPath);
  } catch {
    return null;
  }
}

export function getBuildMetadata() {
  return readBuildMetadata() ?? collectBuildMetadata();
}

export function writeBuildMetadata() {
  // About previously calculated separate commit and timestamp values in tsup and Vite.
  // Because the builds run in separate processes, their timestamps naturally differ; later packaging
  // could also show metadata from different artifacts. Write one build-meta.json first and reuse it in
  // both the build and runtime so the About information remains traceable.
  const metadata = collectBuildMetadata();
  mkdirSync(metadataDir, { recursive: true });
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf-8");
  return metadata;
}

export function getBuildMetadataPath() {
  return metadataPath;
}

const entryFilePath = process.argv[1] ? resolve(process.argv[1]) : null;
const currentFilePath = fileURLToPath(import.meta.url);

if (entryFilePath === currentFilePath) {
  const metadata = writeBuildMetadata();
  process.stdout.write(`[build-meta] wrote ${metadataPath}\n`);
  process.stdout.write(
    `[build-meta] commit=${metadata.buildCommitId} time=${metadata.buildTime}\n`,
  );
}
