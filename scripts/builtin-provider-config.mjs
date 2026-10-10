import { loadEndpointEnv } from "./load-endpoint-env.mjs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";

const repositoryRoot = resolve(import.meta.dirname, "..");

/** @param {{root?: string, env?: Record<string, string | undefined>}} options */
export async function resolveBuiltinProviderBuildEnvironment({
  root = repositoryRoot,
  env = process.env,
} = {}) {
  let value = env.ZCODE_ENV;
  if (!value?.trim()) {
    const files = [
      ".env",
      ...(env.NODE_ENV === "production"
        ? [".env.production"]
        : [".env.development", ".env.development.local"]),
    ];
    for (const file of files) {
      let content;
      try {
        content = await readFile(resolve(root, file), "utf8");
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      const parsed = parseEnv(content);
      if (parsed.ZCODE_ENV !== undefined) value = parsed.ZCODE_ENV;
    }
  }
  const normalized = value?.trim().toLowerCase() || "test";
  if (normalized !== "test" && normalized !== "production") {
    throw new Error(`Invalid ZCODE_ENV for Built-in Provider build: ${normalized}`);
  }
  return normalized;
}

/** @param {{root?: string, env?: Record<string, string | undefined>}} options */
export async function loadBuiltinProviderConfig({ root = repositoryRoot, env = process.env } = {}) {
  env = await loadEndpointEnv({ root, env });
  const environment = await resolveBuiltinProviderBuildEnvironment({ root, env });
  const sourcePath = resolve(
    root,
    env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE?.trim() || "config/provider/zcode-builtin.json",
  );
  try {
    const content = await readFile(sourcePath, "utf8");
    // Reuse the full runtime Release validation during the build so Schema incompatibility is caught before packaging succeeds.
    // tsx is used only by the build tool to load repository TypeScript; it is not included in the product bundle, and validation rules are not duplicated.
    // ESM treats the drive letter in a Windows absolute path as a protocol. Convert it to a file URL so every platform uses the same loader entry point.
    const { decodeZCodeBuiltinRelease } = await tsImport(
      pathToFileURL(resolve(repositoryRoot, "packages/provider-node/src/zcode-builtin-release.ts"))
        .href,
      import.meta.url,
    );
    decodeZCodeBuiltinRelease(JSON.parse(content));
    return { environment, sourcePath, content };
  } catch (error) {
    throw new Error(`Invalid Built-in Provider config (${environment}): ${sourcePath}`, {
      cause: error,
    });
  }
}

/** @param {{directory: string, root?: string, env?: Record<string, string | undefined>}} options */
export async function stageBuiltinProviderConfig({ directory, ...options }) {
  const config = await loadBuiltinProviderConfig(options);
  await mkdir(directory, { recursive: true });
  // Bootstrap can reuse the JS, but must not also reuse standalone configuration resources from the previous environment or version.
  await writeFile(resolve(directory, "zcode-builtin.json"), config.content, "utf8");
  return config;
}
