// Koffi native runtime staging for the bundled CUA MCP server.
//
// The CUA server externalizes koffi because esbuild cannot bundle its
// platform-dispatching `.node` requires. The installed agent has no hoisted
// node_modules, so the koffi package and its target platform package are copied
// beside the plugin. koffi 3 ships one native addon per optional
// `@koromix/koffi-<os>-<arch>` package (koffi 2 kept every platform under
// build/koffi/); the loader resolves that sibling package relative to its own
// location, so both must land in the same node_modules.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

function resolveKoffiRoot(koffiPackageRoot) {
  const candidates = [
    resolve(koffiPackageRoot),
    resolve(koffiPackageRoot, "node_modules", "koffi"),
  ];
  const virtualStore = resolve(koffiPackageRoot, "..", "..", "..", "..", "node_modules", ".pnpm");
  candidates.push(resolve(virtualStore, "..", "koffi"));
  if (existsSync(virtualStore)) {
    for (const entry of readdirSync(virtualStore)) {
      if (entry.startsWith("koffi@"))
        candidates.push(resolve(virtualStore, entry, "node_modules", "koffi"));
    }
  }
  for (const candidate of candidates) {
    const packageJson = resolve(candidate, "package.json");
    if (!existsSync(packageJson)) continue;
    try {
      if (JSON.parse(readFileSync(packageJson, "utf8")).name === "koffi") return candidate;
    } catch {
      // Continue searching other installation locations.
    }
  }
  throw new Error(
    `[koffi-package-assets] cannot resolve installed koffi package from ${koffiPackageRoot}`,
  );
}

/** Native directory inside a platform package uses underscores (darwin_arm64). */
function koffiPlatformKey(targetPlatform) {
  return `${targetPlatform.os}_${targetPlatform.arch}`;
}

/** Platform package names use dashes (koffi-darwin-arm64). */
function koffiPlatformPackageName(targetPlatform) {
  return `koffi-${targetPlatform.os}-${targetPlatform.arch}`;
}

function resolveKoffiPlatformPackage(koffiRoot, targetPlatform) {
  const shortName = koffiPlatformPackageName(targetPlatform);
  const candidates = [
    resolve(koffiRoot, "node_modules", "@koromix", shortName),
    resolve(koffiRoot, "..", "@koromix", shortName),
    resolve(koffiRoot, "..", "..", "@koromix", shortName),
    resolve(koffiRoot, "..", "..", "..", "..", "node_modules", "@koromix", shortName),
  ];
  for (const candidate of candidates) {
    if (existsSync(resolve(candidate, "package.json"))) return candidate;
  }
  throw new Error(`[koffi-package-assets] cannot resolve @koromix/${shortName} from ${koffiRoot}`);
}

export function stageKoffiIntoBundledAgents({ koffiPackageRoot, glmDir, targetPlatform }) {
  if (!koffiPackageRoot || !glmDir || !targetPlatform?.os || !targetPlatform?.arch) {
    throw new Error(
      "[koffi-package-assets] koffiPackageRoot, glmDir and targetPlatform are required",
    );
  }
  const sourceRoot = resolveKoffiRoot(koffiPackageRoot);
  const sourcePlatformPackage = resolveKoffiPlatformPackage(sourceRoot, targetPlatform);
  const platformKey = koffiPlatformKey(targetPlatform);
  const sourceNativePath = resolve(sourcePlatformPackage, platformKey, "koffi.node");
  if (!existsSync(sourceNativePath)) {
    throw new Error(`[koffi-package-assets] missing target native addon: ${sourceNativePath}`);
  }

  const targetKoffi = resolve(glmDir, "node_modules", "koffi");
  rmSync(targetKoffi, { recursive: true, force: true });
  mkdirSync(targetKoffi, { recursive: true });
  // Runtime surface of the koffi 3 package: the CJS entries, typings, and the src/ loader it
  // requires at startup. Docs and build files stay out of the staged bundle.
  for (const file of [
    "package.json",
    "index.cjs",
    "index.js",
    "index.d.ts",
    "indirect.cjs",
    "indirect.js",
    "cnoke.cjs",
  ]) {
    if (existsSync(resolve(sourceRoot, file))) {
      cpSync(resolve(sourceRoot, file), resolve(targetKoffi, file));
    }
  }
  cpSync(resolve(sourceRoot, "src"), resolve(targetKoffi, "src"), {
    recursive: true,
    filter: (source) => !source.endsWith("CMakeLists.txt"),
  });

  const targetPlatformPackage = resolve(
    glmDir,
    "node_modules",
    "@koromix",
    koffiPlatformPackageName(targetPlatform),
  );
  rmSync(targetPlatformPackage, { recursive: true, force: true });
  mkdirSync(resolve(targetPlatformPackage, ".."), { recursive: true });
  cpSync(sourcePlatformPackage, targetPlatformPackage, { recursive: true });
  return resolve(targetPlatformPackage, platformKey, "koffi.node");
}

export function verifyStagedKoffi({
  resourcesDir,
  targetPlatform,
  pluginRelativePath = "packages/zcode-cua-plugin",
}) {
  const koffiRoot = resolve(resourcesDir, "glm", pluginRelativePath, "node_modules", "koffi");
  const nativePath = resolve(
    koffiRoot,
    "..",
    "@koromix",
    koffiPlatformPackageName(targetPlatform),
    koffiPlatformKey(targetPlatform),
    "koffi.node",
  );
  return existsSync(nativePath) && existsSync(resolve(koffiRoot, "index.cjs"))
    ? []
    : [`missing staged koffi runtime for ${koffiPlatformKey(targetPlatform)}: ${nativePath}`];
}
